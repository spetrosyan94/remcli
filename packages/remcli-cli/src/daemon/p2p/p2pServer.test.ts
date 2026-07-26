import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import { deriveBearerToken, generateSharedSecret } from './p2pAuth';
import { P2PRunnerCredentialStore, SESSION_MESSAGE_ACK_VERSION } from './p2pRunnerCredentials';
import { P2PStore } from './p2pStore';
import { getWebStaticCacheControl, isWebStaticAssetRequest, startP2PServer } from './p2pServer';

const SOCKET_TIMEOUT_MS = 5_000;

function createSocket(port: number, token: string, auth: Record<string, unknown>): ClientSocket {
    return ioClient(`http://127.0.0.1:${port}`, {
        auth: { token, ...auth },
        path: '/v1/updates',
        transports: ['websocket'],
        reconnection: false,
        autoConnect: false,
        timeout: SOCKET_TIMEOUT_MS,
    });
}

async function connectSocket(socket: ClientSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off('connect', handleConnect);
            socket.off('connect_error', handleError);
            reject(new Error('Timed out connecting to P2P Socket.IO server'));
        }, SOCKET_TIMEOUT_MS);
        const handleConnect = (): void => {
            clearTimeout(timeout);
            socket.off('connect_error', handleError);
            resolve();
        };
        const handleError = (error: Error): void => {
            clearTimeout(timeout);
            socket.off('connect', handleConnect);
            reject(error);
        };
        socket.once('connect', handleConnect);
        socket.once('connect_error', handleError);
        socket.connect();
    });
}

function waitForDisconnect(socket: ClientSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off('disconnect', handleDisconnect);
            reject(new Error('Timed out waiting for Socket.IO disconnect'));
        }, SOCKET_TIMEOUT_MS);
        const handleDisconnect = (): void => {
            clearTimeout(timeout);
            resolve();
        };
        socket.once('disconnect', handleDisconnect);
    });
}

function waitForSocketEvent<T>(socket: ClientSocket, event: string, timeoutMs = SOCKET_TIMEOUT_MS): Promise<T> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off(event, handleEvent);
            reject(new Error(`Timed out waiting for ${event}`));
        }, timeoutMs);
        const handleEvent = (data: T): void => {
            clearTimeout(timeout);
            resolve(data);
        };
        socket.once(event, handleEvent);
    });
}

describe('web static asset policy', () => {
    it('revalidates the Vite entry chunk but keeps route chunks immutable', () => {
        expect(getWebStaticCacheControl('/tmp/web-dist/assets/index-abc123.js')).toBe('no-cache');
        expect(getWebStaticCacheControl('/tmp/web-dist/assets/TerminalPage-abc123.js')).toBe(
            'public, max-age=31536000, immutable',
        );
        expect(getWebStaticCacheControl('/tmp/web-dist/index.html')).toBe('no-cache');
    });

    it('does not turn missing static assets into SPA documents', () => {
        expect(isWebStaticAssetRequest('/assets/TerminalPage-missing.js')).toBe(true);
        expect(isWebStaticAssetRequest('/favicon.ico')).toBe(true);
        expect(isWebStaticAssetRequest('/session/remcli-session/terminal')).toBe(false);
        expect(isWebStaticAssetRequest('/session/remcli-session?fixtures=1')).toBe(false);
    });

    it('serves a newly added lazy chunk without restarting the static route registry', async () => {
        const webAppDir = mkdtempSync(join(tmpdir(), 'remcli-web-static-'));
        const assetsDir = join(webAppDir, 'assets');
        mkdirSync(assetsDir);
        writeFileSync(join(webAppDir, 'index.html'), '<!doctype html><title>remcli</title>');

        const server = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: new Uint8Array(32),
            store: new P2PStore({ kvFilePath: null }),
            webAppDir,
        });
        try {
            writeFileSync(join(assetsDir, 'TerminalPage-new.js'), 'export default null;');

            const response = await fetch(`http://127.0.0.1:${server.port}/assets/TerminalPage-new.js`);

            expect(response.status).toBe(200);
            expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
            await expect(response.text()).resolves.toContain('export default null');
        } finally {
            await server.stop();
            rmSync(webAppDir, { recursive: true, force: true });
        }
    });
});

