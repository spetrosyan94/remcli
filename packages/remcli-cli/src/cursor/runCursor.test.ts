import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CursorLaunchControls } from './cursorLaunchControls';
import type { AgentState } from '@/api/types';

const TEST_RUNNER = {
    executable: 'agent' as const,
    cliFingerprint: '0123456789abcdef',
};
const TEST_EXECUTION = {
    model: 'cursor-model-a',
    catalogVersion: 'cursor-catalog-v1',
};
const TEST_CONTROLS: CursorLaunchControls = { executionMode: 'agent' };
const TEST_WRITER_LEASE = {
    agent: 'cursor' as const,
    leaseId: 'cursor-acp-writer-lease-12345678901234567890',
    nativeSessionId: 'cursor-native-session',
    remcliSessionId: 'remcli-session',
    owner: 'headless' as const,
};

interface TestSession {
    sessionId: string;
    metadata: Record<string, unknown>;
    metadataUpdates: Array<Record<string, unknown>>;
    agentState: AgentState;
    sendAgentMessage: ReturnType<typeof vi.fn>;
    sendUserTextMessage: ReturnType<typeof vi.fn>;
    sendSessionEvent: ReturnType<typeof vi.fn>;
    keepAlive: ReturnType<typeof vi.fn>;
    cancelPendingUserMessageDelivery: ReturnType<typeof vi.fn>;
    updateMetadata: ReturnType<typeof vi.fn>;
    updateAgentState: ReturnType<typeof vi.fn>;
    sendSessionDeath: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    onUserMessage: ReturnType<typeof vi.fn>;
    rpcHandlerManager: { registerHandler: ReturnType<typeof vi.fn> };
}

interface QueuedMessage {
    message: string;
    mode: {
        launchControls: CursorLaunchControls;
        model?: string;
        deliveryId?: string;
    };
    isolate: boolean;
    hash: string;
    acknowledge: ReturnType<typeof vi.fn>;
    reject: ReturnType<typeof vi.fn>;
}

interface FakeAcpOptions {
    cwd: string;
    mode?: 'agent' | 'plan' | 'ask';
    model?: string;
    resumeSessionId?: string;
    command?: string;
    onSessionUpdate?: (notification: {
        sessionId: string;
        update: Record<string, unknown>;
    }) => void | Promise<void>;
    onExtension?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

const testState = vi.hoisted(() => {
    class FakeMessageQueue {
        static instances: FakeMessageQueue[] = [];
        private resolver: ((message: QueuedMessage | null) => void) | null = null;

        constructor(_hasher: (mode: unknown) => string) {
            FakeMessageQueue.instances.push(this);
        }

        waitForMessagesAndGetAsString(signal: AbortSignal): Promise<QueuedMessage | null> {
            return new Promise((resolve) => {
                this.resolver = resolve;
                if (signal.aborted) resolve(null);
                else signal.addEventListener('abort', () => resolve(null), { once: true });
            });
        }

        push(): void {}
        async pushWithAcceptance(): Promise<void> {}

        resolve(message: QueuedMessage | null): void {
            this.resolver?.(message);
            this.resolver = null;
        }
    }

    class FakeCursorAcpClient {
        static instances: FakeCursorAcpClient[] = [];
        readonly start = vi.fn(async () => testState.startImplementation(this));
        readonly setMode = vi.fn(async () => undefined);
        readonly setModel = vi.fn(async () => undefined);
        readonly prompt = vi.fn(async (text: string, signal?: AbortSignal) => (
            testState.promptImplementation(this, text, signal)
        ));
        readonly cancel = vi.fn(async () => undefined);
        readonly dispose = vi.fn(async () => undefined);

        constructor(readonly options: FakeAcpOptions) {
            FakeCursorAcpClient.instances.push(this);
        }
    }

    return {
        FakeMessageQueue,
        FakeCursorAcpClient,
        response: { id: 'remcli-session' } as { id: string } | null,
        session: null as TestSession | null,
        readSettings: vi.fn(),
        getOrCreateSession: vi.fn(),
        acquireCredential: vi.fn(),
        reportTerminalSessionStarted: vi.fn(),
        preflight: vi.fn(),
        bind: vi.fn(),
        acquireLease: vi.fn(),
        releaseLease: vi.fn(),
        consumeExecution: vi.fn(),
        reportBootstrapFailure: vi.fn(),
        reportStopping: vi.fn(),
        reportStopped: vi.fn(),
        verifyRunner: vi.fn(),
        reconnectCancel: vi.fn(),
        permissionUpdateSession: vi.fn(),
        permissionReset: vi.fn(),
        startImplementation: null as unknown as (client: FakeCursorAcpClient) => Promise<{
            sessionId: string;
            modes: { availableModes: Array<{ id: string; name: string }>; currentModeId: string };
            models: { availableModels: Array<{ modelId: string; name: string }>; currentModelId: string };
        }>,
        promptImplementation: null as unknown as (
            client: FakeCursorAcpClient,
            text: string,
            signal?: AbortSignal,
        ) => Promise<{ stopReason: string }>,
    };
});

vi.mock('@/persistence', () => ({
    readSettings: testState.readSettings,
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({ getOrCreateSession: testState.getOrCreateSession })),
    },
}));

