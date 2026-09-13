import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ACPMessageData, SessionEvent } from '@/api/apiSession';
import type { DeliveredUserMessage, MessageMeta, Metadata } from '@/api/types';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import type { AntigravityExecutionConfig } from './antigravityCapabilities';
import type { AntigravityLaunchControls } from './antigravityCli';
import type {
    AntigravityStreamEvent,
    AntigravityTurnResult,
} from './antigravityStreamClient';

type UserMessageHandler = (message: DeliveredUserMessage) => Promise<void> | void;
type RpcHandler = () => Promise<void> | void;
type StepUpdate = Extract<AntigravityStreamEvent, { event: 'step_update' }>['step_update'];

interface StreamOptionsHarness extends AntigravityLaunchControls {
    cwd: string;
    conversationId?: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high';
    onEvent?: (event: AntigravityStreamEvent) => unknown;
    onStderr?: (diagnostic: string) => unknown;
}

interface StreamHarness {
    readonly options: StreamOptionsHarness;
    readonly startCalls: Array<string | undefined>;
    readonly sentTurns: string[];
    abortCalls: number;
    stopCalls: number;
    abortError: Error | null;
    stopError: Error | null;
    abortWait: Promise<void> | null;
    hasPendingInit(): boolean;
    emitInit(conversationId: string): void;
    failInit(error: Error): void;
    emitStep(step: StepUpdate): void;
    emitStderr(diagnostic: string): void;
    finish(result: AntigravityTurnResult): void;
    failTurn(error: Error): void;
}

interface SentAgentMessage {
    provider: string;
    body: ACPMessageData;
}

interface MetadataAttempt {
    metadata: Metadata;
    succeeded: boolean;
}

interface SessionHarness {
    sessionId: string;
    metadata: Metadata;
    metadataFailuresRemaining: number;
    metadataFailure: Error | null;
    metadataAttempts: MetadataAttempt[];
    userHandler: UserMessageHandler | null;
    rpcHandlers: Map<string, RpcHandler>;
    messages: SentAgentMessage[];
    events: SessionEvent[];
    cancelledDeliveries: string[];
    keepAliveCalls: Array<{ thinking: boolean; mode: 'local' | 'remote' }>;
    deathCalls: number;
    flushCalls: number;
    closeCalls: number;
    flushError: Error | null;
    closeError: Error | null;
    pendingDurableMessage: DeliveredUserMessage | null;
    deliveryInFlight: boolean;
    deliveryAttemptPromises: Promise<void>[];
    redeliveryRequestCalls: number;
    acceptedRedeliveryRequests: number;
    redeliveryRefusalsRemaining: number;
    onUserMessage(handler: UserMessageHandler): void;
    dispatchDurableMessage(message: DeliveredUserMessage): Promise<void>;
    requestPendingUserMessageRedelivery(): boolean;
    sendAgentMessage(provider: string, body: ACPMessageData): void;
    sendSessionEvent(event: SessionEvent): void;
    keepAlive(thinking: boolean, mode: 'local' | 'remote'): void;
    updateMetadata(handler: (metadata: Metadata) => Metadata): Promise<void>;
    cancelPendingUserMessageDelivery(deliveryId: string): boolean;
    sendSessionDeath(): void;
    flush(): Promise<void>;
    close(): Promise<void>;
    rpcHandlerManager: {
        registerHandler(name: string, handler: RpcHandler): void;
    };
}

interface SessionCreationRequest {
    tag: string;
    metadata: Metadata;
    state: unknown;
}

interface RunHarnessOptions {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    resumeSessionId?: string;
    execution?: AntigravityExecutionConfig;
    launchControls?: AntigravityLaunchControls;
}

const testState = vi.hoisted(() => {
    const baseMetadata = (flavor = 'antigravity'): Metadata => ({
        path: '/repo',
        host: 'test-host',
        homeDir: '/home/test',
        remcliHomeDir: '/home/test/.remcli',
        remcliLibDir: '/repo/lib',
        remcliToolsDir: '/repo/tools',
        machineId: 'machine-1',
        startedBy: 'terminal',
        lifecycleState: 'running',
        flavor,
    });

    return {
        baseMetadata,
        settings: { machineId: 'machine-1' } as { machineId?: string } | null,
        session: null as SessionHarness | null,
        streams: [] as StreamHarness[],
        runPromises: [] as Promise<void>[],
        apiCreateCalls: [] as Credentials[],
        apiCreateError: null as Error | null,
        apiGetError: null as Error | null,
        apiResponse: { id: 'remcli-session' } as { id: string } | null,
        creationRequests: [] as SessionCreationRequest[],
        sessionSyncCalls: [] as Array<{ id: string }>,
        metadataFactoryCalls: [] as Array<{
            flavor: string;
            machineId: string;
            startedBy?: 'daemon' | 'terminal';
        }>,
        setupCalls: [] as unknown[],
        sessionSwap: null as ((session: SessionHarness) => void) | null,
        reconnectionCancelCalls: 0,
        preflightResult: {
            ok: true,
            data: { type: 'verified' as const },
        } as unknown,
        preflightRequests: [] as unknown[],
        bindingResult: {
            ok: true,
            data: { type: 'bound' as const },
        } as unknown,
        bindingWait: null as Promise<void> | null,
        bindingWaitResolve: null as (() => void) | null,
        bindingRequests: [] as unknown[],
        credentialAccepted: true,
        credentialRequests: [] as unknown[],
        terminalStartedRequests: [] as unknown[],
        bootstrapFailureRequests: [] as unknown[],
        stoppingSessionIds: [] as string[],
        stoppedSessionIds: [] as string[],
        killHandler: null as RpcHandler | null,
        titlePrompts: [] as string[],
        lifecycleOrder: [] as string[],
    };
});

vi.mock('@/persistence', () => ({
    readSettings: vi.fn(async () => testState.settings),
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async (credentials: Credentials) => {
            testState.apiCreateCalls.push(credentials);
            if (testState.apiCreateError) throw testState.apiCreateError;
            return {
                getOrCreateSession: async (request: SessionCreationRequest) => {
                    testState.lifecycleOrder.push('get-or-create');
                    testState.creationRequests.push(request);
                    if (testState.apiGetError) throw testState.apiGetError;
                    if (testState.session) {
                        testState.session.metadata = { ...request.metadata };
                    }
                    return testState.apiResponse;
                },
                sessionSyncClient: (response: { id: string }) => {
                    testState.sessionSyncCalls.push(response);
                    if (!testState.session) throw new Error('Test session is not initialized.');
                    return testState.session;
                },
            };
        }),
    },
}));

vi.mock('@/utils/createSessionMetadata', () => ({
    createSessionMetadata: vi.fn((options: {
        flavor: string;
        machineId: string;
        startedBy?: 'daemon' | 'terminal';
    }) => {
        testState.metadataFactoryCalls.push(options);
        return {
            state: { controlledByUser: false },
            metadata: {
                ...testState.baseMetadata(options.flavor),
                machineId: options.machineId,
                startedBy: options.startedBy ?? 'terminal',
                startedFromDaemon: options.startedBy === 'daemon',
            },
        };
    }),
}));

