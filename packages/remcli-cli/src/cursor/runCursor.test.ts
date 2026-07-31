import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RetryableUserMessageDeliveryError } from '@/api/types';
import { CursorTurnError } from './cursorQuery';
import type { CursorLaunchControls } from './cursorLaunchControls';
import type { CursorStreamEvent } from './types';

const TEST_CURSOR_LAUNCH_CONTROLS: CursorLaunchControls = {
    executionMode: 'agent',
    force: false,
    autoReview: false,
    sandbox: 'local-configuration',
    approveMcps: false,
};
const TEST_CURSOR_RUNNER = {
    executable: 'agent' as const,
    cliFingerprint: '0123456789abcdef',
};
const TEST_HEADLESS_WRITER_LEASE = {
    agent: 'cursor' as const,
    leaseId: 'cursor-headless-writer-lease-12345678901234567890',
    nativeSessionId: 'cursor-native-confirmed',
    remcliSessionId: 'cursor-session',
    owner: 'headless' as const,
};

interface TestSession {
    sessionId: string;
    metadata: Record<string, unknown>;
    metadataUpdates: Array<Record<string, unknown>>;
    lifecycleCalls: string[];
    updateMetadata: ReturnType<typeof vi.fn>;
    sendSessionDeath: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    keepAlive: ReturnType<typeof vi.fn>;
    sendAgentMessage: ReturnType<typeof vi.fn>;
    sendSessionEvent: ReturnType<typeof vi.fn>;
    cancelPendingUserMessageDelivery: ReturnType<typeof vi.fn>;
    onUserMessage: ReturnType<typeof vi.fn>;
    rpcHandlerManager: {
        registerHandler: ReturnType<typeof vi.fn>;
    };
}

interface QueuedMessage {
    message: string;
    mode: {
        launchControls: CursorLaunchControls;
        model?: string;
    };
    isolate: boolean;
    hash: string;
    acknowledge?: () => void;
    reject?: (error: unknown) => void;
}

interface ReconnectionOptions {
    onSessionSwap: (newSession: TestSession) => void;
}

const testState = vi.hoisted(() => {
    const createSessionMetadataResult = (options: {
        flavor?: string;
        machineId?: string;
        startedBy?: 'daemon' | 'terminal';
    }) => ({
        state: {},
        metadata: {
            path: '/workspace',
            host: 'test-host',
            homeDir: '/home/test',
            remcliHomeDir: '/home/test/.remcli',
            remcliLibDir: '/workspace/remcli',
            remcliToolsDir: '/workspace/remcli/tools',
            ...(options.flavor ? { flavor: options.flavor } : {}),
            ...(options.machineId ? { machineId: options.machineId } : {}),
            ...(options.startedBy ? { startedBy: options.startedBy } : {}),
        },
    });

    class FakeMessageQueue {
        static instances: FakeMessageQueue[] = [];

        private resolver: ((message: QueuedMessage | null) => void) | null = null;
        private resolveAcceptance: (() => void) | null = null;
        private rejectAcceptance: ((error: unknown) => void) | null = null;
        private readonly modeHasher: (mode: unknown) => string;
        public waitCount = 0;
        public pushed: Array<{ message: string; mode: { launchControls: CursorLaunchControls; model?: string } }> = [];
        public modeHashes: string[] = [];

        public constructor(modeHasher: (mode: unknown) => string) {
            this.modeHasher = modeHasher;
            FakeMessageQueue.instances.push(this);
        }

        public waitForMessagesAndGetAsString(signal: AbortSignal): Promise<QueuedMessage | null> {
            this.waitCount += 1;
            return new Promise((resolve) => {
                this.resolver = resolve;
                if (signal.aborted) {
                    resolve(null);
                    return;
                }
                signal.addEventListener('abort', () => resolve(null), { once: true });
            });
        }

        public push(message: string, mode: unknown): void {
            this.modeHashes.push(this.modeHasher(mode));
            this.pushed.push({
                message,
                mode: mode as { launchControls: CursorLaunchControls; model?: string },
            });
        }

        public pushWithAcceptance(message: string, mode: unknown): Promise<void> {
            this.push(message, mode);
            return new Promise((resolve, reject) => {
                this.resolveAcceptance = resolve;
                this.rejectAcceptance = reject;
            });
        }

        public resolve(message: QueuedMessage | null): void {
            if (message?.acknowledge) {
                const acknowledge = message.acknowledge;
                message.acknowledge = () => {
                    acknowledge();
                    this.resolveAcceptance?.();
                    this.resolveAcceptance = null;
                    this.rejectAcceptance = null;
                };
            }
            if (message) {
                const reject = message.reject;
                message.reject = (error) => {
                    reject?.(error);
                    this.rejectAcceptance?.(error);
                    this.resolveAcceptance = null;
                    this.rejectAcceptance = null;
                };
            }
            this.resolver?.(message);
        }
    }

    return {
        FakeMessageQueue,
        response: null as { id: string } | null,
        initialSession: null as TestSession | null,
        reconnectionOptions: null as ReconnectionOptions | null,
        readSettings: vi.fn(),
        createApiClient: vi.fn(),
        getOrCreateSession: vi.fn(),
        sessionSyncClient: vi.fn(),
        acquireDaemonRunnerCredential: vi.fn(),
        reportTerminalSessionStarted: vi.fn(),
        bindDaemonCursorSession: vi.fn(),
        consumeDaemonSessionExecution: vi.fn(),
        acquireDaemonCursorHeadlessWriterLease: vi.fn(),
        releaseDaemonCursorNativeWriterLease: vi.fn(),
        preflightDaemonCursorRunner: vi.fn(),
        reportDaemonCursorRunnerBootstrapFailure: vi.fn(),
        reportDaemonRunnerStopping: vi.fn(),
        reportDaemonRunnerStopped: vi.fn(),
        verifyCursorRunnerIdentity: vi.fn(),
        createSessionMetadata: vi.fn(createSessionMetadataResult),
        runCursorTurn: vi.fn(),
        isCursorTurnAbortError: vi.fn(() => false),
        reconnectionCancel: vi.fn(),
        loggerDebug: vi.fn(),
        reset(): void {
            FakeMessageQueue.instances = [];
            this.response = null;
            this.initialSession = null;
            this.reconnectionOptions = null;
            this.readSettings.mockReset();
            this.readSettings.mockResolvedValue({ machineId: 'test-machine' });
            this.createApiClient.mockReset();
            this.createApiClient.mockImplementation(async () => ({
                getOrCreateSession: testState.getOrCreateSession,
                sessionSyncClient: testState.sessionSyncClient,
            }));
            this.getOrCreateSession.mockReset();
            this.getOrCreateSession.mockImplementation(async () => testState.response);
            this.sessionSyncClient.mockReset();
            this.acquireDaemonRunnerCredential.mockReset();
            this.reportTerminalSessionStarted.mockReset();
            this.bindDaemonCursorSession.mockReset();
            this.consumeDaemonSessionExecution.mockReset();
            this.consumeDaemonSessionExecution.mockResolvedValue({
                ok: true,
                data: {
                    sessionId: 'cursor-session',
                    provider: 'cursor',
                    revision: 0,
                    current: {
                        provider: 'cursor',
                        model: 'controlled-cursor-model',
                        catalogVersion: 'controlled-cursor-catalog',
                    },
                    didApplyPending: false,
                },
            });
            this.acquireDaemonCursorHeadlessWriterLease.mockReset();
            this.acquireDaemonCursorHeadlessWriterLease.mockResolvedValue({
                ok: true,
                data: {
                    type: 'acquired',
                    writerLease: { ...TEST_HEADLESS_WRITER_LEASE },
                },
            });
            this.releaseDaemonCursorNativeWriterLease.mockReset();
            this.releaseDaemonCursorNativeWriterLease.mockResolvedValue({
                ok: true,
                data: { released: true },
            });
            this.preflightDaemonCursorRunner.mockReset();
            this.reportDaemonCursorRunnerBootstrapFailure.mockReset();
            this.reportDaemonCursorRunnerBootstrapFailure.mockResolvedValue({ ok: true, data: { accepted: true } });
            this.reportDaemonRunnerStopping.mockReset();
            this.reportDaemonRunnerStopped.mockReset();
            this.reportDaemonRunnerStopping.mockResolvedValue({ ok: false, error: 'test runner lifecycle unavailable' });
            this.reportDaemonRunnerStopped.mockResolvedValue({ ok: false, error: 'test runner lifecycle unavailable' });
            this.verifyCursorRunnerIdentity.mockReset();
            this.verifyCursorRunnerIdentity.mockResolvedValue(true);
            this.createSessionMetadata.mockReset();
            this.createSessionMetadata.mockImplementation(createSessionMetadataResult);
            this.runCursorTurn.mockReset();
            this.isCursorTurnAbortError.mockReset();
            this.reconnectionCancel.mockReset();
            this.loggerDebug.mockReset();
        },
    };
});

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: testState.createApiClient,
    },
}));

vi.mock('@/persistence', () => ({
    readSettings: testState.readSettings,
}));

vi.mock('@/utils/createSessionMetadata', () => ({
    createSessionMetadata: testState.createSessionMetadata,
}));

vi.mock('@/utils/daemonRunnerCredentialBootstrap', () => ({
    acquireDaemonRunnerCredential: testState.acquireDaemonRunnerCredential,
    reportTerminalSessionStarted: testState.reportTerminalSessionStarted,
}));