vi.mock('@/utils/createSessionMetadata', () => ({
    createSessionMetadata: ({ flavor, machineId, startedBy }: Record<string, unknown>) => ({
        state: {},
        metadata: {
            path: '/workspace',
            host: 'test-host',
            homeDir: '/home/test',
            flavor,
            machineId,
            startedBy,
        },
    }),
}));

vi.mock('@/utils/setupOfflineReconnection', () => ({
    setupOfflineReconnection: () => ({
        session: testState.session,
        reconnectionHandle: { cancel: testState.reconnectCancel },
    }),
}));

vi.mock('@/utils/daemonRunnerCredentialBootstrap', () => ({
    acquireDaemonRunnerCredential: testState.acquireCredential,
    reportTerminalSessionStarted: testState.reportTerminalSessionStarted,
}));

vi.mock('@/daemon/controlClient', () => ({
    preflightDaemonCursorRunner: testState.preflight,
    bindDaemonCursorSession: testState.bind,
    acquireDaemonCursorHeadlessWriterLease: testState.acquireLease,
    releaseDaemonCursorNativeWriterLease: testState.releaseLease,
    consumeDaemonSessionExecution: testState.consumeExecution,
    reportDaemonCursorRunnerBootstrapFailure: testState.reportBootstrapFailure,
    reportDaemonRunnerStopping: testState.reportStopping,
    reportDaemonRunnerStopped: testState.reportStopped,
}));

vi.mock('./cursorCapabilities', async (importOriginal) => ({
    ...await importOriginal<typeof import('./cursorCapabilities')>(),
    verifyCursorRunnerIdentity: testState.verifyRunner,
}));

vi.mock('./cursorAcpClient', () => ({
    CursorAcpClient: testState.FakeCursorAcpClient,
}));

vi.mock('./cursorPermissionHandler', () => ({
    CursorPermissionHandler: class {
        updateSession = testState.permissionUpdateSession;
        reset = testState.permissionReset;
        handleRequest = vi.fn(async () => 'reject_once');
    },
}));

vi.mock('@/utils/MessageQueue2', () => ({
    MessageQueue2: testState.FakeMessageQueue,
}));

vi.mock('@/utils/autoSessionTitle', () => ({
    createAutoTitleSetter: () => vi.fn(),
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn(),
}));

vi.mock('@/utils/caffeinate', () => ({ stopCaffeinate: vi.fn() }));
vi.mock('@/utils/serverConnectionErrors', () => ({ connectionState: { setBackend: vi.fn() } }));
vi.mock('@/ui/ink/CodexDisplay', () => ({ CodexDisplay: () => null }));
vi.mock('@/ui/ink/messageBuffer', () => ({
    MessageBuffer: class {
        addMessage(): void {}
        updateLastMessage(): void {}
        clear(): void {}
    },
}));
vi.mock('ink', () => ({ render: vi.fn() }));

import { runCursor } from './runCursor';

function createSession(): TestSession {
    const session: TestSession = {
        sessionId: 'remcli-session',
        metadata: {},
        metadataUpdates: [],
        agentState: {},
        sendAgentMessage: vi.fn(),
        sendUserTextMessage: vi.fn(),
        sendSessionEvent: vi.fn(),
        keepAlive: vi.fn(),
        cancelPendingUserMessageDelivery: vi.fn(() => true),
        sendSessionDeath: vi.fn(),
        flush: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        onUserMessage: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() },
        updateMetadata: vi.fn(async (update: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            session.metadata = update(session.metadata);
            session.metadataUpdates.push({ ...session.metadata });
        }),
        updateAgentState: vi.fn((update: (state: AgentState) => AgentState) => {
            session.agentState = update(session.agentState);
        }),
    };
    return session;
}

