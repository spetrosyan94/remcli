/**
 * Opt-in real Cursor lifecycle gate.
 *
 * The real daemon-owned Remcli runner, tmux session and local Cursor Agent CLI
 * stay live. It uses the existing Cursor login only when explicitly enabled,
 * never queries or changes Cursor account state, and records no native output.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient, type Socket } from 'socket.io-client';
import type { CursorLaunchControls } from '@/cursor/cursorLaunchControls';

const shouldRunRealCursor = process.env.REMCLI_REAL_CURSOR === '1';
const realCursorDescribe = shouldRunRealCursor ? describe : describe.skip;
const REAL_CURSOR_TEST_MODEL = process.env.REMCLI_REAL_CURSOR_MODEL ?? 'gpt-5.6-luna-xhigh';

const SOCKET_TIMEOUT_MS = 8_000;
const RPC_REGISTRATION_TIMEOUT_MS = 8_000;
const RPC_REGISTRATION_RETRY_MS = 50;
const LIFECYCLE_TIMEOUT_MS = 60_000;
const REAL_GATE_TIMEOUT_MS = 180_000;
const TEST_MACHINE_ID = 'real-cursor-lifecycle-machine';
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI_ARTIFACT_SNAPSHOT_ATTEMPTS = 30;
const CLI_ARTIFACT_SNAPSHOT_RETRY_MS = 250;
const RUNNER_DELIVERY_PROBE_WINDOW_MS = 250;
const TEST_SESSION_MESSAGE_ACK_VERSION = 1;
const REAL_CURSOR_LAUNCH_CONTROLS: CursorLaunchControls = {
    executionMode: 'agent',
    force: false,
    autoReview: false,
    sandbox: 'local-configuration',
    approveMcps: false,
};

interface RpcCallAck {
    ok: boolean;
    result?: string;
    error?: string;
}

interface SpawnResult {
    type: string;
    sessionId?: string;
    errorMessage?: string;
}

interface CursorExecution {
    model: string;
    catalogVersion: string;
}

interface CleanupTask {
    label: string;
    run: () => void | Promise<void>;
}

interface LifecycleHarness {
    callMachineRpc: (method: string, params: unknown) => Promise<unknown>;
    cursorExecution: CursorExecution;
    getAssistantMessages: (sessionId: string) => string[];
    getChildrenCount: () => number;
    getExecutionOutcome: (sessionId: string) => 'error' | 'success' | null;
    getNativeCursorSessionId: (sessionId: string) => string | null;
    sendPhonePrompt: (sessionId: string, prompt: string) => void;
    verifyAcknowledgedDelivery: (sessionId: string) => Promise<void>;
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
        && (value.sessionId === undefined || typeof value.sessionId === 'string')
        && (value.errorMessage === undefined || typeof value.errorMessage === 'string');
}

function getSpawnFailureMessage(result: unknown): string {
    if (isSpawnResult(result) && result.type === 'error' && result.errorMessage) {
        return result.errorMessage;
    }
    return 'the daemon returned an invalid spawn result';
}

function isStoppedSession(value: unknown, sessionId: string): boolean {
    return isRecord(value)
        && value.message === 'Session stopped'
        && value.sessionId === sessionId;
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
        const artifactRoot = mkdtempSync(join(PACKAGE_ROOT, '.remcli-real-cursor-artifact-'));

        try {
            cpSync(join(PACKAGE_ROOT, 'bin'), join(artifactRoot, 'bin'), { recursive: true });
            cpSync(join(PACKAGE_ROOT, 'dist'), join(artifactRoot, 'dist'), { recursive: true });
            copyFileSync(join(PACKAGE_ROOT, 'package.json'), join(artifactRoot, 'package.json'));

            if (!existsSync(join(artifactRoot, 'dist', 'index.mjs'))) {
                throw new Error('Real Cursor CLI artifact snapshot is missing dist/index.mjs.');
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
        : new Error('Unable to create an isolated real Cursor CLI artifact snapshot.');
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
        await run('daemon-owned real Cursor runner cleanup', runnerCleanup);
    }
    for (const cleanupTask of [...cleanupTasks].reverse()) {
        await run(cleanupTask.label, cleanupTask.run);
    }

    if (errors.length > 0) {
        throw new AggregateError(
            errors,
            `Real Cursor lifecycle cleanup failed: ${errors.map((error) => error.message).join('; ')}`,
        );
    }
}

function waitForCondition(
    condition: () => boolean,
    description: string,
    timeoutMs: number = LIFECYCLE_TIMEOUT_MS,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = (): void => {
            try {
                if (condition()) {
                    resolve();
                    return;
                }
            } catch (error) {
                reject(toError(error));
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

function createSocketConnection(port: number, auth: SocketAuthentication, onUpdate: (update: unknown) => void): Promise<Socket> {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
        auth,
        path: '/v1/updates',
        reconnection: false,
        transports: ['websocket'],
        timeout: SOCKET_TIMEOUT_MS,
    });
    socket.on('update', onUpdate);

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Timed out connecting the real Cursor lifecycle phone socket.'));
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
        throw new Error('Real Cursor machine RPC returned an invalid acknowledgement.');
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
    return lastResponse ?? { ok: false, error: 'No acknowledgement received for real Cursor machine RPC.' };
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

function createSpawnParams(cursorExecution: CursorExecution, resumeSessionId?: string): Record<string, unknown> {
    return {
        type: 'spawn-in-directory',
        machineId: TEST_MACHINE_ID,
        directory: process.cwd(),
        approvedNewDirectoryCreation: false,
        agent: 'cursor',
        cursorExecution,
        cursorLaunchControls: REAL_CURSOR_LAUNCH_CONTROLS,
        ...(resumeSessionId ? { resumeSessionId, resumeSessionName: 'Real Cursor native session' } : {}),
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
            label: 'isolated real Cursor CLI artifact',
            run: () => rmSync(artifactRoot, { recursive: true, force: true }),
        });

        const encryption = await import('@/api/encryption');
        const { configuration } = await import('@/configuration');
        const { writeDaemonState, updateSettings } = await import('@/persistence');
        const { CodexCapabilitiesService } = await import('@/codex/codexCapabilities');
        const {
            CursorCapabilitiesService,
        } = await import('@/cursor/cursorCapabilities');
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
        const issuedRunnerCredentials = new Map<string, string>();
        store.getOrCreateMachine(
            TEST_MACHINE_ID,
            JSON.stringify({
                host: 'real-cursor-lifecycle-host',
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
        cleanupTasks.push({ label: 'real Cursor P2P server', run: () => p2pServer.stop() });
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
        runnerCleanup = async () => {
            await sessionManager.killAllSessions();
            if (sessionManager.getChildren().length !== 0) {
                throw new Error('Real Cursor daemon-owned tmux runner remained after cleanup.');
            }
        };
        const pairingRekeyCoordinator = new PairingRekeyCoordinator({
            currentSecrets: () => ({ authSecret, contentSecret }),
            createQrPayload: async () => ({
                qrUrl: 'http://127.0.0.1/terminal/connect#real-cursor-lifecycle',
                qrDataUrl: 'data:image/png;base64,real-cursor-lifecycle',
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
                const runnerCredential = runnerCredentialStore.issue(sessionId, owner);
                issuedRunnerCredentials.set(sessionId, runnerCredential);
                return runnerCredential;
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
                tmuxWindowId: '@real-cursor-lifecycle-tui',
            }),
            approvePairingRekey: async () => ({ type: 'not-found' }),
        });
        cleanupTasks.push({ label: 'real Cursor daemon control server', run: () => controlServer.stop() });
        writeDaemonState({
            pid: process.pid,
            httpPort: controlServer.port,
            p2pPort: p2pServer.port,
            p2pHost: '127.0.0.1',
            startTime: new Date().toISOString(),
            startedWithCliVersion: configuration.currentCliVersion,
        });

        const codexCapabilities = new CodexCapabilitiesService({ getAppServerState: () => null });
        const cursorCapabilities = new CursorCapabilitiesService();
        const cursorSnapshot = await cursorCapabilities.getCapabilities(true);
        if (cursorSnapshot.status !== 'ready' || !cursorSnapshot.catalogVersion) {
            throw new Error('Real Cursor model discovery did not provide a ready account-visible catalog.');
        }
        const selectedModel = cursorSnapshot.models.find((model) => model.id === REAL_CURSOR_TEST_MODEL);
        if (!selectedModel) {
            throw new Error(`Real Cursor model ${REAL_CURSOR_TEST_MODEL} is not account-visible.`);
        }
        const cursorExecution = { model: selectedModel.id, catalogVersion: cursorSnapshot.catalogVersion };
        const machineSocket = bootstrapMachineSocket({
            p2pPort: p2pServer.port,
            machineId: TEST_MACHINE_ID,
            bearerToken,
            contentSecret,
            pairingRekeyCoordinator,
            codexCapabilities,
            cursorCapabilities,
            spawnSession: sessionManager.spawnSession,
            stopSession: sessionManager.stopSession,
            requestShutdown: () => undefined,
        });
        cleanupTasks.push({ label: 'real Cursor machine socket', run: () => machineSocket.close() });

        const assistantMessages = new Map<string, string[]>();
        const appSocket = await createSocketConnection(p2pServer.port, {
            token: bearerToken,
            clientType: 'user-scoped',
        }, (update) => {
            const body = isRecord(update) && isRecord(update.body) ? update.body : null;
            const sessionId = body ? readString(body.sid) : null;
            const message = body?.t === 'new-message' && isRecord(body.message) ? body.message : null;
            const encryptedContent = message && isRecord(message.content) && message.content.t === 'encrypted'
                ? readString(message.content.c)
                : null;
            if (!encryptedContent || !sessionId) return;

            try {
                const response = getAssistantText(encryption.decrypt(
                    contentSecret,
                    'legacy',
                    encryption.decodeBase64(encryptedContent),
                ));
                if (response === null) return;

                const messages = assistantMessages.get(sessionId) ?? [];
                messages.push(response);
                assistantMessages.set(sessionId, messages);
            } catch {
                // The socket also receives unrelated encrypted session events.
            }
        });
        cleanupTasks.push({ label: 'real Cursor phone socket', run: () => appSocket.close() });

        const callMachineRpc = async (method: string, params: unknown): Promise<unknown> => {
            const encryptedParams = encryption.encodeBase64(encryption.encrypt(contentSecret, 'legacy', params));
            const response = await emitRpcCallWhenRegistered(
                appSocket,
                `${TEST_MACHINE_ID}:${method}`,
                encryptedParams,
            );
            if (!response.ok || !response.result) {
                throw new Error(`Real Cursor RPC ${method} did not return an encrypted result.`);
            }
            return encryption.decrypt(
                contentSecret,
                'legacy',
                encryption.decodeBase64(response.result),
            );
        };

        const verifyAcknowledgedDelivery = async (sessionId: string): Promise<void> => {
            const runnerCredential = issuedRunnerCredentials.get(sessionId);
            if (!runnerCredential) {
                throw new Error(`Real Cursor runner credential was not issued for ${sessionId}.`);
            }

            const replayedSequences: number[] = [];
            const runnerSocket = await createSocketConnection(p2pServer.port, {
                token: bearerToken,
                clientType: 'session-scoped',
                sessionId,
                messageAckVersion: TEST_SESSION_MESSAGE_ACK_VERSION,
                runnerCredential,
            }, (update) => {
                const body = isRecord(update) && isRecord(update.body) ? update.body : null;
                const message = body?.t === 'new-message' && isRecord(body.message) ? body.message : null;
                const sequence = message?.seq;
                if (body?.sid === sessionId && typeof sequence === 'number') {
                    replayedSequences.push(sequence);
                }
            });

            try {
                await new Promise((resolve) => setTimeout(resolve, RUNNER_DELIVERY_PROBE_WINDOW_MS));
                expect(replayedSequences).toEqual([]);
            } finally {
                runnerSocket.close();
            }
        };

        const getSessionMetadata = (sessionId: string): Record<string, unknown> | null => {
            const metadata = store.getSession(sessionId)?.metadata;
            if (!metadata) return null;
            try {
                const parsed = encryption.decrypt(
                    contentSecret,
                    'legacy',
                    encryption.decodeBase64(metadata),
                );
                if (!isRecord(parsed)) {
                    throw new Error('Real Cursor lifecycle metadata has an invalid decrypted shape.');
                }
                return parsed;
            } catch (error) {
                throw new Error(
                    `Real Cursor lifecycle metadata could not be decoded: ${toError(error).message}`,
                );
            }
        };

        return {
            callMachineRpc,
            cursorExecution,
            getAssistantMessages: (sessionId) => assistantMessages.get(sessionId) ?? [],
            getChildrenCount: () => sessionManager.getChildren().length,
            getExecutionOutcome: (sessionId) => {
                const executionOutcome = getSessionMetadata(sessionId)?.executionOutcome;
                return isRecord(executionOutcome)
                    && (executionOutcome.kind === 'error' || executionOutcome.kind === 'success')
                    ? executionOutcome.kind
                    : null;
            },
            getNativeCursorSessionId: (sessionId) => readString(getSessionMetadata(sessionId)?.cursorSessionId),
            sendPhonePrompt: (sessionId, prompt) => {
                appSocket.emit('message', {
                    sid: sessionId,
                    message: encryption.encodeBase64(encryption.encrypt(contentSecret, 'legacy', {
                        role: 'user',
                        content: { type: 'text', text: prompt },
                        meta: { sentFrom: 'phone' },
                    })),
                });
            },
            verifyAcknowledgedDelivery,
            close,
        };
    } catch (error) {
        try {
            await close();
        } catch (cleanupError) {
            throw new AggregateError(
                [toError(error), toError(cleanupError)],
                'Real Cursor lifecycle harness failed during setup and cleanup.',
            );
        }
        throw error;
    }
}

beforeEach(() => {
    originalEnvironment = {
        REMCLI_HOME_DIR: process.env.REMCLI_HOME_DIR,
        REMCLI_DISABLE_CAFFEINATE: process.env.REMCLI_DISABLE_CAFFEINATE,
    };
    remcliHomeDir = mkdtempSync(join(tmpdir(), 'remcli-real-cursor-lifecycle-'));
    process.env.REMCLI_HOME_DIR = remcliHomeDir;
    process.env.REMCLI_DISABLE_CAFFEINATE = '1';
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

realCursorDescribe('Cursor real lifecycle gate (skipped unless REMCLI_REAL_CURSOR=1)', { timeout: REAL_GATE_TIMEOUT_MS }, () => {
    it('creates, stops, resumes and proves native Cursor context through the real Remcli runner', async () => {
        const marker = `remcli-cursor-lifecycle-${randomUUID()}`;
        const initialResponse = 'INITIAL_ACK';
        const markerPrompt = `Запомни маркер ${marker} для следующего вопроса. Не используй инструменты. Ответь только ${initialResponse}.`;
        const followUpPrompt = 'Какой маркер я попросил запомнить в предыдущем сообщении? Не используй инструменты. Ответь только значением маркера, без пояснений и форматирования.';
        harness = await createLifecycleHarness();

        const spawned = await harness.callMachineRpc('spawn-remcli-session', createSpawnParams(harness.cursorExecution));
        if (!isSpawnResult(spawned) || !spawned.sessionId) {
            throw new Error('Real Cursor initial spawn did not return a Remcli session ID.');
        }
        const firstRemcliSessionId = spawned.sessionId;

        harness.sendPhonePrompt(firstRemcliSessionId, markerPrompt);
        await waitForCondition(
            () => {
                if (harness!.getExecutionOutcome(firstRemcliSessionId) === 'error') {
                    throw new Error('Real Cursor reported a terminal error before confirming its native session ID.');
                }
                return harness!.getNativeCursorSessionId(firstRemcliSessionId) !== null;
            },
            'the real Cursor native session ID after the marker prompt',
        );
        await waitForCondition(
            () => harness!.getAssistantMessages(firstRemcliSessionId).some((message) => message.includes(initialResponse)),
            'the real Cursor marker-prompt completion',
        );
        await harness.verifyAcknowledgedDelivery(firstRemcliSessionId);
        const nativeCursorSessionId = harness.getNativeCursorSessionId(firstRemcliSessionId);
        if (!nativeCursorSessionId) {
            throw new Error('Real Cursor did not confirm a native session ID.');
        }

        const stopped = await harness.callMachineRpc('stop-session', { sessionId: firstRemcliSessionId });
        expect(isStoppedSession(stopped, firstRemcliSessionId)).toBe(true);
        await waitForCondition(
            () => harness!.getChildrenCount() === 0,
            'the first real daemon-owned Cursor runner to stop',
        );

        const resumed = await harness.callMachineRpc(
            'spawn-remcli-session',
            createSpawnParams(harness.cursorExecution, nativeCursorSessionId),
        );
        if (!isSpawnResult(resumed) || !resumed.sessionId) {
            throw new Error(`Real Cursor resume spawn did not return a Remcli session ID: ${getSpawnFailureMessage(resumed)}`);
        }
        const resumedRemcliSessionId = resumed.sessionId;
        const resumedMessageCountBeforeFollowUp = harness.getAssistantMessages(resumedRemcliSessionId).length;

        harness.sendPhonePrompt(resumedRemcliSessionId, followUpPrompt);
        await waitForCondition(
            () => {
                if (harness!.getExecutionOutcome(resumedRemcliSessionId) === 'error') {
                    throw new Error('Real Cursor reported a terminal error before confirming its resumed native session ID.');
                }
                return harness!.getNativeCursorSessionId(resumedRemcliSessionId) === nativeCursorSessionId;
            },
            'the same native Cursor session ID after resume',
        );
        await waitForCondition(
            () => harness!
                .getAssistantMessages(resumedRemcliSessionId)
                .slice(resumedMessageCountBeforeFollowUp)
                .some((message) => message.trim() === marker),
            'the real Cursor resumed follow-up completion',
        );
        await harness.verifyAcknowledgedDelivery(resumedRemcliSessionId);

        const stoppedResumed = await harness.callMachineRpc('stop-session', { sessionId: resumedRemcliSessionId });
        expect(isStoppedSession(stoppedResumed, resumedRemcliSessionId)).toBe(true);
        await waitForCondition(
            () => harness!.getChildrenCount() === 0,
            'the resumed real daemon-owned Cursor runner to stop',
        );
    });
});