vi.mock('@/daemon/controlClient', () => ({
    acquireDaemonCursorHeadlessWriterLease: testState.acquireDaemonCursorHeadlessWriterLease,
    bindDaemonCursorSession: testState.bindDaemonCursorSession,
    consumeDaemonSessionExecution: testState.consumeDaemonSessionExecution,
    preflightDaemonCursorRunner: testState.preflightDaemonCursorRunner,
    reportDaemonCursorRunnerBootstrapFailure: testState.reportDaemonCursorRunnerBootstrapFailure,
    releaseDaemonCursorNativeWriterLease: testState.releaseDaemonCursorNativeWriterLease,
    reportDaemonRunnerStopping: testState.reportDaemonRunnerStopping,
    reportDaemonRunnerStopped: testState.reportDaemonRunnerStopped,
}));

vi.mock('./cursorCapabilities', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./cursorCapabilities')>();
    return {
        ...actual,
        verifyCursorRunnerIdentity: testState.verifyCursorRunnerIdentity,
    };
});

vi.mock('@/utils/setupOfflineReconnection', () => ({
    setupOfflineReconnection: vi.fn((options: ReconnectionOptions) => {
        testState.reconnectionOptions = options;
        return {
            session: testState.initialSession,
            reconnectionHandle: { cancel: testState.reconnectionCancel },
            isOffline: testState.response === null,
        };
    }),
}));

vi.mock('@/utils/MessageQueue2', () => ({
    MessageQueue2: testState.FakeMessageQueue,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: testState.loggerDebug,
        warn: vi.fn(),
        getLogPath: vi.fn(() => '/tmp/remcli-test.log'),
    },
}));

vi.mock('@/ui/ink/messageBuffer', () => ({
    MessageBuffer: class {
        public addMessage(): void {}
        public updateLastMessage(): void {}
        public clear(): void {}
    },
}));

vi.mock('@/ui/ink/CodexDisplay', () => ({
    CodexDisplay: () => null,
}));

vi.mock('@/utils/caffeinate', () => ({
    stopCaffeinate: vi.fn(),
}));

vi.mock('@/utils/redaction', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/utils/redaction')>();
    return {
        ...actual,
        redactDiagnosticData: (value: unknown): unknown => value,
    };
});

vi.mock('@/utils/serverConnectionErrors', () => ({
    connectionState: { setBackend: vi.fn() },
}));

vi.mock('./cursorQuery', () => ({
    CursorTurnError: class CursorTurnError extends Error {
        public constructor(
            public readonly kind: string,
            message: string,
        ) {
            super(message);
            this.name = 'CursorTurnError';
        }
    },
    runCursorTurn: testState.runCursorTurn,
    isCursorTurnAbortError: testState.isCursorTurnAbortError,
}));

import { runCursor } from './runCursor';
import { parseAgentRunArgs } from '@/agentRunArgs';

function createTestSession(sessionId: string, metadata: Record<string, unknown> = {}): TestSession {
    const session: TestSession = {
        sessionId,
        metadata: { ...metadata },
        metadataUpdates: [],
        lifecycleCalls: [],
        updateMetadata: vi.fn(async (handler: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            session.lifecycleCalls.push('archive');
            session.metadata = handler(session.metadata);
            session.metadataUpdates.push({ ...session.metadata });
        }),
        sendSessionDeath: vi.fn(() => {
            session.lifecycleCalls.push('death');
        }),
        flush: vi.fn(async () => {
            session.lifecycleCalls.push('flush');
        }),
        close: vi.fn(async () => {
            session.lifecycleCalls.push('close');
        }),
        keepAlive: vi.fn(),
        sendAgentMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        cancelPendingUserMessageDelivery: vi.fn(() => true),
        onUserMessage: vi.fn(),
        rpcHandlerManager: {
            registerHandler: vi.fn(),
        },
    };
    return session;
}

function createCredentials(): { token: string; encryption: { type: 'legacy'; secret: Uint8Array } } {
    return {
        token: 'test-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32) },
    };
}

function createQueuedMessage(message: string): QueuedMessage {
    return {
        message,
        mode: { launchControls: { ...TEST_CURSOR_LAUNCH_CONTROLS } },
        isolate: false,
        hash: 'agent-mode',
    };
}

async function waitForMessageQueue(): Promise<InstanceType<typeof testState.FakeMessageQueue>> {
    await vi.waitFor(() => expect(testState.FakeMessageQueue.instances).toHaveLength(1));
    const queue = testState.FakeMessageQueue.instances[0];
    if (!queue) {
        throw new Error('Message queue was not created');
    }
    return queue;
}

function mirrorInitialMetadata(session: TestSession): void {
    testState.getOrCreateSession.mockImplementationOnce(async (request: {
        metadata: Record<string, unknown>;
    }) => {
        session.metadata = { ...request.metadata };
        return testState.response;
    });
}