describe('pairing auth rotation', { timeout: 15_000 }, () => {
    it('revokes stale user access while preserving an acknowledged session runner', async () => {
        const oldAuthSecret = generateSharedSecret();
        const nextAuthSecret = generateSharedSecret();
        const oldBearer = deriveBearerToken(oldAuthSecret);
        const nextBearer = deriveBearerToken(nextAuthSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('rotation-runner', '{}', null);
        const runnerCredentials = new P2PRunnerCredentialStore();
        const runnerCredential = runnerCredentials.issue(session.id, `runner:${session.id}`);
        if (!runnerCredential) throw new Error('Could not issue runner credential');

        const server = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: oldAuthSecret,
            store,
            runnerCredentialStore: runnerCredentials,
        });
        const userSocket = createSocket(server.port, oldBearer, { clientType: 'user-scoped' });
        const runnerSocket = createSocket(server.port, oldBearer, {
            clientType: 'session-scoped',
            sessionId: session.id,
            messageAckVersion: SESSION_MESSAGE_ACK_VERSION,
            runnerCredential,
        });
        const staleUserReconnect = createSocket(server.port, oldBearer, { clientType: 'user-scoped' });
        const resumedRunner = createSocket(server.port, oldBearer, {
            clientType: 'session-scoped',
            sessionId: session.id,
            messageAckVersion: SESSION_MESSAGE_ACK_VERSION,
            runnerCredential,
        });

        try {
            await connectSocket(userSocket);
            await connectSocket(runnerSocket);
            await expect(fetch(`http://127.0.0.1:${server.port}/v1/account/profile`, {
                headers: { Authorization: `Bearer ${oldBearer}` },
            })).resolves.toMatchObject({ status: 200 });

            const userDisconnected = waitForDisconnect(userSocket);
            server.rotateAuthSecret(nextAuthSecret);
            await userDisconnected;

            expect(runnerSocket.connected).toBe(true);
            await expect(fetch(`http://127.0.0.1:${server.port}/v1/account/profile`, {
                headers: { Authorization: `Bearer ${oldBearer}` },
            })).resolves.toMatchObject({ status: 401 });
            await expect(fetch(`http://127.0.0.1:${server.port}/v1/account/profile`, {
                headers: { Authorization: `Bearer ${nextBearer}` },
            })).resolves.toMatchObject({ status: 200 });
            await expect(connectSocket(staleUserReconnect)).rejects.toThrow('Authentication failed');

            runnerSocket.close();
            await connectSocket(resumedRunner);
            expect(resumedRunner.connected).toBe(true);
        } finally {
            userSocket.close();
            runnerSocket.close();
            staleUserReconnect.close();
            resumedRunner.close();
            await server.stop();
        }
    });
});

