import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RetryableUserMessageDeliveryError, type DeliveredUserMessage, type UserMessage } from '@/api/types';
import {
    forgetSessionRunnerCredential,
    rememberSessionRunnerCredential,
} from '@/daemon/p2p/p2pRunnerCredentials';
import { logger } from '@/ui/logger';

const testAppServerErrors = vi.hoisted(() => {
    class TransportError extends Error {
        readonly isRecoverable = true;
    }

    class ThreadStateError extends Error {
        readonly isRecoverable = true;
    }

    class JsonRpcError extends Error {
        constructor(message: string, readonly code?: number) {
            super(message);
        }
    }

    class ActiveTurnHandoffError extends Error {
        constructor(
            readonly threadId: string,
            readonly turnId: string,
        ) {
            super(`Codex app-server has an active turn ${turnId} in thread ${threadId}.`);
        }
    }

    class AmbiguousThreadStartError extends Error {
        readonly code = 'CODEX_THREAD_START_AMBIGUOUS';
    }

    return {
        TransportError,
        ThreadStateError,
        JsonRpcError,
        ActiveTurnHandoffError,
        AmbiguousThreadStartError,
    };
});

interface CapturedTurn {
    threadId: string;
    prompt: string;
    clientUserMessageId?: string;
    model?: string;
    effort?: string;
}

interface CapturedSteer {
    threadId: string;
    expectedTurnId: string;
    prompt: string;
    clientUserMessageId?: string;
}

type TestAppServerEvent =
    | {
        type: 'user_message';
        source: 'own' | 'external';
        text: string;
    }
    | { type: 'task_started' }
    | { type: 'task_complete' }
    | { type: 'agent_error'; message?: string }
    | { type: 'agent_message'; message: string; origin: 'live' | 'replay' }
    | { type: 'exec_command_begin'; command: string };

interface InterruptedTurnCompletedNotification {
    threadId: string;
    turnId: string;
    status: string;
}

interface TestState {
    incomingMessages: DeliveredUserMessage[];
    appServerEvents: TestAppServerEvent[];
    resumeAppServerEvents: TestAppServerEvent[];
    beginTurns: CapturedTurn[];
    steeredTurns: CapturedSteer[];
    sentUserMessages: Array<{ text: string; sentFrom?: string }>;
    sentCodexMessages: Array<{ type: string; message?: string }>;
    sessionEvents: Array<{ type: string; message?: string; isError?: boolean }>;
    executionOutcome: { kind: 'error' | 'success'; occurredAt: number } | null;
    successfulAgentOutputCalls: number;
    bindingCalls: Array<{ agent: string; nativeThreadId: string; remcliSessionId: string }>;
    remoteTuiOpenCalls: Array<{
        agent: string;
        nativeThreadId: string;
        remcliSessionId: string;
        endpoint: string;
        reasoningEffort: string;
        model?: string;
    }>;
    callOrder: string[];
    startupCallOrder: string[];
    sessionStartedResults: Array<{ error?: string }>;
    startedThreads: number;
    resumedThreads: number;
    nativeThreadId: string;
    resumedActiveTurnId: string | null;
    hydratedThreadId: string | null;
    hydratedActiveTurnId: string | null;
    hydratedExternalUserText: string | null;
    hydrationCalls: number;
    hydrationFailures: Error[];
    activeThreadId: string | null;
    activeTurnId: string | null;
    interruptingTurnId: string | null;
    interruptRequests: Array<{ threadId: string; turnId: string }>;
    interruptedTurnWaitCalls: string[];
    interruptedTurnWaitFailure: Error | null;
    interruptedTurnCompletionEvents: InterruptedTurnCompletedNotification[];
    emitInterruptedTurnCompleted: ((notification: InterruptedTurnCompletedNotification) => void) | null;
    connectCalls: number;
    connectFailures: Error[];
    deferConnectAfterCalls: number | null;
    resolveDeferredConnect: (() => void) | null;
    startThreadFailures: Error[];
    beginTurnFailures: Error[];
    isBeginTurnAcceptanceDeferred: boolean;
    resolveBeginTurnAcceptance: (() => void) | null;
    steerFailures: Error[];
    steerFailureSuccessorTurnIds: Array<string | null>;
    steerFailureLifecycleEvents: string[];
    keepsActiveTurnOnSteerFailure: boolean;
    turnCompletionCalls: string[];
    deferredTurnCompletionIds: Set<string>;
    turnCompletionResolvers: Map<string, () => void>;
    acknowledgedDeliveryIds: string[];
    rejectedDeliveryErrors: Error[];
    redeliveryRequests: number;
    closeQueueAfterRedeliveryRequests: number | null;
    abortBeforeNextQueueDelivery: boolean;
    closeQueueWhenEmpty: boolean;
    cancelledDeliveryIds: string[];
    deliverIncomingMessagesSynchronously: boolean;
    userMessageCallback: ((message: DeliveredUserMessage) => void | Promise<void>) | null;
    abortHandler: (() => void | Promise<void>) | null;
    bindingResult: {
        ok: boolean;
        data?: {
            type: 'bound' | 'already-bound' | 'reuse-active-wrapper' | 'wrapper-not-tracked' | 'agent-mismatch';
            wrapper?: { agent: 'codex'; nativeThreadId: string; remcliSessionId: string };
            binding?: { agent: 'codex'; nativeThreadId: string; remcliSessionId: string };
            trackedAgent?: 'claude' | 'codex' | 'cursor' | 'gemini';
        };
        error?: string;
    };
    remoteTuiOpenResults: Array<{
        ok: boolean;
        data?: {
            type: 'opened' | 'already-open' | 'host-unavailable'
                | 'wrapper-not-tracked' | 'agent-mismatch' | 'native-thread-mismatch' | 'wrapper-not-daemon-owned';
            error?: string;
        };
        error?: string;
    }>;
    remoteTuiOpenResult: {
        ok: boolean;
        data?: {
            type: 'opened' | 'already-open' | 'host-unavailable'
                | 'wrapper-not-tracked' | 'agent-mismatch' | 'native-thread-mismatch' | 'wrapper-not-daemon-owned';
            error?: string;
        };
        error?: string;
    };
}