function createQueuedMessage(
    text: string,
    options: { model?: string; mode?: CursorLaunchControls['executionMode']; deliveryId?: string } = {},
): QueuedMessage {
    return {
        message: text,
        mode: {
            launchControls: { executionMode: options.mode ?? 'agent' },
            ...(options.model ? { model: options.model } : {}),
            ...(options.deliveryId ? { deliveryId: options.deliveryId } : {}),
        },
        isolate: false,
        hash: 'cursor-acp-mode',
        acknowledge: vi.fn(),
        reject: vi.fn(),
    };
}

async function waitForQueue(): Promise<InstanceType<typeof testState.FakeMessageQueue>> {
    await vi.waitFor(() => expect(testState.FakeMessageQueue.instances).toHaveLength(1));
    return testState.FakeMessageQueue.instances[0]!;
}

async function stopAndWait(run: Promise<void>): Promise<void> {
    process.emit('SIGINT');
    await run;
}

describe('runCursor ACP lifecycle', () => {
    beforeEach(() => {
        delete process.env.REMCLI_DAEMON_RUNNER_TOKEN;
        testState.FakeMessageQueue.instances = [];
        testState.FakeCursorAcpClient.instances = [];
        testState.session = createSession();
        testState.response = { id: 'remcli-session' };
        testState.readSettings.mockReset();
        testState.readSettings.mockResolvedValue({ machineId: 'machine-1' });
        testState.getOrCreateSession.mockReset();
        testState.getOrCreateSession.mockImplementation(async ({ metadata }: { metadata: Record<string, unknown> }) => {
            testState.session!.metadata = { ...metadata };
            return testState.response;
        });
        testState.acquireCredential.mockReset();
        testState.acquireCredential.mockResolvedValue(true);
        testState.reportTerminalSessionStarted.mockReset();
        testState.preflight.mockReset();
        testState.preflight.mockResolvedValue({ ok: true, data: { type: 'verified' } });
        testState.bind.mockReset();
        testState.bind.mockResolvedValue({
            ok: true,
            data: {
                type: 'bound',
                wrapper: {
                    agent: 'cursor',
                    nativeSessionId: 'cursor-native-session',
                    remcliSessionId: 'remcli-session',
                },
                writerLease: { ...TEST_WRITER_LEASE },
            },
        });
        testState.acquireLease.mockReset();
        testState.acquireLease.mockResolvedValue({
            ok: true,
            data: { type: 'acquired', writerLease: { ...TEST_WRITER_LEASE } },
        });
        testState.releaseLease.mockReset();
        testState.releaseLease.mockResolvedValue({ ok: true, data: { released: true } });
        testState.consumeExecution.mockReset();
        testState.consumeExecution.mockResolvedValue({
            ok: true,
            data: {
                sessionId: 'remcli-session',
                provider: 'cursor',
                revision: 0,
                current: { provider: 'cursor', ...TEST_EXECUTION },
                didApplyPending: false,
            },
        });
        testState.reportBootstrapFailure.mockReset();
        testState.reportBootstrapFailure.mockResolvedValue({ ok: true, data: { accepted: true } });
        testState.reportStopping.mockReset();
        testState.reportStopping.mockResolvedValue({ ok: true, data: { accepted: true } });
        testState.reportStopped.mockReset();
        testState.reportStopped.mockResolvedValue({ ok: true, data: { accepted: true } });
        testState.verifyRunner.mockReset();
        testState.verifyRunner.mockResolvedValue(true);
        testState.reconnectCancel.mockReset();
        testState.permissionUpdateSession.mockReset();
        testState.permissionReset.mockReset();
        testState.startImplementation = async (client) => ({
            sessionId: client.options.resumeSessionId ?? 'cursor-native-session',
            modes: {
                availableModes: [
                    { id: 'agent', name: 'Agent' },
                    { id: 'plan', name: 'Plan' },
                    { id: 'ask', name: 'Ask' },
                ],
                currentModeId: client.options.mode ?? 'agent',
            },
            models: {
                availableModels: [
                    { modelId: 'cursor-model-a', name: 'Cursor model A' },
                    { modelId: 'cursor-model-b', name: 'Cursor model B' },
                ],
                currentModelId: client.options.model ?? 'cursor-model-a',
            },
        });
        testState.promptImplementation = async (client) => {
            await client.options.onSessionUpdate?.({
                sessionId: client.options.resumeSessionId ?? 'cursor-native-session',
                update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'Cursor response' },
                },
            });
            return { stopReason: 'end_turn' };
        };
    });

    it('keeps one ACP process for multiple prompts and changes model in the same native session', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'runner-token';
        const run = runCursor({
            credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            startedBy: 'daemon',
            execution: TEST_EXECUTION,
            launchControls: TEST_CONTROLS,
            runner: TEST_RUNNER,
        });
        const queue = await waitForQueue();
        const first = createQueuedMessage('first', { model: 'cursor-model-a', deliveryId: 'delivery-1' });
        queue.resolve(first);

        await vi.waitFor(() => expect(first.acknowledge).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(testState.session!.sendAgentMessage).toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'task_complete',
        })));
        const streamedMessages = testState.session!.sendAgentMessage.mock.calls
            .filter(([, body]) => body.type === 'message' && body.streamState)
            .map(([, body]) => body);
        expect(streamedMessages).toEqual([
            expect.objectContaining({ message: 'Cursor response', streamState: 'delta' }),
            expect.objectContaining({ message: 'Cursor response', streamState: 'final' }),
        ]);
        expect(streamedMessages[0].messageId).toBe(streamedMessages[1].messageId);

        const second = createQueuedMessage('second', { model: 'cursor-model-b', mode: 'plan' });
        queue.resolve(second);
        const client = testState.FakeCursorAcpClient.instances[0]!;
        await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledTimes(2));

        expect(testState.FakeCursorAcpClient.instances).toHaveLength(1);
        expect(client.setModel).toHaveBeenCalledWith('cursor-model-b');
        expect(client.setMode).toHaveBeenCalledWith('plan');
        expect(testState.bind).toHaveBeenCalledOnce();
        expect(testState.session!.metadata).toMatchObject({
            agentSessionId: 'cursor-native-session',
            cursorSessionId: 'cursor-native-session',
            cursorExecution: { model: 'cursor-model-a' },
        });

        await stopAndWait(run);
        expect(client.dispose).toHaveBeenCalledOnce();
        expect(testState.releaseLease).toHaveBeenCalledWith(expect.objectContaining({
            leaseId: TEST_WRITER_LEASE.leaseId,
        }));
    });

    it('strictly loads the requested native session and confirms ownership before prompting', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'runner-token';
        testState.preflight.mockResolvedValue({
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: 'parent-remcli-session' },
        });
        const run = runCursor({
            credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            startedBy: 'daemon',
            resumeSessionId: 'cursor-native-session',
            execution: TEST_EXECUTION,
            launchControls: TEST_CONTROLS,
            runner: TEST_RUNNER,
        });
        const queue = await waitForQueue();
        queue.resolve(createQueuedMessage('resume'));

        await vi.waitFor(() => expect(testState.FakeCursorAcpClient.instances).toHaveLength(1));
        const client = testState.FakeCursorAcpClient.instances[0]!;
        await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
        expect(client.options.resumeSessionId).toBe('cursor-native-session');
        expect(testState.acquireLease.mock.invocationCallOrder[0]).toBeLessThan(client.start.mock.invocationCallOrder[0]!);
        expect(client.start.mock.invocationCallOrder[0]).toBeLessThan(testState.bind.mock.invocationCallOrder[0]!);
        expect(testState.bind.mock.invocationCallOrder[0]).toBeLessThan(client.prompt.mock.invocationCallOrder[0]!);
        expect(testState.session!.metadata).toMatchObject({
            resumedFromRemcliSessionId: 'parent-remcli-session',
            cursorSessionId: 'cursor-native-session',
        });

        await stopAndWait(run);
    });

    it('fails closed and removes provisional parent history when ACP load fails', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'runner-token';
        testState.preflight.mockResolvedValue({
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: 'parent-remcli-session' },
        });
        testState.startImplementation = async () => {
            throw new Error('private Cursor provider failure');
        };
        const run = runCursor({
            credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            startedBy: 'daemon',
            resumeSessionId: 'cursor-native-session',
            execution: TEST_EXECUTION,
            launchControls: TEST_CONTROLS,
            runner: TEST_RUNNER,
        });
        const queue = await waitForQueue();
        queue.resolve(createQueuedMessage('resume'));

        await vi.waitFor(() => expect(testState.session!.sendAgentMessage).toHaveBeenCalledWith('cursor', {
            type: 'message',
            message: 'Cursor session could not be resumed. Check Cursor CLI authentication and retry.',
            isError: true,
        }));
        expect(testState.session!.metadata).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(testState.bind).not.toHaveBeenCalled();
        await run;
        expect(testState.FakeCursorAcpClient.instances).toHaveLength(1);
        expect(testState.session!.sendSessionEvent).not.toHaveBeenCalledWith({ type: 'ready' });
    });

    it('replays ACP load history for an external native resume before accepting prompts', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'runner-token';
        testState.startImplementation = async (client) => {
            await client.options.onSessionUpdate?.({
                sessionId: 'cursor-native-session',
                update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Earlier question' } },
            });
            await client.options.onSessionUpdate?.({
                sessionId: 'cursor-native-session',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer' } },
            });
            return {
                sessionId: 'cursor-native-session',
                modes: { availableModes: [{ id: 'agent', name: 'Agent' }], currentModeId: 'agent' },
                models: { availableModels: [{ modelId: 'cursor-model-a', name: 'Cursor model A' }], currentModelId: 'cursor-model-a' },
            };
        };
        const run = runCursor({
            credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            startedBy: 'daemon',
            resumeSessionId: 'cursor-native-session',
            execution: TEST_EXECUTION,
            launchControls: TEST_CONTROLS,
            runner: TEST_RUNNER,
        });

        await vi.waitFor(() => expect(testState.session!.sendUserTextMessage).toHaveBeenCalledWith(
            'Earlier question',
            { sentFrom: 'cursor' },
        ));
        expect(testState.session!.sendAgentMessage).toHaveBeenCalledWith('cursor', {
            type: 'message',
            message: 'Earlier answer',
            isError: false,
            historical: true,
        });

        await stopAndWait(run);
    });

    it('does not start ACP when another writer owns a resumed native session', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'runner-token';
        testState.acquireLease.mockResolvedValue({
            ok: true,
            data: {
                type: 'writer-busy',
                owner: 'interactive',
                request: {
                    agent: 'cursor',
                    nativeSessionId: 'cursor-native-session',
                    remcliSessionId: 'remcli-session',
                },
            },
        });
        const run = runCursor({
            credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            startedBy: 'daemon',
            resumeSessionId: 'cursor-native-session',
            execution: TEST_EXECUTION,
            launchControls: TEST_CONTROLS,
            runner: TEST_RUNNER,
        });
        const queue = await waitForQueue();
        queue.resolve(createQueuedMessage('must not run'));

        await vi.waitFor(() => expect(testState.session!.sendAgentMessage).toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'message',
            message: 'Cursor native session is already controlled by an active interactive writer.',
            isError: true,
        })));
        expect(testState.FakeCursorAcpClient.instances[0]!.start).not.toHaveBeenCalled();

        await stopAndWait(run);
    });

    it('cancels an active ACP prompt and reports an aborted turn', async () => {
        let resolvePrompt!: (result: { stopReason: string }) => void;
        testState.promptImplementation = async (client, _text, signal) => new Promise((resolve) => {
            resolvePrompt = resolve;
            signal?.addEventListener('abort', () => {
                void client.cancel();
                resolve({ stopReason: 'cancelled' });
            }, { once: true });
        });
        const run = runCursor({
            credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            startedBy: 'terminal',
        });
        const queue = await waitForQueue();
        queue.resolve(createQueuedMessage('long task'));
        await vi.waitFor(() => expect(testState.FakeCursorAcpClient.instances).toHaveLength(1));
        const client = testState.FakeCursorAcpClient.instances[0]!;
        await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());

        const abortHandler = testState.session!.rpcHandlerManager.registerHandler.mock.calls.find(
            ([name]) => name === 'abort',
        )?.[1] as (() => Promise<void>) | undefined;
        await abortHandler?.();
        await expect(client.options.onExtension?.('cursor/ask_question', {
            toolCallId: 'late-question',
            questions: [{
                id: 'scope',
                prompt: 'Should this appear?',
                options: [{ id: 'no', label: 'No' }],
            }],
        })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
        expect(testState.session!.agentState.cursorStructuredRequests).toBeUndefined();
        await vi.waitFor(() => expect(client.cancel).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(testState.session!.sendAgentMessage).toHaveBeenCalledWith('cursor', expect.objectContaining({
            type: 'turn_aborted',
        })));
        resolvePrompt({ stopReason: 'cancelled' });

        await stopAndWait(run);
    });

    it('keeps a Cursor question blocking until the encrypted session RPC answers it', async () => {
        let nativeOutcome: Record<string, unknown> | undefined;
        testState.promptImplementation = async (client) => {
            nativeOutcome = await client.options.onExtension?.('cursor/ask_question', {
                toolCallId: 'question-tool',
                title: 'Choose scope',
                questions: [{
                    id: 'scope',
                    prompt: 'What should be reviewed?',
                    options: [{ id: 'web', label: 'Web' }, { id: 'daemon', label: 'Daemon' }],
                }],
            });
            return { stopReason: 'end_turn' };
        };
        const run = runCursor({
            credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            startedBy: 'terminal',
        });
        const queue = await waitForQueue();
        queue.resolve(createQueuedMessage('review'));

        await vi.waitFor(() => expect(Object.values(testState.session!.agentState.cursorStructuredRequests ?? {})).toHaveLength(1));
        const request = Object.values(testState.session!.agentState.cursorStructuredRequests ?? {})[0]!;
        const responseHandler = testState.session!.rpcHandlerManager.registerHandler.mock.calls.find(
            ([name]) => name === 'cursor-structured-input-response',
        )?.[1] as ((response: Record<string, unknown>) => Promise<unknown>) | undefined;
        await expect(responseHandler?.({
            requestKey: request.requestKey,
            submissionId: 'submission-1',
            action: 'submit',
            answers: { scope: ['web'] },
        })).resolves.toEqual({ status: 'submitted' });
        await vi.waitFor(() => expect(nativeOutcome).toEqual({
            outcome: { outcome: 'answered', answers: [{ questionId: 'scope', selectedOptionIds: ['web'] }] },
        }));
        expect(testState.session!.agentState.cursorStructuredRequests).toBeUndefined();

        await stopAndWait(run);
    });

    it('keeps a Cursor plan blocking until the encrypted session RPC rejects it', async () => {
        let nativeOutcome: Record<string, unknown> | undefined;
        testState.promptImplementation = async (client) => {
            nativeOutcome = await client.options.onExtension?.('cursor/create_plan', {
                toolCallId: 'plan-tool',
                name: 'Ship structured forms',
                overview: 'Validate the full runner bridge.',
                plan: '1. Validate ACP.\n2. Bridge the response.',
                todos: [{ id: 'validate', content: 'Validate ACP', status: 'completed' }],
            });
            return { stopReason: 'end_turn' };
        };
        const run = runCursor({
            credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            startedBy: 'terminal',
        });
        const queue = await waitForQueue();
        queue.resolve(createQueuedMessage('plan'));

        await vi.waitFor(() => expect(Object.values(testState.session!.agentState.cursorStructuredRequests ?? {})).toHaveLength(1));
        const request = Object.values(testState.session!.agentState.cursorStructuredRequests ?? {})[0]!;
        expect(request.kind).toBe('cursor-plan');
        const responseHandler = testState.session!.rpcHandlerManager.registerHandler.mock.calls.find(
            ([name]) => name === 'cursor-structured-input-response',
        )?.[1] as ((response: Record<string, unknown>) => Promise<unknown>) | undefined;
        await expect(responseHandler?.({
            requestKey: request.requestKey,
            submissionId: 'submission-plan-1',
            action: 'decline',
        })).resolves.toEqual({ status: 'submitted' });
        await vi.waitFor(() => expect(nativeOutcome).toEqual({ outcome: { outcome: 'rejected' } }));
        expect(testState.session!.agentState.cursorStructuredRequests).toBeUndefined();

        await stopAndWait(run);
    });

    it('uses the ACP session default model for a direct terminal invocation', async () => {
        const run = runCursor({
            credentials: { token: 'test', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
            startedBy: 'terminal',
        });
        const queue = await waitForQueue();
        queue.resolve(createQueuedMessage('terminal prompt'));

        await vi.waitFor(() => expect(testState.FakeCursorAcpClient.instances).toHaveLength(1));
        const client = testState.FakeCursorAcpClient.instances[0]!;
        await vi.waitFor(() => expect(client.prompt).toHaveBeenCalledOnce());
        expect(client.options.model).toBeUndefined();
        expect(testState.reportTerminalSessionStarted).toHaveBeenLastCalledWith(expect.objectContaining({
            metadata: expect.objectContaining({
                cursorSessionId: 'cursor-native-session',
            }),
        }));

        await stopAndWait(run);
    });
});
