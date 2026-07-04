/**
 * Smoke coverage for machine-scoped RPC over the local P2P daemon transport.
 *
 * This simulates the web drawer path from the CLI side: discover a machine via
 * REST, send an encrypted Socket.IO RPC request, and decrypt the daemon's
 * encrypted list-directory response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { ListDirectoryResponse } from '@/daemon/directoryBrowser/types';
import type { MachineSocketHandle } from '@/daemon/machineSocket';
import type { P2PServer } from '@/daemon/p2p/p2pServer';

const SOCKET_CONNECT_TIMEOUT_MS = 5_000;
const RPC_ACK_TIMEOUT_MS = 5_000;
const RPC_REGISTRATION_TIMEOUT_MS = 5_000;
const RPC_REGISTRATION_RETRY_MS = 50;
const EPHEMERAL_TIMEOUT_MS = 5_000;
const TEST_MACHINE_ID = 'machine-rpc-directory-smoke';

interface P2PModules {
    P2PStore: typeof import('@/daemon/p2p/p2pStore').P2PStore;
    bootstrapMachineSocket: typeof import('@/daemon/machineSocket').bootstrapMachineSocket;
    deriveBearerToken: typeof import('@/daemon/p2p/p2pAuth').deriveBearerToken;
    generateSharedSecret: typeof import('@/daemon/p2p/p2pAuth').generateSharedSecret;
    publishSessionActivity: typeof import('@/daemon/p2p/p2pSessionLifecycle').publishSessionActivity;
    startP2PServer: typeof import('@/daemon/p2p/p2pServer').startP2PServer;
}

interface RpcCallAck {
    ok: boolean;
    result?: string;
    error?: string;
}

interface MachineResponse {
    id: string;
}

interface SessionResponse {
    id: string;
    active: boolean;
    activeAt: number;
}

interface EphemeralActivityPayload {
    type: 'activity';
    id: string;
    active: boolean;
    activeAt: number;
    thinking: boolean;
}

interface StopSessionRpcResponse {
    message: string;
    sessionId: string;
}

let remcliHomeDir: string;
let browserRootDir: string;
let p2pServer: P2PServer | null = null;
let machineSocketHandle: MachineSocketHandle | null = null;
let appSocket: ClientSocket | null = null;

const originalRemcliHomeDir = process.env.REMCLI_HOME_DIR;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

async function importP2PModules(): Promise<P2PModules> {
    vi.resetModules();
    const [
        p2pStore,
        machineSocket,
        p2pAuth,
        p2pSessionLifecycle,
        p2pServerModule,
    ] = await Promise.all([
        import('@/daemon/p2p/p2pStore'),
        import('@/daemon/machineSocket'),
        import('@/daemon/p2p/p2pAuth'),
        import('@/daemon/p2p/p2pSessionLifecycle'),
        import('@/daemon/p2p/p2pServer'),
    ]);

    return {
        P2PStore: p2pStore.P2PStore,
        bootstrapMachineSocket: machineSocket.bootstrapMachineSocket,
        deriveBearerToken: p2pAuth.deriveBearerToken,
        generateSharedSecret: p2pAuth.generateSharedSecret,
        publishSessionActivity: p2pSessionLifecycle.publishSessionActivity,
        startP2PServer: p2pServerModule.startP2PServer,
    };
}

function restoreEnvironment(): void {
    if (originalRemcliHomeDir === undefined) {
        delete process.env.REMCLI_HOME_DIR;
    } else {
        process.env.REMCLI_HOME_DIR = originalRemcliHomeDir;
    }

    if (originalHome === undefined) {
        delete process.env.HOME;
    } else {
        process.env.HOME = originalHome;
    }

    if (originalUserProfile === undefined) {
        delete process.env.USERPROFILE;
    } else {
        process.env.USERPROFILE = originalUserProfile;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isRpcCallAck(value: unknown): value is RpcCallAck {
    return (
        isRecord(value) &&
        typeof value.ok === 'boolean' &&
        (value.result === undefined || typeof value.result === 'string') &&
        (value.error === undefined || typeof value.error === 'string')
    );
}

function isMachineResponse(value: unknown): value is MachineResponse {
    return isRecord(value) && typeof value.id === 'string';
}

function isSessionResponse(value: unknown): value is SessionResponse {
    return (
        isRecord(value) &&
        typeof value.id === 'string' &&
        typeof value.active === 'boolean' &&
        typeof value.activeAt === 'number'
    );
}

function isEphemeralActivityPayload(value: unknown): value is EphemeralActivityPayload {
    return (
        isRecord(value) &&
        value.type === 'activity' &&
        typeof value.id === 'string' &&
        typeof value.active === 'boolean' &&
        typeof value.activeAt === 'number' &&
        typeof value.thinking === 'boolean'
    );
}

function isStopSessionRpcResponse(value: unknown): value is StopSessionRpcResponse {
    return (
        isRecord(value) &&
        value.message === 'Session stopped' &&
        typeof value.sessionId === 'string'
    );
}

function isListDirectoryResponse(value: unknown): value is ListDirectoryResponse {
    return (
        isRecord(value) &&
        typeof value.path === 'string' &&
        typeof value.displayPath === 'string' &&
        (typeof value.parent === 'string' || value.parent === null) &&
        (typeof value.parentDisplayPath === 'string' || value.parentDisplayPath === null) &&
        typeof value.style === 'string' &&
        typeof value.separator === 'string' &&
        isRecord(value.home) &&
        Array.isArray(value.entries)
    );
}

function createSocketConnection(port: number, bearerToken: string): Promise<ClientSocket> {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        auth: {
            token: bearerToken,
            clientType: 'user-scoped',
        },
        path: '/v1/updates',
        reconnection: false,
        timeout: SOCKET_CONNECT_TIMEOUT_MS,
    });

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Timed out connecting to P2P Socket.IO server'));
        }, SOCKET_CONNECT_TIMEOUT_MS);

        socket.once('connect', () => {
            clearTimeout(timeout);
            resolve(socket);
        });

        socket.once('connect_error', (error: Error) => {
            clearTimeout(timeout);
            socket.close();
            reject(error);
        });
    });
}

async function fetchMachines(port: number, bearerToken: string): Promise<MachineResponse[]> {
    const response = await fetch(`http://127.0.0.1:${port}/v1/machines`, {
        headers: {
            Authorization: `Bearer ${bearerToken}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch machines: HTTP ${response.status}`);
    }

    const body = await response.json() as unknown;
    if (!Array.isArray(body) || !body.every(isMachineResponse)) {
        throw new Error('Unexpected machines response shape');
    }

    return body;
}

async function fetchSessions(port: number, bearerToken: string, path: string): Promise<SessionResponse[]> {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: {
            Authorization: `Bearer ${bearerToken}`,
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch sessions: HTTP ${response.status}`);
    }

    const body = await response.json() as unknown;
    if (!isRecord(body) || !Array.isArray(body.sessions) || !body.sessions.every(isSessionResponse)) {
        throw new Error('Unexpected sessions response shape');
    }

    return body.sessions;
}

async function emitRpcCall(socket: ClientSocket, method: string, params: string): Promise<RpcCallAck> {
    const response = await socket
        .timeout(RPC_ACK_TIMEOUT_MS)
        .emitWithAck('rpc-call', { method, params }) as unknown;

    if (!isRpcCallAck(response)) {
        throw new Error('Unexpected rpc-call acknowledgement shape');
    }

    return response;
}

async function emitRpcCallWhenRegistered(socket: ClientSocket, method: string, params: string): Promise<RpcCallAck> {
    const deadline = Date.now() + RPC_REGISTRATION_TIMEOUT_MS;
    let lastResponse: RpcCallAck | null = null;

    while (Date.now() < deadline) {
        lastResponse = await emitRpcCall(socket, method, params);

        if (lastResponse.ok || !lastResponse.error?.startsWith('No handler registered')) {
            return lastResponse;
        }

        await new Promise((resolve) => setTimeout(resolve, RPC_REGISTRATION_RETRY_MS));
    }

    return lastResponse ?? { ok: false, error: `No acknowledgement received for ${method}` };
}

function waitForSessionActivity(socket: ClientSocket, sessionId: string): Promise<EphemeralActivityPayload> {
    return new Promise((resolve, reject) => {
        let timeout: NodeJS.Timeout;

        const handleEphemeral = (payload: unknown) => {
            if (!isEphemeralActivityPayload(payload) || payload.id !== sessionId) {
                return;
            }

            clearTimeout(timeout);
            socket.off('ephemeral', handleEphemeral);
            resolve(payload);
        };

        timeout = setTimeout(() => {
            socket.off('ephemeral', handleEphemeral);
            reject(new Error(`Timed out waiting for activity event for ${sessionId}`));
        }, EPHEMERAL_TIMEOUT_MS);

        socket.on('ephemeral', handleEphemeral);
    });
}

beforeEach(() => {
    remcliHomeDir = mkdtempSync(join(tmpdir(), 'remcli-machine-rpc-home-'));
    browserRootDir = mkdtempSync(join(tmpdir(), 'remcli-machine-rpc-browser-'));
    process.env.REMCLI_HOME_DIR = remcliHomeDir;
    process.env.HOME = browserRootDir;
    process.env.USERPROFILE = browserRootDir;
});

afterEach(async () => {
    appSocket?.close();
    appSocket = null;

    machineSocketHandle?.close();
    machineSocketHandle = null;

    await p2pServer?.stop();
    p2pServer = null;

    restoreEnvironment();
    rmSync(remcliHomeDir, { recursive: true, force: true });
    rmSync(browserRootDir, { recursive: true, force: true });
    vi.resetModules();
});

describe('machine RPC directory browser smoke', { timeout: 15_000 }, () => {
    it('passes encrypted list-directory through the P2P machine RPC path', async () => {
        mkdirSync(join(browserRootDir, 'alpha'));
        mkdirSync(join(browserRootDir, 'beta'));
        mkdirSync(join(browserRootDir, '.hidden'));
        writeFileSync(join(browserRootDir, 'notes.txt'), 'file entries must not be returned');

        const modules = await importP2PModules();
        const sharedSecret = modules.generateSharedSecret();
        const bearerToken = modules.deriveBearerToken(sharedSecret);
        const store = new modules.P2PStore({ kvFilePath: null });
        const machine = store.getOrCreateMachine(
            TEST_MACHINE_ID,
            JSON.stringify({
                host: 'test-host',
                platform: process.platform,
                remcliCliVersion: '0.0.0-test',
                homeDir: browserRootDir,
                remcliHomeDir,
                remcliLibDir: remcliHomeDir,
            }),
            JSON.stringify({ status: 'running', pid: process.pid, startedAt: Date.now() }),
            null,
        );

        expect(machine).not.toBeNull();

        p2pServer = await modules.startP2PServer({
            port: 0,
            host: '127.0.0.1',
            sharedSecret,
            store,
        });

        machineSocketHandle = modules.bootstrapMachineSocket({
            p2pPort: p2pServer.port,
            machineId: TEST_MACHINE_ID,
            bearerToken,
            sharedSecret,
            spawnSession: async () => ({ type: 'error', errorMessage: 'spawn-session is outside this smoke test' }),
            stopSession: () => ({ success: false }),
            requestShutdown: () => undefined,
        });

        const machines = await fetchMachines(p2pServer.port, bearerToken);
        expect(machines.map(({ id }) => id)).toContain(TEST_MACHINE_ID);

        appSocket = await createSocketConnection(p2pServer.port, bearerToken);

        const requestParams = { path: browserRootDir };
        const encryptedParams = encodeBase64(encrypt(sharedSecret, 'legacy', requestParams));
        expect(encryptedParams).not.toBe(JSON.stringify(requestParams));

        const rpcResponse = await emitRpcCallWhenRegistered(
            appSocket,
            `${TEST_MACHINE_ID}:list-directory`,
            encryptedParams,
        );

        expect(rpcResponse.ok).toBe(true);
        if (!rpcResponse.result) {
            throw new Error('RPC response did not include an encrypted result');
        }

        const decrypted = decrypt(sharedSecret, 'legacy', decodeBase64(rpcResponse.result)) as unknown;
        expect(isListDirectoryResponse(decrypted)).toBe(true);

        const result = decrypted as ListDirectoryResponse;
        const rootPath = resolve(browserRootDir);
        const expectedPathStyle = process.platform === 'win32' ? 'win32' : 'posix';
        const expectedSeparator = process.platform === 'win32' ? '\\' : '/';
        expect(result).toMatchObject({
            path: rootPath,
            displayPath: '~',
            parent: dirname(rootPath),
            parentDisplayPath: dirname(rootPath),
            style: expectedPathStyle,
            separator: expectedSeparator,
            home: {
                path: rootPath,
                displayPath: '~',
            },
        });
        expect(result.entries).toEqual([
            {
                name: 'alpha',
                path: join(rootPath, 'alpha'),
                displayPath: `~${expectedSeparator}alpha`,
                type: 'directory',
                hidden: false,
            },
            {
                name: 'beta',
                path: join(rootPath, 'beta'),
                displayPath: `~${expectedSeparator}beta`,
                type: 'directory',
                hidden: false,
            },
            {
                name: '.hidden',
                path: join(rootPath, '.hidden'),
                displayPath: `~${expectedSeparator}.hidden`,
                type: 'directory',
                hidden: true,
            },
        ]);
    });
});

describe('machine RPC session lifecycle', { timeout: 15_000 }, () => {
    it('marks stopped sessions inactive in P2P store and emits offline activity', async () => {
        const modules = await importP2PModules();
        const sharedSecret = modules.generateSharedSecret();
        const bearerToken = modules.deriveBearerToken(sharedSecret);
        const store = new modules.P2PStore({ kvFilePath: null });
        const session = store.createSession('stop-session-smoke', '{}', null);
        const machine = store.getOrCreateMachine(
            TEST_MACHINE_ID,
            JSON.stringify({
                host: 'test-host',
                platform: process.platform,
                remcliCliVersion: '0.0.0-test',
                homeDir: browserRootDir,
                remcliHomeDir,
                remcliLibDir: remcliHomeDir,
            }),
            JSON.stringify({ status: 'running', pid: process.pid, startedAt: Date.now() }),
            null,
        );

        expect(machine).not.toBeNull();
        expect(session.active).toBe(true);

        p2pServer = await modules.startP2PServer({
            port: 0,
            host: '127.0.0.1',
            sharedSecret,
            store,
        });

        machineSocketHandle = modules.bootstrapMachineSocket({
            p2pPort: p2pServer.port,
            machineId: TEST_MACHINE_ID,
            bearerToken,
            sharedSecret,
            spawnSession: async () => ({ type: 'error', errorMessage: 'spawn-session is outside this smoke test' }),
            stopSession: (sessionId: string) => {
                if (sessionId !== session.id) {
                    return { success: false };
                }
                return { success: true, stoppedSessionId: session.id };
            },
            onSessionStopped: (sessionId: string) => {
                if (!p2pServer) {
                    throw new Error('P2P server must be started before stop-session RPC');
                }
                modules.publishSessionActivity(store, p2pServer.router, {
                    sessionId,
                    active: false,
                    terminal: true,
                });
            },
            requestShutdown: () => undefined,
        });

        appSocket = await createSocketConnection(p2pServer.port, bearerToken);
        const activityPromise = waitForSessionActivity(appSocket, session.id);
        const encryptedParams = encodeBase64(encrypt(sharedSecret, 'legacy', { sessionId: session.id }));

        const rpcResponse = await emitRpcCallWhenRegistered(
            appSocket,
            `${TEST_MACHINE_ID}:stop-session`,
            encryptedParams,
        );

        expect(rpcResponse.ok).toBe(true);
        if (!rpcResponse.result) {
            throw new Error('RPC response did not include an encrypted result');
        }

        const decrypted = decrypt(sharedSecret, 'legacy', decodeBase64(rpcResponse.result)) as unknown;
        expect(isStopSessionRpcResponse(decrypted)).toBe(true);
        if (!isStopSessionRpcResponse(decrypted)) {
            throw new Error('Unexpected stop-session response shape');
        }
        expect(decrypted).toEqual({ message: 'Session stopped', sessionId: session.id });

        const activity = await activityPromise;
        expect(activity).toMatchObject({
            type: 'activity',
            id: session.id,
            active: false,
            thinking: false,
        });

        const allSessions = await fetchSessions(p2pServer.port, bearerToken, '/v1/sessions');
        expect(allSessions.find(({ id }) => id === session.id)).toMatchObject({
            active: false,
            activeAt: activity.activeAt,
        });

        const activeSessions = await fetchSessions(p2pServer.port, bearerToken, '/v2/sessions/active?limit=150');
        expect(activeSessions.map(({ id }) => id)).not.toContain(session.id);
    });
});