const testState = vi.hoisted(() => {
    const state: TestState = {
        incomingMessages: [],
        appServerEvents: [],
        resumeAppServerEvents: [],
        beginTurns: [],
        steeredTurns: [],
        sentUserMessages: [],
        sentCodexMessages: [],
        sessionEvents: [],
        executionOutcome: null,
        successfulAgentOutputCalls: 0,
        bindingCalls: [],
        remoteTuiOpenCalls: [],
        callOrder: [],
        startupCallOrder: [],
        sessionStartedResults: [],
        startedThreads: 0,
        resumedThreads: 0,
        nativeThreadId: 'native-thread',
        resumedActiveTurnId: null,
        hydratedThreadId: null,
        hydratedActiveTurnId: null,
        hydratedExternalUserText: null,
        hydrationCalls: 0,
        hydrationFailures: [],
        activeThreadId: null,
        activeTurnId: null,
        interruptingTurnId: null,
        interruptRequests: [],
        interruptedTurnWaitCalls: [],
        interruptedTurnWaitFailure: null,
        interruptedTurnCompletionEvents: [],
        emitInterruptedTurnCompleted: null,
        connectCalls: 0,
        connectFailures: [],
        deferConnectAfterCalls: null,
        resolveDeferredConnect: null,
        startThreadFailures: [],
        beginTurnFailures: [],
        isBeginTurnAcceptanceDeferred: false,
        resolveBeginTurnAcceptance: null,
        steerFailures: [],
        steerFailureSuccessorTurnIds: [],
        steerFailureLifecycleEvents: [],
        keepsActiveTurnOnSteerFailure: false,
        turnCompletionCalls: [],
        deferredTurnCompletionIds: new Set(),
        turnCompletionResolvers: new Map(),
        acknowledgedDeliveryIds: [],
        rejectedDeliveryErrors: [],
        redeliveryRequests: 0,
        closeQueueAfterRedeliveryRequests: null,
        abortBeforeNextQueueDelivery: false,
        closeQueueWhenEmpty: false,
        cancelledDeliveryIds: [],
        deliverIncomingMessagesSynchronously: false,
        userMessageCallback: null,
        abortHandler: null,
        bindingResult: {
            ok: true,
            data: {
                type: 'bound',
                wrapper: {
                    agent: 'codex',
                    nativeThreadId: 'native-thread',
                    remcliSessionId: 'remcli-session',
                },
            },
        },
        remoteTuiOpenResult: {
            ok: true,
            data: { type: 'opened' },
        },
        remoteTuiOpenResults: [],
    };

    return {
        state,
        reset(): void {
            state.incomingMessages = [];
            state.appServerEvents = [];
            state.resumeAppServerEvents = [];
            state.beginTurns = [];
            state.steeredTurns = [];
            state.sentUserMessages = [];
            state.sentCodexMessages = [];
            state.sessionEvents = [];
            state.executionOutcome = null;
            state.successfulAgentOutputCalls = 0;
            state.bindingCalls = [];
            state.remoteTuiOpenCalls = [];
            state.callOrder = [];
            state.startupCallOrder = [];
            state.sessionStartedResults = [];
            state.startedThreads = 0;
            state.resumedThreads = 0;
            state.nativeThreadId = 'native-thread';
            state.resumedActiveTurnId = null;
            state.hydratedThreadId = null;
            state.hydratedActiveTurnId = null;
            state.hydratedExternalUserText = null;
            state.hydrationCalls = 0;
            state.hydrationFailures = [];
            state.activeThreadId = null;
            state.activeTurnId = null;
            state.interruptingTurnId = null;
            state.interruptRequests = [];
            state.interruptedTurnWaitCalls = [];
            state.interruptedTurnWaitFailure = null;
            state.interruptedTurnCompletionEvents = [];
            state.emitInterruptedTurnCompleted = null;
            state.connectCalls = 0;
            state.connectFailures = [];
            state.deferConnectAfterCalls = null;
            state.resolveDeferredConnect = null;
            state.startThreadFailures = [];
            state.beginTurnFailures = [];
            state.isBeginTurnAcceptanceDeferred = false;
            state.resolveBeginTurnAcceptance = null;
            state.steerFailures = [];
            state.steerFailureSuccessorTurnIds = [];
            state.steerFailureLifecycleEvents = [];
            state.keepsActiveTurnOnSteerFailure = false;
            state.turnCompletionCalls = [];
            state.deferredTurnCompletionIds.clear();
            state.turnCompletionResolvers.clear();
            state.acknowledgedDeliveryIds = [];
            state.rejectedDeliveryErrors = [];
            state.redeliveryRequests = 0;
            state.closeQueueAfterRedeliveryRequests = null;
            state.abortBeforeNextQueueDelivery = false;
            state.closeQueueWhenEmpty = false;
            state.cancelledDeliveryIds = [];
            state.deliverIncomingMessagesSynchronously = false;
            state.userMessageCallback = null;
            state.abortHandler = null;
            state.bindingResult = {
                ok: true,
                data: {
                    type: 'bound',
                    wrapper: {
                        agent: 'codex',
                        nativeThreadId: 'native-thread',
                        remcliSessionId: 'remcli-session',
                    },
                },
            };
            state.remoteTuiOpenResult = {
                ok: true,
                data: { type: 'opened' },
            };
            state.remoteTuiOpenResults = [];
        },
    };
});

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            getOrCreateSession: vi.fn(async () => ({
                id: 'remcli-session',
                seq: 1,
                metadata: testState.state.executionOutcome
                    ? { executionOutcome: testState.state.executionOutcome }
                    : {},
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy',
            })),
            sessionSyncClient: vi.fn(() => {
                testState.state.startupCallOrder.push('session-sync');
                return {
                sessionId: 'remcli-session',
                onUserMessage(callback: (message: DeliveredUserMessage) => void | Promise<void>): void {
                    testState.state.userMessageCallback = callback;
                    const deliverIncomingMessages = () => {
                        for (const message of testState.state.incomingMessages) {
                            void Promise.resolve(callback(message)).catch(() => undefined);
                        }
                    };
                    if (testState.state.deliverIncomingMessagesSynchronously) {
                        deliverIncomingMessages();
                    } else {
                        queueMicrotask(deliverIncomingMessages);
                    }
                },
                sendUserTextMessage(text: string, meta: { sentFrom?: string }): void {
                    testState.state.sentUserMessages.push({ text, sentFrom: meta.sentFrom });
                },
                sendCodexMessage(message: { type: string; message?: string }): void {
                    testState.state.sentCodexMessages.push(message);
                },
                sendAgentMessage: vi.fn(),
                sendClaudeSessionMessage: vi.fn(),
                sendSessionEvent(event: { type: string; message?: string; isError?: boolean }): void {
                    testState.state.sessionEvents.push(event);
                },
                sendSessionDeath: vi.fn(),
                recordSuccessfulAgentOutput(): void {
                    testState.state.successfulAgentOutputCalls += 1;
                    testState.state.executionOutcome = {
                        kind: 'success',
                        occurredAt: 200,
                    };
                },
                requestPendingUserMessageRedelivery(): boolean {
                    const message = testState.state.incomingMessages[0];
                    const callback = testState.state.userMessageCallback;
                    if (!message || !callback) {
                        return false;
                    }
                    testState.state.redeliveryRequests += 1;
                    queueMicrotask(() => {
                        void Promise.resolve(callback(message)).catch(() => undefined);
                    });
                    return true;
                },
                cancelPendingUserMessageDelivery(deliveryId: string): boolean {
                    testState.state.cancelledDeliveryIds.push(deliveryId);
                    return true;
                },
                updateLifecycleState: vi.fn(),
                requestControlTransfer: vi.fn(async () => undefined),
                keepAlive: vi.fn(),
                flush: vi.fn(async () => undefined),
                close: vi.fn(async () => undefined),
                updateMetadata: vi.fn(),
                updateAgentState: vi.fn(),
                rpcHandlerManager: {
                    registerHandler: vi.fn((method: string, handler: () => void | Promise<void>) => {
                        if (method === 'abort') {
                            testState.state.abortHandler = handler;
                        }
                    }),
                },
                };
            }),
        })),
    },
}));

vi.mock('@/persistence', () => ({
    readDaemonState: vi.fn(async () => ({
        codexAppServerEndpoint: 'ws://127.0.0.1:45123',
        codexAppServerPid: process.pid,
    })),
    readSettings: vi.fn(async () => ({ machineId: 'test-machine' })),
}));

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionStarted: vi.fn(async () => {
        testState.state.startupCallOrder.push('session-started');
        const result = testState.state.sessionStartedResults.shift() ?? {};
        if (!result.error) {
            rememberSessionRunnerCredential('remcli-session', 'test-runner-credential');
        }
        return result;
    }),
    bindDaemonCodexThread: vi.fn(async (binding: { agent: string; nativeThreadId: string; remcliSessionId: string }) => {
        testState.state.bindingCalls.push(binding);
        testState.state.callOrder.push('bind');
        return testState.state.bindingResult;
    }),
    openDaemonCodexRemoteTui: vi.fn(async (request: {
        agent: string;
        nativeThreadId: string;
        remcliSessionId: string;
        endpoint: string;
        reasoningEffort: string;
        model?: string;
    }) => {
        testState.state.remoteTuiOpenCalls.push(request);
        testState.state.callOrder.push('open-tui');
        return testState.state.remoteTuiOpenResults.shift() ?? testState.state.remoteTuiOpenResult;
    }),
}));

vi.mock('./utils/replayCodexSessionHistory', () => ({
    replayCodexSessionHistory: vi.fn(async () => 0),
}));


vi.mock('./codexAppServerHost', () => ({
    CODEX_DEFAULT_REASONING_EFFORT: 'xhigh',
    isCodexAppServerStateUsable: vi.fn(async () => true),
}));

