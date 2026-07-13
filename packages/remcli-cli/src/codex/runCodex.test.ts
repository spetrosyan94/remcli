import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UserMessage } from '@/api/types';
import {
    forgetSessionRunnerCredential,
    rememberSessionRunnerCredential,
} from '@/daemon/p2p/p2pRunnerCredentials';

interface CapturedTurn {
    threadId: string;
    prompt: string;
    model?: string;
    effort?: string;
}

interface TestAppServerEvent {
    type: 'user_message';
    source: 'own' | 'external';
    text: string;
}

interface TestState {
    incomingMessages: UserMessage[];
    appServerEvents: TestAppServerEvent[];
    beginTurns: CapturedTurn[];
    sentUserMessages: Array<{ text: string; sentFrom?: string }>;
    sessionEvents: Array<{ type: string; message?: string; isError?: boolean }>;
    bindingCalls: Array<{ agent: string; nativeThreadId: string; remcliSessionId: string }>;
    remoteTuiOpenCalls: Array<{
        agent: string;
        nativeThreadId: string;
        remcliSessionId: string;
        endpoint: string;
    }>;
    callOrder: string[];
    startupCallOrder: string[];
    sessionStartedResults: Array<{ error?: string }>;
    startedThreads: number;
    resumedThreads: number;
    nativeThreadId: string;
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
        beginTurns: [],
        sentUserMessages: [],
        sessionEvents: [],
        bindingCalls: [],
        remoteTuiOpenCalls: [],
        callOrder: [],
        startupCallOrder: [],
        sessionStartedResults: [],
        startedThreads: 0,
        resumedThreads: 0,
        nativeThreadId: 'native-thread',
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
    };

    return {
        state,
        reset(): void {
            state.incomingMessages = [];
            state.appServerEvents = [];
            state.beginTurns = [];
            state.sentUserMessages = [];
            state.sessionEvents = [];
            state.bindingCalls = [];
            state.remoteTuiOpenCalls = [];
            state.callOrder = [];
            state.startupCallOrder = [];
            state.sessionStartedResults = [];
            state.startedThreads = 0;
            state.resumedThreads = 0;
            state.nativeThreadId = 'native-thread';
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
        },
    };
});

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            getOrCreateSession: vi.fn(async () => ({
                id: 'remcli-session',
                seq: 1,
                metadata: {},
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
                onUserMessage(callback: (message: UserMessage) => void): void {
                    queueMicrotask(() => {
                        for (const message of testState.state.incomingMessages) {
                            callback(message);
                        }
                    });
                },
                sendUserTextMessage(text: string, meta: { sentFrom?: string }): void {
                    testState.state.sentUserMessages.push({ text, sentFrom: meta.sentFrom });
                },
                sendCodexMessage: vi.fn(),
                sendAgentMessage: vi.fn(),
                sendClaudeSessionMessage: vi.fn(),
                sendSessionEvent(event: { type: string; message?: string; isError?: boolean }): void {
                    testState.state.sessionEvents.push(event);
                },
                sendSessionDeath: vi.fn(),
                updateLifecycleState: vi.fn(),
                requestControlTransfer: vi.fn(async () => undefined),
                keepAlive: vi.fn(),
                flush: vi.fn(async () => undefined),
                close: vi.fn(async () => undefined),
                updateMetadata: vi.fn(),
                updateAgentState: vi.fn(),
                rpcHandlerManager: {
                    registerHandler: vi.fn(),
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
    }) => {
        testState.state.remoteTuiOpenCalls.push(request);
        testState.state.callOrder.push('open-tui');
        return testState.state.remoteTuiOpenResult;
    }),
}));

vi.mock('./utils/replayCodexSessionHistory', () => ({
    replayCodexSessionHistory: vi.fn(async () => 0),
}));


vi.mock('./codexAppServerHost', () => ({
    isCodexAppServerStateUsable: vi.fn(async () => true),
}));