describe('runCursor lifecycle', () => {
    beforeEach(() => {
        testState.reset();
        delete process.env.REMCLI_CURSOR_RESUMED_FROM_SESSION_ID;
        delete process.env.REMCLI_DAEMON_RUNNER_TOKEN;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(false);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified' },
        });
        testState.runCursorTurn.mockResolvedValue({
            sessionId: 'cursor-native-session',
            response: 'Cursor response',
            exitCode: 0,
        });
    });

    it('publishes verified stopped-parent lineage before the first child prompt and rolls it back before stop', async () => {
        const parentSessionId = 'trusted-parent-remcli-session';
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: parentSessionId },
        });

        let releaseGetOrCreateSession: (() => void) | undefined;
        const getOrCreateSessionGate = new Promise<void>((resolve) => {
            releaseGetOrCreateSession = resolve;
        });
        testState.getOrCreateSession.mockImplementationOnce(async (request: {
            metadata: Record<string, unknown>;
        }) => {
            session.metadata = { ...request.metadata };
            await getOrCreateSessionGate;
            return testState.response;
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'cursor-native-session',
        });

        await vi.waitFor(() => expect(testState.getOrCreateSession).toHaveBeenCalledOnce());
        const getOrCreateOptions = testState.getOrCreateSession.mock.calls[0]?.[0] as {
            metadata: Record<string, unknown>;
        } | undefined;
        expect(getOrCreateOptions?.metadata).toMatchObject({
            resumedFromRemcliSessionId: parentSessionId,
        });
        expect(testState.preflightDaemonCursorRunner).toHaveBeenCalledWith({
            agent: 'cursor',
            nativeResumeSessionId: 'cursor-native-session',
            pid: process.pid,
        });
        expect(testState.preflightDaemonCursorRunner.mock.invocationCallOrder[0])
            .toBeLessThan(testState.getOrCreateSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
        expect(testState.FakeMessageQueue.instances).toHaveLength(0);
        expect(testState.runCursorTurn).not.toHaveBeenCalled();

        releaseGetOrCreateSession?.();
        await waitForMessageQueue();
        process.emit('SIGTERM');
        await runPromise;

        expect(session.metadataUpdates).toHaveLength(2);
        expect(session.metadataUpdates[0]).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(session.metadataUpdates[1]).toEqual(expect.objectContaining({
            lifecycleState: 'archived',
        }));
        expect(session.metadataUpdates[1]).not.toHaveProperty('resumedFromRemcliSessionId');
    });

    it.each([
        ['missing runner capability', undefined, undefined],
        ['forged runner capability', 'forged-daemon-runner-token', 'cursor-native-forged'],
    ] as const)('creates no metadata or P2P session for parser-style --started-by daemon with %s', async (_case, runnerToken, nativeResumeSessionId) => {
        const parsed = parseAgentRunArgs([
            'cursor',
            '--started-by', 'daemon',
            ...(nativeResumeSessionId ? ['--resume', nativeResumeSessionId] : []),
        ]);
        process.env.REMCLI_CURSOR_RESUMED_FROM_SESSION_ID = 'forged-parent-remcli-session';
        if (runnerToken) {
            process.env.REMCLI_DAEMON_RUNNER_TOKEN = runnerToken;
        }
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: false,
            error: 'daemon runner preflight rejected',
        });

        await runCursor({
            credentials: createCredentials(),
            startedBy: parsed.startedBy,
            resumeSessionId: parsed.resumeSessionId,
            ...(runnerToken ? {
                execution: {
                    model: 'controlled-cursor-model',
                    catalogVersion: 'controlled-cursor-catalog',
                },
                launchControls: { ...TEST_CURSOR_LAUNCH_CONTROLS },
                runner: { ...TEST_CURSOR_RUNNER },
            } : {}),
        });

        expect(parsed).toMatchObject({
            startedBy: 'daemon',
            resumeSessionId: nativeResumeSessionId,
        });
        expect(testState.preflightDaemonCursorRunner).toHaveBeenCalledWith({
            agent: 'cursor',
            nativeResumeSessionId,
            pid: process.pid,
        });
        expect(testState.createSessionMetadata).not.toHaveBeenCalled();
        expect(testState.getOrCreateSession).not.toHaveBeenCalled();
        expect(testState.FakeMessageQueue.instances).toHaveLength(0);
        expect(testState.acquireDaemonRunnerCredential).not.toHaveBeenCalled();
    });

    it('reports an authenticated rejected preflight before P2P setup or a native Cursor turn', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'daemon-owned-runner-token';
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: false,
            error: 'daemon runner preflight rejected',
        });

        await runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            execution: {
                model: 'controlled-cursor-model',
                catalogVersion: 'controlled-cursor-catalog',
            },
            launchControls: { ...TEST_CURSOR_LAUNCH_CONTROLS },
            runner: { ...TEST_CURSOR_RUNNER },
        });

        expect(testState.reportDaemonCursorRunnerBootstrapFailure).toHaveBeenCalledWith({
            agent: 'cursor',
            pid: process.pid,
        });
        expect(testState.createSessionMetadata).not.toHaveBeenCalled();
        expect(testState.getOrCreateSession).not.toHaveBeenCalled();
        expect(testState.runCursorTurn).not.toHaveBeenCalled();
    });

    it('reports authenticated bootstrap failure when daemon settings have no machine id without cleaning up a session', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'daemon-owned-runner-token';
        testState.readSettings.mockResolvedValueOnce({});
        const processExit = vi.spyOn(process, 'exit').mockImplementation((() => {
            throw new Error('test process exit');
        }) as never);

        try {
            await expect(runCursor({
                credentials: createCredentials(),
                startedBy: 'daemon',
                execution: {
                    model: 'controlled-cursor-model',
                    catalogVersion: 'controlled-cursor-catalog',
                },
                launchControls: { ...TEST_CURSOR_LAUNCH_CONTROLS },
                runner: { ...TEST_CURSOR_RUNNER },
            })).rejects.toThrow('test process exit');
        } finally {
            processExit.mockRestore();
        }

        expect(testState.reportDaemonCursorRunnerBootstrapFailure).toHaveBeenCalledWith({
            agent: 'cursor',
            pid: process.pid,
        });
        expect(testState.getOrCreateSession).not.toHaveBeenCalled();
        expect(testState.runCursorTurn).not.toHaveBeenCalled();
        expect(testState.reportDaemonRunnerStopping).not.toHaveBeenCalled();
        expect(testState.reportDaemonRunnerStopped).not.toHaveBeenCalled();
    });

    it('reports authenticated bootstrap failure when P2P session creation returns null without cleaning up a session', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'daemon-owned-runner-token';
        testState.response = null;

        await expect(runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            execution: {
                model: 'controlled-cursor-model',
                catalogVersion: 'controlled-cursor-catalog',
            },
            launchControls: { ...TEST_CURSOR_LAUNCH_CONTROLS },
            runner: { ...TEST_CURSOR_RUNNER },
        })).resolves.toBeUndefined();

        expect(testState.reportDaemonCursorRunnerBootstrapFailure).toHaveBeenCalledWith({
            agent: 'cursor',
            pid: process.pid,
        });
        expect(testState.acquireDaemonRunnerCredential).not.toHaveBeenCalled();
        expect(testState.runCursorTurn).not.toHaveBeenCalled();
        expect(testState.reportDaemonRunnerStopping).not.toHaveBeenCalled();
        expect(testState.reportDaemonRunnerStopped).not.toHaveBeenCalled();
    });

    it('reports an authenticated P2P bootstrap exception before credential handoff or a Cursor turn', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'daemon-owned-runner-token';
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified' },
        });
        testState.createApiClient.mockRejectedValueOnce(new Error('P2P bootstrap unavailable'));

        await expect(runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            execution: {
                model: 'controlled-cursor-model',
                catalogVersion: 'controlled-cursor-catalog',
            },
            launchControls: { ...TEST_CURSOR_LAUNCH_CONTROLS },
            runner: { ...TEST_CURSOR_RUNNER },
        })).resolves.toBeUndefined();

        expect(testState.reportDaemonCursorRunnerBootstrapFailure).toHaveBeenCalledWith({
            agent: 'cursor',
            pid: process.pid,
        });
        expect(testState.getOrCreateSession).not.toHaveBeenCalled();
        expect(testState.acquireDaemonRunnerCredential).not.toHaveBeenCalled();
        expect(testState.runCursorTurn).not.toHaveBeenCalled();
    });

    it('rejects a token-bearing daemon runner that lacks the daemon-validated model and control', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'daemon-owned-runner-token';

        await runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
        });

        expect(testState.preflightDaemonCursorRunner).not.toHaveBeenCalled();
        expect(testState.reportDaemonCursorRunnerBootstrapFailure).toHaveBeenCalledWith({
            agent: 'cursor',
            pid: process.pid,
        });
        expect(testState.createSessionMetadata).not.toHaveBeenCalled();
        expect(testState.getOrCreateSession).not.toHaveBeenCalled();
        expect(testState.runCursorTurn).not.toHaveBeenCalled();
    });

    it('does not report a bootstrap failure without a daemon runner credential', async () => {
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: false,
            error: 'missing daemon runner capability',
        });

        await runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
        });

        expect(testState.reportDaemonCursorRunnerBootstrapFailure).not.toHaveBeenCalled();
        expect(testState.createSessionMetadata).not.toHaveBeenCalled();
        expect(testState.getOrCreateSession).not.toHaveBeenCalled();
    });

    it('rejects a token-bearing daemon runner whose CLI identity changes before P2P creation', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'daemon-owned-runner-token';
        testState.verifyCursorRunnerIdentity.mockResolvedValue(false);

        await runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            execution: {
                model: 'controlled-cursor-model',
                catalogVersion: 'controlled-cursor-catalog',
            },
            launchControls: { ...TEST_CURSOR_LAUNCH_CONTROLS },
            runner: { ...TEST_CURSOR_RUNNER },
        });

        expect(testState.verifyCursorRunnerIdentity).toHaveBeenCalledWith(TEST_CURSOR_RUNNER);
        expect(testState.preflightDaemonCursorRunner).not.toHaveBeenCalled();
        expect(testState.createSessionMetadata).not.toHaveBeenCalled();
        expect(testState.getOrCreateSession).not.toHaveBeenCalled();
    });

    it('publishes fresh daemon metadata only after runner preflight succeeds', async () => {
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);

        let resolvePreflight: ((result: { ok: true; data: { type: 'verified' } }) => void) | undefined;
        const preflightGate = new Promise<{ ok: true; data: { type: 'verified' } }>((resolve) => {
            resolvePreflight = resolve;
        });
        testState.preflightDaemonCursorRunner.mockImplementationOnce(async () => preflightGate);

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
        });

        await vi.waitFor(() => expect(testState.preflightDaemonCursorRunner).toHaveBeenCalledOnce());
        expect(testState.createSessionMetadata).not.toHaveBeenCalled();
        expect(testState.getOrCreateSession).not.toHaveBeenCalled();

        resolvePreflight?.({ ok: true, data: { type: 'verified' } });

        await vi.waitFor(() => expect(testState.getOrCreateSession).toHaveBeenCalledOnce());
        const getOrCreateOptions = testState.getOrCreateSession.mock.calls[0]?.[0] as {
            metadata: Record<string, unknown>;
        } | undefined;
        expect(testState.createSessionMetadata).toHaveBeenCalledWith({
            flavor: 'cursor',
            machineId: 'test-machine',
            startedBy: 'daemon',
        });
        expect(getOrCreateOptions?.metadata).toMatchObject({
            flavor: 'cursor',
            machineId: 'test-machine',
            startedBy: 'daemon',
        });
        expect(getOrCreateOptions?.metadata).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(testState.preflightDaemonCursorRunner.mock.invocationCallOrder[0])
            .toBeLessThan(testState.createSessionMetadata.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
        expect(testState.createSessionMetadata.mock.invocationCallOrder[0])
            .toBeLessThan(testState.getOrCreateSession.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);

        const queue = await waitForMessageQueue();
        queue.resolve(null);
        await runPromise;
    });

    afterEach(() => {
        delete process.env.REMCLI_CURSOR_RESUMED_FROM_SESSION_ID;
        delete process.env.REMCLI_DAEMON_RUNNER_TOKEN;
    });

    it('keeps daemon-verified lineage when the daemon credential handoff fails', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'daemon-owned-runner-token';
        testState.response = { id: 'cursor-session' };
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: {
                type: 'verified',
                parentRemcliSessionId: 'trusted-parent-remcli-session',
            },
        });

        await runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'cursor-native-session',
            execution: {
                model: 'controlled-cursor-model',
                catalogVersion: 'controlled-cursor-catalog',
            },
            launchControls: { ...TEST_CURSOR_LAUNCH_CONTROLS },
            runner: { ...TEST_CURSOR_RUNNER },
        });

        expect(testState.acquireDaemonRunnerCredential).toHaveBeenCalledWith(expect.objectContaining({
            agentName: 'Cursor',
            sessionId: 'cursor-session',
        }));
        const getOrCreateOptions = testState.getOrCreateSession.mock.calls[0]?.[0] as {
            metadata: Record<string, unknown>;
        } | undefined;
        expect(getOrCreateOptions?.metadata).toMatchObject({
            resumedFromRemcliSessionId: 'trusted-parent-remcli-session',
        });
        expect(testState.reportDaemonCursorRunnerBootstrapFailure).toHaveBeenCalledWith({
            agent: 'cursor',
            pid: process.pid,
        });
        expect(testState.sessionSyncClient).not.toHaveBeenCalled();
        expect(testState.runCursorTurn).not.toHaveBeenCalled();
    });

    it.each(['SIGTERM', 'SIGINT', 'SIGHUP'] as const)('cleans up exactly once for %s', async (signal) => {
        const session = createTestSession('offline-session');
        testState.initialSession = session;

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'terminal',
        });
        await waitForMessageQueue();

        process.emit(signal);
        await runPromise;

        expect(session.lifecycleCalls).toEqual(['archive', 'death', 'flush', 'close']);
        expect(session.updateMetadata).toHaveBeenLastCalledWith(
            expect.any(Function),
            expect.objectContaining({ maxAttempts: 2, timeoutMs: 1_000 }),
        );
        expect(session.updateMetadata).toHaveBeenCalledOnce();
        expect(session.sendSessionDeath).toHaveBeenCalledOnce();
        expect(session.flush).toHaveBeenCalledOnce();
        expect(session.close).toHaveBeenCalledOnce();
        expect(testState.reconnectionCancel).toHaveBeenCalledOnce();
    });

    it('notifies the daemon before and after a graceful daemon-owned Cursor runner cleanup', async () => {
        const session = createTestSession('daemon-owned-session');
        testState.response = { id: session.sessionId };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.reportDaemonRunnerStopping.mockResolvedValue({ ok: true, data: { accepted: true } });
        testState.reportDaemonRunnerStopped.mockResolvedValue({ ok: true, data: { accepted: true } });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
        });
        await waitForMessageQueue();

        process.emit('SIGINT');
        await runPromise;

        expect(testState.reportDaemonRunnerStopping).toHaveBeenCalledWith(session.sessionId);
        expect(testState.reportDaemonRunnerStopped).toHaveBeenCalledWith(session.sessionId);
        expect(testState.reportDaemonRunnerStopping.mock.invocationCallOrder[0])
            .toBeLessThan(session.sendSessionDeath.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
        expect(testState.reportDaemonRunnerStopped.mock.invocationCallOrder[0])
            .toBeGreaterThan(session.close.mock.invocationCallOrder[0] ?? 0);
    });

    it('titles the swapped session after reconnect and keeps title assignment one-shot', async () => {
        const offlineSession = createTestSession('offline-session');
        const swappedSession = createTestSession('reconnected-session');
        testState.initialSession = offlineSession;

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'terminal',
        });
        await vi.waitFor(() => expect(testState.reconnectionOptions).not.toBeNull());
        testState.reconnectionOptions?.onSessionSwap(swappedSession);
        const queue = await waitForMessageQueue();

        queue.resolve(createQueuedMessage('first Cursor prompt'));
        await vi.waitFor(() => expect(testState.runCursorTurn).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(swappedSession.metadata.summary).toEqual(expect.objectContaining({
            text: 'first Cursor prompt',
        })));

        queue.resolve(createQueuedMessage('second Cursor prompt'));
        await vi.waitFor(() => expect(testState.runCursorTurn).toHaveBeenCalledTimes(2));

        const titleUpdates = swappedSession.metadataUpdates.filter((metadata) => 'summary' in metadata);
        expect(titleUpdates).toHaveLength(1);
        expect(offlineSession.metadata).not.toHaveProperty('summary');

        process.emit('SIGTERM');
        await runPromise;
    });

    it('acquires and confirms the Cursor writer lease before publishing native daemon metadata', async () => {
        const parentSessionId = 'trusted-parent-remcli-session';
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: parentSessionId },
        });
        mirrorInitialMetadata(session);
        testState.bindDaemonCursorSession.mockResolvedValue({
            ok: true,
            data: {
                type: 'bound',
                wrapper: {
                    agent: 'cursor',
                    nativeSessionId: 'cursor-native-confirmed',
                    remcliSessionId: 'cursor-session',
                },
                writerLease: { ...TEST_HEADLESS_WRITER_LEASE },
            },
        });
        testState.runCursorTurn.mockImplementation(async (
            _options: unknown,
            onEvent: (event: CursorStreamEvent) => void | Promise<void>,
        ) => {
            await onEvent({
                type: 'system',
                subtype: 'init',
                session_id: 'cursor-native-confirmed',
            });
            return {
                sessionId: 'cursor-native-confirmed',
                response: 'Cursor response',
                exitCode: 0,
            };
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'cursor-native-confirmed',
        });
        const queue = await waitForMessageQueue();
        queue.resolve(createQueuedMessage('first daemon Cursor prompt'));

        await vi.waitFor(() => expect(testState.bindDaemonCursorSession).toHaveBeenCalledOnce());
        const getOrCreateOptions = testState.getOrCreateSession.mock.calls[0]?.[0] as {
            metadata: Record<string, unknown>;
        } | undefined;
        expect(getOrCreateOptions?.metadata).toMatchObject({
            resumedFromRemcliSessionId: parentSessionId,
        });
        expect(testState.bindDaemonCursorSession).toHaveBeenCalledWith({
            agent: 'cursor',
            nativeSessionId: 'cursor-native-confirmed',
            remcliSessionId: 'cursor-session',
            writerLeaseId: TEST_HEADLESS_WRITER_LEASE.leaseId,
        });
        expect(testState.acquireDaemonCursorHeadlessWriterLease).toHaveBeenCalledWith({
            agent: 'cursor',
            nativeSessionId: 'cursor-native-confirmed',
            remcliSessionId: 'cursor-session',
        });
        await vi.waitFor(() => expect(testState.releaseDaemonCursorNativeWriterLease).toHaveBeenCalledWith({
            agent: 'cursor',
            leaseId: TEST_HEADLESS_WRITER_LEASE.leaseId,
            nativeSessionId: 'cursor-native-confirmed',
            remcliSessionId: 'cursor-session',
        }));
        const acquireOrder = testState.acquireDaemonCursorHeadlessWriterLease.mock.invocationCallOrder[0];
        const bindOrder = testState.bindDaemonCursorSession.mock.invocationCallOrder[0];
        const turnOrder = testState.runCursorTurn.mock.invocationCallOrder[0];
        const releaseOrder = testState.releaseDaemonCursorNativeWriterLease.mock.invocationCallOrder[0];
        expect(acquireOrder).toBeLessThan(turnOrder!);
        expect(turnOrder).toBeLessThan(bindOrder!);
        expect(turnOrder).toBeLessThan(releaseOrder!);
        expect(bindOrder).toBeLessThan(releaseOrder!);
        expect(session.metadata).toMatchObject({
            agentSessionId: 'cursor-native-confirmed',
            cursorSessionId: 'cursor-native-confirmed',
            resumedFromRemcliSessionId: 'trusted-parent-remcli-session',
        });
        expect(testState.reportTerminalSessionStarted).not.toHaveBeenCalled();
        expect(testState.acquireDaemonRunnerCredential).toHaveBeenCalledOnce();

        process.emit('SIGINT');
        await runPromise;
    });

    it('does not start a known Cursor resume while an interactive writer owns the native session', async () => {
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified' },
        });
        testState.acquireDaemonCursorHeadlessWriterLease.mockResolvedValue({
            ok: true,
            data: {
                type: 'writer-busy',
                request: {
                    agent: 'cursor',
                    nativeSessionId: 'cursor-native-confirmed',
                    remcliSessionId: 'cursor-session',
                },
                owner: 'interactive',
            },
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'cursor-native-confirmed',
        });
        const queue = await waitForMessageQueue();
        queue.resolve(createQueuedMessage('resume after terminal handoff'));

        await vi.waitFor(() => expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'message',
            isError: true,
            message: 'Cursor native session is already controlled by an active interactive writer.',
        })));
        expect(session.sendAgentMessage).not.toHaveBeenCalledWith('cursor', expect.objectContaining({ type: 'task_started' }));
        expect(testState.runCursorTurn).not.toHaveBeenCalled();
        expect(testState.bindDaemonCursorSession).not.toHaveBeenCalled();

        process.emit('SIGTERM');
        await runPromise;
    });

    it('stops fail-closed when the daemon cannot confirm headless Cursor writer lease release', async () => {
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified' },
        });
        testState.bindDaemonCursorSession.mockResolvedValue({
            ok: true,
            data: {
                type: 'bound',
                wrapper: {
                    agent: 'cursor',
                    nativeSessionId: 'cursor-native-confirmed',
                    remcliSessionId: 'cursor-session',
                },
                writerLease: { ...TEST_HEADLESS_WRITER_LEASE },
            },
        });
        testState.releaseDaemonCursorNativeWriterLease.mockResolvedValue({
            ok: false,
            error: 'controlled release transport failure',
        });
        testState.runCursorTurn.mockImplementation(async (
            _options: unknown,
            onEvent: (event: CursorStreamEvent) => void | Promise<void>,
        ) => {
            await onEvent({
                type: 'system',
                subtype: 'init',
                session_id: 'cursor-native-confirmed',
            });
            return {
                sessionId: 'cursor-native-confirmed',
                response: 'Cursor response',
                exitCode: 0,
            };
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'cursor-native-confirmed',
        });
        const queue = await waitForMessageQueue();
        queue.resolve(createQueuedMessage('first daemon Cursor prompt'));

        await expect(runPromise).resolves.toBeUndefined();
        expect(testState.runCursorTurn).toHaveBeenCalledOnce();
        expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', {
            type: 'message',
            message: 'Cursor session stopped because Remcli could not safely release native session ownership. Resume it to continue.',
            isError: true,
        });
        expect(testState.reportDaemonRunnerStopping).toHaveBeenCalledWith('cursor-session');
        expect(testState.reportDaemonRunnerStopped).toHaveBeenCalledWith('cursor-session');
    });

    it('rolls back provisional lineage when daemon Cursor binding is rejected without publishing task_complete', async () => {
        const parentSessionId = 'trusted-parent-remcli-session';
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: parentSessionId },
        });
        mirrorInitialMetadata(session);
        testState.bindDaemonCursorSession.mockResolvedValue({
            ok: true,
            data: {
                type: 'reuse-active-wrapper',
                wrapper: {
                    agent: 'cursor',
                    nativeSessionId: 'cursor-native-owned',
                    remcliSessionId: 'other-cursor-wrapper',
                },
            },
        });
        testState.runCursorTurn.mockImplementation(async (
            _options: unknown,
            onEvent: (event: CursorStreamEvent) => void | Promise<void>,
        ) => {
            await onEvent({
                type: 'system',
                subtype: 'init',
                session_id: 'cursor-native-owned',
            });
            return {
                sessionId: 'cursor-native-owned',
                response: 'must not be delivered',
                exitCode: 0,
            };
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'cursor-native-owned',
        });
        const queue = await waitForMessageQueue();
        queue.resolve(createQueuedMessage('daemon Cursor prompt'));

        await vi.waitFor(() => expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'message',
            isError: true,
            message: 'Cursor native session is already owned by active wrapper other-cursor-wrapper.',
        })));
        expect(session.sendAgentMessage).not.toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'task_complete',
        }));
        const getOrCreateOptions = testState.getOrCreateSession.mock.calls[0]?.[0] as {
            metadata: Record<string, unknown>;
        } | undefined;
        expect(getOrCreateOptions?.metadata).toMatchObject({
            resumedFromRemcliSessionId: parentSessionId,
        });
        expect(session.updateMetadata).toHaveBeenCalledOnce();
        expect(session.metadata).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(session.metadataUpdates[0]).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(testState.reportTerminalSessionStarted).not.toHaveBeenCalled();

        process.emit('SIGTERM');
        await runPromise;

        expect(session.metadataUpdates[1]).toEqual(expect.objectContaining({
            lifecycleState: 'archived',
        }));
        expect(session.metadataUpdates[1]).not.toHaveProperty('resumedFromRemcliSessionId');
    });

    it('publishes a visible binding transport error after init without completing the task or publishing native metadata', async () => {
        const session = createTestSession('cursor-session');
        const transportFailure = 'daemon transport unavailable';
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.bindDaemonCursorSession.mockResolvedValue({
            ok: false,
            error: transportFailure,
        });
        testState.runCursorTurn.mockImplementation(async (
            _options: unknown,
            onEvent: (event: CursorStreamEvent) => void | Promise<void>,
        ) => {
            await onEvent({
                type: 'system',
                subtype: 'init',
                session_id: 'cursor-native-transport-failure',
            });
            return {
                sessionId: 'cursor-native-transport-failure',
                response: 'must not be delivered',
                exitCode: 0,
            };
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
        });
        const queue = await waitForMessageQueue();
        queue.resolve(createQueuedMessage('daemon Cursor prompt'));

        await vi.waitFor(() => expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', {
            type: 'message',
            message: `Cursor native session binding failed: ${transportFailure}`,
            isError: true,
        }));
        expect(testState.bindDaemonCursorSession).toHaveBeenCalledWith({
            agent: 'cursor',
            nativeSessionId: 'cursor-native-transport-failure',
            remcliSessionId: 'cursor-session',
        });
        expect(session.sendAgentMessage).not.toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'task_complete',
        }));
        expect(session.updateMetadata).not.toHaveBeenCalled();
        expect(session.metadata).not.toHaveProperty('agentSessionId');
        expect(session.metadata).not.toHaveProperty('cursorSessionId');
        expect(session.metadata).not.toHaveProperty('resumedFromRemcliSessionId');

        process.emit('SIGTERM');
        await runPromise;

        const nativeMetadataUpdates = session.metadataUpdates.filter((metadata) =>
            'agentSessionId' in metadata || 'cursorSessionId' in metadata,
        );
        expect(nativeMetadataUpdates).toEqual([]);
    });

    it('rolls back provisional parent history when Cursor rejects a native resume mismatch', async () => {
        const parentSessionId = 'trusted-parent-remcli-session';
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: parentSessionId },
        });
        mirrorInitialMetadata(session);
        const expectedNativeSessionId = 'expected-native-session';
        const writerLease = { ...TEST_HEADLESS_WRITER_LEASE, nativeSessionId: expectedNativeSessionId };
        testState.acquireDaemonCursorHeadlessWriterLease.mockResolvedValue({
            ok: true,
            data: { type: 'acquired', writerLease },
        });
        testState.bindDaemonCursorSession.mockResolvedValue({
            ok: true,
            data: {
                type: 'bound',
                wrapper: {
                    agent: 'cursor',
                    nativeSessionId: 'foreign-native-session',
                    remcliSessionId: 'cursor-session',
                },
                writerLease,
            },
        });
        testState.runCursorTurn.mockImplementation(async (
            _options: unknown,
            onEvent: (event: CursorStreamEvent) => void | Promise<void>,
        ) => {
            await onEvent({
                type: 'system',
                subtype: 'init',
                session_id: 'foreign-native-session',
            });
            return {
                sessionId: 'foreign-native-session',
                response: 'must not be delivered',
                exitCode: 0,
            };
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: expectedNativeSessionId,
        });
        const queue = await waitForMessageQueue();
        queue.resolve(createQueuedMessage('resume Cursor prompt'));

        await vi.waitFor(() => expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', expect.objectContaining({
            isError: true,
            message: 'Cursor resumed a different native session. The existing session was not changed.',
        })));
        const getOrCreateOptions = testState.getOrCreateSession.mock.calls[0]?.[0] as {
            metadata: Record<string, unknown>;
        } | undefined;
        expect(getOrCreateOptions?.metadata).toMatchObject({
            resumedFromRemcliSessionId: parentSessionId,
        });
        expect(testState.bindDaemonCursorSession).toHaveBeenCalledWith({
            agent: 'cursor',
            nativeSessionId: 'foreign-native-session',
            remcliSessionId: 'cursor-session',
            writerLeaseId: writerLease.leaseId,
        });
        await vi.waitFor(() => expect(testState.releaseDaemonCursorNativeWriterLease).toHaveBeenCalledWith({
            agent: 'cursor',
            leaseId: writerLease.leaseId,
            nativeSessionId: expectedNativeSessionId,
            remcliSessionId: 'cursor-session',
        }));
        expect(session.updateMetadata).toHaveBeenCalledOnce();
        expect(session.metadata).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(session.metadataUpdates[0]).not.toHaveProperty('resumedFromRemcliSessionId');

        process.emit('SIGTERM');
        await runPromise;

        expect(session.metadataUpdates[1]).toEqual(expect.objectContaining({
            lifecycleState: 'archived',
        }));
        expect(session.metadataUpdates[1]).not.toHaveProperty('resumedFromRemcliSessionId');
    });

    it('rolls back provisional parent history when Cursor fails before native init', async () => {
        const parentSessionId = 'trusted-parent-remcli-session';
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: parentSessionId },
        });
        mirrorInitialMetadata(session);
        testState.runCursorTurn.mockRejectedValue(new Error('Cursor CLI failed before system/init'));

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'expected-native-session',
        });
        const queue = await waitForMessageQueue();
        queue.resolve(createQueuedMessage('resume Cursor prompt'));

        await vi.waitFor(() => expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'message',
            message: 'Cursor CLI failed before system/init',
            isError: true,
        })));
        expect(testState.bindDaemonCursorSession).not.toHaveBeenCalled();
        expect(session.metadataUpdates).toHaveLength(1);
        expect(session.metadata).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(session.metadataUpdates[0]).not.toHaveProperty('resumedFromRemcliSessionId');

        process.emit('SIGTERM');
        await runPromise;

        expect(session.metadataUpdates[1]).toEqual(expect.objectContaining({
            lifecycleState: 'archived',
        }));
        expect(session.metadataUpdates[1]).not.toHaveProperty('resumedFromRemcliSessionId');
    });

    it('removes provisional parent lineage before archiving when stop aborts before native init', async () => {
        const parentSessionId = 'trusted-parent-remcli-session';
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: parentSessionId },
        });
        mirrorInitialMetadata(session);
        testState.isCursorTurnAbortError.mockReturnValue(true);
        testState.runCursorTurn.mockImplementation((options: { abort: AbortSignal }) => (
            new Promise<never>((_resolve, reject) => {
                options.abort.addEventListener('abort', () => {
                    reject(new CursorTurnError('aborted', 'Cursor turn aborted before system/init'));
                }, { once: true });
            })
        ));

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'expected-native-session',
        });
        const queue = await waitForMessageQueue();
        queue.resolve(createQueuedMessage('resume Cursor prompt'));
        await vi.waitFor(() => expect(testState.runCursorTurn).toHaveBeenCalledOnce());

        process.emit('SIGTERM');
        await runPromise;

        expect(testState.bindDaemonCursorSession).not.toHaveBeenCalled();
        expect(session.metadataUpdates).toHaveLength(2);
        expect(session.metadataUpdates[0]).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(session.metadataUpdates[1]).toEqual(expect.objectContaining({
            lifecycleState: 'archived',
        }));
        expect(session.metadataUpdates[1]).not.toHaveProperty('resumedFromRemcliSessionId');
    });

    it('removes provisional parent history while an idle abort resets the native resume', async () => {
        const parentSessionId = 'trusted-parent-remcli-session';
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: parentSessionId },
        });
        mirrorInitialMetadata(session);

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'expected-native-session',
        });

        await waitForMessageQueue();
        const abortHandler = session.rpcHandlerManager.registerHandler.mock.calls.find(
            ([name]) => name === 'abort',
        )?.[1] as (() => Promise<void>) | undefined;
        expect(abortHandler).toBeDefined();

        await abortHandler?.();

        expect(session.metadata).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(session.metadataUpdates).toHaveLength(1);
        expect(session.metadataUpdates[0]).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(testState.runCursorTurn).not.toHaveBeenCalled();

        process.emit('SIGTERM');
        await runPromise;

        expect(session.metadataUpdates[1]).toEqual(expect.objectContaining({
            lifecycleState: 'archived',
        }));
        expect(session.metadataUpdates[1]).not.toHaveProperty('resumedFromRemcliSessionId');
    });

    it('waits for an idle lineage rollback before accepting a fresh prompt', async () => {
        const parentSessionId = 'trusted-parent-remcli-session';
        const session = createTestSession('cursor-session');
        let releaseRollback: (() => void) | undefined;
        const rollbackGate = new Promise<void>((resolve) => {
            releaseRollback = resolve;
        });
        let isFirstMetadataUpdate = true;
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: parentSessionId },
        });
        mirrorInitialMetadata(session);
        session.updateMetadata.mockImplementation(async (handler: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            const updatedMetadata = handler(session.metadata);
            if (isFirstMetadataUpdate) {
                isFirstMetadataUpdate = false;
                await rollbackGate;
            }
            session.lifecycleCalls.push('archive');
            session.metadata = updatedMetadata;
            session.metadataUpdates.push({ ...session.metadata });
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'expected-native-session',
        });
        const queue = await waitForMessageQueue();
        const abortHandler = session.rpcHandlerManager.registerHandler.mock.calls.find(
            ([name]) => name === 'abort',
        )?.[1] as (() => Promise<void>) | undefined;
        expect(abortHandler).toBeDefined();

        const abortPromise = abortHandler?.();
        await vi.waitFor(() => expect(session.updateMetadata).toHaveBeenCalledOnce());
        await new Promise<void>((resolve) => setTimeout(resolve, 25));

        expect(queue.waitCount).toBe(1);
        expect(testState.runCursorTurn).not.toHaveBeenCalled();
        expect(session.metadata).toMatchObject({ resumedFromRemcliSessionId: parentSessionId });

        releaseRollback?.();
        await abortPromise;
        await vi.waitFor(() => expect(queue.waitCount).toBe(2));
        queue.resolve(createQueuedMessage('Start a fresh native Cursor session.'));
        await vi.waitFor(() => expect(testState.runCursorTurn).toHaveBeenCalledOnce());

        expect(testState.runCursorTurn.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
            resumeSessionId: undefined,
        }));
        expect(session.metadata).not.toHaveProperty('resumedFromRemcliSessionId');

        process.emit('SIGTERM');
        await runPromise;
    });

    it('fails closed when provisional parent rollback transport is rejected', async () => {
        const parentSessionId = 'trusted-parent-remcli-session';
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: parentSessionId },
        });
        mirrorInitialMetadata(session);
        session.updateMetadata.mockRejectedValueOnce(new Error('metadata transport rejected rollback'));

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'expected-native-session',
        });

        const queue = await waitForMessageQueue();
        const abortHandler = session.rpcHandlerManager.registerHandler.mock.calls.find(
            ([name]) => name === 'abort',
        )?.[1] as (() => Promise<void>) | undefined;
        expect(abortHandler).toBeDefined();

        await expect(abortHandler?.()).rejects.toThrow('metadata transport rejected rollback');
        await runPromise;

        expect(testState.runCursorTurn).not.toHaveBeenCalled();
        expect(session.metadataUpdates).toHaveLength(1);
        expect(session.metadataUpdates[0]).toEqual(expect.objectContaining({
            lifecycleState: 'archived',
        }));
        expect(session.metadataUpdates[0]).not.toHaveProperty('resumedFromRemcliSessionId');
    });

    it('preserves the parent relation when Cursor fails after matching init and daemon binding', async () => {
        const parentSessionId = 'trusted-parent-remcli-session';
        const nativeSessionId = 'cursor-native-confirmed';
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.preflightDaemonCursorRunner.mockResolvedValue({
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: parentSessionId },
        });
        mirrorInitialMetadata(session);
        testState.bindDaemonCursorSession.mockResolvedValue({
            ok: true,
            data: {
                type: 'bound',
                wrapper: {
                    agent: 'cursor',
                    nativeSessionId,
                    remcliSessionId: 'cursor-session',
                },
                writerLease: { ...TEST_HEADLESS_WRITER_LEASE, nativeSessionId },
            },
        });
        testState.runCursorTurn.mockImplementation(async (
            _options: unknown,
            onEvent: (event: CursorStreamEvent) => void | Promise<void>,
        ) => {
            await onEvent({
                type: 'system',
                subtype: 'init',
                session_id: nativeSessionId,
            });
            throw new Error('Cursor CLI failed after native confirmation');
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: nativeSessionId,
        });
        const queue = await waitForMessageQueue();
        queue.resolve(createQueuedMessage('resume Cursor prompt'));

        await vi.waitFor(() => expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'message',
            message: 'Cursor CLI failed after native confirmation',
            isError: true,
        })));
        expect(testState.bindDaemonCursorSession).toHaveBeenCalledWith({
            agent: 'cursor',
            nativeSessionId,
            remcliSessionId: 'cursor-session',
            writerLeaseId: TEST_HEADLESS_WRITER_LEASE.leaseId,
        });
        await vi.waitFor(() => expect(testState.releaseDaemonCursorNativeWriterLease).toHaveBeenCalledWith({
            agent: 'cursor',
            leaseId: TEST_HEADLESS_WRITER_LEASE.leaseId,
            nativeSessionId,
            remcliSessionId: 'cursor-session',
        }));
        expect(session.metadataUpdates).toHaveLength(1);
        expect(session.metadata).toMatchObject({
            cursorSessionId: nativeSessionId,
            resumedFromRemcliSessionId: parentSessionId,
        });

        process.emit('SIGTERM');
        await runPromise;

        expect(session.metadataUpdates[1]).toEqual(expect.objectContaining({
            lifecycleState: 'archived',
            resumedFromRemcliSessionId: parentSessionId,
        }));
    });

    it('keeps launch controls and model immutable when a phone message forges generic overrides', async () => {
        const session = createTestSession('cursor-session');
        testState.initialSession = session;

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'terminal',
        });
        const queue = await waitForMessageQueue();
        const userMessageHandler = session.onUserMessage.mock.calls[0]?.[0] as ((message: {
            content: { text: string };
            meta?: { permissionMode?: string; model?: string };
        }) => void) | undefined;
        if (!userMessageHandler) {
            throw new Error('Cursor user-message handler was not registered.');
        }

        userMessageHandler({
            content: { text: 'forged phone prompt' },
            meta: { permissionMode: 'plan', model: 'forged-not-account-visible-model' },
        });

        expect(queue.pushed).toEqual([{
            message: 'forged phone prompt',
            mode: { launchControls: TEST_CURSOR_LAUNCH_CONTROLS, model: undefined },
        }]);
        process.emit('SIGTERM');
        await runPromise;
    });

    it('resumes the same native Cursor chat with a consumed model change and acknowledges only after init binding and metadata', async () => {
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.consumeDaemonSessionExecution.mockResolvedValue({
            ok: true,
            data: {
                sessionId: 'cursor-session',
                provider: 'cursor',
                revision: 2,
                current: {
                    provider: 'cursor',
                    model: 'changed-cursor-model',
                    catalogVersion: 'catalog-2',
                },
                didApplyPending: true,
            },
        });
        testState.acquireDaemonCursorHeadlessWriterLease.mockResolvedValue({
            ok: true,
            data: {
                type: 'acquired',
                writerLease: { ...TEST_HEADLESS_WRITER_LEASE, nativeSessionId: 'existing-native-session' },
            },
        });
        testState.bindDaemonCursorSession.mockResolvedValue({
            ok: true,
            data: {
                type: 'bound',
                wrapper: {
                    agent: 'cursor',
                    nativeSessionId: 'existing-native-session',
                    remcliSessionId: 'cursor-session',
                },
                writerLease: { ...TEST_HEADLESS_WRITER_LEASE, nativeSessionId: 'existing-native-session' },
            },
        });
        testState.runCursorTurn.mockImplementation(async (
            _options: unknown,
            onEvent: (event: CursorStreamEvent) => void | Promise<void>,
        ) => {
            await onEvent({ type: 'system', subtype: 'init', session_id: 'existing-native-session' });
            return { sessionId: 'existing-native-session', response: 'done', exitCode: 0 };
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'existing-native-session',
            execution: { model: 'initial-cursor-model', catalogVersion: 'catalog-1' },
            launchControls: { ...TEST_CURSOR_LAUNCH_CONTROLS },
            runner: { ...TEST_CURSOR_RUNNER },
        });
        const queue = await waitForMessageQueue();
        const userMessageHandler = session.onUserMessage.mock.calls[0]?.[0] as ((message: {
            content: { text: string };
            deliveryId: string;
        }) => Promise<void>) | undefined;
        if (!userMessageHandler) {
            throw new Error('Cursor user-message handler was not registered.');
        }

        const userDelivery = userMessageHandler({
            content: { text: 'next prompt' },
            deliveryId: 'p2p:cursor-session:1',
        });
        await vi.waitFor(() => expect(queue.pushed).toEqual([{
            message: 'next prompt',
            mode: expect.objectContaining({ model: 'changed-cursor-model' }),
        }]));
        const acknowledge = vi.fn();
        queue.resolve({
            message: 'next prompt',
            mode: queue.pushed[0]!.mode,
            isolate: false,
            hash: 'launch-controls-only',
            acknowledge,
        });

        await userDelivery;
        await vi.waitFor(() => expect(testState.runCursorTurn).toHaveBeenCalledWith(expect.objectContaining({
            model: 'changed-cursor-model',
            resumeSessionId: 'existing-native-session',
        }), expect.any(Function)));
        expect(acknowledge).toHaveBeenCalledOnce();
        expect(session.metadataUpdates).toContainEqual(expect.objectContaining({
            cursorExecution: { model: 'changed-cursor-model' },
        }));

        process.emit('SIGTERM');
        await runPromise;
    });

    it('reconciles post-init metadata without acknowledging or executing a durable Cursor prompt twice', async () => {
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        session.updateMetadata
            .mockRejectedValueOnce(new Error(
                'Cursor native metadata timeout at https://daemon.local/sync?token=first-secret',
            ))
            .mockRejectedValueOnce(new Error(
                'Cursor native metadata still unavailable at https://daemon.local/sync?token=second-secret',
            ));
        testState.bindDaemonCursorSession.mockResolvedValue({
            ok: true,
            data: {
                type: 'bound',
                wrapper: {
                    agent: 'cursor',
                    nativeSessionId: 'cursor-native-post-init',
                    remcliSessionId: 'cursor-session',
                },
                writerLease: {
                    ...TEST_HEADLESS_WRITER_LEASE,
                    nativeSessionId: 'cursor-native-post-init',
                },
            },
        });
        testState.runCursorTurn.mockImplementation(async (
            _options: unknown,
            onEvent: (event: CursorStreamEvent) => void | Promise<void>,
        ) => {
            await onEvent({
                type: 'system',
                subtype: 'init',
                session_id: 'cursor-native-post-init',
            });
            return {
                sessionId: 'cursor-native-post-init',
                response: 'single native response',
                exitCode: 0,
            };
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            execution: { model: 'controlled-cursor-model', catalogVersion: 'controlled-cursor-catalog' },
            runner: { ...TEST_CURSOR_RUNNER },
        });
        const queue = await waitForMessageQueue();
        const userMessageHandler = session.onUserMessage.mock.calls[0]?.[0] as ((message: {
            content: { text: string };
            deliveryId: string;
        }) => Promise<void>) | undefined;
        if (!userMessageHandler) {
            throw new Error('Cursor user-message handler was not registered.');
        }

        const deliveryId = 'p2p:cursor-session:post-init-metadata';
        const delivery = {
            content: { text: 'execute exactly once' },
            deliveryId,
        };
        const firstAttempt = userMessageHandler(delivery);
        await vi.waitFor(() => expect(queue.pushed).toHaveLength(1));
        const acknowledge = vi.fn();
        const reject = vi.fn();
        queue.resolve({
            message: 'execute exactly once',
            mode: queue.pushed[0]!.mode,
            isolate: false,
            hash: 'post-init-metadata',
            acknowledge,
            reject,
        });

        await expect(firstAttempt).rejects.toBeInstanceOf(RetryableUserMessageDeliveryError);
        expect(acknowledge).not.toHaveBeenCalled();
        expect(reject).toHaveBeenCalledOnce();
        expect(session.cancelPendingUserMessageDelivery).not.toHaveBeenCalled();
        expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', {
            type: 'message',
            message: 'Cursor native metadata still unavailable at https://daemon.local/sync?token=[REDACTED]',
            isError: true,
        });
        expect(session.metadata).not.toHaveProperty('cursorSessionId');
        expect(testState.runCursorTurn).toHaveBeenCalledOnce();

        await expect(userMessageHandler(delivery)).resolves.toBeUndefined();

        expect(queue.pushed).toHaveLength(1);
        expect(testState.consumeDaemonSessionExecution).toHaveBeenCalledOnce();
        expect(testState.bindDaemonCursorSession).toHaveBeenCalledOnce();
        expect(testState.runCursorTurn).toHaveBeenCalledOnce();
        expect(session.cancelPendingUserMessageDelivery).not.toHaveBeenCalled();
        expect(session.metadata).toMatchObject({
            agentSessionId: 'cursor-native-post-init',
            cursorSessionId: 'cursor-native-post-init',
            cursorExecution: { model: 'controlled-cursor-model' },
        });
        expect(session.sendAgentMessage).toHaveBeenCalledTimes(4);

        process.emit('SIGTERM');
        await runPromise;
    });

    it('keeps rapid durable prompts in separate batches across a model change', async () => {
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.consumeDaemonSessionExecution
            .mockResolvedValueOnce({
                ok: true,
                data: {
                    sessionId: 'cursor-session',
                    provider: 'cursor',
                    revision: 0,
                    current: { provider: 'cursor', model: 'cursor-model-a', catalogVersion: 'catalog-a' },
                    didApplyPending: false,
                },
            })
            .mockResolvedValueOnce({
                ok: true,
                data: {
                    sessionId: 'cursor-session',
                    provider: 'cursor',
                    revision: 1,
                    current: { provider: 'cursor', model: 'cursor-model-b', catalogVersion: 'catalog-b' },
                    didApplyPending: true,
                },
            });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            execution: { model: 'cursor-model-a', catalogVersion: 'catalog-a' },
            runner: { ...TEST_CURSOR_RUNNER },
        });
        const queue = await waitForMessageQueue();
        const userMessageHandler = session.onUserMessage.mock.calls[0]?.[0] as ((message: {
            content: { text: string };
            deliveryId: string;
        }) => Promise<void>) | undefined;
        if (!userMessageHandler) {
            throw new Error('Cursor user-message handler was not registered.');
        }

        void userMessageHandler({ content: { text: 'first durable prompt' }, deliveryId: 'p2p:cursor-session:1' });
        void userMessageHandler({ content: { text: 'second durable prompt' }, deliveryId: 'p2p:cursor-session:2' });

        await vi.waitFor(() => expect(queue.pushed).toEqual([
            expect.objectContaining({ message: 'first durable prompt', mode: expect.objectContaining({ model: 'cursor-model-a' }) }),
            expect.objectContaining({ message: 'second durable prompt', mode: expect.objectContaining({ model: 'cursor-model-b' }) }),
        ]));
        expect(queue.modeHashes).toHaveLength(2);
        expect(queue.modeHashes[0]).not.toBe(queue.modeHashes[1]);

        process.emit('SIGTERM');
        await runPromise;
    });

    it('does not block an unchanged daemon Cursor prompt on a metadata write', async () => {
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            execution: { model: 'controlled-cursor-model', catalogVersion: 'controlled-cursor-catalog' },
            runner: { ...TEST_CURSOR_RUNNER },
        });
        const queue = await waitForMessageQueue();
        const userMessageHandler = session.onUserMessage.mock.calls[0]?.[0] as ((message: {
            content: { text: string };
            deliveryId: string;
        }) => Promise<void>) | undefined;
        if (!userMessageHandler) {
            throw new Error('Cursor user-message handler was not registered.');
        }

        void userMessageHandler({
            content: { text: 'unchanged execution prompt' },
            deliveryId: 'p2p:cursor-session:unchanged',
        });
        await vi.waitFor(() => expect(queue.pushed).toHaveLength(1));
        expect(session.updateMetadata).not.toHaveBeenCalled();

        process.emit('SIGTERM');
        await runPromise;
    });

    it('keeps a durable Cursor prompt pending when execution consume is temporarily unavailable', async () => {
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.consumeDaemonSessionExecution.mockResolvedValueOnce({
            ok: false,
            error: 'Request failed: /session-execution-consume, HTTP 503',
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            execution: { model: 'controlled-cursor-model', catalogVersion: 'controlled-cursor-catalog' },
            runner: { ...TEST_CURSOR_RUNNER },
        });
        const queue = await waitForMessageQueue();
        const userMessageHandler = session.onUserMessage.mock.calls[0]?.[0] as ((message: {
            content: { text: string };
            deliveryId: string;
        }) => Promise<void>) | undefined;
        if (!userMessageHandler) {
            throw new Error('Cursor user-message handler was not registered.');
        }

        const deliveryId = 'p2p:cursor-session:consume-unavailable';
        await expect(userMessageHandler({
            content: { text: 'retry after daemon recovery' },
            deliveryId,
        })).rejects.toEqual(expect.objectContaining({
            name: 'RetryableUserMessageDeliveryError',
            message: 'Cursor execution selection could not be applied: Request failed: /session-execution-consume, HTTP 503',
        }));

        expect(queue.pushed).toEqual([]);
        expect(session.cancelPendingUserMessageDelivery).not.toHaveBeenCalled();
        expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', {
            type: 'message',
            message: 'Cursor execution selection could not be applied: Request failed: /session-execution-consume, HTTP 503',
            isError: true,
        });

        process.emit('SIGTERM');
        await runPromise;
    });

    it('reconciles consumed Cursor execution metadata on replay without dropping the delivery', async () => {
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.consumeDaemonSessionExecution
            .mockResolvedValueOnce({
                ok: true,
                data: {
                    sessionId: 'cursor-session',
                    provider: 'cursor',
                    revision: 1,
                    current: { provider: 'cursor', model: 'cursor-model-b', catalogVersion: 'catalog-b' },
                    didApplyPending: true,
                },
            })
            .mockResolvedValueOnce({
                ok: true,
                data: {
                    sessionId: 'cursor-session',
                    provider: 'cursor',
                    revision: 1,
                    current: { provider: 'cursor', model: 'cursor-model-b', catalogVersion: 'catalog-b' },
                    didApplyPending: false,
                },
            });
        session.updateMetadata.mockRejectedValueOnce(new Error(
            'Cursor metadata update failed at https://daemon.local/sync?token=cursor-secret',
        ));
        testState.bindDaemonCursorSession.mockResolvedValue({
            ok: true,
            data: {
                type: 'bound',
                wrapper: {
                    agent: 'cursor',
                    nativeSessionId: 'cursor-native-after-retry',
                    remcliSessionId: 'cursor-session',
                },
                writerLease: {
                    ...TEST_HEADLESS_WRITER_LEASE,
                    nativeSessionId: 'cursor-native-after-retry',
                },
            },
        });
        testState.runCursorTurn.mockImplementation(async (
            _options: unknown,
            onEvent: (event: CursorStreamEvent) => void | Promise<void>,
        ) => {
            await onEvent({ type: 'system', subtype: 'init', session_id: 'cursor-native-after-retry' });
            return { sessionId: 'cursor-native-after-retry', response: 'done', exitCode: 0 };
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            execution: { model: 'cursor-model-a', catalogVersion: 'catalog-a' },
            runner: { ...TEST_CURSOR_RUNNER },
        });
        const queue = await waitForMessageQueue();
        const userMessageHandler = session.onUserMessage.mock.calls[0]?.[0] as ((message: {
            content: { text: string };
            deliveryId: string;
        }) => Promise<void>) | undefined;
        if (!userMessageHandler) {
            throw new Error('Cursor user-message handler was not registered.');
        }

        const deliveryId = 'p2p:cursor-session:metadata-retry';
        const delivery = {
            content: { text: 'retry metadata before Cursor turn' },
            deliveryId,
        };
        await expect(userMessageHandler(delivery)).rejects.toBeInstanceOf(RetryableUserMessageDeliveryError);
        expect(queue.pushed).toEqual([]);
        expect(session.cancelPendingUserMessageDelivery).not.toHaveBeenCalled();
        expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', {
            type: 'message',
            message: 'Cursor metadata update failed at https://daemon.local/sync?token=[REDACTED]',
            isError: true,
        });

        const replay = userMessageHandler(delivery);
        await vi.waitFor(() => expect(queue.pushed).toEqual([{
            message: 'retry metadata before Cursor turn',
            mode: expect.objectContaining({ model: 'cursor-model-b', deliveryId }),
        }]));
        expect(session.metadataUpdates).toContainEqual(expect.objectContaining({
            cursorExecution: { model: 'cursor-model-b' },
        }));

        const acknowledge = vi.fn();
        queue.resolve({
            message: 'retry metadata before Cursor turn',
            mode: queue.pushed[0]!.mode,
            isolate: false,
            hash: 'retry-delivery',
            acknowledge,
        });
        await replay;

        expect(testState.consumeDaemonSessionExecution).toHaveBeenCalledTimes(2);
        expect(session.cancelPendingUserMessageDelivery).not.toHaveBeenCalled();
        expect(acknowledge).toHaveBeenCalledOnce();

        process.emit('SIGTERM');
        await runPromise;
    });

    it('cancels and acknowledges an exact P2P delivery when Cursor exits before system init', async () => {
        const session = createTestSession('cursor-session');
        testState.response = { id: 'cursor-session' };
        testState.initialSession = session;
        testState.acquireDaemonRunnerCredential.mockResolvedValue(true);
        testState.runCursorTurn.mockResolvedValue({
            sessionId: 'unconfirmed-native-session',
            response: '',
            exitCode: 0,
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            execution: { model: 'controlled-cursor-model', catalogVersion: 'controlled-cursor-catalog' },
            runner: { ...TEST_CURSOR_RUNNER },
        });
        const queue = await waitForMessageQueue();
        const userMessageHandler = session.onUserMessage.mock.calls[0]?.[0] as ((message: {
            content: { text: string };
            deliveryId: string;
        }) => Promise<void>) | undefined;
        if (!userMessageHandler) {
            throw new Error('Cursor user-message handler was not registered.');
        }

        const deliveryId = 'p2p:cursor-session:missing-init';
        const delivery = userMessageHandler({
            content: { text: 'prompt requiring init' },
            deliveryId,
        });
        await vi.waitFor(() => expect(queue.pushed).toHaveLength(1));
        const acknowledge = vi.fn();
        queue.resolve({
            message: 'prompt requiring init',
            mode: queue.pushed[0]!.mode,
            isolate: false,
            hash: 'launch-controls-only',
            acknowledge,
        });

        await delivery;
        await vi.waitFor(() => expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'message',
            message: 'Cursor did not initialize the native session before accepting the P2P prompt.',
            isError: true,
        })));
        expect(session.cancelPendingUserMessageDelivery).toHaveBeenCalledWith(deliveryId);
        expect(acknowledge).toHaveBeenCalledOnce();

        process.emit('SIGTERM');
        await runPromise;
    });

    it('ignores a forged lineage environment value for a terminal Cursor session', async () => {
        const session = createTestSession('cursor-session');
        process.env.REMCLI_CURSOR_RESUMED_FROM_SESSION_ID = 'forged-parent-remcli-session';
        testState.initialSession = session;
        testState.runCursorTurn.mockImplementation(async (
            _options: unknown,
            onEvent: (event: CursorStreamEvent) => void | Promise<void>,
        ) => {
            await onEvent({
                type: 'system',
                subtype: 'init',
                session_id: 'cursor-native-terminal',
            });
            return {
                sessionId: 'cursor-native-terminal',
                response: 'Cursor response',
                exitCode: 0,
            };
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'terminal',
        });
        const queue = await waitForMessageQueue();
        queue.resolve(createQueuedMessage('terminal Cursor prompt'));

        await vi.waitFor(() => expect(session.metadata).toMatchObject({
            cursorSessionId: 'cursor-native-terminal',
        }));
        const getOrCreateOptions = testState.getOrCreateSession.mock.calls[0]?.[0] as {
            metadata: Record<string, unknown>;
        } | undefined;
        expect(getOrCreateOptions?.metadata).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(session.metadata).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(session.metadata).not.toHaveProperty('cursorExecution');

        process.emit('SIGTERM');
        await runPromise;
    });

    it('keeps Cursor tool result payloads out of debug logs', async () => {
        const session = createTestSession('cursor-session');
        const fakeSecret = 'cursor-tool-result-secret';
        testState.initialSession = session;
        testState.runCursorTurn.mockImplementation(async (
            _options: unknown,
            onEvent: (event: CursorStreamEvent) => void | Promise<void>,
        ) => {
            await onEvent({
                type: 'system',
                subtype: 'init',
                session_id: 'cursor-native-session',
            });
            await onEvent({
                type: 'tool_call',
                subtype: 'completed',
                tool_call: {
                    readToolCall: {
                        args: { path: '/workspace/private.txt' },
                        result: fakeSecret,
                    },
                },
            });
            return {
                sessionId: 'cursor-native-session',
                response: 'Cursor response',
                exitCode: 0,
            };
        });

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'terminal',
        });
        const queue = await waitForMessageQueue();
        queue.resolve(createQueuedMessage('run a safe tool'));

        await vi.waitFor(() => expect(testState.runCursorTurn).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'task_complete',
        })));
        const debugOutput = testState.loggerDebug.mock.calls.map((args) => String(args[0])).join('\n');
        expect(debugOutput).not.toContain(fakeSecret);
        expect(debugOutput).toContain('Tool completed: name=readToolCall hasResult=true');

        process.emit('SIGTERM');
        await runPromise;
    });

    it('emits an observable error message without task_complete when the native turn fails', async () => {
        const session = createTestSession('cursor-session');
        testState.initialSession = session;
        testState.runCursorTurn.mockRejectedValue(new Error('native Cursor failure'));

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'terminal',
        });
        const queue = await waitForMessageQueue();
        queue.resolve(createQueuedMessage('failing Cursor prompt'));

        await vi.waitFor(() => expect(session.sendAgentMessage).toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'message',
            message: 'native Cursor failure',
            isError: true,
        })));
        expect(session.sendAgentMessage).not.toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'task_complete',
        }));

        process.emit('SIGHUP');
        await runPromise;
    });
});