vi.mock('./codexAppServerClient', () => ({
    CodexAppServerJsonRpcError: testAppServerErrors.JsonRpcError,
    CodexAppServerAmbiguousThreadStartError: testAppServerErrors.AmbiguousThreadStartError,
    isCodexAppServerActiveTurnHandoffError(error: unknown): boolean {
        return error instanceof testAppServerErrors.ActiveTurnHandoffError;
    },
    isCodexAppServerRecoverableStateError(error: unknown): boolean {
        return error instanceof testAppServerErrors.ThreadStateError;
    },
    isCodexAppServerTransientTransportError(error: unknown): boolean {
        return error instanceof testAppServerErrors.TransportError;
    },
    CodexAppServerClient: class {
        private handler: ((event: TestAppServerEvent) => void) | null = null;
        private threadIdChangeHandler: ((threadId: string) => void) | null = null;

        async connect(): Promise<void> {
            testState.state.connectCalls += 1;
            const failure = testState.state.connectFailures.shift();
            if (failure) {
                throw failure;
            }
            if (
                testState.state.deferConnectAfterCalls !== null
                && testState.state.connectCalls > testState.state.deferConnectAfterCalls
            ) {
                await new Promise<void>((resolve) => {
                    testState.state.resolveDeferredConnect = resolve;
                });
            }
        }

        async disconnect(): Promise<void> {}

        async forceCloseSession(): Promise<void> {}

        getActiveThreadId(): string | null {
            return testState.state.activeThreadId;
        }

        getActiveTurnId(): string | null {
            return testState.state.activeTurnId;
        }

        isTurnInterrupting(turnId: string): boolean {
            return testState.state.interruptingTurnId === turnId;
        }

        async interruptActiveTurn(): Promise<void> {
            const threadId = testState.state.activeThreadId;
            const turnId = testState.state.activeTurnId;
            if (!threadId || !turnId) {
                return;
            }
            testState.state.interruptRequests.push({ threadId, turnId });
            testState.state.interruptingTurnId = turnId;
        }

        async waitForInterruptedTurn(options: { threadId: string; turnId: string }): Promise<void> {
            testState.state.interruptedTurnWaitCalls.push(options.turnId);
            if (testState.state.interruptingTurnId !== options.turnId) return;
            if (testState.state.interruptedTurnWaitFailure) {
                throw testState.state.interruptedTurnWaitFailure;
            }

            await new Promise<void>((resolve) => {
                testState.state.emitInterruptedTurnCompleted = (notification) => {
                    testState.state.interruptedTurnCompletionEvents.push(notification);
                    if (
                        notification.threadId !== options.threadId
                        || notification.turnId !== options.turnId
                        || notification.status !== 'interrupted'
                    ) {
                        return;
                    }
                    testState.state.emitInterruptedTurnCompleted = null;
                    testState.state.interruptingTurnId = null;
                    if (testState.state.activeTurnId === options.turnId) {
                        testState.state.activeTurnId = null;
                    }
                    resolve();
                };
            });
        }

        setHandler(handler: (event: TestAppServerEvent) => void): void {
            this.handler = handler;
        }

        setThreadIdChangeHandler(handler: (threadId: string) => void): void {
            this.threadIdChangeHandler = handler;
        }

        setPermissionHandler(): void {}

        async startThread(): Promise<string> {
            testState.state.startedThreads += 1;
            testState.state.callOrder.push('start');
            const failure = testState.state.startThreadFailures.shift();
            if (failure) {
                throw failure;
            }
            testState.state.activeThreadId = testState.state.nativeThreadId;
            this.threadIdChangeHandler?.(testState.state.nativeThreadId);
            return testState.state.nativeThreadId;
        }

        async resumeThread(): Promise<string> {
            testState.state.resumedThreads += 1;
            testState.state.callOrder.push('resume');
            testState.state.activeThreadId = testState.state.nativeThreadId;
            testState.state.activeTurnId = testState.state.resumedActiveTurnId;
            this.threadIdChangeHandler?.(testState.state.nativeThreadId);
            for (const event of testState.state.resumeAppServerEvents) {
                this.handler?.(event);
            }
            return testState.state.nativeThreadId;
        }

        async hydrateThreadIfNeeded(threadId: string): Promise<void> {
            testState.state.hydrationCalls += 1;
            const failure = testState.state.hydrationFailures.shift();
            if (failure) {
                testState.state.callOrder.push('hydrate');
                throw failure;
            }
            if (testState.state.hydratedThreadId !== threadId) {
                return;
            }
            testState.state.callOrder.push('hydrate');
            testState.state.activeThreadId = threadId;
            testState.state.activeTurnId = testState.state.hydratedActiveTurnId;
            if (testState.state.hydratedExternalUserText) {
                this.handler?.({
                    type: 'user_message',
                    source: 'external',
                    text: testState.state.hydratedExternalUserText,
                });
            }
        }

        async beginTurn(turn: CapturedTurn): Promise<{ turnId: string; completion: Promise<{ content: []; isError: false }> }> {
            testState.state.beginTurns.push(turn);
            testState.state.callOrder.push('begin');
            const failure = testState.state.beginTurnFailures.shift();
            if (failure) {
                if (failure instanceof testAppServerErrors.ActiveTurnHandoffError) {
                    testState.state.activeThreadId = failure.threadId;
                    testState.state.activeTurnId = failure.turnId;
                }
                throw failure;
            }
            if (testState.state.isBeginTurnAcceptanceDeferred) {
                await new Promise<void>((resolve) => {
                    testState.state.resolveBeginTurnAcceptance = resolve;
                });
            }
            testState.state.callOrder.push('begin:accepted');
            testState.state.activeThreadId = turn.threadId;
            testState.state.activeTurnId = 'turn-1';
            for (const event of testState.state.appServerEvents) {
                this.handler?.(event);
            }
            return {
                turnId: 'turn-1',
                completion: Promise.resolve({ content: [], isError: false }),
            };
        }

        async steerTurn(turn: CapturedSteer): Promise<string> {
            testState.state.steeredTurns.push(turn);
            testState.state.activeThreadId = turn.threadId;
            const failure = testState.state.steerFailures.shift();
            if (failure) {
                const successorTurnId = testState.state.steerFailureSuccessorTurnIds.shift();
                if (successorTurnId !== undefined) {
                    testState.state.steerFailureLifecycleEvents.push(`turn/completed:${turn.expectedTurnId}`);
                    this.handler?.({ type: 'task_complete' });
                    testState.state.activeTurnId = successorTurnId;
                    if (successorTurnId) {
                        testState.state.steerFailureLifecycleEvents.push(`turn/started:${successorTurnId}`);
                        this.handler?.({ type: 'task_started' });
                    }
                } else if (!testState.state.keepsActiveTurnOnSteerFailure) {
                    testState.state.activeTurnId = null;
                }
                testState.state.steerFailureLifecycleEvents.push('turn/steer:error');
                throw failure;
            }
            const turnId = testState.state.activeTurnId ?? 'turn-1';
            testState.state.activeTurnId = turnId;
            testState.state.callOrder.push('steer:accepted');
            return turnId;
        }

        async waitForTurnCompletion(options: { turnId: string }): Promise<{ content: []; isError: false }> {
            testState.state.turnCompletionCalls.push(options.turnId);
            if (testState.state.deferredTurnCompletionIds.has(options.turnId)) {
                await new Promise<void>((resolve) => {
                    testState.state.turnCompletionResolvers.set(options.turnId, resolve);
                });
            }
            if (testState.state.activeTurnId === options.turnId) {
                testState.state.activeTurnId = null;
            }
            return { content: [], isError: false };
        }
    },
}));