vi.mock('@/utils/setupOfflineReconnection', () => ({
    setupOfflineReconnection: vi.fn((options: {
        onSessionSwap: (session: SessionHarness) => void;
    }) => {
        testState.setupCalls.push(options);
        testState.sessionSwap = options.onSessionSwap;
        if (!testState.session) throw new Error('Test session is not initialized.');
        return {
            session: testState.session,
            reconnectionHandle: {
                cancel: () => {
                    testState.reconnectionCancelCalls += 1;
                    testState.lifecycleOrder.push('reconnect-cancel');
                },
            },
            isOffline: false,
        };
    }),
}));

vi.mock('@/utils/autoSessionTitle', () => ({
    createAutoTitleSetter: vi.fn(() => (prompt: string) => {
        testState.titlePrompts.push(prompt);
    }),
}));

vi.mock('@/utils/daemonRunnerCredentialBootstrap', () => ({
    acquireDaemonRunnerCredential: vi.fn(async (request: unknown) => {
        testState.lifecycleOrder.push('credential-handoff');
        testState.credentialRequests.push(request);
        return testState.credentialAccepted;
    }),
    reportTerminalSessionStarted: vi.fn(async (request: unknown) => {
        testState.terminalStartedRequests.push(request);
    }),
}));

vi.mock('@/daemon/controlClient', () => ({
    preflightDaemonAntigravityRunner: vi.fn(async (request: unknown) => {
        testState.lifecycleOrder.push('daemon-preflight');
        testState.preflightRequests.push(request);
        return testState.preflightResult;
    }),
    bindDaemonAntigravityConversation: vi.fn(async (request: unknown) => {
        testState.lifecycleOrder.push('native-bind');
        testState.bindingRequests.push(request);
        if (testState.bindingWait) await testState.bindingWait;
        return testState.bindingResult;
    }),
    reportDaemonAntigravityRunnerBootstrapFailure: vi.fn(async (request: unknown) => {
        testState.lifecycleOrder.push('bootstrap-failure');
        testState.bootstrapFailureRequests.push(request);
        return { ok: true, data: { accepted: true } };
    }),
    reportDaemonRunnerStopping: vi.fn(async (sessionId: string) => {
        testState.lifecycleOrder.push('daemon-stopping');
        testState.stoppingSessionIds.push(sessionId);
        return { ok: true, data: { accepted: true } };
    }),
    reportDaemonRunnerStopped: vi.fn(async (sessionId: string) => {
        testState.lifecycleOrder.push('daemon-stopped');
        testState.stoppedSessionIds.push(sessionId);
        return { ok: true, data: { accepted: true } };
    }),
}));

vi.mock('@/claude/registerKillSessionHandler', () => ({
    registerKillSessionHandler: vi.fn((_manager: unknown, handler: RpcHandler) => {
        testState.killHandler = handler;
    }),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}));

vi.mock('./antigravityStreamClient', () => ({
    AntigravityStreamClient: class implements StreamHarness {
        readonly startCalls: Array<string | undefined> = [];
        readonly sentTurns: string[] = [];
        abortCalls = 0;
        stopCalls = 0;
        abortError: Error | null = null;
        stopError: Error | null = null;
        abortWait: Promise<void> | null = null;
        private requestedConversationId: string | undefined;
        private initResolve: ((conversationId: string) => void) | null = null;
        private initReject: ((error: Error) => void) | null = null;
        private activeTurn: {
            resolve: (result: AntigravityTurnResult) => void;
            reject: (error: Error) => void;
        } | null = null;

        constructor(readonly options: StreamOptionsHarness) {
            testState.streams.push(this);
        }

        start(requestedConversationId?: string): Promise<string> {
            this.startCalls.push(requestedConversationId);
            this.requestedConversationId = requestedConversationId;
            return new Promise<string>((resolve, reject) => {
                this.initResolve = resolve;
                this.initReject = reject;
            });
        }

        hasPendingInit(): boolean {
            return this.initResolve !== null || this.initReject !== null;
        }

        emitInit(conversationId: string): void {
            const resolve = this.initResolve;
            const reject = this.initReject;
            if (!resolve || !reject) throw new Error('No Antigravity init is pending.');
            this.initResolve = null;
            this.initReject = null;
            if (this.requestedConversationId !== undefined
                && conversationId !== this.requestedConversationId) {
                reject(new Error('Antigravity conversation_id does not match requested resume.'));
                return;
            }
            this.options.onEvent?.({ event: 'init', conversation_id: conversationId, init: {} });
            resolve(conversationId);
        }

        failInit(error: Error): void {
            const reject = this.initReject;
            this.initResolve = null;
            this.initReject = null;
            reject?.(error);
        }

        sendTurn(content: string | Array<{ type: 'text'; text: string }>): Promise<AntigravityTurnResult> {
            if (this.activeTurn) return Promise.reject(new Error('A turn is already active.'));
            this.sentTurns.push(typeof content === 'string' ? content : JSON.stringify(content));
            return new Promise<AntigravityTurnResult>((resolve, reject) => {
                this.activeTurn = { resolve, reject };
            });
        }

        emitStep(step: StepUpdate): void {
            this.options.onEvent?.({ event: 'step_update', step_update: step });
        }

        emitStderr(diagnostic: string): void {
            this.options.onStderr?.(diagnostic);
        }

        finish(result: AntigravityTurnResult): void {
            const turn = this.activeTurn;
            if (!turn) throw new Error('No Antigravity turn is active.');
            this.options.onEvent?.({ event: 'result', result });
            this.activeTurn = null;
            turn.resolve(result);
        }

        failTurn(error: Error): void {
            const turn = this.activeTurn;
            if (!turn) throw new Error('No Antigravity turn is active.');
            this.activeTurn = null;
            turn.reject(error);
        }

        async abort(): Promise<void> {
            this.abortCalls += 1;
            testState.lifecycleOrder.push('native-abort');
            if (this.abortError) {
                const error = this.abortError;
                this.failInit(error);
                const turn = this.activeTurn;
                this.activeTurn = null;
                turn?.reject(error);
                throw error;
            }
            if (this.abortWait) await this.abortWait;
            this.failInit(new Error('Antigravity stream was aborted.'));
            const turn = this.activeTurn;
            this.activeTurn = null;
            turn?.resolve({
                conversation_id: this.requestedConversationId ?? 'fresh-conversation',
                status: 'CANCELED',
                response: '',
            });
        }

        async stop(): Promise<void> {
            this.stopCalls += 1;
            testState.lifecycleOrder.push('native-stop');
            if (this.stopError) {
                this.failInit(this.stopError);
                throw this.stopError;
            }
            this.failInit(new Error('Antigravity stream was stopped.'));
        }
    },
}));

import { RetryableUserMessageDeliveryError } from '@/api/types';
import { runAntigravity } from './runAntigravity';

