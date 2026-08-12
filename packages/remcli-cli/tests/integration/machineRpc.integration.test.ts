/**
 * Smoke coverage for machine-scoped RPC over the local P2P daemon transport.
 *
 * This simulates the web drawer path from the CLI side: discover a machine via
 * REST, send an encrypted Socket.IO RPC request, and decrypt the daemon's
 * encrypted list-directory response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { ListDirectoryResponse } from '@/daemon/directoryBrowser/types';
import type { MachineSocketHandle } from '@/daemon/machineSocket';
import type { P2PServer } from '@/daemon/p2p/p2pServer';
import {
    calculateRequestProofMac,
    REQUEST_PROOF_TTL_MS,
    REQUEST_PROOF_VERSION,
} from '@/daemon/p2p/p2pRequestProof';
import type { StopSessionResult } from '@/daemon/types';

const SOCKET_CONNECT_TIMEOUT_MS = 5_000;
const RPC_ACK_TIMEOUT_MS = 5_000;
const TEST_MACHINE_ID = 'machine-rpc-directory-smoke';

interface P2PModules {
    P2PStore: typeof import('@/daemon/p2p/p2pStore').P2PStore;
    PairingRekeyCoordinator: typeof import('@/daemon/p2p/pairingRekey').PairingRekeyCoordinator;
    CursorCapabilitiesService: typeof import('@/cursor/cursorCapabilities').CursorCapabilitiesService;
    bootstrapMachineSocket: typeof import('@/daemon/machineSocket').bootstrapMachineSocket;
    deriveBearerToken: typeof import('@/daemon/p2p/p2pAuth').deriveBearerToken;
    generateSharedSecret: typeof import('@/daemon/p2p/p2pAuth').generateSharedSecret;
    startP2PServer: typeof import('@/daemon/p2p/p2pServer').startP2PServer;
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

interface RpcCallAck {
    ok: boolean;
    result?: string;
    error?: string;
}

interface MachineResponse {
    id: string;
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
        pairingRekey,
        machineSocket,
        cursorCapabilities,
        p2pAuth,
        p2pServerModule,
    ] = await Promise.all([
        import('@/daemon/p2p/p2pStore'),
        import('@/daemon/p2p/pairingRekey'),
        import('@/daemon/machineSocket'),
        import('@/cursor/cursorCapabilities'),
        import('@/daemon/p2p/p2pAuth'),
        import('@/daemon/p2p/p2pServer'),
    ]);

    return {
        P2PStore: p2pStore.P2PStore,
        PairingRekeyCoordinator: pairingRekey.PairingRekeyCoordinator,
        CursorCapabilitiesService: cursorCapabilities.CursorCapabilitiesService,
        bootstrapMachineSocket: machineSocket.bootstrapMachineSocket,
        deriveBearerToken: p2pAuth.deriveBearerToken,
        generateSharedSecret: p2pAuth.generateSharedSecret,
        startP2PServer: p2pServerModule.startP2PServer,
    };
}

function createPairingRekeyCoordinator(modules: P2PModules, sharedSecret: Uint8Array) {
    return new modules.PairingRekeyCoordinator({
        currentSecrets: () => ({ authSecret: sharedSecret, contentSecret: sharedSecret }),
        createQrPayload: async () => ({
            qrUrl: "http://127.0.0.1/terminal/connect#test",
            qrDataUrl: "data:image/png;base64,test",
        }),
        rotateAuthSecret: async () => undefined,
    });
}

function createDeferred<T>(): Deferred<T> {
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });

    if (!resolvePromise) {
        throw new Error('Could not create deferred promise');
    }

    return { promise, resolve: resolvePromise };
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

function createSocketConnection(
    port: number,
    bearerToken: string,
    auth: Record<string, unknown> = { clientType: 'user-scoped' },
): Promise<ClientSocket> {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        auth: {
            token: bearerToken,
            ...auth,
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

function createSocketProof(authSecret: Uint8Array, operation: string, payload: Record<string, string>) {
    const id = randomUUID();
    const expiresAt = Date.now() + REQUEST_PROOF_TTL_MS;
    const mac = calculateRequestProofMac(authSecret, {
        v: REQUEST_PROOF_VERSION,
        transport: 'socket',
        operation,
        requestId: id,
        expiresAt,
        payload,
    });
    if (!mac) {
        throw new Error('Could not create request proof');
    }
    return { v: REQUEST_PROOF_VERSION, id, expiresAt, mac };
}

async function emitRpcCall(
    socket: ClientSocket,
    authSecret: Uint8Array,
    method: string,
    params: string,
): Promise<RpcCallAck> {
    const payload = { method, params };
    const response = await socket
        .timeout(RPC_ACK_TIMEOUT_MS)
        .emitWithAck('rpc-call', { ...payload, proof: createSocketProof(authSecret, 'rpc-call', payload) }) as unknown;

    if (!isRpcCallAck(response)) {
        throw new Error('Unexpected rpc-call acknowledgement shape');
    }

    return response;
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
        p2pServer = await modules.startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            daemonMachineId: TEST_MACHINE_ID,
        });
        if (!p2pServer.daemonMachineCredential) {
            throw new Error('Expected daemon machine credential');
        }

        machineSocketHandle = modules.bootstrapMachineSocket({
            p2pPort: p2pServer.port,
            machineId: TEST_MACHINE_ID,
            bearerToken,
            daemonMachineCredential: p2pServer.daemonMachineCredential,
            authSecret: sharedSecret,
            contentSecret: sharedSecret,
            pairingRekeyCoordinator: createPairingRekeyCoordinator(modules, sharedSecret),
            cursorCapabilities: new modules.CursorCapabilitiesService({
                readModelList: async () => ({
                    executable: 'agent',
                    output: 'Available models\n\nauto - Auto (default)\n\nTip: use --model <id> to switch.',
                }),
            }),
            spawnSession: async () => ({ type: 'error', errorMessage: 'spawn-session is outside this smoke test' }),
            stopSession: () => ({ success: false }),
            requestShutdown: () => undefined,
        });
        await machineSocketHandle.ready;

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

        const machines = await fetchMachines(p2pServer.port, bearerToken);
        expect(machines.map(({ id }) => id)).toContain(TEST_MACHINE_ID);

        await expect(
            createSocketConnection(p2pServer.port, bearerToken, {
                clientType: 'machine-scoped',
                machineId: TEST_MACHINE_ID,
            }),
        ).rejects.toThrow('Authentication failed');

        appSocket = await createSocketConnection(p2pServer.port, bearerToken);

        const requestParams = { path: browserRootDir };
        const encryptedParams = encodeBase64(encrypt(sharedSecret, 'legacy', requestParams));
        expect(encryptedParams).not.toBe(JSON.stringify(requestParams));

        const rpcResponse = await emitRpcCall(
            appSocket,
            sharedSecret,
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

describe('machine RPC stop acknowledgements', { timeout: 15_000 }, () => {
    it('does not acknowledge stop-session RPC before the asynchronous stop result resolves', async () => {
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

        const server = await modules.startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
        });
        p2pServer = server;

        const deferredStop = createDeferred<StopSessionResult>();
        const stopSession = vi.fn(() => deferredStop.promise);

        machineSocketHandle = modules.bootstrapMachineSocket({
            p2pPort: server.port,
            machineId: TEST_MACHINE_ID,
            bearerToken,
            authSecret: sharedSecret,
            contentSecret: sharedSecret,
            pairingRekeyCoordinator: createPairingRekeyCoordinator(modules, sharedSecret),
            cursorCapabilities: new modules.CursorCapabilitiesService({
                readModelList: async () => ({
                    executable: 'agent',
                    output: 'Available models\n\nauto - Auto (default)\n\nTip: use --model <id> to switch.',
                }),
            }),
            spawnSession: async () => ({ type: 'error', errorMessage: 'spawn-session is outside this smoke test' }),
            stopSession,
            requestShutdown: () => undefined,
        });
        await machineSocketHandle.ready;

        appSocket = await createSocketConnection(server.port, bearerToken);
        const encryptedParams = encodeBase64(encrypt(sharedSecret, 'legacy', { sessionId: session.id }));

        let hasRpcAcknowledged = false;
        const rpcResponsePromise = emitRpcCall(
            appSocket,
            sharedSecret,
            `${TEST_MACHINE_ID}:stop-session`,
            encryptedParams,
        ).then((response) => {
            hasRpcAcknowledged = true;
            return response;
        });

        await vi.waitFor(() => {
            expect(stopSession).toHaveBeenCalledWith(session.id);
        });
        expect(hasRpcAcknowledged).toBe(false);

        deferredStop.resolve({ success: true, stoppedSessionId: session.id });

        const rpcResponse = await rpcResponsePromise;

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
    });
});
