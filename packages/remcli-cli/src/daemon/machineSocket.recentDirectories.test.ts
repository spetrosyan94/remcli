import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as ioClient, type Socket } from 'socket.io-client';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import {
    CodexCapabilitiesService,
    getDefaultCodexExecution,
    type CodexCapabilityClient,
} from '@/codex/codexCapabilities';
import { CursorCapabilitiesService } from '@/cursor/cursorCapabilities';
import { bootstrapMachineSocket, type MachineSocketHandle } from '@/daemon/machineSocket';
import { PairingRekeyCoordinator } from '@/daemon/p2p/pairingRekey';
import { deriveBearerToken, generateSharedSecret } from '@/daemon/p2p/p2pAuth';
import { P2PStore } from '@/daemon/p2p/p2pStore';
import { startP2PServer, type P2PServer } from '@/daemon/p2p/p2pServer';
import {
    RecentDirectoriesError,
    createRecentDirectoriesStore,
    type RecentDirectoriesStore,
} from '@/daemon/recentDirectories';
import type { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

const TEST_MACHINE_ID = 'machine-recent-directories-rpc';
const RPC_TIMEOUT_MS = 5_000;
const RPC_RETRY_INTERVAL_MS = 50;

interface RpcCallAck {
    ok: boolean;
    result?: string;
    error?: string;
}

let p2pServer: P2PServer | null = null;
let machineSocketHandle: MachineSocketHandle | null = null;
let appSocket: Socket | null = null;
let testDirectory: string | null = null;

function createCodexCapabilities(): CodexCapabilitiesService {
    const client: CodexCapabilityClient = {
        listModels: async () => ({ data: [] }),
        readConfigRequirements: async () => ({ allowedSandboxModes: [] }),
        disconnect: async () => undefined,
    };

    return new CodexCapabilitiesService({
        getAppServerState: () => null,
        isStateUsable: async () => false,
        createClient: () => client,
    });
}

function createReadyCodexCapabilities(): CodexCapabilitiesService {
    const client: CodexCapabilityClient = {
        listModels: async () => ({
            data: [{
                id: 'gpt-5.6-terra',
                displayName: 'GPT-5.6-Terra',
                defaultReasoningEffort: 'high',
                supportedReasoningEfforts: [{ reasoningEffort: 'high' }],
                isDefault: true,
            }],
        }),
        readConfigRequirements: async () => ({
            allowedSandboxModes: ['workspaceWrite'],
            allowedApprovalPolicies: ['onRequest'],
        }),
        disconnect: async () => undefined,
    };

    return new CodexCapabilitiesService({
        getAppServerState: () => ({
            codexAppServerEndpoint: 'ws://127.0.0.1:45123',
            codexAppServerPid: 123,
        }),
        isStateUsable: async () => true,
        createClient: () => client,
    });
}

function createCursorCapabilities(): CursorCapabilitiesService {
    return new CursorCapabilitiesService({
        readModelList: async () => ({ executable: 'agent', version: 'test', output: '' }),
    });
}

function createPairingRekeyCoordinator(secret: Uint8Array): PairingRekeyCoordinator {
    return new PairingRekeyCoordinator({
        currentSecrets: () => ({ authSecret: secret, contentSecret: secret }),
        createQrPayload: async () => ({
            qrUrl: 'http://127.0.0.1/terminal/connect#test',
            qrDataUrl: 'data:image/png;base64,test',
        }),
        rotateAuthSecret: async () => undefined,
    });
}

function connectUserSocket(port: number, bearerToken: string): Promise<Socket> {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        auth: { token: bearerToken, clientType: 'user-scoped' },
        path: '/v1/updates',
        reconnection: false,
        timeout: RPC_TIMEOUT_MS,
    });

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Timed out connecting to machine RPC test server'));
        }, RPC_TIMEOUT_MS);

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

function isRpcCallAck(value: unknown): value is RpcCallAck {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.ok === 'boolean'
        && (candidate.result === undefined || typeof candidate.result === 'string')
        && (candidate.error === undefined || typeof candidate.error === 'string');
}