const ENV_KEYS = [
    'REMCLI_DAEMON_RUNNER_TOKEN',
    'REMCLI_ANTIGRAVITY_MODEL',
    'REMCLI_ANTIGRAVITY_CATALOG_VERSION',
    'REMCLI_ANTIGRAVITY_REASONING_EFFORT',
    'REMCLI_ANTIGRAVITY_EFFORT',
    'REMCLI_ANTIGRAVITY_MODE',
    'REMCLI_ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS',
    'REMCLI_ANTIGRAVITY_SANDBOX',
] as const;
const originalEnvironment = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

const execution: AntigravityExecutionConfig = {
    model: 'gemini-3-pro-high',
    reasoningEffort: 'medium',
    catalogVersion: 'catalog-v1',
};
const launchControls = (sandbox: boolean): Required<AntigravityLaunchControls> => ({
    mode: 'default',
    dangerouslySkipPermissions: false,
    sandbox,
});

function createCredentials(): Credentials {
    return {
        token: 'test-token',
        encryption: { type: 'legacy', secret: new Uint8Array(32) },
    };
}

function createSession(): SessionHarness {
    let session: SessionHarness;
    const invokePendingDelivery = (): Promise<void> => {
        const message = session.pendingDurableMessage;
        const handler = session.userHandler;
        if (!message || !handler || session.deliveryInFlight) {
            return Promise.reject(new Error('No pending durable message can be delivered.'));
        }
        session.deliveryInFlight = true;
        const attempt = Promise.resolve()
            .then(() => handler(message))
            .then(() => {
                if (session.pendingDurableMessage === message) session.pendingDurableMessage = null;
            })
            .finally(() => {
                session.deliveryInFlight = false;
            });
        session.deliveryAttemptPromises.push(attempt);
        return attempt;
    };

    session = {
        sessionId: 'remcli-session',
        metadata: testState.baseMetadata(),
        metadataFailuresRemaining: 0,
        metadataFailure: null,
        metadataAttempts: [],
        userHandler: null,
        rpcHandlers: new Map(),
        messages: [],
        events: [],
        cancelledDeliveries: [],
        keepAliveCalls: [],
        deathCalls: 0,
        flushCalls: 0,
        closeCalls: 0,
        flushError: null,
        closeError: null,
        pendingDurableMessage: null,
        deliveryInFlight: false,
        deliveryAttemptPromises: [],
        redeliveryRequestCalls: 0,
        acceptedRedeliveryRequests: 0,
        redeliveryRefusalsRemaining: 0,
        onUserMessage(handler) {
            session.userHandler = handler;
        },
        dispatchDurableMessage(message) {
            if (!message.deliveryId) throw new Error('Durable test delivery requires a deliveryId.');
            if (session.pendingDurableMessage) throw new Error('A durable test delivery is already pending.');
            session.pendingDurableMessage = message;
            return invokePendingDelivery();
        },
        requestPendingUserMessageRedelivery() {
            session.redeliveryRequestCalls += 1;
            if (session.redeliveryRefusalsRemaining > 0) {
                session.redeliveryRefusalsRemaining -= 1;
                return false;
            }
            if (!session.pendingDurableMessage || !session.userHandler || session.deliveryInFlight) return false;
            session.acceptedRedeliveryRequests += 1;
            void invokePendingDelivery().catch(() => undefined);
            return true;
        },
        sendAgentMessage(provider, body) {
            session.messages.push({ provider, body });
        },
        sendSessionEvent(event) {
            session.events.push(event);
        },
        keepAlive(thinking, mode) {
            session.keepAliveCalls.push({ thinking, mode });
        },
        async updateMetadata(handler) {
            const updated = handler(session.metadata);
            testState.lifecycleOrder.push('metadata-update');
            if (session.metadataFailuresRemaining > 0) {
                session.metadataFailuresRemaining -= 1;
                session.metadataAttempts.push({ metadata: updated, succeeded: false });
                throw session.metadataFailure ?? new Error('metadata publication failed');
            }
            session.metadata = updated;
            session.metadataAttempts.push({ metadata: updated, succeeded: true });
        },
        cancelPendingUserMessageDelivery(deliveryId) {
            session.cancelledDeliveries.push(deliveryId);
            if (session.pendingDurableMessage?.deliveryId === deliveryId) {
                session.pendingDurableMessage = null;
            }
            return true;
        },
        sendSessionDeath() {
            session.deathCalls += 1;
            testState.lifecycleOrder.push('session-death');
        },
        async flush() {
            session.flushCalls += 1;
            testState.lifecycleOrder.push('session-flush');
            if (session.flushError) throw session.flushError;
        },
        async close() {
            session.closeCalls += 1;
            testState.lifecycleOrder.push('session-close');
            if (session.closeError) throw session.closeError;
        },
        rpcHandlerManager: {
            registerHandler(name, handler) {
                session.rpcHandlers.set(name, handler);
            },
        },
    };
    return session;
}

function session(): SessionHarness {
    if (!testState.session) throw new Error('Test session is not initialized.');
    return testState.session;
}

function launch(options: Omit<RunHarnessOptions, 'credentials'> = {}): Promise<void> {
    const completion = runAntigravity({ credentials: createCredentials(), ...options });
    testState.runPromises.push(completion);
    return completion;
}

function daemonRunOptions(sandbox = false): Omit<RunHarnessOptions, 'credentials' | 'resumeSessionId'> {
    process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'runner-token';
    return {
        startedBy: 'daemon',
        execution,
        launchControls: launchControls(sandbox),
    };
}

function deliveredMessage(
    text: string,
    deliveryId?: string,
    meta?: MessageMeta,
): DeliveredUserMessage {
    return {
        role: 'user',
        content: { type: 'text', text },
        ...(deliveryId ? { deliveryId } : {}),
        ...(meta ? { meta } : {}),
    };
}

async function waitForUserHandler(): Promise<UserMessageHandler> {
    await vi.waitFor(() => expect(session().userHandler).not.toBeNull());
    return session().userHandler!;
}

async function waitForStream(index = 0): Promise<StreamHarness> {
    await vi.waitFor(() => expect(testState.streams.length).toBeGreaterThan(index));
    return testState.streams[index];
}

function deliver(
    handler: UserMessageHandler,
    text: string,
    deliveryId?: string,
    meta?: MessageMeta,
): Promise<void> {
    return Promise.resolve(handler(deliveredMessage(text, deliveryId, meta)));
}

function deliverDurable(text: string, deliveryId: string, meta?: MessageMeta): Promise<void> {
    return session().dispatchDurableMessage(deliveredMessage(text, deliveryId, meta));
}

function deferBinding(): () => void {
    testState.bindingWait = new Promise<void>((resolve) => {
        testState.bindingWaitResolve = resolve;
    });
    return () => {
        testState.bindingWaitResolve?.();
        testState.bindingWaitResolve = null;
        testState.bindingWait = null;
    };
}

async function waitForSentTurns(stream: StreamHarness, count: number): Promise<void> {
    await vi.waitFor(() => expect(stream.sentTurns).toHaveLength(count));
}

async function waitForAgentMessages(type: ACPMessageData['type'], count: number): Promise<void> {
    await vi.waitFor(() => {
        expect(session().messages.filter(({ body }) => body.type === type)).toHaveLength(count);
    });
}