vi.mock('@/utils/MessageQueue2', () => ({
    MessageQueue2: class<T> {
        private readonly messages: Array<{
            message: string;
            mode: T;
            hash: string;
            resolveAcceptance?: () => void;
            rejectAcceptance?: (error: Error) => void;
        }> = [];
        private resolveInitialMessage: ((message: {
            message: string;
            mode: T;
            isolate: boolean;
            hash: string;
            acknowledge: () => void;
            reject: (error: unknown) => void;
        } | null) => void) | null = null;
        private hasDeliveredMessage = false;
        private hasWaitedForCompletion = false;

        constructor(private readonly hashMode: (mode: T) => string) {}

        push(message: string, mode: T): void {
            this.enqueue({ message, mode, hash: this.hashMode(mode) });
        }

        pushWithAcceptance(message: string, mode: T): Promise<void> {
            return new Promise((resolve, reject) => {
                this.enqueue({
                    message,
                    mode,
                    hash: this.hashMode(mode),
                    resolveAcceptance: resolve,
                    rejectAcceptance: reject,
                });
            });
        }

        private enqueue(queuedMessage: {
            message: string;
            mode: T;
            hash: string;
            resolveAcceptance?: () => void;
            rejectAcceptance?: (error: Error) => void;
        }): void {
            this.messages.push(queuedMessage);
            if (this.resolveInitialMessage) {
                const resolve = this.resolveInitialMessage;
                this.resolveInitialMessage = null;
                resolve(this.takeMessage());
            }
        }

        async waitForMessagesAndGetAsString(abortSignal?: AbortSignal): Promise<{
            message: string;
            mode: T;
            isolate: boolean;
            hash: string;
            acknowledge: () => void;
            reject: (error: unknown) => void;
        } | null> {
            if (this.messages.length > 0) {
                return this.takeMessage();
            }
            if (testState.state.closeQueueWhenEmpty) {
                return null;
            }
            if (!this.hasWaitedForCompletion) {
                this.hasWaitedForCompletion = true;
                return await new Promise((resolve) => {
                    if (abortSignal?.aborted) {
                        resolve(null);
                        return;
                    }
                    const resolveWaiter = (message: {
                        message: string;
                        mode: T;
                        isolate: boolean;
                        hash: string;
                        acknowledge: () => void;
                        reject: (error: unknown) => void;
                    } | null): void => {
                        if (this.resolveInitialMessage === resolveWaiter) {
                            this.resolveInitialMessage = null;
                        }
                        resolve(message);
                    };
                    this.resolveInitialMessage = resolveWaiter;
                    abortSignal?.addEventListener('abort', () => resolveWaiter(null), { once: true });
                });
            }
            if (
                testState.state.closeQueueAfterRedeliveryRequests !== null
                && testState.state.redeliveryRequests < testState.state.closeQueueAfterRedeliveryRequests
            ) {
                return await new Promise((resolve) => {
                    if (abortSignal?.aborted) {
                        resolve(null);
                        return;
                    }
                    const resolveWaiter = (message: {
                        message: string;
                        mode: T;
                        isolate: boolean;
                        hash: string;
                        acknowledge: () => void;
                        reject: (error: unknown) => void;
                    } | null): void => {
                        if (this.resolveInitialMessage === resolveWaiter) {
                            this.resolveInitialMessage = null;
                        }
                        resolve(message);
                    };
                    this.resolveInitialMessage = resolveWaiter;
                    abortSignal?.addEventListener('abort', () => resolveWaiter(null), { once: true });
                });
            }
            return null;
        }

        size(): number {
            return this.messages.length;
        }

        private takeMessage(): {
            message: string;
            mode: T;
            isolate: boolean;
            hash: string;
            acknowledge: () => void;
            reject: (error: unknown) => void;
        } {
            const message = this.messages.shift();
            if (!message) {
                throw new Error('Expected a queued Codex message.');
            }
            this.hasDeliveredMessage = true;
            if (testState.state.abortBeforeNextQueueDelivery) {
                testState.state.abortBeforeNextQueueDelivery = false;
                testState.state.closeQueueWhenEmpty = true;
                void testState.state.abortHandler?.();
            }
            return {
                message: message.message,
                mode: message.mode,
                hash: message.hash,
                isolate: false,
                acknowledge: () => {
                    const deliveryId = (message.mode as { clientUserMessageId?: unknown }).clientUserMessageId;
                    if (typeof deliveryId === 'string') {
                        testState.state.acknowledgedDeliveryIds.push(deliveryId);
                    }
                    testState.state.callOrder.push('ack');
                    message.resolveAcceptance?.();
                },
                reject: (error) => {
                    const rejection = error instanceof Error ? error : new Error(String(error));
                    testState.state.rejectedDeliveryErrors.push(rejection);
                    message.rejectAcceptance?.(rejection);
                    if (!(rejection instanceof RetryableUserMessageDeliveryError)) {
                        this.hasWaitedForCompletion = true;
                    }
                },
            };
        }
    },
}));

function createIncomingMessage(
    overrides: Partial<UserMessage['meta']> = {},
    deliveryId?: string,
): DeliveredUserMessage {
    return {
        role: 'user',
        content: { type: 'text', text: 'remote prompt' },
        meta: {
            permissionMode: 'read-only',
            model: 'gpt-test',
            ...overrides,
        },
        ...(deliveryId ? { deliveryId } : {}),
    };
}