async function callMachineRpc(secret: Uint8Array, method: string, params: unknown): Promise<unknown> {
    if (!appSocket) {
        throw new Error('Test machine RPC socket is not connected');
    }

    const encryptedParams = encodeBase64(encrypt(secret, 'legacy', params));
    const deadline = Date.now() + RPC_TIMEOUT_MS;
    let response: RpcCallAck | null = null;

    while (Date.now() < deadline) {
        const received = await appSocket.timeout(RPC_TIMEOUT_MS).emitWithAck('rpc-call', {
            method: `${TEST_MACHINE_ID}:${method}`,
            params: encryptedParams,
        }) as unknown;
        if (!isRpcCallAck(received)) {
            throw new Error('Unexpected machine RPC acknowledgement');
        }
        response = received;
        if (response.ok || !response.error?.startsWith('No handler registered')) {
            break;
        }
        await new Promise((resolve) => setTimeout(resolve, RPC_RETRY_INTERVAL_MS));
    }

    if (!response?.ok || !response.result) {
        throw new Error(response?.error ?? 'Machine RPC did not return an encrypted response');
    }

    return decrypt(secret, 'legacy', decodeBase64(response.result)) as unknown;
}

async function startHarness(
    recentDirectories: RecentDirectoriesStore,
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>,
    codexCapabilities: CodexCapabilitiesService = createCodexCapabilities(),
): Promise<Uint8Array> {
    const secret = generateSharedSecret();
    const bearerToken = deriveBearerToken(secret);
    const store = new P2PStore({ kvFilePath: null });
    store.getOrCreateMachine(
        TEST_MACHINE_ID,
        JSON.stringify({ host: 'test-host' }),
        JSON.stringify({ status: 'running' }),
        null,
    );
    p2pServer = await startP2PServer({
        port: 0,
        host: '127.0.0.1',
        authSecret: secret,
        store,
    });
    machineSocketHandle = bootstrapMachineSocket({
        p2pPort: p2pServer.port,
        machineId: TEST_MACHINE_ID,
        bearerToken,
        contentSecret: secret,
        pairingRekeyCoordinator: createPairingRekeyCoordinator(secret),
        codexCapabilities,
        cursorCapabilities: createCursorCapabilities(),
        spawnSession,
        stopSession: () => ({ success: false }),
        requestShutdown: () => undefined,
        recentDirectories,
    });
    appSocket = await connectUserSocket(p2pServer.port, bearerToken);

    return secret;
}

afterEach(async () => {
    appSocket?.close();
    appSocket = null;
    machineSocketHandle?.close();
    machineSocketHandle = null;
    await p2pServer?.stop();
    p2pServer = null;
    if (testDirectory) {
        rmSync(testDirectory, { recursive: true, force: true });
        testDirectory = null;
    }
});