async function stopRunner(completion: Promise<void>): Promise<void> {
    const abort = session().rpcHandlers.get('abort');
    if (!abort) throw new Error('Abort RPC is not registered.');
    await abort();
    await completion;
}

function successfulResult(conversationId: string, response: string): AntigravityTurnResult {
    return { conversation_id: conversationId, status: 'SUCCESS', response };
}

function visibleMessages(): string {
    return JSON.stringify(session().messages);
}

describe('runAntigravity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of ENV_KEYS) delete process.env[key];
        testState.settings = { machineId: 'machine-1' };
        testState.session = createSession();
        testState.streams.length = 0;
        testState.runPromises.length = 0;
        testState.apiCreateCalls.length = 0;
        testState.apiCreateError = null;
        testState.apiGetError = null;
        testState.apiResponse = { id: 'remcli-session' };
        testState.creationRequests.length = 0;
        testState.sessionSyncCalls.length = 0;
        testState.metadataFactoryCalls.length = 0;
        testState.setupCalls.length = 0;
        testState.sessionSwap = null;
        testState.reconnectionCancelCalls = 0;
        testState.preflightResult = { ok: true, data: { type: 'verified' } };
        testState.preflightRequests.length = 0;
        testState.bindingResult = { ok: true, data: { type: 'bound' } };
        testState.bindingWait = null;
        testState.bindingWaitResolve = null;
        testState.bindingRequests.length = 0;
        testState.credentialAccepted = true;
        testState.credentialRequests.length = 0;
        testState.terminalStartedRequests.length = 0;
        testState.bootstrapFailureRequests.length = 0;
        testState.stoppingSessionIds.length = 0;
        testState.stoppedSessionIds.length = 0;
        testState.killHandler = null;
        testState.titlePrompts.length = 0;
        testState.lifecycleOrder.length = 0;
    });

    afterEach(async () => {
        testState.bindingWaitResolve?.();
        testState.bindingWaitResolve = null;
        testState.bindingWait = null;
        for (const stream of testState.streams) {
            stream.abortError = null;
            stream.stopError = null;
            stream.abortWait = null;
            if (stream.hasPendingInit()) stream.failInit(new Error('test teardown'));
        }
        const abort = testState.session?.rpcHandlers.get('abort');
        if (abort) await Promise.resolve(abort()).catch(() => undefined);
        await Promise.allSettled(testState.runPromises);
    });

    afterAll(() => {
        for (const key of ENV_KEYS) {
            const original = originalEnvironment.get(key);
            if (original === undefined) delete process.env[key];
            else process.env[key] = original;
        }
    });

    it('uses direct antigravity metadata and keeps one native stream across two turns', async () => {
        const completion = launch({ execution, launchControls: launchControls(false) });
        const handler = await waitForUserHandler();
        const firstDelivery = deliver(handler, 'first prompt', undefined, {
            model: 'untrusted-model',
            permissionMode: 'bypassPermissions',
        });
        const stream = await waitForStream();

        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        stream.emitStep({
            conversation_id: 'conversation-1',
            step_index: 0,
            state: 'ACTIVE',
            step_type: 'agent_response',
            text_delta: 'Hello',
        });
        stream.finish(successfulResult('conversation-1', 'Hello world'));
        await firstDelivery;
        await waitForAgentMessages('task_complete', 1);

        const secondDelivery = deliver(handler, 'second prompt');
        await waitForSentTurns(stream, 2);
        stream.finish(successfulResult('conversation-1', 'Second answer'));
        await secondDelivery;
        await waitForAgentMessages('task_complete', 2);

        expect(testState.metadataFactoryCalls).toEqual([{
            flavor: 'antigravity',
            machineId: 'machine-1',
            startedBy: undefined,
        }]);
        expect(testState.streams).toHaveLength(1);
        expect(stream.startCalls).toEqual([undefined]);
        expect(stream.sentTurns).toEqual(['first prompt', 'second prompt']);
        expect(stream.options).toMatchObject({
            model: execution.model,
            effort: 'medium',
            mode: 'default',
            dangerouslySkipPermissions: false,
            sandbox: false,
        });
        const firstStreamMessages = session().messages
            .map(({ body }) => body)
            .filter((body): body is Extract<ACPMessageData, { type: 'message' }> => (
                body.type === 'message' && body.streamState !== undefined && body.message.startsWith('Hello')
            ));
        expect(firstStreamMessages.map(({ streamState }) => streamState)).toEqual(['delta', 'final']);
        expect(firstStreamMessages[0].messageId).toBe(firstStreamMessages[1].messageId);
        expect(testState.titlePrompts).toEqual(['first prompt', 'second prompt']);

        await stopRunner(completion);
    });

    it('isolates durable messages by deliveryId instead of batching them', async () => {
        const completion = launch();
        const handler = await waitForUserHandler();
        const first = deliver(handler, 'first', 'delivery-1');
        const second = deliver(handler, 'second', 'delivery-2');
        const stream = await waitForStream();

        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        expect(stream.sentTurns).toEqual(['first']);
        stream.finish(successfulResult('conversation-1', 'one'));
        await first;

        await waitForSentTurns(stream, 2);
        expect(stream.sentTurns).toEqual(['first', 'second']);
        stream.finish(successfulResult('conversation-1', 'two'));
        await second;
        await waitForAgentMessages('task_complete', 2);

        await stopRunner(completion);
    });

    it('resumes the exact conversation, then binds and publishes native metadata', async () => {
        testState.preflightResult = {
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: 'parent-remcli-session' },
        };
        const completion = launch({
            ...daemonRunOptions(false),
            resumeSessionId: 'native-conversation',
        });
        const stream = await waitForStream();

        expect(stream.startCalls).toEqual(['native-conversation']);
        expect(testState.bindingRequests).toEqual([]);
        expect(session().userHandler).toBeNull();
        stream.emitInit('native-conversation');

        await vi.waitFor(() => expect(testState.bindingRequests).toHaveLength(1));
        await waitForUserHandler();
        await vi.waitFor(() => expect(session().metadata.agentSessionId).toBe('native-conversation'));

        expect(testState.preflightRequests).toEqual([expect.objectContaining({
            agent: 'antigravity',
            nativeResumeConversationId: 'native-conversation',
        })]);
        expect(testState.lifecycleOrder.indexOf('daemon-preflight'))
            .toBeLessThan(testState.lifecycleOrder.indexOf('get-or-create'));
        expect(testState.bindingRequests).toEqual([{
            agent: 'antigravity',
            nativeConversationId: 'native-conversation',
            remcliSessionId: 'remcli-session',
        }]);
        expect(stream.options).toMatchObject({
            conversationId: 'native-conversation',
            sandbox: false,
        });
        expect(testState.creationRequests[0].metadata).toMatchObject({
            flavor: 'antigravity',
            resumedFromRemcliSessionId: 'parent-remcli-session',
            antigravityExecution: {
                model: execution.model,
                reasoningEffort: 'medium',
            },
        });
        expect(testState.creationRequests[0].metadata.antigravityExecution).not.toHaveProperty('catalogVersion');
        expect(session().metadata).toMatchObject({
            agentSessionId: 'native-conversation',
            antigravitySessionId: 'native-conversation',
            resumedFromRemcliSessionId: 'parent-remcli-session',
        });

        await stopRunner(completion);
    });

    it('shows an exact-resume mismatch and never starts a fresh fallback', async () => {
        testState.preflightResult = {
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: 'parent-remcli-session' },
        };
        const completion = launch({
            ...daemonRunOptions(false),
            resumeSessionId: 'wanted-conversation',
        });
        const stream = await waitForStream();

        stream.emitInit('other-conversation');
        await completion;

        expect(testState.streams).toHaveLength(1);
        expect(stream.startCalls).toEqual(['wanted-conversation']);
        expect(stream.sentTurns).toEqual([]);
        expect(stream.stopCalls).toBe(1);
        expect(testState.bindingRequests).toEqual([]);
        expect(session().metadata.resumedFromRemcliSessionId).toBeUndefined();
        expect(visibleMessages()).toContain('could not be resumed');
    });

    it('shows a missing exact-resume conversation and never starts fresh', async () => {
        const completion = launch({
            ...daemonRunOptions(false),
            resumeSessionId: 'missing-conversation',
        });
        const stream = await waitForStream();

        stream.failInit(new Error('native conversation was not found'));
        await completion;

        expect(testState.streams).toHaveLength(1);
        expect(stream.startCalls).toEqual(['missing-conversation']);
        expect(stream.sentTurns).toEqual([]);
        expect(stream.stopCalls).toBe(1);
        expect(visibleMessages()).toContain('native conversation was not found');
    });

    it('propagates startup stop failure and never reports the daemon runner stopped', async () => {
        const completion = launch({
            ...daemonRunOptions(false),
            resumeSessionId: 'missing-conversation',
        });
        const stream = await waitForStream();
        const nativeFailure = new Error('native process survived startup cleanup');
        stream.stopError = nativeFailure;
        const completionOutcome = completion.then(
            () => null,
            (error: unknown) => error,
        );

        stream.failInit(new Error('native conversation was not found'));
        const failure = await completionOutcome;

        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors).toContain(nativeFailure);
        expect(stream.stopCalls).toBe(1);
        expect(testState.stoppingSessionIds).toEqual(['remcli-session']);
        expect(testState.stoppedSessionIds).toEqual([]);
        expect(session().deathCalls).toBe(1);
        expect(session().flushCalls).toBe(1);
        expect(session().closeCalls).toBe(1);
    });

    it('acknowledges a durable delivery only after the first provider event', async () => {
        const completion = launch();
        const handler = await waitForUserHandler();
        let settled = false;
        const delivery = deliver(handler, 'prompt', 'delivery-1').then(
            () => { settled = true; },
            (error: unknown) => {
                settled = true;
                throw error;
            },
        );
        const stream = await waitForStream();

        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        await Promise.resolve();
        expect(settled).toBe(false);

        stream.emitStep({
            conversation_id: 'conversation-1',
            step_index: 0,
            state: 'ACTIVE',
            step_type: 'agent_response',
            text_delta: 'accepted',
        });
        await delivery;
        expect(settled).toBe(true);

        stream.finish(successfulResult('conversation-1', 'accepted'));
        await waitForAgentMessages('task_complete', 1);
        await stopRunner(completion);
    });

    it('cancels and acknowledges an active durable delivery only after native abort succeeds', async () => {
        const completion = launch();
        const handler = await waitForUserHandler();
        const delivery = deliver(handler, 'prompt', 'delivery-1');
        const stream = await waitForStream();

        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        const abort = session().rpcHandlers.get('abort');
        if (!abort) throw new Error('Abort RPC is not registered.');
        await abort();
        await completion;
        await delivery;

        expect(stream.abortCalls).toBe(1);
        expect(session().cancelledDeliveries).toEqual(['delivery-1']);
        expect(session().messages.filter(({ body }) => body.type === 'task_started')).toHaveLength(1);
        expect(session().messages.filter(({ body }) => body.type === 'turn_aborted')).toHaveLength(1);
        expect(session().messages.filter(({ body }) => body.type === 'task_complete')).toHaveLength(0);
    });

    it('aborts a published native candidate when RPC abort arrives during pending init', async () => {
        const completion = launch(daemonRunOptions(false));
        await waitForUserHandler();
        const delivery = deliverDurable('prompt', 'delivery-init-race');
        const stream = await waitForStream();
        let releaseAbort!: () => void;
        stream.abortWait = new Promise<void>((resolve) => {
            releaseAbort = resolve;
        });
        const abort = session().rpcHandlers.get('abort');
        if (!abort) throw new Error('Abort RPC is not registered.');

        const cleanupOutcome = Promise.resolve(abort());
        await vi.waitFor(() => expect(stream.abortCalls).toBe(1));
        expect(stream.hasPendingInit()).toBe(true);
        expect(testState.stoppedSessionIds).toEqual([]);
        expect(session().closeCalls).toBe(0);

        releaseAbort();
        await cleanupOutcome;
        await completion;
        await delivery;

        expect(stream.stopCalls).toBe(0);
        expect(session().cancelledDeliveries).toEqual(['delivery-init-race']);
        expect(testState.stoppedSessionIds).toEqual(['remcli-session']);
        expect(testState.lifecycleOrder.indexOf('native-abort'))
            .toBeLessThan(testState.lifecycleOrder.indexOf('daemon-stopped'));
    });

    it('waits for pending daemon binding after SIGTERM before reporting stopped', async () => {
        const previousSignalListeners = new Set(process.listeners('SIGTERM'));
        const releaseBinding = deferBinding();
        const completion = launch(daemonRunOptions(false));
        await waitForUserHandler();
        const delivery = deliverDurable('prompt', 'delivery-bind-race');
        const stream = await waitForStream();
        stream.emitInit('conversation-1');
        await vi.waitFor(() => expect(testState.bindingRequests).toHaveLength(1));
        const signalHandler = process.listeners('SIGTERM')
            .find((listener) => !previousSignalListeners.has(listener));
        if (!signalHandler) throw new Error('SIGTERM cleanup handler is not registered.');

        signalHandler('SIGTERM');
        await vi.waitFor(() => expect(stream.abortCalls).toBe(1));
        expect(testState.stoppedSessionIds).toEqual([]);
        expect(session().closeCalls).toBe(0);

        releaseBinding();
        await completion;
        await delivery;

        expect(stream.stopCalls).toBe(0);
        expect(session().cancelledDeliveries).toEqual(['delivery-bind-race']);
        expect(testState.stoppedSessionIds).toEqual(['remcli-session']);
        expect(process.listeners('SIGTERM')).not.toContain(signalHandler);
    });

    it('recovers a durable prompt after provider failure before acceptance', async () => {
        const completion = launch();
        await waitForUserHandler();
        const firstAttempt = deliverDurable('prompt', 'delivery-1');
        const firstStream = await waitForStream();

        firstStream.emitInit('conversation-1');
        await waitForSentTurns(firstStream, 1);
        firstStream.failTurn(new Error('provider disconnected before acceptance'));

        await expect(firstAttempt).rejects.toBeInstanceOf(RetryableUserMessageDeliveryError);
        await vi.waitFor(() => expect(session().acceptedRedeliveryRequests).toBe(1));
        const recoveredStream = await waitForStream(1);
        expect(recoveredStream.options.conversationId).toBe('conversation-1');
        expect(recoveredStream.startCalls).toEqual(['conversation-1']);
        recoveredStream.emitInit('conversation-1');
        await waitForSentTurns(recoveredStream, 1);
        recoveredStream.emitStep({
            conversation_id: 'conversation-1',
            step_index: 0,
            state: 'ACTIVE',
            step_type: 'agent_response',
            text_delta: 'accepted after recovery',
        });
        const recoveredAttempt = session().deliveryAttemptPromises.at(-1);
        if (!recoveredAttempt) throw new Error('Recovered delivery attempt was not recorded.');
        await recoveredAttempt;
        recoveredStream.finish(successfulResult('conversation-1', 'accepted after recovery'));
        await waitForAgentMessages('task_complete', 1);

        expect(visibleMessages()).toContain('provider disconnected before acceptance');
        expect(session().messages.filter(({ body }) => body.type === 'task_started')).toHaveLength(2);
        expect(session().messages.filter(({ body }) => body.type === 'turn_aborted')).toHaveLength(1);
        expect(firstStream.stopCalls).toBe(1);
        expect(firstStream.abortCalls).toBe(0);
        expect(session().redeliveryRequestCalls).toBe(1);
        expect(testState.streams).toHaveLength(2);
        expect(session().pendingDurableMessage).toBeNull();

        let runnerSettled = false;
        void completion.then(
            () => { runnerSettled = true; },
            () => { runnerSettled = true; },
        );
        await Promise.resolve();
        expect(runnerSettled).toBe(false);
        await stopRunner(completion);
    });

    it('bounds automatic recovery after a repeated pre-acceptance provider failure', async () => {
        const completion = launch();
        await waitForUserHandler();
        const firstAttempt = deliverDurable('prompt', 'delivery-bounded');
        const firstStream = await waitForStream();
        firstStream.emitInit('conversation-1');
        await waitForSentTurns(firstStream, 1);
        firstStream.failTurn(new Error('first provider failure'));
        await expect(firstAttempt).rejects.toBeInstanceOf(RetryableUserMessageDeliveryError);

        await vi.waitFor(() => expect(session().acceptedRedeliveryRequests).toBe(1));
        const recoveredStream = await waitForStream(1);
        recoveredStream.emitInit('conversation-1');
        await waitForSentTurns(recoveredStream, 1);
        const recoveredAttempt = session().deliveryAttemptPromises.at(-1);
        if (!recoveredAttempt) throw new Error('Recovered delivery attempt was not recorded.');
        recoveredStream.failTurn(new Error('second provider failure'));
        await expect(recoveredAttempt).rejects.toBeInstanceOf(RetryableUserMessageDeliveryError);
        await new Promise((resolve) => setTimeout(resolve, 150));

        expect(session().redeliveryRequestCalls).toBe(1);
        expect(session().acceptedRedeliveryRequests).toBe(1);
        expect(testState.streams).toHaveLength(2);
        expect(session().pendingDurableMessage?.deliveryId).toBe('delivery-bounded');
        await stopRunner(completion);
    });

    it('keeps an accepted delivery acknowledged when the provider later fails', async () => {
        const completion = launch();
        const handler = await waitForUserHandler();
        const delivery = deliver(handler, 'prompt', 'delivery-1');
        const stream = await waitForStream();

        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        stream.emitStep({
            conversation_id: 'conversation-1',
            step_index: 0,
            state: 'ACTIVE',
            step_type: 'agent_response',
            text_delta: 'accepted',
        });
        await delivery;
        stream.failTurn(new Error('provider disconnected after acceptance'));

        await completion;
        expect(visibleMessages()).toContain('provider disconnected after acceptance');
        expect(session().messages.filter(({ body }) => body.type === 'task_started')).toHaveLength(1);
        expect(session().messages.filter(({ body }) => (
            body.type === 'task_complete' || body.type === 'turn_aborted'
        ))).toHaveLength(1);
        expect(session().redeliveryRequestCalls).toBe(0);
        expect(testState.streams).toHaveLength(1);
    });

    it('soft-denies redacted stderr and exposes a non-success result', async () => {
        const completion = launch();
        const handler = await waitForUserHandler();
        const delivery = deliver(handler, 'prompt');
        const stream = await waitForStream();

        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        stream.emitStderr('Authorization: Bearer stderr-secret\nTOKEN=second-secret');
        stream.finish({
            conversation_id: 'conversation-1',
            status: 'ERROR',
            response: '',
            error: 'token=result-secret provider failed',
        });
        await delivery;
        await waitForAgentMessages('task_complete', 1);

        const visible = visibleMessages();
        expect(visible).toContain('Antigravity stderr');
        expect(visible).toContain('provider failed');
        expect(visible).toContain('[REDACTED]');
        expect(visible).not.toContain('stderr-secret');
        expect(visible).not.toContain('second-secret');
        expect(visible).not.toContain('result-secret');

        await stopRunner(completion);
    });

    it('deeply clones, bounds, and redacts nested tool information', async () => {
        const completion = launch();
        const handler = await waitForUserHandler();
        const delivery = deliver(handler, 'prompt');
        const stream = await waitForStream();
        const toolInfo = {
            command: 'curl https://example.test?token=query-secret',
            nested: {
                authToken: 'field-secret',
                note: 'Authorization: Bearer text-secret',
                values: [
                    { cookie: 'cookie-secret' },
                    'TOKEN=array-secret',
                    'x'.repeat(5_000),
                ],
            },
            bulk: Array.from({ length: 12 }, (_value, index) => `${index}:${'y'.repeat(3_000)}`),
        };

        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        stream.emitStep({
            conversation_id: 'conversation-1',
            step_index: 3,
            state: 'ACTIVE',
            step_type: 'tool',
            tool_name: 'shell',
            tool_info: toolInfo,
        });
        stream.emitStep({
            conversation_id: 'conversation-1',
            step_index: 3,
            state: 'DONE',
            step_type: 'tool',
            tool_name: 'shell',
            tool_info: toolInfo,
        });
        toolInfo.nested.note = 'mutated-after-send';
        stream.finish(successfulResult('conversation-1', 'done'));
        await delivery;
        await waitForAgentMessages('task_complete', 1);

        const toolMessages = session().messages
            .map(({ body }) => body)
            .filter((body): body is Extract<ACPMessageData, { type: 'tool-call' | 'tool-result' }> => (
                body.type === 'tool-call' || body.type === 'tool-result'
            ));
        expect(toolMessages).toHaveLength(2);
        expect(toolMessages.map(({ callId }) => callId)).toEqual([
            'antigravity-1-3',
            'antigravity-1-3',
        ]);
        const input = toolMessages[0].type === 'tool-call' ? toolMessages[0].input : undefined;
        const output = toolMessages[1].type === 'tool-result' ? toolMessages[1].output : undefined;
        expect(input).not.toBe(toolInfo);
        expect(output).not.toBe(toolInfo);
        const serialized = JSON.stringify({ input, output });
        expect(Buffer.byteLength(JSON.stringify(input), 'utf8')).toBeLessThanOrEqual(8 * 1_024);
        expect(serialized).toContain('[REDACTED]');
        expect(serialized).not.toContain('query-secret');
        expect(serialized).not.toContain('field-secret');
        expect(serialized).not.toContain('text-secret');
        expect(serialized).not.toContain('cookie-secret');
        expect(serialized).not.toContain('array-secret');
        expect(serialized).not.toContain('mutated-after-send');
        expect(serialized).not.toContain('x'.repeat(2_100));

        await stopRunner(completion);
    });

    it('retries native metadata reconciliation before accepting a redelivery', async () => {
        const daemonOptions = daemonRunOptions(false);
        session().metadataFailuresRemaining = 1;
        session().redeliveryRefusalsRemaining = 1;
        const completion = launch(daemonOptions);
        await waitForUserHandler();
        const firstDelivery = deliverDurable('retry me', 'delivery-1');
        const stream = await waitForStream();

        stream.emitInit('conversation-1');
        await expect(firstDelivery).rejects.toBeInstanceOf(RetryableUserMessageDeliveryError);
        expect(stream.sentTurns).toEqual([]);
        expect(testState.bindingRequests).toHaveLength(1);
        expect(session().metadataAttempts[0]).toMatchObject({
            succeeded: false,
            metadata: {
                agentSessionId: 'conversation-1',
                antigravitySessionId: 'conversation-1',
            },
        });

        await vi.waitFor(() => expect(session().acceptedRedeliveryRequests).toBe(1));
        await waitForSentTurns(stream, 1);
        const redelivery = session().deliveryAttemptPromises.at(-1);
        if (!redelivery) throw new Error('Metadata redelivery attempt was not recorded.');
        expect(session().metadataAttempts.filter(({ succeeded }) => succeeded)).toHaveLength(1);
        expect(session().metadata).toMatchObject({
            agentSessionId: 'conversation-1',
            antigravitySessionId: 'conversation-1',
        });
        stream.finish(successfulResult('conversation-1', 'accepted after metadata retry'));
        await redelivery;
        await waitForAgentMessages('task_complete', 1);

        expect(testState.streams).toHaveLength(1);
        expect(stream.startCalls).toEqual([undefined]);
        expect(testState.bindingRequests).toHaveLength(1);
        expect(session().redeliveryRequestCalls).toBe(2);
        expect(session().acceptedRedeliveryRequests).toBe(1);
        await stopRunner(completion);
    });

    it('rolls back a provisional resume parent before reporting credential handoff failure', async () => {
        testState.preflightResult = {
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: 'parent-remcli-session' },
        };
        testState.credentialAccepted = false;
        const completion = launch({
            ...daemonRunOptions(false),
            resumeSessionId: 'native-conversation',
        });

        await completion;

        expect(testState.creationRequests[0].metadata.resumedFromRemcliSessionId)
            .toBe('parent-remcli-session');
        expect(session().metadata).toMatchObject({
            lifecycleState: 'archived',
            archiveReason: 'Daemon credential handoff failed',
        });
        expect(session().metadata.resumedFromRemcliSessionId).toBeUndefined();
        expect(session().deathCalls).toBe(1);
        expect(session().flushCalls).toBe(1);
        expect(session().closeCalls).toBe(1);
        expect(testState.setupCalls).toHaveLength(0);
        expect(testState.streams).toHaveLength(0);
        expect(testState.bootstrapFailureRequests).toHaveLength(1);
        expect(testState.lifecycleOrder.indexOf('session-close'))
            .toBeLessThan(testState.lifecycleOrder.indexOf('bootstrap-failure'));
    });

    it('propagates provisional parent rollback teardown failure after bootstrap reporting', async () => {
        testState.preflightResult = {
            ok: true,
            data: { type: 'verified', parentRemcliSessionId: 'parent-remcli-session' },
        };
        testState.credentialAccepted = false;
        session().metadataFailuresRemaining = 1;
        session().metadataFailure = new Error('token=provisional-secret rollback failed');
        const completion = launch({
            ...daemonRunOptions(false),
            resumeSessionId: 'native-conversation',
        });

        const failure = await completion.then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(AggregateError);
        expect(String(failure)).not.toContain('provisional-secret');
        expect(session().metadata.resumedFromRemcliSessionId).toBe('parent-remcli-session');
        expect(session().deathCalls).toBe(1);
        expect(session().flushCalls).toBe(1);
        expect(session().closeCalls).toBe(1);
        expect(testState.bootstrapFailureRequests).toHaveLength(1);
        expect(testState.lifecycleOrder.indexOf('session-close'))
            .toBeLessThan(testState.lifecycleOrder.indexOf('bootstrap-failure'));
        expect(visibleMessages()).toContain('[REDACTED]');
        expect(visibleMessages()).not.toContain('provisional-secret');
        expect(JSON.stringify(vi.mocked(logger.debug).mock.calls)).not.toContain('provisional-secret');
    });

    it('cancels reconnection, archives P2P, and reports stopped only after native abort', async () => {
        const completion = launch(daemonRunOptions(false));
        const handler = await waitForUserHandler();
        const delivery = deliver(handler, 'prompt');
        const stream = await waitForStream();

        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        stream.finish(successfulResult('conversation-1', 'done'));
        await delivery;
        await waitForAgentMessages('task_complete', 1);
        expect(testState.killHandler).not.toBeNull();

        await testState.killHandler!();
        await completion;

        expect(stream.abortCalls).toBe(1);
        expect(testState.reconnectionCancelCalls).toBe(1);
        expect(session().metadata).toMatchObject({
            lifecycleState: 'archived',
            archiveReason: 'User terminated',
        });
        expect(session().deathCalls).toBe(1);
        expect(session().flushCalls).toBe(1);
        expect(session().closeCalls).toBe(1);
        expect(testState.stoppingSessionIds).toEqual(['remcli-session']);
        expect(testState.stoppedSessionIds).toEqual(['remcli-session']);
        expect(testState.lifecycleOrder.indexOf('native-abort'))
            .toBeLessThan(testState.lifecycleOrder.indexOf('daemon-stopped'));
    });

    it.each([
        {
            stage: 'metadata archival',
            inject: (target: SessionHarness) => {
                target.metadataFailuresRemaining = 1;
                target.metadataFailure = new Error('token=metadata-secret teardown failed');
            },
        },
        {
            stage: 'flush',
            inject: (target: SessionHarness) => {
                target.flushError = new Error('token=flush-secret teardown failed');
            },
        },
        {
            stage: 'close',
            inject: (target: SessionHarness) => {
                target.closeError = new Error('token=close-secret teardown failed');
            },
        },
    ])('propagates $stage failure and keeps daemon tracking fail-closed', async ({ stage, inject }) => {
        const completion = launch(daemonRunOptions(false));
        const handler = await waitForUserHandler();
        const delivery = deliver(handler, 'prompt');
        const stream = await waitForStream();
        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        stream.finish(successfulResult('conversation-1', 'done'));
        await delivery;
        await waitForAgentMessages('task_complete', 1);
        inject(session());

        const completionOutcome = completion.then(
            () => null,
            (error: unknown) => error,
        );
        const abort = session().rpcHandlers.get('abort');
        if (!abort) throw new Error('Abort RPC is not registered.');
        const cleanupOutcome = Promise.resolve(abort()).then(
            () => null,
            (error: unknown) => error,
        );
        const cleanupFailure = await cleanupOutcome;
        const completionFailure = await completionOutcome;

        expect(cleanupFailure).toBeInstanceOf(AggregateError);
        expect(completionFailure).toBe(cleanupFailure);
        expect(String(cleanupFailure)).not.toContain('secret');
        expect(stream.abortCalls).toBe(1);
        expect(session().deathCalls).toBe(1);
        expect(session().flushCalls).toBe(1);
        expect(session().closeCalls).toBe(1);
        expect(testState.stoppingSessionIds).toEqual(['remcli-session']);
        expect(testState.stoppedSessionIds).toEqual([]);
        expect(visibleMessages()).toContain(stage);
        expect(visibleMessages()).toContain('[REDACTED]');
        expect(visibleMessages()).not.toMatch(/metadata-secret|flush-secret|close-secret/);
        expect(JSON.stringify(vi.mocked(logger.debug).mock.calls))
            .not.toMatch(/metadata-secret|flush-secret|close-secret/);
    });

    it('propagates native abort failure and leaves daemon tracking fail-closed', async () => {
        const completion = launch(daemonRunOptions(false));
        const handler = await waitForUserHandler();
        const delivery = deliver(handler, 'prompt', 'delivery-1');
        const stream = await waitForStream();

        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        const nativeFailure = new Error('native process did not stop');
        stream.abortError = nativeFailure;
        const completionOutcome = completion.then(
            () => null,
            (error: unknown) => error,
        );
        const deliveryOutcome = delivery.then(
            () => null,
            (error: unknown) => error,
        );
        const abort = session().rpcHandlers.get('abort');
        if (!abort) throw new Error('Abort RPC is not registered.');
        const cleanupOutcome = Promise.resolve(abort()).then(
            () => null,
            (error: unknown) => error,
        );

        expect(await cleanupOutcome).toBe(nativeFailure);
        expect(await completionOutcome).toBe(nativeFailure);
        expect(await deliveryOutcome).toBeInstanceOf(RetryableUserMessageDeliveryError);
        expect(testState.stoppingSessionIds).toEqual(['remcli-session']);
        expect(testState.stoppedSessionIds).toEqual([]);
        expect(session().messages.filter(({ body }) => body.type === 'turn_aborted')).toHaveLength(1);
        expect(session().messages.filter(({ body }) => body.type === 'task_complete')).toHaveLength(0);
        expect(session().deathCalls).toBe(1);
        expect(session().flushCalls).toBe(1);
        expect(session().closeCalls).toBe(1);
        expect(testState.lifecycleOrder).not.toContain('daemon-stopped');
    });

    it('uses the same native cleanup path for termination signals', async () => {
        const previousSignalListeners = new Set(process.listeners('SIGTERM'));
        const completion = launch();
        const handler = await waitForUserHandler();
        const delivery = deliver(handler, 'prompt');
        const stream = await waitForStream();

        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        stream.finish(successfulResult('conversation-1', 'done'));
        await delivery;
        await waitForAgentMessages('task_complete', 1);
        const signalHandler = process.listeners('SIGTERM')
            .find((listener) => !previousSignalListeners.has(listener));
        if (!signalHandler) throw new Error('SIGTERM cleanup handler is not registered.');

        signalHandler('SIGTERM');
        await completion;

        expect(stream.abortCalls).toBe(1);
        expect(testState.reconnectionCancelCalls).toBe(1);
        expect(process.listeners('SIGTERM')).not.toContain(signalHandler);
    });

    it('passes sandbox true to the persistent native client', async () => {
        const completion = launch({ launchControls: launchControls(true) });
        const handler = await waitForUserHandler();
        const delivery = deliver(handler, 'prompt');
        const stream = await waitForStream();

        expect(stream.options.sandbox).toBe(true);
        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        stream.finish(successfulResult('conversation-1', 'done'));
        await delivery;
        await waitForAgentMessages('task_complete', 1);
        await stopRunner(completion);
    });

    it('ignores the legacy reasoning environment variable', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'runner-token';
        process.env.REMCLI_ANTIGRAVITY_MODEL = execution.model;
        process.env.REMCLI_ANTIGRAVITY_CATALOG_VERSION = execution.catalogVersion;
        process.env.REMCLI_ANTIGRAVITY_EFFORT = 'high';
        process.env.REMCLI_ANTIGRAVITY_MODE = 'default';
        process.env.REMCLI_ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS = 'false';
        process.env.REMCLI_ANTIGRAVITY_SANDBOX = 'false';
        const completion = launch({ startedBy: 'daemon' });
        const handler = await waitForUserHandler();
        const delivery = deliver(handler, 'prompt');
        const stream = await waitForStream();

        expect(stream.options.effort).toBeUndefined();
        expect(stream.options.sandbox).toBe(false);
        stream.emitInit('conversation-1');
        await waitForSentTurns(stream, 1);
        stream.finish(successfulResult('conversation-1', 'done'));
        await delivery;
        await waitForAgentMessages('task_complete', 1);
        await stopRunner(completion);
    });

    it('fails closed before P2P when the daemon tuple is incomplete', async () => {
        process.env.REMCLI_DAEMON_RUNNER_TOKEN = 'runner-token';
        process.env.REMCLI_ANTIGRAVITY_MODEL = execution.model;
        process.env.REMCLI_ANTIGRAVITY_CATALOG_VERSION = execution.catalogVersion;
        process.env.REMCLI_ANTIGRAVITY_REASONING_EFFORT = 'medium';
        process.env.REMCLI_ANTIGRAVITY_MODE = 'default';
        process.env.REMCLI_ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS = 'false';
        const completion = launch({ startedBy: 'daemon' });

        await completion;

        expect(testState.bootstrapFailureRequests).toHaveLength(1);
        expect(testState.preflightRequests).toHaveLength(0);
        expect(testState.apiCreateCalls).toHaveLength(0);
        expect(testState.creationRequests).toHaveLength(0);
        expect(testState.streams).toHaveLength(0);
    });

    it('fails closed before P2P when the daemon runner token is missing', async () => {
        const completion = launch({
            startedBy: 'daemon',
            execution,
            launchControls: launchControls(false),
        });

        await completion;

        expect(testState.bootstrapFailureRequests).toHaveLength(1);
        expect(testState.preflightRequests).toHaveLength(0);
        expect(testState.apiCreateCalls).toHaveLength(0);
        expect(testState.creationRequests).toHaveLength(0);
        expect(testState.streams).toHaveLength(0);
    });
});