vi.mock('./codexAppServerClient', () => ({
    CodexAppServerClient: class {
        private handler: ((event: TestAppServerEvent) => void) | null = null;
        private threadIdChangeHandler: ((threadId: string) => void) | null = null;

        async connect(): Promise<void> {}

        async disconnect(): Promise<void> {}

        async forceCloseSession(): Promise<void> {}

        getActiveThreadId(): null {
            return null;
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
            this.threadIdChangeHandler?.(testState.state.nativeThreadId);
            return testState.state.nativeThreadId;
        }

        async resumeThread(): Promise<string> {
            testState.state.resumedThreads += 1;
            testState.state.callOrder.push('resume');
            this.threadIdChangeHandler?.(testState.state.nativeThreadId);
            return testState.state.nativeThreadId;
        }

        async beginTurn(turn: CapturedTurn): Promise<{ turnId: string; completion: Promise<{ content: []; isError: false }> }> {
            testState.state.beginTurns.push(turn);
            testState.state.callOrder.push('begin');
            for (const event of testState.state.appServerEvents) {
                this.handler?.(event);
            }
            return {
                turnId: 'turn-1',
                completion: Promise.resolve({ content: [], isError: false }),
            };
        }

        async steerTurn(): Promise<string> {
            return 'turn-1';
        }
    },
}));

vi.mock('@/utils/MessageQueue2', () => ({
    MessageQueue2: class<T> {
        private readonly messages: Array<{ message: string; mode: T; hash: string }> = [];
        private resolveInitialMessage: ((message: { message: string; mode: T; isolate: boolean; hash: string } | null) => void) | null = null;
        private hasDeliveredMessage = false;
        private hasWaitedForCompletion = false;

        constructor(private readonly hashMode: (mode: T) => string) {}

        push(message: string, mode: T): void {
            const queuedMessage = { message, mode, hash: this.hashMode(mode) };
            this.messages.push(queuedMessage);
            if (this.resolveInitialMessage) {
                const resolve = this.resolveInitialMessage;
                this.resolveInitialMessage = null;
                resolve(this.takeMessage());
            }
        }

        async waitForMessagesAndGetAsString(): Promise<{ message: string; mode: T; isolate: boolean; hash: string } | null> {
            if (this.messages.length > 0) {
                return this.takeMessage();
            }
            if (!this.hasDeliveredMessage) {
                return await new Promise((resolve) => {
                    this.resolveInitialMessage = resolve;
                });
            }
            if (!this.hasWaitedForCompletion) {
                this.hasWaitedForCompletion = true;
                return await new Promise(() => {});
            }
            return null;
        }

        size(): number {
            return this.messages.length;
        }

        private takeMessage(): { message: string; mode: T; isolate: boolean; hash: string } {
            const message = this.messages.shift();
            if (!message) {
                throw new Error('Expected a queued Codex message.');
            }
            this.hasDeliveredMessage = true;
            return { ...message, isolate: false };
        }
    },
}));

function createIncomingMessage(overrides: Partial<UserMessage['meta']> = {}): UserMessage {
    return {
        role: 'user',
        content: { type: 'text', text: 'remote prompt' },
        meta: {
            permissionMode: 'read-only',
            model: 'gpt-test',
            ...overrides,
        },
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

    it('omits the internal reasoning effort when no option is provided', async () => {
        testState.state.incomingMessages = [createIncomingMessage()];

        await runTestCodex();

        expect(testState.state.beginTurns).toEqual([expect.objectContaining({
            effort: undefined,
        })]);
    });

    it('shows a remote TUI host error without dropping the Codex turn', async () => {
        testState.state.incomingMessages = [createIncomingMessage()];
        testState.state.remoteTuiOpenResult = {
            ok: true,
            data: { type: 'host-unavailable', error: 'tmux host is unavailable' },
        };

        await runTestCodex({ startedBy: 'daemon', resumeSessionId: 'native-thread' });

        expect(testState.state.remoteTuiOpenCalls).toEqual([{
            agent: 'codex',
            nativeThreadId: 'native-thread',
            remcliSessionId: 'remcli-session',
            endpoint: 'ws://127.0.0.1:45123',
        }]);
        expect(testState.state.sessionEvents).toContainEqual({
            type: 'message',
            message: 'Could not open Codex remote TUI for thread native-thread: tmux host is unavailable',
            isError: true,
        });
        expect(testState.state.beginTurns).toHaveLength(1);
    });
});
