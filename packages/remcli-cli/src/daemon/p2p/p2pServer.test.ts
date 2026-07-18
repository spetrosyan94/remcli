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
