/**
 * Product-boundary Codex lifecycle gate.
 *
 * The phone-side encrypted RPC, real P2P server, daemon SessionManager, tmux
 * runner and compiled CLI remain live. Only the documented Codex app-server
 * endpoint is controlled so this deterministic test never spends provider quota.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient, type Socket } from 'socket.io-client';

import {
    startControlledCodexAppServer,
    type ControlledCodexAppServer,
} from './controlledCodexAppServer';
import { calculateRequestProofMac } from '@/daemon/p2p/p2pRequestProof';

const SOCKET_TIMEOUT_MS = 8_000;
const RPC_REGISTRATION_TIMEOUT_MS = 8_000;
const RPC_REGISTRATION_RETRY_MS = 50;
const LIFECYCLE_TIMEOUT_MS = 45_000;
const TEST_MACHINE_ID = 'controlled-codex-machine-rpc';
// Deliberately differs from Remcli's local Luna/xhigh default so this gate
// proves the daemon forwards the provider-discovered capability selection.
const FIXTURE_MODEL = 'gpt-5.6-terra';
const FIXTURE_REASONING_EFFORT = 'high';
const TEST_NATIVE_THREAD_ID = 'controlled-codex-native-thread';
const FIRST_CONTEXT_PROMPT = 'fixture seed context';
const RESUME_CONTEXT_PROMPT = 'fixture resume context';
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI_ARTIFACT_SNAPSHOT_ATTEMPTS = 30;
const CLI_ARTIFACT_SNAPSHOT_RETRY_MS = 250;

interface RpcCallAck {
    ok: boolean;
    result?: string;
    error?: string;
}

interface SpawnResult {
    type: string;
    sessionId?: string;
}

interface CodexCapabilitySelection {
    catalogVersion: string;
    model: string;
    reasoningEffort: string;
    permissionMode: string;
}

interface CleanupTask {
    label: string;
    run: () => void | Promise<void>;
}

interface PhoneAssistantMessage {
    sessionId: string;
    text: string;
}

interface LifecycleHarness {
    fixture: ControlledCodexAppServer;
    callMachineRpc: (method: string, params: unknown) => Promise<unknown>;
    sendPhonePrompt: (sessionId: string, text: string) => void;
    getChildren: () => Array<{ remcliSessionId?: string }>;
    getPhoneAssistantTexts: (sessionId: string) => string[];
    close: () => Promise<void>;
}

let remcliHomeDir: string;
let originalEnvironment: Record<string, string | undefined>;
let harness: LifecycleHarness | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRpcCallAck(value: unknown): value is RpcCallAck {
    return isRecord(value)
        && typeof value.ok === 'boolean'
        && (value.result === undefined || typeof value.result === 'string')
        && (value.error === undefined || typeof value.error === 'string');
}

function isSpawnResult(value: unknown): value is SpawnResult {
    return isRecord(value)
        && typeof value.type === 'string'
        && (value.sessionId === undefined || typeof value.sessionId === 'string');
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

function toError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

async function createCliArtifactSnapshot(): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt < CLI_ARTIFACT_SNAPSHOT_ATTEMPTS; attempt += 1) {
        const artifactRoot = mkdtempSync(join(PACKAGE_ROOT, '.remcli-controlled-codex-artifact-'));

        try {
            cpSync(join(PACKAGE_ROOT, 'bin'), join(artifactRoot, 'bin'), { recursive: true });
            cpSync(join(PACKAGE_ROOT, 'dist'), join(artifactRoot, 'dist'), { recursive: true });
            copyFileSync(join(PACKAGE_ROOT, 'package.json'), join(artifactRoot, 'package.json'));

            if (!existsSync(join(artifactRoot, 'dist', 'index.mjs'))) {
                throw new Error('Controlled Codex CLI artifact snapshot is missing dist/index.mjs.');
            }

            return artifactRoot;
        } catch (error) {
            lastError = error;
            rmSync(artifactRoot, { recursive: true, force: true });
        }

        await new Promise<void>((resolve) => setTimeout(resolve, CLI_ARTIFACT_SNAPSHOT_RETRY_MS));
    }

    throw lastError instanceof Error
        ? lastError
        : new Error('Unable to create an isolated controlled Codex CLI artifact snapshot.');
}

function readCodexCapabilitySelection(value: unknown): CodexCapabilitySelection {
    if (!isRecord(value) || value.status !== 'ready') {
        throw new Error('Controlled Codex capability response is not ready.');
    }

    const catalogVersion = readString(value.catalogVersion);
    const models = Array.isArray(value.models) ? value.models.filter(isRecord) : [];
    const selectedModel = models.find((model) => model.isDefault === true);
    const model = selectedModel ? readString(selectedModel.id) : null;
    const reasoningEffort = selectedModel ? readString(selectedModel.defaultReasoningEffort) : null;
    const supportedReasoningEfforts = selectedModel && Array.isArray(selectedModel.supportedReasoningEfforts)
        ? selectedModel.supportedReasoningEfforts.filter((item): item is string => typeof item === 'string')
        : [];
    const permissionModes = Array.isArray(value.permissionModes)
        ? value.permissionModes.filter((item): item is string => typeof item === 'string')
        : [];
    const approvalPolicies = Array.isArray(value.approvalPolicies)
        ? value.approvalPolicies.filter((item): item is string => typeof item === 'string')
        : [];
    const permissionMode = permissionModes.find((item) => item === 'read-only');

    if (!catalogVersion || !model || !reasoningEffort || !supportedReasoningEfforts.includes(reasoningEffort)) {
        throw new Error('Controlled Codex capability response did not expose a default model with a valid reasoning effort.');
    }
    if (!permissionMode || !approvalPolicies.includes('on-request')) {
        throw new Error('Controlled Codex capability response did not expose the read-only permission profile.');
    }

    return {
        catalogVersion,
        model,
        reasoningEffort,
        permissionMode,
    };
}

async function runCleanupTasks(
    runnerCleanup: (() => Promise<void>) | null,
    cleanupTasks: CleanupTask[],
): Promise<void> {
    const errors: Error[] = [];
    const run = async (label: string, task: () => void | Promise<void>): Promise<void> => {
        try {
            await task();
        } catch (error) {
            errors.push(new Error(`${label}: ${toError(error).message}`));
        }
    };

    if (runnerCleanup) {
        await run('daemon-owned Codex runner cleanup', runnerCleanup);
    }
    for (const cleanupTask of [...cleanupTasks].reverse()) {
        await run(cleanupTask.label, cleanupTask.run);
    }

    if (errors.length > 0) {
        throw new AggregateError(
            errors,
            `Controlled Codex lifecycle cleanup failed: ${errors.map((error) => error.message).join('; ')}`,
        );
    }
}

function waitForCondition(
    condition: () => boolean,
    description: string,
    timeoutMs: number = SOCKET_TIMEOUT_MS,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = (): void => {
            if (condition()) {
                resolve();
                return;
            }
            if (Date.now() >= deadline) {
                reject(new Error(`Timed out waiting for ${description}.`));
                return;
            }
            setTimeout(poll, 25);
        };
        poll();
    });
}

function createSocketConnection(port: number, bearerToken: string): Promise<Socket> {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
        auth: {
            token: bearerToken,
            clientType: 'user-scoped',
        },
        path: '/v1/updates',
        reconnection: false,
        transports: ['websocket'],
        timeout: SOCKET_TIMEOUT_MS,
    });

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Timed out connecting controlled Codex phone socket.'));
        }, SOCKET_TIMEOUT_MS);
        const onConnect = (): void => {
            clearTimeout(timeout);
            socket.off('connect_error', onError);
            resolve(socket);
        };
        const onError = (error: Error): void => {
            clearTimeout(timeout);
            socket.off('connect', onConnect);
            socket.close();
            reject(error);
        };
        socket.once('connect', onConnect);
        socket.once('connect_error', onError);
    });
}

function signSocketMutation(
    authSecret: Uint8Array,
    operation: string,
    payload: Record<string, unknown>,
): Record<string, unknown> {
    const id = randomUUID();
    const mac = calculateRequestProofMac(authSecret, {
        v: 1,
        transport: 'socket',
        operation,
        requestId: id,
        payload,
    });
    if (!mac) {
        throw new Error('Could not create a controlled Codex request proof.');
    }

    return { ...payload, proof: { v: 1, id, mac } };
}

async function emitRpcCall(
    socket: Socket,
    authSecret: Uint8Array,
    method: string,
    params: string,
): Promise<RpcCallAck> {
    const payload = { method, params };
    const response = await socket
        .timeout(SOCKET_TIMEOUT_MS)
        .emitWithAck('rpc-call', signSocketMutation(authSecret, 'rpc-call', payload)) as unknown;
    if (!isRpcCallAck(response)) {
        throw new Error('Controlled Codex machine RPC returned an invalid acknowledgement.');
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
    return lastResponse ?? { ok: false, error: `No acknowledgement received for ${method}.` };
}

function getAssistantText(value: unknown): string | null {
    if (!isRecord(value) || value.role !== 'agent' || !isRecord(value.content)) {
        return null;
    }
    if (value.content.type !== 'codex' || !isRecord(value.content.data)) {
        return null;
    }
    return value.content.data.type === 'message'
        ? readString(value.content.data.message)
        : null;
}

function createSpawnParams(
    selection: CodexCapabilitySelection,
    resumeSessionId?: string,
): Record<string, unknown> {
    return {
        type: 'spawn-in-directory',
        machineId: TEST_MACHINE_ID,
        directory: process.cwd(),
        approvedNewDirectoryCreation: false,
        agent: 'codex',
        token: 'controlled-codex-phone-token',
        permissionMode: selection.permissionMode,
        codexExecution: {
            model: selection.model,
            reasoningEffort: selection.reasoningEffort,
            catalogVersion: selection.catalogVersion,
        },
        ...(resumeSessionId ? {
            resumeSessionId,
            resumeSessionName: 'Controlled Codex native thread',
        } : {}),
    };
}

async function createLifecycleHarness(): Promise<LifecycleHarness> {
    let runnerCleanup: (() => Promise<void>) | null = null;
    let closePromise: Promise<void> | null = null;
    const cleanupTasks: CleanupTask[] = [];
    const close = async (): Promise<void> => {
        if (!closePromise) {
            closePromise = runCleanupTasks(runnerCleanup, cleanupTasks);
        }
        await closePromise;
    };

    try {
        const artifactRoot = await createCliArtifactSnapshot();
        cleanupTasks.push({
            label: 'isolated controlled Codex CLI artifact',
            run: () => rmSync(artifactRoot, { recursive: true, force: true }),
        });
        const fixture = await startControlledCodexAppServer({
            model: FIXTURE_MODEL,
            reasoningEffort: FIXTURE_REASONING_EFFORT,
            nativeThreadId: TEST_NATIVE_THREAD_ID,
        });
        cleanupTasks.push({ label: 'controlled Codex app-server fixture', run: () => fixture.close() });
        const encryption = await import('@/api/encryption');
        const { configuration } = await import('@/configuration');
        const { writeDaemonState, updateSettings } = await import('@/persistence');
        const { CodexCapabilitiesService } = await import('@/codex/codexCapabilities');
        const { CursorCapabilitiesService } = await import('@/cursor/cursorCapabilities');
        const { createSessionManager } = await import('@/daemon/sessionSpawner');
        const { startDaemonControlServer } = await import('@/daemon/controlServer');
        const { bootstrapMachineSocket } = await import('@/daemon/machineSocket');
        const { PairingRekeyCoordinator } = await import('@/daemon/p2p/pairingRekey');
        const { deriveBearerToken, generateSharedSecret } = await import('@/daemon/p2p/p2pAuth');
        const { replacePairing } = await import('@/daemon/p2p/p2pPairing');
        const { P2PRunnerCredentialStore } = await import('@/daemon/p2p/p2pRunnerCredentials');
        const { startP2PServer } = await import('@/daemon/p2p/p2pServer');
        const { P2PStore } = await import('@/daemon/p2p/p2pStore');

        const authSecret = generateSharedSecret();
        const contentSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(authSecret);
        const store = new P2PStore({ kvFilePath: null });
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        store.getOrCreateMachine(
            TEST_MACHINE_ID,
            JSON.stringify({
                host: 'controlled-codex-host',
                platform: process.platform,
                remcliCliVersion: configuration.currentCliVersion,
                homeDir: remcliHomeDir,
                remcliHomeDir,
                remcliLibDir: remcliHomeDir,
            }),
            JSON.stringify({ status: 'running', pid: process.pid, startedAt: Date.now() }),
            null,
        );

        const p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret,
            store,
            runnerCredentialStore,
        });
        cleanupTasks.push({ label: 'controlled P2P server', run: () => p2pServer.stop() });
        replacePairing({
            authSecret,
            contentSecret,
            port: p2pServer.port,
            createdAt: new Date().toISOString(),
        });
        await updateSettings((settings) => ({ ...settings, machineId: TEST_MACHINE_ID }));

        const sessionManager = createSessionManager({
            runnerEntrypointPath: join(artifactRoot, 'dist', 'index.mjs'),
            onSessionStopped: (sessionId) => {
                runnerCredentialStore.revoke(sessionId);
                store.markSessionStopped(sessionId);
            },
        });
        runnerCleanup = () => sessionManager.killAllSessions();
        const pairingRekeyCoordinator = new PairingRekeyCoordinator({
            currentSecrets: () => ({ authSecret, contentSecret }),
            createQrPayload: async () => ({
                qrUrl: 'http://127.0.0.1/terminal/connect#controlled-codex',
                qrDataUrl: 'data:image/png;base64,controlled-codex',
            }),
            rotateAuthSecret: async () => undefined,
        });
        const controlInstanceId = '3d8c88c3-e2e4-4b0c-a4e1-5ff1f4bb2e7c';
        const controlServer = await startDaemonControlServer({
            instanceId: controlInstanceId,
            getChildren: sessionManager.getChildren,
            consumeSessionExecution: sessionManager.consumeSessionExecution,
            stopSession: sessionManager.stopSession,
            spawnSession: sessionManager.spawnSession,
            requestShutdown: () => undefined,
            onRemcliSessionWebhook: sessionManager.onRemcliSessionWebhook,
            issueSessionRunnerCredential: (sessionId, owner) => runnerCredentialStore.issue(sessionId, owner),
            verifySessionRunnerCredential: (sessionId, credential) => runnerCredentialStore.verify(sessionId, credential),
            bindNativeCodexThread: sessionManager.bindNativeCodexThread,
            bindNativeCursorSession: sessionManager.bindNativeCursorSession,
            preflightCursorRunner: sessionManager.preflightCursorRunner,
            // The integration owns the runner pane but intentionally does not open
            // Terminal.app or a second native Codex TUI while testing its control RPC.
            openCodexRemoteTui: async (request) => ({
                type: 'already-open',
                wrapper: {
                    agent: 'codex',
                    nativeThreadId: request.nativeThreadId,
                    remcliSessionId: request.remcliSessionId,
                },
                tmuxWindowId: '@controlled-codex-tui',
            }),
            approvePairingRekey: async () => ({ type: 'not-found' }),
        });
        cleanupTasks.push({ label: 'controlled daemon control server', run: () => controlServer.stop() });
        writeDaemonState({
            schemaVersion: 1,
            instanceId: controlInstanceId,
            state: 'running',
            stateReason: 'ready',
            pid: process.pid,
            httpPort: controlServer.port,
            p2pPort: p2pServer.port,
            p2pHost: '127.0.0.1',
            startedAtMs: Date.now(),
            startedWithCliVersion: configuration.currentCliVersion,
            codexAppServerEndpoint: fixture.endpoint,
            codexAppServerPid: process.pid,
            ownedChildPids: [],
        });

        const codexCapabilities = new CodexCapabilitiesService({
            getAppServerState: () => ({
                codexAppServerEndpoint: fixture.endpoint,
                codexAppServerPid: process.pid,
            }),
        });
        const cursorCapabilities = new CursorCapabilitiesService({
            readModelList: async () => ({
                executable: 'agent',
                output: [
                    'Available models',
                    '',
                    'auto - Auto (default)',
                    '',
                    'Tip: use --model <id> to switch.',
                ].join('\n'),
            }),
        });
        const machineSocket = bootstrapMachineSocket({
            p2pPort: p2pServer.port,
            machineId: TEST_MACHINE_ID,
            bearerToken,
            authSecret,
            contentSecret,
            pairingRekeyCoordinator,
            codexCapabilities,
            cursorCapabilities,
            spawnSession: sessionManager.spawnSession,
            stopSession: sessionManager.stopSession,
            getSessionExecution: sessionManager.getSessionExecution,
            getSessionExecutionState: sessionManager.getSessionExecutionState,
            setSessionExecution: sessionManager.setSessionExecution,
            requestShutdown: () => undefined,
        });
        cleanupTasks.push({ label: 'controlled machine socket', run: () => machineSocket.close() });
        const appSocket = await createSocketConnection(p2pServer.port, bearerToken);
        cleanupTasks.push({ label: 'controlled phone socket', run: () => appSocket.close() });
        const phoneAssistantMessages: PhoneAssistantMessage[] = [];
        appSocket.on('update', (update: unknown) => {
            const body = isRecord(update) && isRecord(update.body) ? update.body : null;
            const sessionId = body ? readString(body.sid) : null;
            const message = body?.t === 'new-message' && isRecord(body.message) ? body.message : null;
            const encryptedContent = message && isRecord(message.content) && message.content.t === 'encrypted'
                ? readString(message.content.c)
                : null;
            if (!encryptedContent) return;

            try {
                const text = getAssistantText(encryption.decrypt(
                    contentSecret,
                    'legacy',
                    encryption.decodeBase64(encryptedContent),
                ));
                if (text && sessionId) {
                    phoneAssistantMessages.push({ sessionId, text });
                }
            } catch {
                // This phone socket also sees other encrypted test events. Only a
                // valid Codex agent message is relevant to this lifecycle assertion.
            }
        });

        const callMachineRpc = async (method: string, params: unknown): Promise<unknown> => {
            const encryptedParams = encryption.encodeBase64(encryption.encrypt(contentSecret, 'legacy', params));
            const response = await emitRpcCallWhenRegistered(
                appSocket,
                authSecret,
                `${TEST_MACHINE_ID}:${method}`,
                encryptedParams,
            );
            if (!response.ok || !response.result) {
                throw new Error(response.error ?? `Controlled Codex RPC ${method} did not return an encrypted result.`);
            }
            return encryption.decrypt(
                contentSecret,
                'legacy',
                encryption.decodeBase64(response.result),
            );
        };

        return {
            fixture,
            callMachineRpc,
            sendPhonePrompt: (sessionId, text) => {
                const payload = {
                    sid: sessionId,
                    message: encryption.encodeBase64(encryption.encrypt(contentSecret, 'legacy', {
                        role: 'user',
                        content: { type: 'text', text },
                        meta: { sentFrom: 'phone' },
                    })),
                };
                appSocket.emit('message', signSocketMutation(authSecret, 'message', payload));
            },
            getChildren: () => sessionManager.getChildren(),
            getPhoneAssistantTexts: (sessionId) => phoneAssistantMessages
                .filter((message) => message.sessionId === sessionId)
                .map((message) => message.text),
            close,
        };
    } catch (error) {
        try {
            await close();
        } catch (cleanupError) {
            throw new AggregateError(
                [toError(error), toError(cleanupError)],
                'Controlled Codex lifecycle harness failed during setup and cleanup.',
            );
        }
        throw error;
    }
}

beforeEach(() => {
    originalEnvironment = {
        REMCLI_HOME_DIR: process.env.REMCLI_HOME_DIR,
        REMCLI_DISABLE_CAFFEINATE: process.env.REMCLI_DISABLE_CAFFEINATE,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
    };
    remcliHomeDir = mkdtempSync(join(tmpdir(), 'remcli-controlled-codex-lifecycle-'));
    process.env.REMCLI_HOME_DIR = remcliHomeDir;
    process.env.REMCLI_DISABLE_CAFFEINATE = '1';
    process.env.HOME = remcliHomeDir;
    process.env.USERPROFILE = remcliHomeDir;
});

afterEach(async () => {
    let cleanupError: unknown;
    try {
        await harness?.close();
    } catch (error) {
        cleanupError = error;
    } finally {
        harness = null;

        for (const [key, value] of Object.entries(originalEnvironment)) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
        rmSync(remcliHomeDir, { recursive: true, force: true });
        vi.resetModules();
    }
    if (cleanupError) throw cleanupError;
});

describe('Codex encrypted machine RPC lifecycle', { timeout: LIFECYCLE_TIMEOUT_MS }, () => {
    it('creates, guards, stops and resumes one native Codex thread through the daemon-owned runner', async () => {
        harness = await createLifecycleHarness();
        const capabilitySnapshot = await harness.callMachineRpc('get-codex-capabilities', {});
        expect(capabilitySnapshot).toMatchObject({
            agent: 'codex',
            status: 'ready',
            models: [{
                id: FIXTURE_MODEL,
                defaultReasoningEffort: FIXTURE_REASONING_EFFORT,
                supportedReasoningEfforts: [FIXTURE_REASONING_EFFORT],
                isDefault: true,
            }],
            permissionModes: ['read-only'],
            approvalPolicies: ['on-request'],
        });
        const selection = readCodexCapabilitySelection(capabilitySnapshot);
        expect(selection).toEqual({
            catalogVersion: expect.any(String),
            model: FIXTURE_MODEL,
            reasoningEffort: FIXTURE_REASONING_EFFORT,
            permissionMode: 'read-only',
        });

        const spawned = await harness.callMachineRpc(
            'spawn-remcli-session',
            createSpawnParams(selection),
        );
        expect(isSpawnResult(spawned)).toBe(true);
        expect(spawned).toEqual({
            type: 'success',
            sessionId: expect.any(String),
            terminal: { type: 'not-requested' },
        });
        if (!isSpawnResult(spawned) || !spawned.sessionId) {
            throw new Error('Controlled Codex initial spawn did not return a Remcli session ID.');
        }
        const firstRemcliSessionId = spawned.sessionId;

        harness.sendPhonePrompt(firstRemcliSessionId, FIRST_CONTEXT_PROMPT);
        await waitForCondition(
            () => harness!.fixture.getRequests('turn/start').length === 1,
            'the initial Codex native turn to start',
        );
        await waitForCondition(
            () => harness!.getPhoneAssistantTexts(firstRemcliSessionId).includes(`fixture accepted: ${FIRST_CONTEXT_PROMPT}`),
            'the initial Codex phone response',
        );

        const duplicateResume = await harness.callMachineRpc(
            'spawn-remcli-session',
            createSpawnParams(selection, TEST_NATIVE_THREAD_ID),
        );
        expect(duplicateResume).toEqual({
            type: 'success',
            sessionId: firstRemcliSessionId,
            terminal: { type: 'not-requested' },
        });
        expect(harness.getChildren()).toHaveLength(1);
        expect(harness.fixture.getRequests('thread/resume')).toHaveLength(0);

        const stopped = await harness.callMachineRpc('stop-session', { sessionId: firstRemcliSessionId });
        expect(stopped).toEqual({ message: 'Session stopped', sessionId: firstRemcliSessionId });
        await waitForCondition(
            () => harness!.getChildren().length === 0,
            'the first daemon-owned Codex runner to stop',
            LIFECYCLE_TIMEOUT_MS,
        );

        const resumed = await harness.callMachineRpc(
            'spawn-remcli-session',
            createSpawnParams(selection, TEST_NATIVE_THREAD_ID),
        );
        expect(isSpawnResult(resumed)).toBe(true);
        expect(resumed).toEqual({
            type: 'success',
            sessionId: expect.any(String),
            terminal: { type: 'not-requested' },
        });
        if (!isSpawnResult(resumed) || !resumed.sessionId) {
            throw new Error('Controlled Codex resume did not return a Remcli session ID.');
        }
        const resumedRemcliSessionId = resumed.sessionId;
        expect(resumedRemcliSessionId).not.toBe(firstRemcliSessionId);

        harness.sendPhonePrompt(resumedRemcliSessionId, RESUME_CONTEXT_PROMPT);
        await waitForCondition(
            () => harness!.fixture.getRequests('turn/start').length === 2,
            'the resumed Codex native turn to start',
        );
        await waitForCondition(
            () => harness!.getPhoneAssistantTexts(resumedRemcliSessionId).includes('fixture resume context preserved'),
            'the resumed Codex phone response',
        );

        expect(harness.fixture.protocolViolations).toEqual([]);
        expect(harness.fixture.getRequests('thread/start')).toHaveLength(1);
        expect(harness.fixture.getRequests('thread/resume')).toHaveLength(1);
        expect(harness.fixture.getRequests('turn/start')).toHaveLength(2);
        expect(harness.fixture.getRequests('thread/start')[0]?.params).toEqual({
            cwd: process.cwd(),
            sandbox: 'read-only',
            approvalPolicy: 'on-request',
            ephemeral: false,
            model: FIXTURE_MODEL,
        });
        expect(harness.fixture.getRequests('thread/resume')[0]?.params).toEqual({
            threadId: TEST_NATIVE_THREAD_ID,
            cwd: process.cwd(),
            sandbox: 'read-only',
            approvalPolicy: 'on-request',
            model: FIXTURE_MODEL,
        });

        const stoppedResumed = await harness.callMachineRpc('stop-session', { sessionId: resumedRemcliSessionId });
        expect(stoppedResumed).toEqual({ message: 'Session stopped', sessionId: resumedRemcliSessionId });
        await waitForCondition(
            () => harness!.getChildren().length === 0,
            'the resumed daemon-owned Codex runner to stop',
            LIFECYCLE_TIMEOUT_MS,
        );
    });
});