describe('machine RPC recent directories', { timeout: 15_000 }, () => {
    it('records only a successful spawn and returns the MRU through authenticated machine RPC', async () => {
        testDirectory = mkdtempSync(join(tmpdir(), 'remcli-machine-rpc-recent-'));
        const workspace = join(testDirectory, 'workspace');
        mkdirSync(workspace);
        const recentDirectories = createRecentDirectoriesStore({
            machineId: TEST_MACHINE_ID,
            filePath: join(testDirectory, 'recent-directories.json'),
            getHomeDirectory: () => testDirectory!,
            now: () => 100,
        });
        const secret = await startHarness(recentDirectories, async () => ({
            type: 'success',
            sessionId: 'spawned-session',
        }));

        expect(await callMachineRpc(secret, 'spawn-remcli-session', {
            type: 'spawn-in-directory',
            agent: 'claude',
            directory: workspace,
        })).toEqual({
            type: 'success',
            sessionId: 'spawned-session',
        });
        expect(await callMachineRpc(secret, 'list-recent-directories', {})).toEqual({
            directories: [{
                canonicalPath: realpathSync(workspace),
                displayPath: '~/workspace',
                lastUsedAt: 100,
            }],
        });
    });

    it('rejects missing or unknown providers and foreign provider controls before spawn', async () => {
        const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: 'unused' }));
        testDirectory = mkdtempSync(join(tmpdir(), 'remcli-machine-rpc-provider-'));
        const recentDirectories = createRecentDirectoriesStore({
            machineId: TEST_MACHINE_ID,
            filePath: join(testDirectory, 'recent-directories.json'),
        });
        const secret = await startHarness(recentDirectories, spawn);

        const invalidRequests = [
            { directory: process.cwd() },
            { agent: 'terminal', directory: process.cwd() },
            {
                agent: 'claude',
                directory: process.cwd(),
                codexExecution: { model: 'gpt-5.6-terra', catalogVersion: 'forged' },
            },
            {
                agent: 'gemini',
                directory: process.cwd(),
                cursorExecution: { model: 'cursor-model', catalogVersion: 'forged' },
            },
            { agent: 'claude', directory: process.cwd(), permissionMode: 'workspace-write' },
            { agent: 'gemini', directory: process.cwd(), permissionMode: 'acceptEdits' },
            {
                agent: 'cursor',
                directory: process.cwd(),
                cursorExecution: { model: 'cursor-model', catalogVersion: 'forged' },
                cursorLaunchControls: {
                    executionMode: 'agent',
                    force: false,
                    autoReview: false,
                    sandbox: 'local-configuration',
                    approveMcps: false,
                },
                cursorRunner: { executable: 'agent', cliFingerprint: '0123456789abcdef' },
            },
        ];

        for (const request of invalidRequests) {
            await expect(callMachineRpc(secret, 'spawn-remcli-session', request)).resolves.toEqual(
                expect.objectContaining({ error: expect.any(String) }),
            );
        }
        expect(spawn).not.toHaveBeenCalled();
    });

    it('spawns Codex only after its validated native selection passes a live refresh', async () => {
        const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: 'codex-session' }));
        const codexCapabilities = createReadyCodexCapabilities();
        const snapshot = await codexCapabilities.getCapabilities();
        const execution = getDefaultCodexExecution(snapshot);
        expect(execution).not.toBeNull();
        testDirectory = mkdtempSync(join(tmpdir(), 'remcli-machine-rpc-codex-'));
        const recentDirectories = createRecentDirectoriesStore({
            machineId: TEST_MACHINE_ID,
            filePath: join(testDirectory, 'recent-directories.json'),
        });
        const secret = await startHarness(recentDirectories, spawn, codexCapabilities);

        await expect(callMachineRpc(secret, 'spawn-remcli-session', {
            type: 'spawn-in-directory',
            agent: 'codex',
            directory: process.cwd(),
            permissionMode: 'workspace-write',
            codexExecution: execution,
        })).resolves.toEqual({ type: 'success', sessionId: 'codex-session' });
        expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
            agent: 'codex',
            permissionMode: 'workspace-write',
            codexExecution: execution,
        }));
    });

    it('returns a daemon terminal-unavailable status through encrypted machine RPC', async () => {
        const spawn = vi.fn(async () => ({
            type: 'success' as const,
            sessionId: 'terminal-session',
            terminal: { type: 'unavailable' as const, error: 'terminal-unavailable' as const },
        }));
        testDirectory = mkdtempSync(join(tmpdir(), 'remcli-machine-rpc-terminal-'));
        const recentDirectories = createRecentDirectoriesStore({
            machineId: TEST_MACHINE_ID,
            filePath: join(testDirectory, 'recent-directories.json'),
        });
        const secret = await startHarness(recentDirectories, spawn);

        await expect(callMachineRpc(secret, 'spawn-remcli-session', {
            type: 'spawn-in-directory',
            agent: 'claude',
            directory: process.cwd(),
        })).resolves.toEqual({
            type: 'success',
            sessionId: 'terminal-session',
            terminal: { type: 'unavailable', error: 'terminal-unavailable' },
        });
    });

    it('keeps a typed persistence failure inside the encrypted RPC error boundary', async () => {
        const recentDirectories: RecentDirectoriesStore = {
            list: () => {
                throw new RecentDirectoriesError('unavailable');
            },
            recordSuccessfulSpawn: () => undefined,
        };
        const secret = await startHarness(recentDirectories, async () => ({
            type: 'success',
            sessionId: 'unused',
        }));

        expect(await callMachineRpc(secret, 'list-recent-directories', {})).toEqual({
            error: {
                code: 'unavailable',
                message: 'Recent directories are unavailable.',
            },
        });
    });
});
