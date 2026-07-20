/**
 * Product-boundary Cursor lifecycle gate.
 *
 * Phone-side encrypted RPC, real P2P, daemon SessionManager, tmux runner and
 * compiled CLI remain live. Only `agent` is replaced with a controlled local
 * executable, so this gate validates Cursor's CLI contract without provider
 * credentials or quota.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient, type Socket } from 'socket.io-client';

import {
    createControlledCursorAgent,
    type ControlledCursorAgent,
} from './controlledCursorAgent';
import type { CursorLaunchControls } from '@/cursor/cursorLaunchControls';

const SOCKET_TIMEOUT_MS = 8_000;
const RPC_REGISTRATION_TIMEOUT_MS = 8_000;
const RPC_REGISTRATION_RETRY_MS = 50;
const LIFECYCLE_TIMEOUT_MS = 45_000;
const TEST_MACHINE_ID = 'controlled-cursor-machine-rpc';
const FIXTURE_MODEL = 'controlled-cursor-model';
const TEST_NATIVE_SESSION_ID = 'controlled-cursor-native-session';
const FIRST_CONTEXT_PROMPT = 'fixture seed context';
const IN_FLIGHT_DELIVERY_PROMPT = 'fixture delivery disconnect before acknowledgement';
const ACTIVE_STOP_PROMPT = 'fixture active Cursor turn to stop';
const RESUME_CONTEXT_PROMPT = 'fixture resume context';
const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CLI_ARTIFACT_SNAPSHOT_ATTEMPTS = 30;
const CLI_ARTIFACT_SNAPSHOT_RETRY_MS = 250;
const RUNNER_DELIVERY_PROBE_WINDOW_MS = 250;
const TEST_SESSION_MESSAGE_ACK_VERSION = 1;
const TMUX_SIBLING_SENTINEL_COMMAND = 'sleep 60';
const CURSOR_WORKSPACE_MISMATCH_ERROR = 'Cursor session belongs to a different working directory. Select its original workspace before resuming.';
const FIXTURE_CURSOR_LAUNCH_CONTROLS: CursorLaunchControls = {
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
}

interface CleanupTask {
    label: string;
    run: () => void | Promise<void>;
}

interface PhoneAssistantMessage {
    sessionId: string;
    text: string;
}

interface InFlightDeliveryReplay {
    deliveredSequences: number[];
    replayedSequences: number[];
}

interface PhonePromptOverrides {
    meta?: Record<string, unknown>;
}

interface LifecycleHarness {
    fixture: ControlledCursorAgent;
    callMachineRpc: (method: string, params: unknown) => Promise<unknown>;
    createTmuxSiblingPane: (sessionId: string) => { runnerPaneId: string; siblingPaneId: string };
    getChildren: () => Array<{ remcliSessionId?: string }>;
    getPhoneAssistantTexts: (sessionId: string) => string[];
    probeReplacementRunnerDelivery: (sessionId: string) => Promise<number[]>;
    verifyInFlightDeliveryReplay: (sessionId: string, text: string) => Promise<InFlightDeliveryReplay>;
    sendPhonePrompt: (sessionId: string, text: string, overrides?: PhonePromptOverrides) => void;
    close: () => Promise<void>;
}

let remcliHomeDir: string;
let originalEnvironment: Record<string, string | undefined>;
let harness: LifecycleHarness | null = null;
let fixtureCursorExecution: { model: string; catalogVersion: string } | null = null;

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

function runTmux(args: string[]): string {
    const result = spawnSync('tmux', args, { encoding: 'utf8' });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`tmux ${args[0] ?? 'command'} failed: ${result.stderr}`);
    }
    return result.stdout;
}

function doesTmuxPaneExist(paneId: string): boolean {
    const result = spawnSync('tmux', [
        'display-message',
        '-p',
        '-t',
        paneId,
        '#{pane_id}',
    ], { encoding: 'utf8' });
    if (result.error) {
        throw result.error;
    }
    return result.status === 0 && result.stdout.trim() === paneId;
}

function releaseTmuxPane(paneId: string): void {
    const result = spawnSync('tmux', ['kill-pane', '-t', paneId], { encoding: 'utf8' });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0 && result.status !== 1) {
        throw new Error(`tmux kill-pane failed for ${paneId}: ${result.stderr}`);
    }
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

function waitForSocketDisconnect(socket: Socket, description: string): Promise<void> {
    if (!socket.connected) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off('disconnect', onDisconnect);
            reject(new Error(`Timed out waiting for ${description} to disconnect.`));
        }, SOCKET_TIMEOUT_MS);
        const onDisconnect = (): void => {
            clearTimeout(timeout);
            resolve();
        };
        socket.once('disconnect', onDisconnect);
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

function createSpawnParams(
    resumeSessionId?: string,
    directory: string = process.cwd(),
    cursorLaunchControls: CursorLaunchControls = FIXTURE_CURSOR_LAUNCH_CONTROLS,
): Record<string, unknown> {
    if (!fixtureCursorExecution) {
        throw new Error('Controlled Cursor capability snapshot was not initialized.');
    }
    return {
        type: 'spawn-in-directory',
        machineId: TEST_MACHINE_ID,
        directory,
        approvedNewDirectoryCreation: false,
        agent: 'cursor',
        cursorExecution: fixtureCursorExecution,
        cursorLaunchControls,
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
        const {
            CursorCapabilitiesService,
            getDefaultCursorExecution,
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
            acquireCursorHeadlessWriterLease: sessionManager.acquireCursorHeadlessWriterLease,
            releaseCursorNativeWriterLease: sessionManager.releaseCursorNativeWriterLease,
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
        const cursorCapabilities = new CursorCapabilitiesService({
            readModelList: async () => ({
                executable: 'agent',
                version: 'controlled-cursor-agent 1.0.0',
                output: [
                    'Available models',
                    '',
                    `${FIXTURE_MODEL} - Controlled Cursor Model (default)`,
                    '',
                    'Tip: use --model <id> to switch.',
                ].join('\n'),
            }),
        });
        const cursorExecution = getDefaultCursorExecution(await cursorCapabilities.getCapabilities());
        if (!cursorExecution) {
            throw new Error('Controlled Cursor model discovery did not provide an explicit provider default.');
        }
        fixtureCursorExecution = cursorExecution;
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

        const createTmuxSiblingPane = (sessionId: string): { runnerPaneId: string; siblingPaneId: string } => {
            const trackedSession = sessionManager.getChildren().find((session) => session.remcliSessionId === sessionId);
            const runnerPaneId = trackedSession?.tmuxRunner?.paneId;
            if (!runnerPaneId) {
                throw new Error(`Controlled Cursor runner ${sessionId} has no owned tmux pane.`);
            }

            const siblingPaneId = runTmux([
                'split-window',
                '-d',
                '-P',
                '-F',
                '#{pane_id}',
                '-t',
                runnerPaneId,
                TMUX_SIBLING_SENTINEL_COMMAND,
            ]).trim();
            if (!siblingPaneId || siblingPaneId === runnerPaneId) {
                throw new Error('Controlled Cursor tmux sibling pane was not created.');
            }

            cleanupTasks.push({
                label: 'controlled Cursor tmux sibling pane',
                run: () => releaseTmuxPane(siblingPaneId),
            });

            return { runnerPaneId, siblingPaneId };
        };

        const sendPhonePrompt = (sessionId: string, text: string, overrides: PhonePromptOverrides = {}): void => {
            appSocket.emit('message', {
                sid: sessionId,
                message: encryption.encodeBase64(encryption.encrypt(contentSecret, 'legacy', {
                    role: 'user',
                    content: { type: 'text', text },
                    meta: {
                        sentFrom: 'phone',
                        model: FIXTURE_MODEL,
                        ...overrides.meta,
                    },
                })),
            });
        };

        const verifyInFlightDeliveryReplay = async (
            sessionId: string,
            text: string,
        ): Promise<InFlightDeliveryReplay> => {
            const runnerCredential = issuedRunnerCredentials.get(sessionId);
            if (!runnerCredential) {
                throw new Error(`Controlled Cursor runner credential was not issued for ${sessionId}.`);
            }

            const deliveredSequences: number[] = [];
            const unacknowledgedRunner = await createSocketConnection(
                p2pServer.port,
                {
                    token: bearerToken,
                    clientType: 'session-scoped',
                    sessionId,
                    messageAckVersion: TEST_SESSION_MESSAGE_ACK_VERSION,
                    runnerCredential,
                },
                (update) => {
                    const body = isRecord(update) && isRecord(update.body) ? update.body : null;
                    const message = body?.t === 'new-message' && isRecord(body.message) ? body.message : null;
                    const sequence = message?.seq;
                    if (body?.sid === sessionId && typeof sequence === 'number') {
                        deliveredSequences.push(sequence);
                    }
                },
            );

            try {
                sendPhonePrompt(sessionId, text);
                await waitForCondition(
                    () => deliveredSequences.length === 1,
                    'the unacknowledged controlled Cursor delivery',
                );

                const unacknowledgedRunnerDisconnected = waitForSocketDisconnect(
                    unacknowledgedRunner,
                    'the unacknowledged controlled Cursor runner',
                );
                const replayedSequences: number[] = [];
                const replacementRunner = await createSocketConnection(
                    p2pServer.port,
                    {
                        token: bearerToken,
                        clientType: 'session-scoped',
                        sessionId,
                        messageAckVersion: TEST_SESSION_MESSAGE_ACK_VERSION,
                        runnerCredential,
                    },
                    (update) => {
                        const body = isRecord(update) && isRecord(update.body) ? update.body : null;
                        const message = body?.t === 'new-message' && isRecord(body.message) ? body.message : null;
                        const sequence = message?.seq;
                        if (body?.sid === sessionId && typeof sequence === 'number') {
                            replayedSequences.push(sequence);
                        }
                    },
                );

                try {
                    await unacknowledgedRunnerDisconnected;
                    await waitForCondition(
                        () => replayedSequences.length === 1,
                        'the replacement controlled Cursor delivery replay',
                    );
                    replacementRunner.emit('message-ack', {
                        sid: sessionId,
                        seq: replayedSequences[0],
                    });
                    return { deliveredSequences, replayedSequences };
                } finally {
                    replacementRunner.close();
                }
            } finally {
                unacknowledgedRunner.close();
            }
        };

        return {
            fixture,
            callMachineRpc,
            createTmuxSiblingPane,
            getChildren: () => sessionManager.getChildren(),
            getPhoneAssistantTexts: (sessionId) => phoneAssistantMessages
                .filter((message) => message.sessionId === sessionId)
                .map((message) => message.text),
            probeReplacementRunnerDelivery: async (sessionId) => {
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
                        messageAckVersion: TEST_SESSION_MESSAGE_ACK_VERSION,
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
                    await new Promise((resolve) => setTimeout(resolve, RUNNER_DELIVERY_PROBE_WINDOW_MS));
                    return replayedDeliverySequences;
                } finally {
                    probeSocket.close();
                }
            },
            verifyInFlightDeliveryReplay,
            sendPhonePrompt,
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
        fixtureCursorExecution = null;

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
    it('rejects generic or incomplete Cursor launch input and keeps the daemon-validated selection immutable', async () => {
        harness = await createLifecycleHarness();

        const genericPermissionParams = {
            ...createSpawnParams(),
            permissionMode: 'plan',
        };
        const { cursorLaunchControls: _ignoredControls, ...missingControlsParams } = createSpawnParams();
        await expect(
            harness.callMachineRpc('spawn-remcli-session', genericPermissionParams),
        ).resolves.toEqual({
            error: 'Cursor launch controls must not use the generic permissionMode field.',
        });
        await expect(
            harness.callMachineRpc('spawn-remcli-session', missingControlsParams),
        ).resolves.toEqual({
            error: 'Cursor requires a current model and validated launch controls.',
        });
        expect(harness.getChildren()).toHaveLength(0);
        expect(harness.fixture.getInvocations()).toEqual([]);

        const spawned = await harness.callMachineRpc('spawn-remcli-session', createSpawnParams());
        expect(spawned).toEqual({ type: 'success', sessionId: expect.any(String) });
        if (!isSpawnResult(spawned) || !spawned.sessionId) {
            throw new Error('Controlled Cursor spawn did not return a Remcli session ID.');
        }

        harness.sendPhonePrompt(spawned.sessionId, FIRST_CONTEXT_PROMPT, {
            meta: {
                model: 'forged-not-account-visible-model',
                permissionMode: 'plan',
            },
        });
        await waitForCondition(
            () => harness!.fixture.getInvocations().length === 1,
            'the forged Cursor phone prompt to reach the daemon-owned runner',
        );

        expect(harness.fixture.getInvocations()).toEqual([{
            args: ['--print', '--output-format', 'stream-json', '--trust', '--model', FIXTURE_MODEL, FIRST_CONTEXT_PROMPT],
            prompt: FIRST_CONTEXT_PROMPT,
            sessionId: TEST_NATIVE_SESSION_ID,
        }]);
        expect(harness.fixture.getProtocolViolations()).toEqual([]);

        const stopped = await harness.callMachineRpc('stop-session', { sessionId: spawned.sessionId });
        expect(stopped).toEqual({ message: 'Session stopped', sessionId: spawned.sessionId });
        await waitForCondition(
            () => harness!.getChildren().length === 0,
            'the forged-override daemon-owned Cursor runner to stop',
            LIFECYCLE_TIMEOUT_MS,
        );
    });

    it('creates, guards, stops and resumes one native Cursor session with all independent controls', async () => {
        harness = await createLifecycleHarness();
        const launchControls: CursorLaunchControls = {
            executionMode: 'agent',
            force: true,
            autoReview: true,
            sandbox: 'enabled',
            approveMcps: true,
        };

        const spawned = await harness.callMachineRpc(
            'spawn-remcli-session',
            createSpawnParams(undefined, process.cwd(), launchControls),
        );
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
            args: [
                '--print', '--output-format', 'stream-json', '--trust', '--model', FIXTURE_MODEL,
                '--force', '--auto-review', '--sandbox', 'enabled', '--approve-mcps', FIRST_CONTEXT_PROMPT,
            ],
            prompt: FIRST_CONTEXT_PROMPT,
            sessionId: TEST_NATIVE_SESSION_ID,
        }]);

        // A processed phone prompt must not replay to a credential-bound
        // replacement runner once the live runner has acknowledged it.
        expect(await harness.probeReplacementRunnerDelivery(firstRemcliSessionId)).toEqual([]);
        expect(harness.fixture.getInvocations()).toHaveLength(1);

        // Server-side disconnect is deliberately tested with an explicit
        // credential-bound replacement, not an assumption that the original
        // runner will auto-reconnect. The replacement receives the one durable
        // delivery that the disconnected runner left unacknowledged.
        const inFlightDeliveryReplay = await harness.verifyInFlightDeliveryReplay(
            firstRemcliSessionId,
            IN_FLIGHT_DELIVERY_PROMPT,
        );
        expect(inFlightDeliveryReplay.deliveredSequences).toHaveLength(1);
        expect(inFlightDeliveryReplay.replayedSequences).toEqual(inFlightDeliveryReplay.deliveredSequences);
        expect(harness.fixture.getInvocations()).toHaveLength(1);

        const duplicateResume = await harness.callMachineRpc(
            'spawn-remcli-session',
            createSpawnParams(TEST_NATIVE_SESSION_ID, process.cwd(), launchControls),
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
            createSpawnParams(TEST_NATIVE_SESSION_ID, process.cwd(), launchControls),
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

        const { runnerPaneId, siblingPaneId } = harness.createTmuxSiblingPane(activeStopRemcliSessionId);
        expect(doesTmuxPaneExist(runnerPaneId)).toBe(true);
        expect(doesTmuxPaneExist(siblingPaneId)).toBe(true);

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
        await waitForCondition(
            () => harness!.fixture.getLiveProcessIds().length === 0,
            'the active Cursor native child to exit after the daemon-owned runner stops',
            LIFECYCLE_TIMEOUT_MS,
        );
        expect(doesTmuxPaneExist(runnerPaneId)).toBe(false);
        expect(doesTmuxPaneExist(siblingPaneId)).toBe(true);

        const resumed = await harness.callMachineRpc(
            'spawn-remcli-session',
            createSpawnParams(TEST_NATIVE_SESSION_ID, process.cwd(), launchControls),
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
                args: [
                    '--print', '--output-format', 'stream-json', '--trust', '--model', FIXTURE_MODEL,
                    '--force', '--auto-review', '--sandbox', 'enabled', '--approve-mcps', FIRST_CONTEXT_PROMPT,
                ],
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
                    '--force',
                    '--auto-review',
                    '--sandbox', 'enabled',
                    '--approve-mcps',
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
                    '--force',
                    '--auto-review',
                    '--sandbox', 'enabled',
                    '--approve-mcps',
                    RESUME_CONTEXT_PROMPT,
                ],
                prompt: RESUME_CONTEXT_PROMPT,
                resumeSessionId: TEST_NATIVE_SESSION_ID,
                sessionId: TEST_NATIVE_SESSION_ID,
            },
        ]);
        expect(harness.fixture.getInvocations().every((invocation) => !invocation.args.includes('--mode'))).toBe(true);
        expect(harness.fixture.getInterruptedPrompts()).toEqual([ACTIVE_STOP_PROMPT]);

        const stoppedResumed = await harness.callMachineRpc('stop-session', { sessionId: resumedRemcliSessionId });
        expect(stoppedResumed).toEqual({ message: 'Session stopped', sessionId: resumedRemcliSessionId });
        await waitForCondition(
            () => harness!.getChildren().length === 0,
            'the resumed daemon-owned Cursor runner to stop',
            LIFECYCLE_TIMEOUT_MS,
        );
    });

    it('deduplicates concurrent pre-init Cursor resumes and rejects a workspace mismatch', async () => {
        harness = await createLifecycleHarness();

        const [firstResume, duplicateResume] = await Promise.all([
            harness.callMachineRpc('spawn-remcli-session', createSpawnParams(TEST_NATIVE_SESSION_ID)),
            harness.callMachineRpc('spawn-remcli-session', createSpawnParams(TEST_NATIVE_SESSION_ID)),
        ]);
        expect(firstResume).toEqual({ type: 'success', sessionId: expect.any(String) });
        expect(duplicateResume).toEqual({ type: 'success', sessionId: expect.any(String) });
        if (!isSpawnResult(firstResume) || !firstResume.sessionId) {
            throw new Error('Controlled Cursor first pre-init resume did not return a Remcli session ID.');
        }
        if (!isSpawnResult(duplicateResume) || !duplicateResume.sessionId) {
            throw new Error('Controlled Cursor duplicate pre-init resume did not return a Remcli session ID.');
        }
        const resumedRemcliSessionId = firstResume.sessionId;

        expect(duplicateResume.sessionId).toBe(resumedRemcliSessionId);
        expect(harness.getChildren()).toHaveLength(1);
        expect(harness.fixture.getInvocations()).toEqual([]);

        const workspaceMismatch = await harness.callMachineRpc(
            'spawn-remcli-session',
            createSpawnParams(TEST_NATIVE_SESSION_ID, remcliHomeDir),
        );
        expect(workspaceMismatch).toEqual({
            error: CURSOR_WORKSPACE_MISMATCH_ERROR,
        });
        expect(harness.getChildren()).toHaveLength(1);
        expect(harness.fixture.getInvocations()).toEqual([]);

        harness.sendPhonePrompt(resumedRemcliSessionId, FIRST_CONTEXT_PROMPT);
        await waitForCondition(
            () => harness!.fixture.getInvocations().length === 1,
            'the pre-init Cursor native resume turn to start',
        );
        await waitForCondition(
            () => harness!.getPhoneAssistantTexts(resumedRemcliSessionId).includes(`fixture accepted: ${FIRST_CONTEXT_PROMPT}`),
            'the pre-init Cursor native resume phone response',
        );
        expect(harness.fixture.getInvocations()).toEqual([{
            args: [
                '--print',
                '--output-format',
                'stream-json',
                '--trust',
                '--model',
                FIXTURE_MODEL,
                '--resume',
                TEST_NATIVE_SESSION_ID,
                FIRST_CONTEXT_PROMPT,
            ],
            prompt: FIRST_CONTEXT_PROMPT,
            resumeSessionId: TEST_NATIVE_SESSION_ID,
            sessionId: TEST_NATIVE_SESSION_ID,
        }]);
        expect(harness.fixture.getProtocolViolations()).toEqual([]);

        const stopped = await harness.callMachineRpc('stop-session', { sessionId: resumedRemcliSessionId });
        expect(stopped).toEqual({ message: 'Session stopped', sessionId: resumedRemcliSessionId });
        await waitForCondition(
            () => harness!.getChildren().length === 0,
            'the pre-init Cursor resume runner to stop',
            LIFECYCLE_TIMEOUT_MS,
        );
    });
});