async function runTestCodex(options: {
    startedBy?: 'daemon' | 'terminal';
    resumeSessionId?: string;
    reasoningEffort?: string;
} = {}): Promise<void> {
    const { runCodex } = await import('./runCodex');
    await runCodex({
        credentials: {
            token: 'test-token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        },
        ...options,
    });
}

function expectExactlyOneSessionError(message: string): void {
    expect(testState.state.sessionEvents).toEqual([{
        type: 'message',
        message,
        isError: true,
    }]);
}

describe('runCodex app-server integration', () => {
    beforeEach(() => {
        testState.reset();
    });

    afterEach(() => {
        forgetSessionRunnerCredential('remcli-session');
    });

    it('forwards one external native user item to the P2P feed without starting another turn', async () => {
        testState.state.incomingMessages = [
            createIncomingMessage({ sentFrom: 'native-app-server' }),
            createIncomingMessage(),
        ];
        testState.state.appServerEvents = [{
            type: 'user_message',
            source: 'external',
            text: 'native app prompt',
        }];

        await runTestCodex();

        expect(testState.state.sentUserMessages).toEqual([
            { text: 'native app prompt', sentFrom: 'native-app-server' },
        ]);
        expect(testState.state.beginTurns).toHaveLength(1);
        expect(testState.state.remoteTuiOpenCalls).toEqual([]);
    });

    it('redacts credentials in app-server event diagnostics', async () => {
        const cookie = 'runner-cookie-value';
        const setCookie = 'runner-set-cookie-value';
        const bearer = 'runner-bearer-value';
        const authToken = 'runner-auth-token-value';
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        testState.state.incomingMessages = [createIncomingMessage()];
        testState.state.appServerEvents = [{
            type: 'exec_command_begin',
            command: [
                `curl -H 'Cookie: ${cookie}'`,
                `-H "Set-Cookie: ${setCookie}"`,
                `-H '"Authorization": "Bearer ${bearer}"'`,
                `-H 'X-Auth-Token: ${authToken}'`,
            ].join(' '),
        }];

        try {
            await runTestCodex();

            const diagnostics = JSON.stringify(debug.mock.calls);
            expect(diagnostics).toContain('[REDACTED]');
            expect(diagnostics).not.toContain(cookie);
            expect(diagnostics).not.toContain(setCookie);
            expect(diagnostics).not.toContain(bearer);
            expect(diagnostics).not.toContain(authToken);
        } finally {
            debug.mockRestore();
        }
    });

    it('redacts app-server errors before saving them to the encrypted chat history', async () => {
        const bearer = 'bearer-secret-value';
        const cookie = 'cookie-secret-value';
        const accessToken = 'access-token-value';
        testState.state.incomingMessages = [createIncomingMessage()];
        testState.state.appServerEvents = [{
            type: 'agent_error',
            message: [
                `Authorization: Bearer ${bearer}`,
                `Cookie: ${cookie}`,
                `https://example.test/run?access_token=${accessToken}`,
            ].join(' · '),
        }];

        await runTestCodex();

        const errorEvent = testState.state.sessionEvents.find((event) => event.isError);
        expect(errorEvent).toMatchObject({ type: 'message', isError: true });
        const serializedEvent = JSON.stringify(errorEvent);
        expect(serializedEvent).toContain('[REDACTED]');
        expect(serializedEvent).not.toContain(bearer);
        expect(serializedEvent).not.toContain(cookie);
        expect(serializedEvent).not.toContain(accessToken);
    });

    it('keeps an existing error outcome for replayed output after thread resume', async () => {
        const existingError = { kind: 'error' as const, occurredAt: 100 };
        testState.state.executionOutcome = existingError;
        testState.state.incomingMessages = [createIncomingMessage()];
        testState.state.resumeAppServerEvents = [{
            type: 'agent_message',
            message: 'Historical Codex response',
            origin: 'replay',
        }];

        await runTestCodex({ resumeSessionId: 'native-resume-thread' });

        expect(testState.state.sentCodexMessages).toContainEqual(expect.objectContaining({
            type: 'message',
            message: 'Historical Codex response',
        }));
        expect(testState.state.successfulAgentOutputCalls).toBe(0);
        expect(testState.state.executionOutcome).toEqual(existingError);
    });

    it('replaces an existing error outcome after a live Codex response', async () => {
        testState.state.executionOutcome = { kind: 'error', occurredAt: 100 };
        testState.state.incomingMessages = [createIncomingMessage()];
        testState.state.appServerEvents = [{
            type: 'agent_message',
            message: 'Live Codex response',
            origin: 'live',
        }];

        await runTestCodex();

        expect(testState.state.sentCodexMessages).toContainEqual(expect.objectContaining({
            type: 'message',
            message: 'Live Codex response',
        }));
        expect(testState.state.successfulAgentOutputCalls).toBe(1);
        expect(testState.state.executionOutcome).toEqual({
            kind: 'success',
            occurredAt: 200,
        });
    });

    it('caches the daemon runner credential before creating its session consumer and resuming a turn', async () => {
        testState.state.incomingMessages = [createIncomingMessage()];

        await runTestCodex({
            startedBy: 'daemon',
            resumeSessionId: 'native-resume-thread',
        });

        expect(testState.state.startupCallOrder).toEqual(['session-started', 'session-sync']);
        expect(testState.state.resumedThreads).toBe(1);
        expect(testState.state.beginTurns).toHaveLength(1);
    });

    it('does not create a session consumer or resume a turn when daemon credential handoff fails', async () => {
        testState.state.incomingMessages = [createIncomingMessage()];
        testState.state.sessionStartedResults = [
            { error: 'session-webhook-rejected' },
            { error: 'session-webhook-rejected' },
            { error: 'session-webhook-rejected' },
        ];

        await runTestCodex({
            startedBy: 'daemon',
            resumeSessionId: 'native-resume-thread',
        });

        expect(testState.state.startupCallOrder).toEqual([
            'session-started',
            'session-started',
            'session-started',
        ]);
        expect(testState.state.startupCallOrder).not.toContain('session-sync');
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.resumedThreads).toBe(0);
    });

    it('does not echo an own app-server user item into the P2P feed', async () => {
        testState.state.incomingMessages = [createIncomingMessage()];
        testState.state.appServerEvents = [{
            type: 'user_message',
            source: 'own',
            text: 'remote prompt',
        }];

        await runTestCodex();

        expect(testState.state.sentUserMessages).toEqual([]);
        expect(testState.state.beginTurns).toHaveLength(1);
    });

    it('steers a phone prompt into an active terminal turn without creating another native thread', async () => {
        testState.state.activeThreadId = 'terminal-thread';
        testState.state.activeTurnId = 'terminal-turn';
        testState.state.incomingMessages = [createIncomingMessage()];

        await runTestCodex({ startedBy: 'terminal' });

        expect(testState.state.steeredTurns).toEqual([{
            threadId: 'terminal-thread',
            expectedTurnId: 'terminal-turn',
            prompt: 'remote prompt',
        }]);
        expect(testState.state.startedThreads).toBe(0);
        expect(testState.state.resumedThreads).toBe(0);
        expect(testState.state.beginTurns).toEqual([]);
    });

    it('steers the first phone prompt into an active turn hydrated by native resume', async () => {
        const deliveryId = 'p2p:remcli-session:resume-active-turn';
        testState.state.nativeThreadId = 'native-resume-thread';
        testState.state.resumedActiveTurnId = 'terminal-turn-after-resume';
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];

        await runTestCodex({ startedBy: 'daemon', resumeSessionId: 'native-resume-thread' });

        expect(testState.state.resumedThreads).toBe(1);
        expect(testState.state.steeredTurns).toEqual([{
            threadId: 'native-resume-thread',
            expectedTurnId: 'terminal-turn-after-resume',
            prompt: 'remote prompt',
            clientUserMessageId: deliveryId,
        }]);
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([deliveryId]);
        expect(testState.state.rejectedDeliveryErrors).toEqual([]);
    });

    it('hydrates a terminal turn that began while idle before steering the phone delivery', async () => {
        const deliveryId = 'p2p:remcli-session:idle-reconnect';
        testState.state.nativeThreadId = 'native-resume-thread';
        testState.state.hydratedThreadId = 'native-resume-thread';
        testState.state.hydratedActiveTurnId = 'terminal-turn-after-idle-reconnect';
        testState.state.hydratedExternalUserText = 'Prompt entered in native terminal while Remcli was offline';
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];

        await runTestCodex({ startedBy: 'daemon', resumeSessionId: 'native-resume-thread' });

        expect(testState.state.callOrder).toContain('hydrate');
        expect(testState.state.resumedThreads).toBe(0);
        expect(testState.state.sentUserMessages).toEqual([{
            text: 'Prompt entered in native terminal while Remcli was offline',
            sentFrom: 'native-app-server',
        }]);
        expect(testState.state.steeredTurns).toEqual([{
            threadId: 'native-resume-thread',
            expectedTurnId: 'terminal-turn-after-idle-reconnect',
            prompt: 'remote prompt',
            clientUserMessageId: deliveryId,
        }]);
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([deliveryId]);
        expect(testState.state.rejectedDeliveryErrors).toEqual([]);
    });

    it('steers once when a native turn appears after the idle preflight and before beginTurn', async () => {
        const deliveryId = 'p2p:remcli-session:handoff-after-idle';
        testState.state.nativeThreadId = 'native-resume-thread';
        testState.state.hydratedThreadId = 'native-resume-thread';
        testState.state.hydratedActiveTurnId = null;
        testState.state.beginTurnFailures = [
            new testAppServerErrors.ActiveTurnHandoffError(
                'native-resume-thread',
                'terminal-turn-after-idle-preflight',
            ),
        ];
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];

        await runTestCodex({ startedBy: 'daemon', resumeSessionId: 'native-resume-thread' });

        expect(testState.state.hydrationCalls).toBe(1);
        expect(testState.state.callOrder).toContain('hydrate');
        expect(testState.state.resumedThreads).toBe(1);
        expect(testState.state.beginTurns).toEqual([expect.objectContaining({
            threadId: 'native-resume-thread',
            prompt: 'remote prompt',
            clientUserMessageId: deliveryId,
        })]);
        expect(testState.state.steeredTurns).toEqual([{
            threadId: 'native-resume-thread',
            expectedTurnId: 'terminal-turn-after-idle-preflight',
            prompt: 'remote prompt',
            clientUserMessageId: deliveryId,
        }]);
        expect(testState.state.callOrder).not.toContain('begin:accepted');
        expect(testState.state.callOrder.indexOf('steer:accepted')).toBeLessThan(
            testState.state.callOrder.indexOf('ack'),
        );
        expect(testState.state.acknowledgedDeliveryIds).toEqual([deliveryId]);
        expect(testState.state.rejectedDeliveryErrors).toEqual([]);
    });

    it('rejects an unknown hydration failure before resume or turn/start', async () => {
        const deliveryId = 'p2p:remcli-session:hydration-invalid-response';
        const hydrationError = new Error('Codex app-server returned an invalid thread/read response.');
        testState.state.nativeThreadId = 'native-resume-thread';
        testState.state.hydrationFailures = [hydrationError];
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];

        await runTestCodex({ startedBy: 'daemon', resumeSessionId: 'native-resume-thread' });

        expect(testState.state.hydrationCalls).toBe(1);
        expect(testState.state.resumedThreads).toBe(0);
        expect(testState.state.startedThreads).toBe(0);
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.remoteTuiOpenCalls).toEqual([]);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([]);
        expect(testState.state.rejectedDeliveryErrors).toEqual([hydrationError]);
    });

    it('retries an unacknowledged delivery after a typed recoverable thread-state error', async () => {
        const deliveryId = 'p2p:remcli-session:thread-state-recovery';
        testState.state.nativeThreadId = 'native-resume-thread';
        testState.state.hydrationFailures = [
            new testAppServerErrors.ThreadStateError('Codex app-server thread state is not loaded.'),
        ];
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];

        await runTestCodex({ startedBy: 'daemon', resumeSessionId: 'native-resume-thread' });

        expect(testState.state.hydrationCalls).toBe(2);
        expect(testState.state.callOrder.indexOf('resume')).toBeGreaterThan(
            testState.state.callOrder.indexOf('hydrate'),
        );
        expect(testState.state.beginTurns).toHaveLength(1);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([deliveryId]);
        expect(testState.state.redeliveryRequests).toBe(1);
        expect(testState.state.rejectedDeliveryErrors).toEqual([
            expect.any(RetryableUserMessageDeliveryError),
        ]);
    });

    it('uses private stdio only after a typed transient shared transport failure', async () => {
        testState.state.connectFailures = [
            new testAppServerErrors.TransportError('Codex app-server websocket closed before connection opened.'),
        ];
        testState.state.incomingMessages = [createIncomingMessage()];

        await runTestCodex({ startedBy: 'terminal' });

        expect(testState.state.connectCalls).toBe(2);
        expect(testState.state.beginTurns).toHaveLength(1);
    });

    it('does not fall back to private stdio after a JSON-RPC validation error', async () => {
        const validationError = new testAppServerErrors.JsonRpcError(
            'Invalid initialize parameters.',
            -32602,
        );
        testState.state.connectFailures = [validationError];
        testState.state.incomingMessages = [createIncomingMessage()];

        await expect(runTestCodex({ startedBy: 'terminal' })).rejects.toBe(validationError);

        expect(testState.state.connectCalls).toBe(1);
        expect(testState.state.beginTurns).toEqual([]);
    });

    it('acknowledges a P2P delivery once and only after its native turn/start is accepted', async () => {
        const deliveryId = 'p2p:remcli-session:accepted-once';
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];
        testState.state.isBeginTurnAcceptanceDeferred = true;

        const runner = runTestCodex({ startedBy: 'terminal' });
        await vi.waitFor(() => expect(testState.state.beginTurns).toHaveLength(1));

        expect(testState.state.startedThreads).toBe(1);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([]);
        expect(testState.state.resolveBeginTurnAcceptance).not.toBeNull();

        testState.state.resolveBeginTurnAcceptance?.();
        await runner;

        expect(testState.state.beginTurns).toHaveLength(1);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([deliveryId]);
        expect(testState.state.rejectedDeliveryErrors).toEqual([]);
        expect(testState.state.callOrder.indexOf('begin:accepted')).toBeLessThan(
            testState.state.callOrder.indexOf('ack'),
        );
    });

    it('cancels a queued P2P delivery when abort wins before dispatch', async () => {
        const deliveryId = 'p2p:remcli-session:abort-before-dispatch';
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];
        testState.state.abortBeforeNextQueueDelivery = true;

        await runTestCodex({ startedBy: 'terminal' });

        expect(testState.state.startedThreads).toBe(0);
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.steeredTurns).toEqual([]);
        expect(testState.state.cancelledDeliveryIds).toEqual([deliveryId]);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([deliveryId]);
        expect(testState.state.redeliveryRequests).toBe(0);
    });

    it('keeps a P2P delivery pending until bounded same-runner recovery is exhausted', async () => {
        const deliveryId = 'p2p:remcli-session:retry-exhaustion';
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];
        testState.state.beginTurnFailures = Array.from(
            { length: 4 },
            () => new testAppServerErrors.TransportError('Codex app-server transport disconnected.'),
        );
        testState.state.closeQueueAfterRedeliveryRequests = 3;

        await runTestCodex({ startedBy: 'terminal' });

        expect(testState.state.beginTurns).toHaveLength(4);
        expect(testState.state.startedThreads).toBe(1);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([]);
        expect(testState.state.redeliveryRequests).toBe(3);
        expect(testState.state.rejectedDeliveryErrors).toHaveLength(4);
        expect(testState.state.rejectedDeliveryErrors.slice(0, 3)).toEqual([
            expect.any(RetryableUserMessageDeliveryError),
            expect.any(RetryableUserMessageDeliveryError),
            expect.any(RetryableUserMessageDeliveryError),
        ]);
        expect(testState.state.rejectedDeliveryErrors[3]).toBeInstanceOf(testAppServerErrors.TransportError);
    }, 10_000);

    it('cancels an in-flight recovery without re-offering the same P2P delivery', async () => {
        const deliveryId = 'p2p:remcli-session:abort-during-recovery';
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];
        testState.state.beginTurnFailures = [
            new testAppServerErrors.TransportError('Codex app-server transport disconnected.'),
        ];
        testState.state.deferConnectAfterCalls = 1;

        const runner = runTestCodex({ startedBy: 'terminal' });
        await vi.waitFor(() => {
            expect(testState.state.resolveDeferredConnect).not.toBeNull();
        });

        await testState.state.abortHandler?.();
        testState.state.resolveDeferredConnect?.();
        await runner;
        await Promise.resolve();

        expect(testState.state.redeliveryRequests).toBe(0);
        expect(testState.state.cancelledDeliveryIds).toEqual([deliveryId]);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([]);
    });

    it('does not publish Aborted by user while abort cancels a recovery behind an active interrupt barrier', async () => {
        const deliveryId = 'p2p:remcli-session:abort-recovery-behind-barrier';
        testState.state.activeThreadId = 'native-thread';
        testState.state.activeTurnId = 'terminal-turn';
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];
        testState.state.steerFailures = [
            new testAppServerErrors.TransportError('Codex app-server transport disconnected.'),
        ];
        testState.state.keepsActiveTurnOnSteerFailure = true;

        const runner = runTestCodex({ startedBy: 'terminal' });
        await vi.waitFor(() => {
            expect(testState.state.rejectedDeliveryErrors).toEqual([
                expect.any(RetryableUserMessageDeliveryError),
            ]);
            expect(testState.state.abortHandler).not.toBeNull();
        });

        await testState.state.abortHandler?.();
        testState.state.closeQueueWhenEmpty = true;
        await runner;

        expect(testState.state.interruptRequests).toEqual([{
            threadId: 'native-thread',
            turnId: 'terminal-turn',
        }]);
        expect(testState.state.sessionEvents).not.toContainEqual(expect.objectContaining({
            message: 'Aborted by user',
        }));
    });

    it('interrupts the observed terminal turn and holds the next P2P delivery until matching turn/completed(interrupted)', async () => {
        const deliveryId = 'p2p:remcli-session:after-interrupt';
        testState.state.activeThreadId = 'native-thread';
        testState.state.activeTurnId = 'terminal-turn';
        testState.state.resumedActiveTurnId = 'terminal-turn';

        const runner = runTestCodex({ startedBy: 'terminal', resumeSessionId: 'native-thread' });
        await vi.waitFor(() => {
            expect(testState.state.abortHandler).not.toBeNull();
            expect(testState.state.userMessageCallback).not.toBeNull();
            expect(testState.state.connectCalls).toBeGreaterThan(0);
        });

        await testState.state.abortHandler?.();
        expect(testState.state.interruptRequests).toEqual([{
            threadId: 'native-thread',
            turnId: 'terminal-turn',
        }]);

        void testState.state.userMessageCallback?.(createIncomingMessage({}, deliveryId));
        await vi.waitFor(() => {
            expect(testState.state.interruptedTurnWaitCalls).toEqual(['terminal-turn']);
            expect(testState.state.emitInterruptedTurnCompleted).not.toBeNull();
        });

        expect(testState.state.steeredTurns).toEqual([]);
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([]);
        expect(testState.state.sessionEvents).not.toContainEqual(expect.objectContaining({ message: 'Aborted by user' }));

        testState.state.emitInterruptedTurnCompleted?.({
            threadId: 'foreign-thread',
            turnId: 'terminal-turn',
            status: 'interrupted',
        });
        testState.state.emitInterruptedTurnCompleted?.({
            threadId: 'native-thread',
            turnId: 'terminal-turn',
            status: 'completed',
        });
        testState.state.emitInterruptedTurnCompleted?.({
            threadId: 'native-thread',
            turnId: 'terminal-turn',
            status: 'failed',
        });
        await Promise.resolve();

        expect(testState.state.steeredTurns).toEqual([]);
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([]);
        expect(testState.state.activeTurnId).toBe('terminal-turn');
        expect(testState.state.interruptingTurnId).toBe('terminal-turn');
        expect(testState.state.sessionEvents).not.toContainEqual(expect.objectContaining({ message: 'Aborted by user' }));

        testState.state.resumedActiveTurnId = null;
        testState.state.emitInterruptedTurnCompleted?.({
            threadId: 'native-thread',
            turnId: 'terminal-turn',
            status: 'interrupted',
        });
        await runner;

        expect(testState.state.interruptedTurnCompletionEvents).toEqual([
            { threadId: 'foreign-thread', turnId: 'terminal-turn', status: 'interrupted' },
            { threadId: 'native-thread', turnId: 'terminal-turn', status: 'completed' },
            { threadId: 'native-thread', turnId: 'terminal-turn', status: 'failed' },
            { threadId: 'native-thread', turnId: 'terminal-turn', status: 'interrupted' },
        ]);
        expect(testState.state.steeredTurns).toEqual([]);
        expect(testState.state.beginTurns).toHaveLength(1);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([deliveryId]);
    });

    it('rejects the next P2P delivery when the interrupted-turn settle barrier times out', async () => {
        const deliveryId = 'p2p:remcli-session:interrupted-turn-settle-timeout';
        testState.state.activeThreadId = 'native-thread';
        testState.state.activeTurnId = 'terminal-turn';
        testState.state.resumedActiveTurnId = 'terminal-turn';
        testState.state.interruptedTurnWaitFailure = new Error(
            'Timed out waiting for Codex interrupted turn to settle.',
        );

        const runner = runTestCodex({ startedBy: 'terminal', resumeSessionId: 'native-thread' });
        await vi.waitFor(() => {
            expect(testState.state.abortHandler).not.toBeNull();
            expect(testState.state.userMessageCallback).not.toBeNull();
        });

        await testState.state.abortHandler?.();
        testState.state.closeQueueWhenEmpty = true;
        const callback = testState.state.userMessageCallback;
        expect(callback).not.toBeNull();
        await expect(Promise.resolve(callback?.(createIncomingMessage({}, deliveryId)))).rejects.toThrow(
            'Timed out waiting for Codex interrupted turn to settle.',
        );
        await runner;

        expect(testState.state.interruptedTurnWaitCalls).toEqual(['terminal-turn']);
        expect(testState.state.steeredTurns).toEqual([]);
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([]);
        expect(testState.state.rejectedDeliveryErrors).toEqual([
            expect.objectContaining({ message: 'Timed out waiting for Codex interrupted turn to settle.' }),
        ]);
        expect(testState.state.sessionEvents).toContainEqual({
            type: 'message',
            message: 'Timed out waiting for Codex interrupted turn to settle.',
            isError: true,
        });
    });

    it('starts the same delivery in the existing thread when turn/steer loses a terminal turn race', async () => {
        const deliveryId = 'p2p:remcli-session:7';
        testState.state.activeThreadId = 'terminal-thread';
        testState.state.activeTurnId = 'terminal-turn';
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];
        testState.state.steerFailures = [new Error('expectedTurnId is no longer active')];

        await runTestCodex({ startedBy: 'terminal' });

        expect(testState.state.steeredTurns).toEqual([{
            threadId: 'terminal-thread',
            expectedTurnId: 'terminal-turn',
            prompt: 'remote prompt',
            clientUserMessageId: deliveryId,
        }]);
        expect(testState.state.beginTurns).toEqual([expect.objectContaining({
            threadId: 'terminal-thread',
            prompt: 'remote prompt',
            clientUserMessageId: deliveryId,
        })]);
        expect(testState.state.startedThreads).toBe(0);
        expect(testState.state.resumedThreads).toBe(0);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([deliveryId]);
        expect(testState.state.rejectedDeliveryErrors).toEqual([]);
    });

    it('retries a recoverable app-server overload without rejecting the P2P delivery', async () => {
        const deliveryId = 'p2p:remcli-session:retry-overload';
        const overloadError = new testAppServerErrors.JsonRpcError(
            'Server overloaded; retry later.',
            -32001,
        );
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];
        testState.state.beginTurnFailures = [overloadError];

        await runTestCodex({ startedBy: 'terminal' });

        expect(testState.state.beginTurns).toHaveLength(2);
        expect(testState.state.beginTurns).toEqual([
            expect.objectContaining({ clientUserMessageId: deliveryId }),
            expect.objectContaining({ clientUserMessageId: deliveryId }),
        ]);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([deliveryId]);
        expect(testState.state.redeliveryRequests).toBe(1);
        expect(testState.state.rejectedDeliveryErrors).toEqual([
            expect.any(RetryableUserMessageDeliveryError),
        ]);
        expect(testState.state.sessionEvents).toEqual([{ type: 'ready' }]);
    });

    it('never starts a second native thread after an ambiguous thread/start receipt', async () => {
        const firstDeliveryId = 'p2p:remcli-session:ambiguous-start-1';
        const secondDeliveryId = 'p2p:remcli-session:ambiguous-start-2';
        const ambiguousError = new testAppServerErrors.AmbiguousThreadStartError(
            'Codex app-server may have created a thread, but its id was not confirmed.',
        );
        testState.state.incomingMessages = [
            createIncomingMessage({}, firstDeliveryId),
            createIncomingMessage({}, secondDeliveryId),
        ];
        testState.state.startThreadFailures = [ambiguousError];

        await runTestCodex({ startedBy: 'daemon' });

        expect(testState.state.startedThreads).toBe(1);
        expect(testState.state.bindingCalls).toEqual([]);
        expect(testState.state.remoteTuiOpenCalls).toEqual([]);
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([]);
        expect(testState.state.rejectedDeliveryErrors).toEqual([
            ambiguousError,
            ambiguousError,
        ]);
    });

    it('waits for a successor turn after a steer conflict before starting the same delivery once', async () => {
        const deliveryId = 'p2p:remcli-session:t1-t2-race';
        testState.state.activeThreadId = 'terminal-thread';
        testState.state.activeTurnId = 'terminal-turn-1';
        testState.state.incomingMessages = [createIncomingMessage({}, deliveryId)];
        testState.state.steerFailures = [new Error('expectedTurnId is no longer active')];
        testState.state.steerFailureSuccessorTurnIds = ['terminal-turn-2'];
        testState.state.deferredTurnCompletionIds.add('terminal-turn-2');

        const runner = runTestCodex({ startedBy: 'terminal' });

        await vi.waitFor(() => {
            expect(testState.state.turnCompletionCalls).toEqual(
                expect.arrayContaining(['terminal-turn-1', 'terminal-turn-2']),
            );
        });
        expect(testState.state.steerFailureLifecycleEvents).toEqual([
            'turn/completed:terminal-turn-1',
            'turn/started:terminal-turn-2',
            'turn/steer:error',
        ]);
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([]);
        expect(testState.state.connectCalls).toBe(1);

        testState.state.activeTurnId = null;
        const resolveSuccessorTurn = testState.state.turnCompletionResolvers.get('terminal-turn-2');
        expect(resolveSuccessorTurn).toBeDefined();
        resolveSuccessorTurn?.();

        await runner;

        expect(testState.state.steeredTurns).toEqual([{
            threadId: 'terminal-thread',
            expectedTurnId: 'terminal-turn-1',
            prompt: 'remote prompt',
            clientUserMessageId: deliveryId,
        }]);
        expect(testState.state.beginTurns).toEqual([expect.objectContaining({
            threadId: 'terminal-thread',
            prompt: 'remote prompt',
            clientUserMessageId: deliveryId,
        })]);
        expect(testState.state.startedThreads).toBe(0);
        expect(testState.state.resumedThreads).toBe(0);
        expect(testState.state.acknowledgedDeliveryIds).toEqual([deliveryId]);
        expect(testState.state.rejectedDeliveryErrors).toEqual([]);
        expect(testState.state.connectCalls).toBe(1);
    });

    it('does not invoke protected daemon lifecycle endpoints for a terminal-started Codex session', async () => {
        testState.state.incomingMessages = [createIncomingMessage()];

        await runTestCodex({ startedBy: 'terminal' });

        expect(testState.state.bindingCalls).toEqual([]);
        expect(testState.state.remoteTuiOpenCalls).toEqual([]);
        expect(testState.state.beginTurns).toHaveLength(1);
    });

    it('binds a resumed native thread once before opening its remote TUI', async () => {
        testState.state.nativeThreadId = 'native-resume-thread';
        testState.state.incomingMessages = [createIncomingMessage()];

        await runTestCodex({ startedBy: 'daemon', resumeSessionId: 'native-resume-thread' });

        expect(testState.state.bindingCalls).toEqual([{
            agent: 'codex',
            nativeThreadId: 'native-resume-thread',
            remcliSessionId: 'remcli-session',
        }]);
        expect(testState.state.remoteTuiOpenCalls).toEqual([{
            agent: 'codex',
            nativeThreadId: 'native-resume-thread',
            remcliSessionId: 'remcli-session',
            endpoint: 'ws://127.0.0.1:45123',
            reasoningEffort: 'xhigh',
            model: 'gpt-test',
        }]);
        expect(testState.state.callOrder.indexOf('bind')).toBeLessThan(testState.state.callOrder.indexOf('resume'));
        expect(testState.state.callOrder.indexOf('resume')).toBeLessThan(testState.state.callOrder.indexOf('open-tui'));
    });

    it('stops a redundant resumed runner when the daemon already owns its native thread', async () => {
        testState.state.bindingResult = {
            ok: true,
            data: {
                type: 'reuse-active-wrapper',
                wrapper: {
                    agent: 'codex',
                    nativeThreadId: 'native-resume-thread',
                    remcliSessionId: 'active-remcli-session',
                },
            },
        };

        await runTestCodex({ startedBy: 'daemon', resumeSessionId: 'native-resume-thread' });

        expect(testState.state.bindingCalls).toHaveLength(1);
        expect(testState.state.remoteTuiOpenCalls).toEqual([]);
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.resumedThreads).toBe(0);
        expect(testState.state.sessionEvents).not.toContainEqual(expect.objectContaining({ isError: true }));
    });

    it('terminally stops an untracked new thread before beginTurn or remote TUI', async () => {
        testState.state.incomingMessages = [createIncomingMessage()];
        testState.state.bindingResult = {
            ok: true,
            data: {
                type: 'wrapper-not-tracked',
                binding: {
                    agent: 'codex',
                    nativeThreadId: 'native-thread',
                    remcliSessionId: 'remcli-session',
                },
            },
        };

        await runTestCodex({ startedBy: 'daemon' });

        expect(testState.state.remoteTuiOpenCalls).toEqual([]);
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.startedThreads).toBe(1);
        expect(testState.state.resumedThreads).toBe(0);
        expect(testState.state.callOrder).toEqual(['start', 'bind']);
        expectExactlyOneSessionError('Codex thread native-thread is not tracked by the daemon.');
    });

    it.each([
        {
            name: 'the daemon rejects the binding request',
            bindingResult: { ok: false, error: 'Request failed: /codex-thread-bound, HTTP 409' },
            errorMessage: 'Failed to bind Codex thread native-resume-thread to the daemon: Request failed: /codex-thread-bound, HTTP 409',
        },
        {
            name: 'the daemon does not track the wrapper',
            bindingResult: {
                ok: true,
                data: {
                    type: 'wrapper-not-tracked',
                    binding: {
                        agent: 'codex',
                        nativeThreadId: 'native-resume-thread',
                        remcliSessionId: 'remcli-session',
                    },
                },
            },
            errorMessage: 'Codex thread native-resume-thread is not tracked by the daemon.',
        },
        {
            name: 'the tracked wrapper belongs to another agent',
            bindingResult: {
                ok: true,
                data: {
                    type: 'agent-mismatch',
                    binding: {
                        agent: 'codex',
                        nativeThreadId: 'native-resume-thread',
                        remcliSessionId: 'remcli-session',
                    },
                    trackedAgent: 'claude',
                },
            },
            errorMessage: 'Codex thread native-resume-thread cannot bind to claude wrapper.',
        },
    ] satisfies Array<{
        name: string;
        bindingResult: TestState['bindingResult'];
        errorMessage: string;
    }>)('terminally stops a resumed runner when $name', async ({ bindingResult, errorMessage }) => {
        testState.state.incomingMessages = [createIncomingMessage()];
        testState.state.bindingResult = bindingResult;

        await runTestCodex({ startedBy: 'daemon', resumeSessionId: 'native-resume-thread' });

        expect(testState.state.remoteTuiOpenCalls).toEqual([]);
        expect(testState.state.beginTurns).toEqual([]);
        expect(testState.state.startedThreads).toBe(0);
        expect(testState.state.resumedThreads).toBe(0);
        expect(testState.state.callOrder).toEqual(['bind']);
        expectExactlyOneSessionError(errorMessage);
    });

    it.each([
        {
            name: 'new',
            options: {},
            startedThreads: 1,
            resumedThreads: 0,
        },
        {
            name: 'resumed',
            options: { resumeSessionId: 'native-thread' },
            startedThreads: 0,
            resumedThreads: 1,
        },
    ])('passes model and reasoning effort to a $name app-server turn', async ({
        options,
        startedThreads,
        resumedThreads,
    }) => {
        testState.state.incomingMessages = [createIncomingMessage({ model: 'gpt-5.6-luna' })];

        await runTestCodex({ ...options, reasoningEffort: 'xhigh' });

        expect(testState.state.beginTurns).toEqual([expect.objectContaining({
            model: 'gpt-5.6-luna',
            effort: 'xhigh',
        })]);
        expect(testState.state.startedThreads).toBe(startedThreads);
        expect(testState.state.resumedThreads).toBe(resumedThreads);
    });

    it('uses xhigh for a browser-created Luna turn when no effort override is provided', async () => {
        testState.state.incomingMessages = [createIncomingMessage({ model: 'gpt-5.6-luna' })];

        await runTestCodex();

        expect(testState.state.beginTurns).toEqual([expect.objectContaining({
            model: 'gpt-5.6-luna',
            effort: 'xhigh',
        })]);
    });

    it('publishes an unsupported permission error when a queued delivery drains during handler registration', async () => {
        testState.state.deliverIncomingMessagesSynchronously = true;
        testState.state.closeQueueWhenEmpty = true;
        const unsupportedPermissionMessage = createIncomingMessage();
        unsupportedPermissionMessage.meta!.permissionMode = 'unsupported-permission' as never;
        testState.state.incomingMessages = [unsupportedPermissionMessage];

        await runTestCodex();

        expectExactlyOneSessionError('Unsupported Codex permission mode "unsupported-permission". Use read-only, workspace-write, or danger-full-access.');
        expect(testState.state.beginTurns).toEqual([]);
    });

    it('preserves an explicit app-server reasoning effort override', async () => {
        testState.state.incomingMessages = [createIncomingMessage()];

        await runTestCodex({ reasoningEffort: 'high' });

        expect(testState.state.beginTurns).toEqual([expect.objectContaining({
            effort: 'high',
        })]);
    });

    it.each([
        { name: 'the default', options: {}, effort: 'xhigh' },
        { name: 'an explicit override', options: { reasoningEffort: 'high' }, effort: 'high' },
    ] satisfies Array<{
        name: string;
        options: { reasoningEffort?: string };
        effort: string;
    }>)('passes $name selected model and reasoning effort to both phone turns and the daemon remote TUI', async ({ options, effort }) => {
        testState.state.incomingMessages = [createIncomingMessage({ model: 'gpt-5.6-luna' })];

        await runTestCodex({
            startedBy: 'daemon',
            resumeSessionId: 'native-thread',
            ...options,
        });

        expect(testState.state.beginTurns).toEqual([expect.objectContaining({
            model: 'gpt-5.6-luna',
            effort,
        })]);
        expect(testState.state.remoteTuiOpenCalls).toEqual([expect.objectContaining({
            reasoningEffort: effort,
            model: 'gpt-5.6-luna',
        })]);
    });

    it('shows a remote TUI host error without dropping the Codex turn', async () => {
        testState.state.incomingMessages = [createIncomingMessage()];
        testState.state.remoteTuiOpenResult = {
            ok: true,
            data: { type: 'host-unavailable', error: 'tmux host is unavailable' },
        };

        await runTestCodex({ startedBy: 'daemon', resumeSessionId: 'native-thread' });

        expect(testState.state.remoteTuiOpenCalls).toEqual(Array.from({ length: 3 }, () => ({
            agent: 'codex',
            nativeThreadId: 'native-thread',
            remcliSessionId: 'remcli-session',
            endpoint: 'ws://127.0.0.1:45123',
            reasoningEffort: 'xhigh',
            model: 'gpt-test',
        })));
        expect(testState.state.sessionEvents).toContainEqual({
            type: 'message',
            message: 'Could not open Codex remote TUI for thread native-thread: tmux host is unavailable',
            isError: true,
        });
        expect(testState.state.beginTurns).toHaveLength(1);
    });

    it('retries a transient remote TUI host failure before starting the Codex turn', async () => {
        testState.state.incomingMessages = [createIncomingMessage()];
        testState.state.remoteTuiOpenResults = [
            {
                ok: true,
                data: { type: 'host-unavailable', error: 'tmux host is starting' },
            },
            {
                ok: true,
                data: { type: 'opened' },
            },
        ];

        await runTestCodex({ startedBy: 'daemon', resumeSessionId: 'native-thread' });

        expect(testState.state.remoteTuiOpenCalls).toHaveLength(2);
        expect(testState.state.sessionEvents).not.toContainEqual(expect.objectContaining({ isError: true }));
        expect(testState.state.beginTurns).toHaveLength(1);
    });
});