describe('session-scoped socket isolation', { timeout: 15_000 }, () => {
    it('prevents runner A from affecting session B while retaining bound runner and user actions', async () => {
        const authSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(authSecret);
        const store = new P2PStore({ kvFilePath: null });
        const sessionA = store.createSession('session-a', 'metadata-a', null);
        const sessionB = store.createSession('session-b', 'metadata-b', null);
        const runnerCredentials = new P2PRunnerCredentialStore();
        const runnerCredentialA = runnerCredentials.issue(sessionA.id, `runner:${sessionA.id}`);
        const runnerCredentialB = runnerCredentials.issue(sessionB.id, `runner:${sessionB.id}`);
        if (!runnerCredentialA || !runnerCredentialB) {
            throw new Error('Could not issue runner credentials');
        }

        const server = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret,
            store,
            runnerCredentialStore: runnerCredentials,
        });
        const userSocket = createSocket(server.port, bearerToken, { clientType: 'user-scoped' });
        const runnerA = createSocket(server.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: sessionA.id,
            messageAckVersion: SESSION_MESSAGE_ACK_VERSION,
            runnerCredential: runnerCredentialA,
        });
        const runnerB = createSocket(server.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: sessionB.id,
            messageAckVersion: SESSION_MESSAGE_ACK_VERSION,
            runnerCredential: runnerCredentialB,
        });
        const resumedRunnerA = createSocket(server.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: sessionA.id,
            messageAckVersion: SESSION_MESSAGE_ACK_VERSION,
            runnerCredential: runnerCredentialA,
        });

        try {
            await connectSocket(userSocket);
            await connectSocket(runnerA);

            let sessionBEphemeralEvents = 0;
            userSocket.on('ephemeral', (payload: { id?: string }) => {
                if (payload.id === sessionB.id) {
                    sessionBEphemeralEvents++;
                }
            });

            const originalSessionB = { ...store.getSession(sessionB.id)! };
            runnerA.emit('message', { sid: sessionB.id, message: 'forbidden-message' });
            runnerA.emit('session-alive', { sid: sessionB.id, time: originalSessionB.activeAt + 1, thinking: true });
            runnerA.emit('session-end', { sid: sessionB.id, time: originalSessionB.activeAt + 2 });
            runnerA.emit('usage-report', {
                key: 'forbidden-usage',
                sessionId: sessionB.id,
                tokens: { total: 1 },
                cost: { total: 1 },
            });

            const metadataResponseForB = await runnerA.timeout(SOCKET_TIMEOUT_MS).emitWithAck('update-metadata', {
                sid: sessionB.id,
                metadata: 'forbidden-metadata',
                expectedVersion: originalSessionB.metadataVersion,
            });
            const metadataResponseForMissingSession = await runnerA.timeout(SOCKET_TIMEOUT_MS).emitWithAck('update-metadata', {
                sid: 'missing-session',
                metadata: 'forbidden-metadata',
                expectedVersion: originalSessionB.metadataVersion,
            });
            const stateResponseForB = await runnerA.timeout(SOCKET_TIMEOUT_MS).emitWithAck('update-state', {
                sid: sessionB.id,
                agentState: 'forbidden-state',
                expectedVersion: originalSessionB.agentStateVersion,
            });

            expect(metadataResponseForB).toEqual(metadataResponseForMissingSession);
            expect(metadataResponseForB).toEqual({ result: 'error' });
            expect(stateResponseForB).toEqual({ result: 'error' });
            expect(store.getMessageCount(sessionB.id)).toBe(0);
            expect(store.getSession(sessionB.id)).toMatchObject({
                metadata: originalSessionB.metadata,
                metadataVersion: originalSessionB.metadataVersion,
                agentState: originalSessionB.agentState,
                agentStateVersion: originalSessionB.agentStateVersion,
                active: originalSessionB.active,
                activeAt: originalSessionB.activeAt,
            });
            expect(sessionBEphemeralEvents).toBe(0);

            const metadataResponseForA = await runnerA.timeout(SOCKET_TIMEOUT_MS).emitWithAck('update-metadata', {
                sid: sessionA.id,
                metadata: 'metadata-a-updated',
                expectedVersion: sessionA.metadataVersion,
            });
            expect(metadataResponseForA).toMatchObject({ result: 'success', metadata: 'metadata-a-updated' });
            expect(store.getSession(sessionA.id)?.metadata).toBe('metadata-a-updated');

            userSocket.emit('message', { sid: sessionB.id, message: 'user-message-for-b' });
            runnerA.emit('message-ack', { sid: sessionB.id, seq: 1 });
            const sessionBMessage = waitForSocketEvent<{
                body: { sid: string; message: { content: { c: string; t: string } } };
            }>(runnerB, 'update');
            await connectSocket(runnerB);
            await expect(sessionBMessage).resolves.toMatchObject({
                body: { sid: sessionB.id, message: { content: { c: 'user-message-for-b', t: 'encrypted' } } },
            });

            let sessionBRpcCalls = 0;
            runnerB.on('rpc-request', (_data, callback: (response: string) => void) => {
                sessionBRpcCalls++;
                callback('session-b-response');
            });
            const rpcMethod = `${sessionB.id}:control`;
            const rpcRegistered = waitForSocketEvent<{ method: string }>(runnerB, 'rpc-registered');
            runnerB.emit('rpc-register', { method: rpcMethod });
            await expect(rpcRegistered).resolves.toEqual({ method: rpcMethod });

            const registerError = waitForSocketEvent<{ type: string; error: string }>(runnerA, 'rpc-error');
            runnerA.emit('rpc-register', { method: `${sessionB.id}:forbidden` });
            await expect(registerError).resolves.toEqual({ type: 'register', error: 'Method is not available' });

            const unregisterError = waitForSocketEvent<{ type: string; error: string }>(runnerA, 'rpc-error');
            runnerA.emit('rpc-unregister', { method: rpcMethod });
            await expect(unregisterError).resolves.toEqual({ type: 'unregister', error: 'Method is not available' });

            const rpcResponseForB = await runnerA.timeout(SOCKET_TIMEOUT_MS).emitWithAck('rpc-call', { method: rpcMethod });
            const rpcResponseForMissingSession = await runnerA.timeout(SOCKET_TIMEOUT_MS).emitWithAck('rpc-call', {
                method: 'missing-session:control',
            });
            expect(rpcResponseForB).toEqual(rpcResponseForMissingSession);
            expect(rpcResponseForB).toEqual({ ok: false, error: 'Method is not available' });
            expect(sessionBRpcCalls).toBe(0);

            await expect(userSocket.timeout(SOCKET_TIMEOUT_MS).emitWithAck('rpc-call', { method: rpcMethod }))
                .resolves.toEqual({ ok: true, result: 'session-b-response' });
            expect(sessionBRpcCalls).toBe(1);

            const sessionAMessage = waitForSocketEvent<{ body: { sid: string; message: { seq: number } } }>(runnerA, 'update');
            userSocket.emit('message', { sid: sessionA.id, message: 'user-message-for-a' });
            const deliveredSessionAMessage = await sessionAMessage;
            runnerA.emit('message-ack', {
                sid: sessionA.id,
                seq: deliveredSessionAMessage.body.message.seq,
            });
            await runnerA.timeout(SOCKET_TIMEOUT_MS).emitWithAck('ping');
            const replayedSessionAMessage = waitForSocketEvent(resumedRunnerA, 'update', 250);
            runnerA.close();
            await connectSocket(resumedRunnerA);
            await expect(replayedSessionAMessage).rejects.toThrow('Timed out waiting for update');
        } finally {
            userSocket.close();
            runnerA.close();
            runnerB.close();
            resumedRunnerA.close();
            await server.stop();
        }
    });
});
