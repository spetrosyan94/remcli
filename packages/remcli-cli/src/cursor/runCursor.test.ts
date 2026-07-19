import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
        public waitCount = 0;
        public pushed: Array<{ message: string; mode: { launchControls: CursorLaunchControls; model?: string } }> = [];

        public constructor(_hash: unknown) {
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
            this.pushed.push({
                message,
                mode: mode as { launchControls: CursorLaunchControls; model?: string },
            });
        }

        public resolve(message: QueuedMessage | null): void {
            this.resolver?.(message);
        }
    }

    return {
        FakeMessageQueue,
        response: null as { id: string } | null,
        initialSession: null as TestSession | null,
        reconnectionOptions: null as ReconnectionOptions | null,
        getOrCreateSession: vi.fn(),
        sessionSyncClient: vi.fn(),
        acquireDaemonRunnerCredential: vi.fn(),
        reportTerminalSessionStarted: vi.fn(),
        bindDaemonCursorSession: vi.fn(),
        preflightDaemonCursorRunner: vi.fn(),
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
            this.getOrCreateSession.mockReset();
            this.getOrCreateSession.mockImplementation(async () => testState.response);
            this.sessionSyncClient.mockReset();
            this.acquireDaemonRunnerCredential.mockReset();
            this.reportTerminalSessionStarted.mockReset();
            this.bindDaemonCursorSession.mockReset();
            this.preflightDaemonCursorRunner.mockReset();
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
        create: vi.fn(async () => ({
            getOrCreateSession: testState.getOrCreateSession,
            sessionSyncClient: testState.sessionSyncClient,
        })),
    },
}));

vi.mock('@/persistence', () => ({
    readSettings: vi.fn(async () => ({ machineId: 'test-machine' })),
}));

vi.mock('@/utils/createSessionMetadata', () => ({
    createSessionMetadata: testState.createSessionMetadata,
}));

vi.mock('@/utils/daemonRunnerCredentialBootstrap', () => ({
    acquireDaemonRunnerCredential: testState.acquireDaemonRunnerCredential,
    reportTerminalSessionStarted: testState.reportTerminalSessionStarted,
}));

vi.mock('@/daemon/controlClient', () => ({
    bindDaemonCursorSession: testState.bindDaemonCursorSession,
    preflightDaemonCursorRunner: testState.preflightDaemonCursorRunner,
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

vi.mock('@/utils/redaction', () => ({
    redactDiagnosticData: (value: unknown): unknown => value,
}));

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

    it('rejects a token-bearing daemon runner that lacks the daemon-validated model and control', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'daemon-owned-runner-token';

        await runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
        });

        expect(testState.preflightDaemonCursorRunner).not.toHaveBeenCalled();
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
        expect(testState.sessionSyncClient).not.toHaveBeenCalled();
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

    it('binds the confirmed Cursor native ID before publishing daemon metadata without reacquiring the ACK lease', async () => {
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
        });
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
        testState.runCursorTurn.mockRejectedValue(new CursorTurnError('resume-mismatch',
            'Cursor resumed a different native session. The existing session was not changed.',
        ));

        const runPromise = runCursor({
            credentials: createCredentials(),
            startedBy: 'daemon',
            resumeSessionId: 'expected-native-session',
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
        expect(testState.bindDaemonCursorSession).not.toHaveBeenCalled();
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
        });
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
