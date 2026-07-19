/**
 * Product-boundary Cursor lifecycle gate.
 *
 * Phone-side encrypted RPC, real P2P, daemon SessionManager, tmux runner and
 * compiled CLI remain live. Only `agent` is replaced with a controlled local
 * executable, so this gate validates Cursor's CLI contract without provider
 * credentials or quota.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient, type Socket } from 'socket.io-client';

import {
    createControlledCursorAgent,
    type ControlledCursorAgent,
} from './controlledCursorAgent';

const SOCKET_TIMEOUT_MS = 8_000;
const RPC_REGISTRATION_TIMEOUT_MS = 8_000;
const RPC_REGISTRATION_RETRY_MS = 50;
const LIFECYCLE_TIMEOUT_MS = 45_000;
const TEST_MACHINE_ID = 'controlled-cursor-machine-rpc';
const FIXTURE_MODEL = 'controlled-cursor-model';
const TEST_NATIVE_SESSION_ID = 'controlled-cursor-native-session';
const FIRST_CONTEXT_PROMPT = 'fixture seed context';
const ACTIVE_STOP_PROMPT = 'fixture active Cursor turn to stop';
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

interface CleanupTask {
    label: string;
    run: () => void | Promise<void>;
}

interface PhoneAssistantMessage {
    sessionId: string;
    text: string;
}

interface LifecycleHarness {
    fixture: ControlledCursorAgent;
    callMachineRpc: (method: string, params: unknown) => Promise<unknown>;
    getChildren: () => Array<{ remcliSessionId?: string }>;
    getPhoneAssistantTexts: (sessionId: string) => string[];
    probeAcknowledgedRunnerReconnect: (sessionId: string) => Promise<number[]>;
    sendPhonePrompt: (sessionId: string, text: string) => void;
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
        const artifactRoot = mkdtempSync(join(PACKAGE_ROOT, '.remcli-controlled-cursor-artifact-'));

        try {
            cpSync(join(PACKAGE_ROOT, 'bin'), join(artifactRoot, 'bin'), { recursive: true });
            cpSync(join(PACKAGE_ROOT, 'dist'), join(artifactRoot, 'dist'), { recursive: true });
            copyFileSync(join(PACKAGE_ROOT, 'package.json'), join(artifactRoot, 'package.json'));

            if (!existsSync(join(artifactRoot, 'dist', 'index.mjs'))) {
                throw new Error('Controlled Cursor CLI artifact snapshot is missing dist/index.mjs.');
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
        : new Error('Unable to create an isolated controlled Cursor CLI artifact snapshot.');
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
        await run('daemon-owned Cursor runner cleanup', runnerCleanup);
    }
    for (const cleanupTask of [...cleanupTasks].reverse()) {
        await run(cleanupTask.label, cleanupTask.run);
    }

    if (errors.length > 0) {
        throw new AggregateError(
            errors,
            `Controlled Cursor lifecycle cleanup failed: ${errors.map((error) => error.message).join('; ')}`,
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

interface SocketAuthentication {
    token: string;
    clientType: 'session-scoped' | 'user-scoped';
    sessionId?: string;
    messageAckVersion?: number;
    runnerCredential?: string;
}

function createSocketConnection(
    port: number,
    auth: SocketAuthentication,
    onUpdate?: (update: unknown) => void,
): Promise<Socket> {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
        auth,
        path: '/v1/updates',
        reconnection: false,
        transports: ['websocket'],
        timeout: SOCKET_TIMEOUT_MS,
    });

    if (onUpdate) {
        socket.on('update', onUpdate);
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Timed out connecting controlled Cursor phone socket.'));
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

async function emitRpcCall(socket: Socket, method: string, params: string): Promise<RpcCallAck> {
    const response = await socket
        .timeout(SOCKET_TIMEOUT_MS)
        .emitWithAck('rpc-call', { method, params }) as unknown;
    if (!isRpcCallAck(response)) {
        throw new Error('Controlled Cursor machine RPC returned an invalid acknowledgement.');
    }
    return response;
}

async function emitRpcCallWhenRegistered(socket: Socket, method: string, params: string): Promise<RpcCallAck> {
    const deadline = Date.now() + RPC_REGISTRATION_TIMEOUT_MS;
    let lastResponse: RpcCallAck | null = null;
    while (Date.now() < deadline) {
        lastResponse = await emitRpcCall(socket, method, params);
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
    if (value.content.type !== 'acp' || value.content.provider !== 'cursor' || !isRecord(value.content.data)) {
        return null;
    }
    return value.content.data.type === 'message'
        ? readString(value.content.data.message)
        : null;
}

function createSpawnParams(resumeSessionId?: string): Record<string, unknown> {
    return {
        type: 'spawn-in-directory',
        machineId: TEST_MACHINE_ID,
        directory: process.cwd(),
        approvedNewDirectoryCreation: false,
        agent: 'cursor',
        permissionMode: 'agent',
        ...(resumeSessionId ? {
            resumeSessionId,
            resumeSessionName: 'Controlled Cursor native session',
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
        const fixture = createControlledCursorAgent({
            firstContextPrompt: FIRST_CONTEXT_PROMPT,
            holdPrompt: ACTIVE_STOP_PROMPT,
            nativeSessionId: TEST_NATIVE_SESSION_ID,
            resumeContextPrompt: RESUME_CONTEXT_PROMPT,
        });
        cleanupTasks.push({ label: 'controlled Cursor Agent fixture', run: () => fixture.close() });
        process.env.PATH = `${fixture.binDir}${delimiter}${process.env.PATH ?? ''}`;
        process.env.REMCLI_CONTROLLED_CURSOR_STATE_FILE = fixture.stateFile;

        const artifactRoot = await createCliArtifactSnapshot();
        cleanupTasks.push({
            label: 'isolated controlled Cursor CLI artifact',
            run: () => rmSync(artifactRoot, { recursive: true, force: true }),
        });

        const encryption = await import('@/api/encryption');
        const { configuration } = await import('@/configuration');
        const { writeDaemonState, updateSettings } = await import('@/persistence');
        const { CodexCapabilitiesService } = await import('@/codex/codexCapabilities');
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
                host: 'controlled-cursor-host',
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
        const issuedRunnerCredentials = new Map<string, string>();
        const pairingRekeyCoordinator = new PairingRekeyCoordinator({
            currentSecrets: () => ({ authSecret, contentSecret }),
            createQrPayload: async () => ({
                qrUrl: 'http://127.0.0.1/terminal/connect#controlled-cursor',
                qrDataUrl: 'data:image/png;base64,controlled-cursor',
            }),
            rotateAuthSecret: async () => undefined,
        });
        const controlServer = await startDaemonControlServer({
            getChildren: sessionManager.getChildren,
            stopSession: sessionManager.stopSession,
            spawnSession: sessionManager.spawnSession,
            requestShutdown: () => undefined,
            onRemcliSessionWebhook: sessionManager.onRemcliSessionWebhook,
            issueSessionRunnerCredential: (sessionId, owner) => {
                const credential = runnerCredentialStore.issue(sessionId, owner);
                if (credential) {
                    issuedRunnerCredentials.set(sessionId, credential);
                }
                return credential;
            },
            verifySessionRunnerCredential: (sessionId, credential) => runnerCredentialStore.verify(sessionId, credential),
            bindNativeCodexThread: sessionManager.bindNativeCodexThread,
            bindNativeCursorSession: sessionManager.bindNativeCursorSession,
            preflightCursorRunner: sessionManager.preflightCursorRunner,
            openCodexRemoteTui: async (request) => ({
                type: 'already-open',
                wrapper: {
                    agent: 'codex',
                    nativeThreadId: request.nativeThreadId,
                    remcliSessionId: request.remcliSessionId,
                },
                tmuxWindowId: '@controlled-cursor-tui',
            }),
            approvePairingRekey: async () => ({ type: 'not-found' }),
        });
        cleanupTasks.push({ label: 'controlled daemon control server', run: () => controlServer.stop() });
        writeDaemonState({
            pid: process.pid,
            httpPort: controlServer.port,
            p2pPort: p2pServer.port,
            p2pHost: '127.0.0.1',
            startTime: new Date().toISOString(),
            startedWithCliVersion: configuration.currentCliVersion,
        });

        const codexCapabilities = new CodexCapabilitiesService({ getAppServerState: () => null });
        const machineSocket = bootstrapMachineSocket({
            p2pPort: p2pServer.port,
            machineId: TEST_MACHINE_ID,
            bearerToken,
            contentSecret,
            pairingRekeyCoordinator,
            codexCapabilities,
            spawnSession: sessionManager.spawnSession,
            stopSession: sessionManager.stopSession,
            requestShutdown: () => undefined,
        });
        cleanupTasks.push({ label: 'controlled machine socket', run: () => machineSocket.close() });
        const appSocket = await createSocketConnection(p2pServer.port, {
            token: bearerToken,
            clientType: 'user-scoped',
        });
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
                // The socket also receives unrelated encrypted session events.
            }
        });

        const callMachineRpc = async (method: string, params: unknown): Promise<unknown> => {
            const encryptedParams = encryption.encodeBase64(encryption.encrypt(contentSecret, 'legacy', params));
            const response = await emitRpcCallWhenRegistered(
                appSocket,
                `${TEST_MACHINE_ID}:${method}`,
                encryptedParams,
            );
            if (!response.ok || !response.result) {
                throw new Error(response.error ?? `Controlled Cursor RPC ${method} did not return an encrypted result.`);
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
            getChildren: () => sessionManager.getChildren(),
            getPhoneAssistantTexts: (sessionId) => phoneAssistantMessages
                .filter((message) => message.sessionId === sessionId)
                .map((message) => message.text),
            probeAcknowledgedRunnerReconnect: async (sessionId) => {
                const runnerCredential = issuedRunnerCredentials.get(sessionId);
                if (!runnerCredential) {
                    throw new Error(`Controlled Cursor runner credential was not issued for ${sessionId}.`);
                }

                const replayedDeliverySequences: number[] = [];
                const probeSocket = await createSocketConnection(
                    p2pServer.port,
                    {
                        token: bearerToken,
                        clientType: 'session-scoped',
                        sessionId,
                        messageAckVersion: 1,
                        runnerCredential,
                    },
                    (update) => {
                        const body = isRecord(update) && isRecord(update.body) ? update.body : null;
                        const message = body?.t === 'new-message' && isRecord(body.message) ? body.message : null;
                        const sequence = message?.seq;
                        if (body?.sid === sessionId && typeof sequence === 'number') {
                            replayedDeliverySequences.push(sequence);
                        }
                    },
                );
                try {
                    await new Promise((resolve) => setTimeout(resolve, 250));
                    return replayedDeliverySequences;
                } finally {
                    probeSocket.close();
                }
            },
            sendPhonePrompt: (sessionId, text) => {
                appSocket.emit('message', {
                    sid: sessionId,
                    message: encryption.encodeBase64(encryption.encrypt(contentSecret, 'legacy', {
                        role: 'user',
                        content: { type: 'text', text },
                        meta: {
                            sentFrom: 'phone',
                            permissionMode: 'agent',
                            model: FIXTURE_MODEL,
                        },
                    })),
                });
            },
            close,
        };
    } catch (error) {
        try {
            await close();
        } catch (cleanupError) {
            throw new AggregateError(
                [toError(error), toError(cleanupError)],
                'Controlled Cursor lifecycle harness failed during setup and cleanup.',
            );
        }
        throw error;
    }
}

beforeEach(() => {
    originalEnvironment = {
        REMCLI_HOME_DIR: process.env.REMCLI_HOME_DIR,
        REMCLI_DISABLE_CAFFEINATE: process.env.REMCLI_DISABLE_CAFFEINATE,
        REMCLI_CONTROLLED_CURSOR_STATE_FILE: process.env.REMCLI_CONTROLLED_CURSOR_STATE_FILE,
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        USERPROFILE: process.env.USERPROFILE,
    };
    remcliHomeDir = mkdtempSync(join(tmpdir(), 'remcli-controlled-cursor-lifecycle-'));
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

describe('Cursor encrypted machine RPC lifecycle', { timeout: LIFECYCLE_TIMEOUT_MS }, () => {
    it('creates, guards, stops and resumes one native Cursor session through the daemon-owned runner', async () => {
        harness = await createLifecycleHarness();

        const spawned = await harness.callMachineRpc('spawn-remcli-session', createSpawnParams());
        expect(isSpawnResult(spawned)).toBe(true);
        expect(spawned).toEqual({ type: 'success', sessionId: expect.any(String) });
        if (!isSpawnResult(spawned) || !spawned.sessionId) {
            throw new Error('Controlled Cursor initial spawn did not return a Remcli session ID.');
        }
        const firstRemcliSessionId = spawned.sessionId;

        harness.sendPhonePrompt(firstRemcliSessionId, FIRST_CONTEXT_PROMPT);
        await waitForCondition(
            () => harness!.fixture.getInvocations().length === 1,
            'the initial Cursor native turn to start',
        );
        await waitForCondition(
            () => harness!.getPhoneAssistantTexts(firstRemcliSessionId).includes(`fixture accepted: ${FIRST_CONTEXT_PROMPT}`),
            'the initial Cursor phone response',
        );

        expect(harness.fixture.getInvocations()).toEqual([{
            args: ['--print', '--output-format', 'stream-json', '--trust', '--model', FIXTURE_MODEL, FIRST_CONTEXT_PROMPT],
            prompt: FIRST_CONTEXT_PROMPT,
            sessionId: TEST_NATIVE_SESSION_ID,
        }]);

        // The reconnect probe replaces the live ACK-capable runner socket. A
        // processed phone prompt must not be replayed to that replacement.
        expect(await harness.probeAcknowledgedRunnerReconnect(firstRemcliSessionId)).toEqual([]);
        expect(harness.fixture.getInvocations()).toHaveLength(1);

        const duplicateResume = await harness.callMachineRpc(
            'spawn-remcli-session',
            createSpawnParams(TEST_NATIVE_SESSION_ID),
        );
        expect(duplicateResume).toEqual({ type: 'success', sessionId: firstRemcliSessionId });
        expect(harness.getChildren()).toHaveLength(1);
        expect(harness.fixture.getInvocations()).toHaveLength(1);

        const stopped = await harness.callMachineRpc('stop-session', { sessionId: firstRemcliSessionId });
        expect(stopped).toEqual({ message: 'Session stopped', sessionId: firstRemcliSessionId });
        await waitForCondition(
            () => harness!.getChildren().length === 0,
            'the first daemon-owned Cursor runner to stop',
            LIFECYCLE_TIMEOUT_MS,
        );

        const resumedForActiveStop = await harness.callMachineRpc(
            'spawn-remcli-session',
            createSpawnParams(TEST_NATIVE_SESSION_ID),
        );
        expect(resumedForActiveStop).toEqual({ type: 'success', sessionId: expect.any(String) });
        if (!isSpawnResult(resumedForActiveStop) || !resumedForActiveStop.sessionId) {
            throw new Error('Controlled Cursor active-stop resume did not return a Remcli session ID.');
        }
        const activeStopRemcliSessionId = resumedForActiveStop.sessionId;
        expect(activeStopRemcliSessionId).not.toBe(firstRemcliSessionId);

        harness.sendPhonePrompt(activeStopRemcliSessionId, ACTIVE_STOP_PROMPT);
        await waitForCondition(
            () => harness!.fixture.getInvocations().length === 2,
            'the active Cursor native turn to start before stop',
        );

        const stoppedActiveTurn = await harness.callMachineRpc('stop-session', { sessionId: activeStopRemcliSessionId });
        expect(stoppedActiveTurn).toEqual({ message: 'Session stopped', sessionId: activeStopRemcliSessionId });
        await waitForCondition(
            () => harness!.getChildren().length === 0,
            'the active daemon-owned Cursor runner to stop',
            LIFECYCLE_TIMEOUT_MS,
        );
        await waitForCondition(
            () => harness!.fixture.getInterruptedPrompts().includes(ACTIVE_STOP_PROMPT),
            'the active Cursor native child to receive a termination signal',
            LIFECYCLE_TIMEOUT_MS,
        );

        const resumed = await harness.callMachineRpc(
            'spawn-remcli-session',
            createSpawnParams(TEST_NATIVE_SESSION_ID),
        );
        expect(isSpawnResult(resumed)).toBe(true);
        expect(resumed).toEqual({ type: 'success', sessionId: expect.any(String) });
        if (!isSpawnResult(resumed) || !resumed.sessionId) {
            throw new Error('Controlled Cursor resume did not return a Remcli session ID.');
        }
        const resumedRemcliSessionId = resumed.sessionId;
        expect(resumedRemcliSessionId).not.toBe(firstRemcliSessionId);

        harness.sendPhonePrompt(resumedRemcliSessionId, RESUME_CONTEXT_PROMPT);
        await waitForCondition(
            () => harness!.fixture.getInvocations().length === 3,
            'the resumed Cursor native turn to start',
        );
        await waitForCondition(
            () => harness!.getPhoneAssistantTexts(resumedRemcliSessionId).includes('fixture resume context preserved'),
            'the resumed Cursor phone response',
        );

        expect(harness.fixture.getProtocolViolations()).toEqual([]);
        expect(harness.fixture.getInvocations()).toEqual([
            {
                args: ['--print', '--output-format', 'stream-json', '--trust', '--model', FIXTURE_MODEL, FIRST_CONTEXT_PROMPT],
                prompt: FIRST_CONTEXT_PROMPT,
                sessionId: TEST_NATIVE_SESSION_ID,
            },
            {
                args: [
                    '--print',
                    '--output-format',
                    'stream-json',
                    '--trust',
                    '--model',
                    FIXTURE_MODEL,
                    '--resume',
                    TEST_NATIVE_SESSION_ID,
                    ACTIVE_STOP_PROMPT,
                ],
                prompt: ACTIVE_STOP_PROMPT,
                resumeSessionId: TEST_NATIVE_SESSION_ID,
                sessionId: TEST_NATIVE_SESSION_ID,
            },
            {
                args: [
                    '--print',
                    '--output-format',
                    'stream-json',
                    '--trust',
                    '--model',
                    FIXTURE_MODEL,
                    '--resume',
                    TEST_NATIVE_SESSION_ID,
                    RESUME_CONTEXT_PROMPT,
                ],
                prompt: RESUME_CONTEXT_PROMPT,
                resumeSessionId: TEST_NATIVE_SESSION_ID,
                sessionId: TEST_NATIVE_SESSION_ID,
            },
        ]);
        expect(harness.fixture.getInterruptedPrompts()).toEqual([ACTIVE_STOP_PROMPT]);

        const stoppedResumed = await harness.callMachineRpc('stop-session', { sessionId: resumedRemcliSessionId });
        expect(stoppedResumed).toEqual({ message: 'Session stopped', sessionId: resumedRemcliSessionId });
        await waitForCondition(
            () => harness!.getChildren().length === 0,
            'the resumed daemon-owned Cursor runner to stop',
            LIFECYCLE_TIMEOUT_MS,
        );
    });
});
