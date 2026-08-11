import { afterEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { io as ioClient, type Socket } from 'socket.io-client';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { CodexAppServerStateSnapshot } from '@/codex/codexAppServerHost';
import {
    CodexCapabilitiesService,
    type CodexCapabilitiesSnapshot,
    type CodexCapabilityClient,
    type CodexExecutionConfig,
} from '@/codex/codexCapabilities';
import {
    CursorCapabilitiesService,
    type CursorCapabilitiesSnapshot,
    type CursorExecutionConfig,
} from '@/cursor/cursorCapabilities';
import { DEFAULT_CURSOR_LAUNCH_CONTROLS } from '@/cursor/cursorLaunchControls';
import {
    bootstrapMachineSocket,
    type MachineSocketHandle,
} from '@/daemon/machineSocket';
import { PairingRekeyCoordinator } from '@/daemon/p2p/pairingRekey';
import { deriveBearerToken, generateSharedSecret } from '@/daemon/p2p/p2pAuth';
import {
    calculateRequestProofMac,
    REQUEST_PROOF_TTL_MS,
    REQUEST_PROOF_VERSION,
} from '@/daemon/p2p/p2pRequestProof';
import { P2PStore } from '@/daemon/p2p/p2pStore';
import { startP2PServer, type P2PServer } from '@/daemon/p2p/p2pServer';
import type { CodexSandbox } from '@/codex/types';
import type {
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/modules/common/registerCommonHandlers';

const SOCKET_CONNECT_TIMEOUT_MS = 5_000;
const RPC_ACK_TIMEOUT_MS = 5_000;
const RPC_REGISTRATION_TIMEOUT_MS = 5_000;
const RPC_REGISTRATION_RETRY_MS = 50;
const TEST_MACHINE_ID = 'machine-rpc-codex-capabilities';

interface RpcCallAck {
    ok: boolean;
    result?: string;
    error?: string;
}

interface RpcHarness {
    appSocket: Socket;
    sharedSecret: Uint8Array;
    snapshot: CodexCapabilitiesSnapshot;
    spawnSession: ReturnType<typeof vi.fn<(options: SpawnSessionOptions) => Promise<SpawnSessionResult>>>;
    validateSelectionSpy: MockInstance<CodexCapabilitiesService['validateSelection']>;
    cursorSnapshot: CursorCapabilitiesSnapshot;
    cursorValidateSelectionSpy: MockInstance<CursorCapabilitiesService['validateSelection']>;
}

let p2pServer: P2PServer | null = null;
let machineSocketHandle: MachineSocketHandle | null = null;
let appSocket: Socket | null = null;

function createPairingRekeyCoordinator(sharedSecret: Uint8Array): PairingRekeyCoordinator {
    return new PairingRekeyCoordinator({
        currentSecrets: () => ({ authSecret: sharedSecret, contentSecret: sharedSecret }),
        createQrPayload: async () => ({
            qrUrl: 'http://127.0.0.1/terminal/connect#test',
            qrDataUrl: 'data:image/png;base64,test',
        }),
        rotateAuthSecret: async () => undefined,
    });
}

function createCodexCapabilitiesService(): CodexCapabilitiesService {
    const capabilityClient: CodexCapabilityClient = {
        listModels: vi.fn(async () => ({
            data: [
                {
                    id: 'gpt-5.6-luna',
                    displayName: 'GPT-5.6-Luna',
                    defaultReasoningEffort: 'xhigh',
                    supportedReasoningEfforts: [
                        { reasoningEffort: 'high' },
                        { reasoningEffort: 'xhigh' },
                    ],
                    isDefault: true,
                },
                {
                    id: 'gpt-5.6-no-reasoning',
                    displayName: 'GPT-5.6 No Reasoning',
                    supportedReasoningEfforts: [],
                    isDefault: false,
                },
            ],
        })),
        readConfigRequirements: vi.fn(async () => ({
            allowedSandboxModes: ['readOnly', 'workspaceWrite'],
        })),
        disconnect: vi.fn(async () => undefined),
    };

    const appServerState: CodexAppServerStateSnapshot = {
        codexAppServerEndpoint: 'ws://127.0.0.1:45123',
        codexAppServerPid: 45123,
    };

    return new CodexCapabilitiesService({
        getAppServerState: () => appServerState,
        isStateUsable: async () => true,
        createClient: () => capabilityClient,
        now: () => 1_000,
    });
}

function createCursorCapabilitiesService(): CursorCapabilitiesService {
    return new CursorCapabilitiesService({
        readModelList: async () => ({
            executable: 'agent',
            version: 'controlled-cursor-agent 1.0.0',
            output: [
                'Available models',
                '',
                'auto - Auto (default)',
                'controlled-cursor-model - Controlled Cursor Model',
                '',
                'Tip: use --model <id> to switch.',
            ].join('\n'),
        }),
        now: () => 1_000,
    });
}

function createSocketConnection(port: number, bearerToken: string): Promise<Socket> {
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
            reject(new Error('Timed out connecting to Codex capability RPC test server'));
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

function isRpcCallAck(value: unknown): value is RpcCallAck {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.ok === 'boolean'
        && (candidate.result === undefined || typeof candidate.result === 'string')
        && (candidate.error === undefined || typeof candidate.error === 'string');
}

async function emitRpcCall(
    socket: Socket,
    authSecret: Uint8Array,
    method: string,
    params: string,
): Promise<RpcCallAck> {
    const payload = { method, params };
    const id = randomUUID();
    const expiresAt = Date.now() + REQUEST_PROOF_TTL_MS;
    const response = await socket
        .timeout(RPC_ACK_TIMEOUT_MS)
        .emitWithAck('rpc-call', {
            ...payload,
            proof: {
                v: REQUEST_PROOF_VERSION,
                id,
                expiresAt,
                mac: calculateRequestProofMac(authSecret, {
                    v: REQUEST_PROOF_VERSION,
                    transport: 'socket',
                    operation: 'rpc-call',
                    requestId: id,
                    expiresAt,
                    payload,
                }),
            },
        }) as unknown;

    if (!isRpcCallAck(response)) {
        throw new Error('Unexpected rpc-call acknowledgement shape');
    }

    return response;
}

async function emitRpcCallWhenRegistered(
    socket: Socket,
    authSecret: Uint8Array,
    method: string,
    params: string,
): Promise<RpcCallAck> {
    const deadline = Date.now() + RPC_REGISTRATION_TIMEOUT_MS;
    let lastResponse: RpcCallAck | null = null;

    while (Date.now() < deadline) {
        lastResponse = await emitRpcCall(socket, authSecret, method, params);
        if (lastResponse.ok || !lastResponse.error?.startsWith('No handler registered')) {
            return lastResponse;
        }
        await new Promise((resolve) => setTimeout(resolve, RPC_REGISTRATION_RETRY_MS));
    }

    return lastResponse ?? { ok: false, error: `No acknowledgement received for ${method}` };
}

async function callMachineRpc(
    harness: Pick<RpcHarness, 'appSocket' | 'sharedSecret'>,
    method: string,
    params: unknown,
): Promise<unknown> {
    const encryptedParams = encodeBase64(encrypt(harness.sharedSecret, 'legacy', params));
    const response = await emitRpcCallWhenRegistered(
        harness.appSocket,
        harness.sharedSecret,
        `${TEST_MACHINE_ID}:${method}`,
        encryptedParams,
    );

    expect(response.ok).toBe(true);
    if (!response.result) {
        throw new Error(response.error ?? `RPC ${method} did not return an encrypted result`);
    }

    return decrypt(
        harness.sharedSecret,
        'legacy',
        decodeBase64(response.result),
    ) as unknown;
}

async function createRpcHarness(): Promise<RpcHarness> {
    const sharedSecret = generateSharedSecret();
    const bearerToken = deriveBearerToken(sharedSecret);
    const store = new P2PStore({ kvFilePath: null });
    const codexCapabilities = createCodexCapabilitiesService();
    const cursorCapabilities = createCursorCapabilitiesService();
    const validateSelectionSpy = vi.spyOn(codexCapabilities, 'validateSelection');
    const cursorValidateSelectionSpy = vi.spyOn(cursorCapabilities, 'validateSelection');
    const snapshot = await codexCapabilities.getCapabilities();
    const cursorSnapshot = await cursorCapabilities.getCapabilities();
    const spawnSession = vi.fn(async (_options: SpawnSessionOptions): Promise<SpawnSessionResult> => ({
        type: 'success',
        sessionId: 'spawned-codex-session',
    }));

    store.getOrCreateMachine(
        TEST_MACHINE_ID,
        JSON.stringify({
            host: 'test-host',
            platform: process.platform,
            remcliCliVersion: '0.0.0-test',
            homeDir: process.cwd(),
            remcliHomeDir: process.cwd(),
            remcliLibDir: process.cwd(),
        }),
        JSON.stringify({ status: 'running', pid: process.pid, startedAt: Date.now() }),
        null,
    );

    p2pServer = await startP2PServer({
        port: 0,
        host: '127.0.0.1',
        authSecret: sharedSecret,
        store,
    });

    machineSocketHandle = bootstrapMachineSocket({
        p2pPort: p2pServer.port,
        machineId: TEST_MACHINE_ID,
        bearerToken,
        authSecret: sharedSecret,
        contentSecret: sharedSecret,
        pairingRekeyCoordinator: createPairingRekeyCoordinator(sharedSecret),
        codexCapabilities,
        cursorCapabilities,
        spawnSession,
        stopSession: () => ({ success: false }),
        requestShutdown: () => undefined,
    });

    appSocket = await createSocketConnection(p2pServer.port, bearerToken);

    return {
        appSocket,
        sharedSecret,
        snapshot,
        spawnSession,
        validateSelectionSpy,
        cursorSnapshot,
        cursorValidateSelectionSpy,
    };
}

function createValidExecution(
    snapshot: CodexCapabilitiesSnapshot,
    model: 'gpt-5.6-luna' | 'gpt-5.6-no-reasoning' = 'gpt-5.6-luna',
): CodexExecutionConfig {
    if (!snapshot.catalogVersion) {
        throw new Error('Expected the deterministic Codex capability snapshot to have a catalog version');
    }

    if (model === 'gpt-5.6-no-reasoning') {
        return {
            model,
            catalogVersion: snapshot.catalogVersion,
        };
    }

    return { model, reasoningEffort: 'xhigh', catalogVersion: snapshot.catalogVersion };
}

function createValidSpawnParams(
    execution: CodexExecutionConfig,
    overrides: Partial<SpawnSessionOptions> = {},
): SpawnSessionOptions & { type: string } {
    return {
        type: 'spawn-in-directory',
        machineId: TEST_MACHINE_ID,
        directory: '/workspace/remcli',
        approvedNewDirectoryCreation: false,
        token: 'session-token',
        agent: 'codex',
        permissionMode: 'workspace-write',
        codexExecution: execution,
        ...overrides,
    };
}

function expectedSpawnOptions(params: SpawnSessionOptions & { type: string }): SpawnSessionOptions {
    const { type: _type, ...options } = params;
    return options;
}

async function expectSpawned(
    harness: RpcHarness,
    spawnParams: SpawnSessionOptions & { type: string },
): Promise<void> {
    const result = await callMachineRpc(harness, 'spawn-remcli-session', spawnParams);

    expect(result).toEqual({ type: 'success', sessionId: 'spawned-codex-session' });
    expect(harness.spawnSession).toHaveBeenCalledOnce();
    if (spawnParams.agent === 'cursor') {
        const validationResult = harness.cursorValidateSelectionSpy.mock.results.at(-1);
        if (!validationResult) {
            throw new Error('Cursor spawn did not validate the capability selection.');
        }
        const cursorRunner = await validationResult.value;
        expect(harness.spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            ...expectedSpawnOptions(spawnParams),
            cursorRunner,
        }));
        return;
    }
    expect(harness.spawnSession).toHaveBeenCalledWith(expectedSpawnOptions(spawnParams));
}

async function expectRpcError(
    harness: RpcHarness,
    method: string,
    params: unknown,
    expectedError: string,
): Promise<void> {
    const result = await callMachineRpc(harness, method, params);
    expect(result).toEqual({ error: expectedError });
    expect(harness.spawnSession).not.toHaveBeenCalled();
}

async function expectPreValidationRpcError(
    harness: RpcHarness,
    params: unknown,
): Promise<void> {
    await expectRpcError(
        harness,
        'spawn-remcli-session',
        params,
        'Codex requires a current model, reasoning, and permission selection.',
    );
    expect(harness.validateSelectionSpy).not.toHaveBeenCalled();
}

afterEach(async () => {
    appSocket?.close();
    appSocket = null;

    machineSocketHandle?.close();
    machineSocketHandle = null;

    await p2pServer?.stop();
    p2pServer = null;
});

describe('Codex machine RPC capability and spawn contract', { timeout: 15_000 }, () => {
    it('returns a typed ready capability snapshot through encrypted machine RPC', async () => {
        const harness = await createRpcHarness();

        const result = await callMachineRpc(harness, 'get-codex-capabilities', {});

        expect(result).toEqual(harness.snapshot);
        expect(result).toMatchObject({
            agent: 'codex',
            status: 'ready',
            catalogVersion: expect.any(String),
            models: [{
                id: 'gpt-5.6-luna',
                displayName: 'GPT-5.6-Luna',
                defaultReasoningEffort: 'xhigh',
                supportedReasoningEfforts: ['high', 'xhigh'],
                isDefault: true,
            }, {
                id: 'gpt-5.6-no-reasoning',
                displayName: 'GPT-5.6 No Reasoning',
                supportedReasoningEfforts: [],
                isDefault: false,
            }],
            permissionModes: ['read-only', 'workspace-write'],
        } satisfies Partial<CodexCapabilitiesSnapshot>);
    });

    it.each([
        ['an explicit model and supported reasoning effort', (snapshot: CodexCapabilitiesSnapshot) =>
            createValidSpawnParams(createValidExecution(snapshot))],
        ['a model without a reasoning selector', (snapshot: CodexCapabilitiesSnapshot) =>
            createValidSpawnParams(createValidExecution(snapshot, 'gpt-5.6-no-reasoning'))],
        ['a valid native Codex resume payload', (snapshot: CodexCapabilitiesSnapshot) =>
            createValidSpawnParams(createValidExecution(snapshot), {
                resumeSessionId: 'native-codex-thread',
                resumeSessionName: 'Existing Codex session',
            })],
    ] as const)('forwards %s unchanged to spawnSession', async (_caseName, createSpawnParams) => {
        const harness = await createRpcHarness();
        await expectSpawned(harness, createSpawnParams(harness.snapshot));
    });

    it.each([
        ['unknown transport envelope', (params: ReturnType<typeof createValidSpawnParams>) => ({
            ...params,
            type: 'spawn-in-project',
        })],
        ['foreign transport field', (params: ReturnType<typeof createValidSpawnParams>) => ({
            ...params,
            unexpectedTransportField: true,
        })],
    ] as const)('rejects %s before provider validation or spawn', async (_caseName, mutateParams) => {
        const harness = await createRpcHarness();
        const params = mutateParams(createValidSpawnParams(createValidExecution(harness.snapshot)));

        await expectRpcError(harness, 'spawn-remcli-session', params, 'Invalid provider spawn request.');
        expect(harness.validateSelectionSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['stale catalog', (execution: CodexExecutionConfig) => ({ ...execution, catalogVersion: 'stale-catalog' }), 'workspace-write', 'Codex capability selection rejected: expired.'],
        ['nonexistent model', (execution: CodexExecutionConfig) => ({ ...execution, model: 'gpt-5.6-not-in-catalog' }), 'workspace-write', 'Codex capability selection rejected: unsupported_selection.'],
        ['unsupported effort', (execution: CodexExecutionConfig) => ({ ...execution, reasoningEffort: 'unsupported-effort' }), 'workspace-write', 'Codex capability selection rejected: unsupported_selection.'],
        ['reasoning effort for a model without a selector', (execution: CodexExecutionConfig) => ({ ...execution, model: 'gpt-5.6-no-reasoning', reasoningEffort: 'xhigh' }), 'workspace-write', 'Codex capability selection rejected: unsupported_selection.'],
        ['policy-denied permission', (execution: CodexExecutionConfig) => execution, 'danger-full-access', 'Codex capability selection rejected: policy_denied.'],
    ] as const)('rejects %s before spawn', async (_caseName, mutateExecution, permissionMode, expectedError) => {
        const harness = await createRpcHarness();
        const execution = mutateExecution(createValidExecution(harness.snapshot));
        const spawnParams = {
            ...createValidSpawnParams(execution),
            permissionMode: permissionMode as CodexSandbox,
        };

        await expectRpcError(harness, 'spawn-remcli-session', spawnParams, expectedError);
    });

    it.each([
        ['missing execution', (params: ReturnType<typeof createValidSpawnParams>) => {
            const { codexExecution: _codexExecution, ...withoutExecution } = params;
            return withoutExecution;
        }],
        ['malformed execution', (params: ReturnType<typeof createValidSpawnParams>) => ({
            ...params,
            codexExecution: { model: 'gpt-5.6-luna', reasoningEffort: 42, catalogVersion: params.codexExecution?.catalogVersion },
        })],
        ['execution array', (params: ReturnType<typeof createValidSpawnParams>) => ({
            ...params,
            codexExecution: [params.codexExecution],
        })],
        ['unknown execution field', (params: ReturnType<typeof createValidSpawnParams>) => ({
            ...params,
            codexExecution: {
                ...params.codexExecution,
                unexpectedExecutionState: 'must-not-reach-spawn',
            },
        })],
        ['prototype-pollution execution field', (params: ReturnType<typeof createValidSpawnParams>) => {
            const codexExecution = { ...params.codexExecution };
            Object.defineProperty(codexExecution, '__proto__', {
                value: { polluted: true },
                enumerable: true,
            });
            return { ...params, codexExecution };
        }],
    ] as const)('rejects %s before spawn', async (_caseName, mutateParams) => {
        const harness = await createRpcHarness();
        const spawnParams = mutateParams(createValidSpawnParams(createValidExecution(harness.snapshot)));

        await expectPreValidationRpcError(harness, spawnParams);
    });
});

function createValidCursorExecution(snapshot: CursorCapabilitiesSnapshot): CursorExecutionConfig {
    if (!snapshot.catalogVersion) {
        throw new Error('Expected the deterministic Cursor capability snapshot to have a catalog version');
    }
    return { model: 'auto', catalogVersion: snapshot.catalogVersion };
}

function createValidCursorSpawnParams(
    execution: CursorExecutionConfig,
    overrides: Partial<SpawnSessionOptions> = {},
): SpawnSessionOptions & { type: string } {
    return {
        type: 'spawn-in-directory',
        machineId: TEST_MACHINE_ID,
        directory: '/workspace/remcli',
        approvedNewDirectoryCreation: false,
        token: 'session-token',
        agent: 'cursor',
        cursorExecution: execution,
        cursorLaunchControls: { ...DEFAULT_CURSOR_LAUNCH_CONTROLS },
        ...overrides,
    };
}

describe('Cursor machine RPC capability and spawn contract', { timeout: 15_000 }, () => {
    it('returns the daemon-normalized account-visible model snapshot through encrypted RPC', async () => {
        const harness = await createRpcHarness();

        await expect(callMachineRpc(harness, 'get-cursor-capabilities', {})).resolves.toEqual(harness.cursorSnapshot);
    });

    it('validates the exact catalog model before forwarding a Cursor spawn', async () => {
        const harness = await createRpcHarness();
        const spawnParams = createValidCursorSpawnParams(createValidCursorExecution(harness.cursorSnapshot));

        await expectSpawned(harness, spawnParams);
        expect(harness.cursorValidateSelectionSpy).toHaveBeenCalledWith(spawnParams.cursorExecution);
    });

    it.each([
        ['missing execution', (params: ReturnType<typeof createValidCursorSpawnParams>) => {
            const { cursorExecution: _cursorExecution, ...withoutExecution } = params;
            return withoutExecution;
        }, 'Cursor requires a current model and validated launch controls.'],
        ['missing launch controls', (params: ReturnType<typeof createValidCursorSpawnParams>) => {
            const { cursorLaunchControls: _cursorLaunchControls, ...withoutControls } = params;
            return withoutControls;
        }, 'Cursor requires a current model and validated launch controls.'],
        ['malformed execution', (params: ReturnType<typeof createValidCursorSpawnParams>) => ({
            ...params,
            cursorExecution: { model: 'auto', catalogVersion: 42 },
        }), 'Cursor requires a current model and validated launch controls.'],
        ['unknown execution field', (params: ReturnType<typeof createValidCursorSpawnParams>) => ({
            ...params,
            cursorExecution: {
                ...params.cursorExecution,
                unexpectedExecutionState: 'must-not-reach-spawn',
            },
        }), 'Cursor requires a current model and validated launch controls.'],
        ['stale catalog', (params: ReturnType<typeof createValidCursorSpawnParams>) => ({
            ...params,
            cursorExecution: { ...params.cursorExecution!, catalogVersion: 'stale-catalog' },
        }), 'Cursor capability selection rejected: expired.'],
        ['non-account model', (params: ReturnType<typeof createValidCursorSpawnParams>) => ({
            ...params,
            cursorExecution: { ...params.cursorExecution!, model: 'not-account-visible' },
        }), 'Cursor capability selection rejected: unsupported_selection.'],
        ['foreign provider control', (params: ReturnType<typeof createValidCursorSpawnParams>) => ({
            ...params,
            permissionMode: 'workspace-write',
        }), 'Cursor launch controls must not use the generic permissionMode field.'],
    ] as const)('rejects %s before spawn', async (_caseName, mutateParams, expectedError) => {
        const harness = await createRpcHarness();
        const params = mutateParams(createValidCursorSpawnParams(createValidCursorExecution(harness.cursorSnapshot)));

        await expectRpcError(harness, 'spawn-remcli-session', params, expectedError);
        expect(harness.cursorValidateSelectionSpy).toHaveBeenCalledTimes(expectedError.startsWith('Cursor capability') ? 1 : 0);
    });
});
