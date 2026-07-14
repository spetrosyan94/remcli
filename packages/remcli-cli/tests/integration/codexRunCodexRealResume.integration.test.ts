import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentState, DeliveredUserMessage, Metadata } from '@/api/types';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import {
    forgetSessionRunnerCredential,
    getSessionRunnerCredential,
    rememberSessionRunnerCredential,
} from '@/daemon/p2p/p2pRunnerCredentials';
import {
    expectTurnSucceeded,
    getRealCodexModel,
    getRealCodexReasoningEffort,
} from './codexRealTestUtils';

const runRealAi = process.env.REMCLI_REAL_AI === '1';
const realCodexDescribe = runRealAi ? describe : describe.skip;
const REMCLI_SESSION_ID = 'remcli-real-codex-test-session';
const TEST_RUNNER_CREDENTIAL = 'real-resume-runner-credential';
const REAL_DELIVERY_ID = `p2p:${REMCLI_SESSION_ID}:1`;
const DELIVERY_GATE_TIMEOUT_MS = 8_000;

interface CapturedSessionEvent {
    type: string;
    message?: string;
    isError?: boolean;
}

interface CapturedCodexMessage {
    type?: string;
    message?: string;
}

const fakeSessionState = vi.hoisted(() => ({
    prompt: '',
    model: '',
    shouldClose: false,
    hasCollectedLivePrompt: false,
    deliveryPromise: null as Promise<void> | null,
    deliveryStatus: 'not-started' as 'not-started' | 'pending' | 'accepted' | 'rejected',
    deliveryRejection: null as unknown,
    agentOutputPromise: Promise.resolve(),
    resolveAgentOutput: () => {},
    hasObservedAgentOutput: false,
    sentCodexMessages: [] as string[],
    sentSessionEvents: [] as CapturedSessionEvent[],
    recordSuccessfulAgentOutput: vi.fn(),
    agentState: {
        requests: {},
        completedRequests: {},
    } as AgentState,
    permissionHandler: undefined as ((response: { id: string; approved: boolean; decision: string }) => unknown) | undefined,
    metadata: {
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/Users/test',
        remcliHomeDir: '/Users/test/.remcli',
        remcliLibDir: process.cwd(),
        remcliToolsDir: `${process.cwd()}/tools/unpacked`,
        startedBy: 'daemon',
        flavor: 'codex',
    } as Metadata,
    reset(prompt: string, model: string) {
        this.prompt = prompt;
        this.model = model;
        this.shouldClose = false;
        this.hasCollectedLivePrompt = false;
        this.deliveryPromise = null;
        this.deliveryStatus = 'not-started';
        this.deliveryRejection = null;
        this.hasObservedAgentOutput = false;
        this.agentOutputPromise = new Promise<void>((resolve) => {
            this.resolveAgentOutput = resolve;
        });
        this.sentCodexMessages = [];
        this.sentSessionEvents = [];
        this.recordSuccessfulAgentOutput.mockReset();
        this.recordSuccessfulAgentOutput.mockImplementation(() => {
            this.hasObservedAgentOutput = true;
            this.resolveAgentOutput();
        });
        this.agentState = {
            requests: {},
            completedRequests: {},
        };
        this.permissionHandler = undefined;
    },
    trackDelivery(callback: (message: DeliveredUserMessage) => void | Promise<void>): void {
        this.deliveryStatus = 'pending';
        const delivery = Promise.resolve().then(() => callback({
            role: 'user',
            content: { type: 'text', text: this.prompt },
            meta: {
                permissionMode: 'read-only',
                ...(this.model ? { model: this.model } : {}),
            },
            deliveryId: REAL_DELIVERY_ID,
        }));
        this.deliveryPromise = delivery;
        delivery.then(
            () => {
                this.deliveryStatus = 'accepted';
            },
            (error) => {
                this.deliveryStatus = 'rejected';
                this.deliveryRejection = error;
            },
        );
    },
    async waitForDeliveryAndAgentOutput(): Promise<void> {
        const delivery = this.deliveryPromise;
        if (!delivery) {
            throw new Error('The real-resume fake session did not start a tracked delivery callback.');
        }

        const waitFor = async (promise: Promise<void>, description: string): Promise<void> => {
            let timeout: NodeJS.Timeout | undefined;
            try {
                await Promise.race([
                    promise,
                    new Promise<never>((_, reject) => {
                        timeout = setTimeout(() => {
                            reject(new Error(`Timed out waiting for ${description}.`));
                        }, DELIVERY_GATE_TIMEOUT_MS);
                    }),
                ]);
            } finally {
                if (timeout) clearTimeout(timeout);
            }
        };

        await waitFor(delivery, 'the onUserMessage callback to resolve after delivery acceptance');
        await waitFor(this.agentOutputPromise, 'observed successful agent output before queue closure');
    },
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            getOrCreateSession: vi.fn(async (opts: { metadata: Metadata }) => ({
                id: REMCLI_SESSION_ID,
                seq: 1,
                metadata: opts.metadata,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy',
            })),
            sessionSyncClient: vi.fn(() => ({
                sessionId: REMCLI_SESSION_ID,
                onUserMessage(callback: (message: DeliveredUserMessage) => void | Promise<void>) {
                    fakeSessionState.trackDelivery(callback);
                },
                sendCodexMessage(message: CapturedCodexMessage) {
                    if (message.type === 'message' && typeof message.message === 'string') {
                        if (fakeSessionState.hasCollectedLivePrompt) {
                            fakeSessionState.sentCodexMessages.push(message.message);
                            fakeSessionState.shouldClose = true;
                        }
                    }
                },
                recordSuccessfulAgentOutput: fakeSessionState.recordSuccessfulAgentOutput,
                sendUserTextMessage: vi.fn(),
                sendAgentMessage: vi.fn(),
                sendClaudeSessionMessage: vi.fn(),
                sendSessionEvent(event: CapturedSessionEvent) {
                    fakeSessionState.sentSessionEvents.push(event);
                    if (event.isError) {
                        fakeSessionState.shouldClose = true;
                    }
                },
                sendSessionDeath: vi.fn(),
                updateLifecycleState: vi.fn(),
                requestControlTransfer: vi.fn(async () => undefined),
                keepAlive: vi.fn(),
                flush: vi.fn(async () => undefined),
                close: vi.fn(async () => undefined),
                updateMetadata(updater: (metadata: Metadata) => Metadata) {
                    fakeSessionState.metadata = updater(fakeSessionState.metadata);
                },
                updateAgentState(updater: (state: AgentState) => AgentState) {
                    const previousRequestIds = new Set(Object.keys(fakeSessionState.agentState.requests ?? {}));
                    fakeSessionState.agentState = updater(fakeSessionState.agentState);

                    for (const id of Object.keys(fakeSessionState.agentState.requests ?? {})) {
                        if (previousRequestIds.has(id)) continue;
                        queueMicrotask(() => {
                            fakeSessionState.permissionHandler?.({
                                id,
                                approved: true,
                                decision: 'approved_for_session',
                            });
                        });
                    }
                },
                rpcHandlerManager: {
                    registerHandler: vi.fn((method: string, handler: (response: { id: string; approved: boolean; decision: string }) => unknown) => {
                        if (method === 'permission') {
                            fakeSessionState.permissionHandler = handler;
                        }
                    }),
                },
            })),
        })),
    },
}));

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionStarted: vi.fn(async (sessionId: string) => {
        rememberSessionRunnerCredential(sessionId, TEST_RUNNER_CREDENTIAL);
        return {};
    }),
    bindDaemonCodexThread: vi.fn(async (binding: {
        agent: 'codex';
        nativeThreadId: string;
        remcliSessionId: string;
    }) => ({
        ok: true as const,
        data: {
            type: 'already-bound' as const,
            wrapper: binding,
        },
    })),
}));

vi.mock('@/persistence', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/persistence')>();
    return {
        ...actual,
        readDaemonState: vi.fn(async () => undefined),
        readSettings: vi.fn(async () => ({
            onboardingCompleted: true,
            profiles: [],
            activeProfileId: undefined,
            machineId: 'test-machine-id',
        })),
    };
});

vi.mock('@/utils/MessageQueue2', () => {
    class SingleTurnMessageQueue<T> {
        private queue: Array<{
            message: string;
            mode: T;
            hash: string;
            resolveAcceptance?: () => void;
            rejectAcceptance?: (error: Error) => void;
        }> = [];
        private waiter: ((hasMessages: boolean) => void) | null = null;
        private didCollect = false;

        constructor(private readonly modeHasher: (mode: T) => string) {}

        push(message: string, mode: T): void {
            this.enqueue({ message, mode, hash: this.modeHasher(mode) });
        }

        pushWithAcceptance(message: string, mode: T): Promise<void> {
            return new Promise((resolve, reject) => {
                this.enqueue({
                    message,
                    mode,
                    hash: this.modeHasher(mode),
                    resolveAcceptance: resolve,
                    rejectAcceptance: reject,
                });
            });
        }

        private enqueue(message: {
            message: string;
            mode: T;
            hash: string;
            resolveAcceptance?: () => void;
            rejectAcceptance?: (error: Error) => void;
        }): void {
            this.queue.push(message);
            if (this.waiter) {
                const waiter = this.waiter;
                this.waiter = null;
                waiter(true);
            }
        }

        async waitForMessagesAndGetAsString(signal?: AbortSignal): Promise<{
            message: string;
            mode: T;
            isolate: boolean;
            hash: string;
            acknowledge: () => void;
            reject: (error: unknown) => void;
        } | null> {
            if (this.queue.length > 0) {
                return this.collect();
            }
            if (this.didCollect && fakeSessionState.shouldClose) {
                await fakeSessionState.waitForDeliveryAndAgentOutput();
                return null;
            }
            if (signal?.aborted) {
                return null;
            }
            return new Promise((resolve) => {
                const onAbort = () => {
                    if (this.waiter === waiter) this.waiter = null;
                    resolve(null);
                };
                const waiter = (hasMessages: boolean) => {
                    signal?.removeEventListener('abort', onAbort);
                    resolve(hasMessages ? this.collect() : null);
                };
                signal?.addEventListener('abort', onAbort, { once: true });
                this.waiter = waiter;
            });
        }

        size(): number {
            return this.queue.length;
        }

        private collect(): {
            message: string;
            mode: T;
            isolate: boolean;
            hash: string;
            acknowledge: () => void;
            reject: (error: unknown) => void;
        } {
            const item = this.queue.shift();
            if (!item) throw new Error('Expected queued message.');
            this.didCollect = true;
            fakeSessionState.hasCollectedLivePrompt = true;
            return {
                message: item.message,
                mode: item.mode,
                isolate: false,
                hash: item.hash,
                acknowledge: () => item.resolveAcceptance?.(),
                reject: (error) => item.rejectAcceptance?.(
                    error instanceof Error ? error : new Error(String(error)),
                ),
            };
        }
    }

    return { MessageQueue2: SingleTurnMessageQueue };
});

const threadIdsToDelete: string[] = [];

afterEach(() => {
    forgetSessionRunnerCredential(REMCLI_SESSION_ID);
    while (threadIdsToDelete.length > 0) {
        const threadId = threadIdsToDelete.pop();
        if (!threadId) continue;
        try {
            execFileSync('codex', ['delete', threadId, '--force'], { stdio: 'ignore' });
        } catch {
            // Best effort cleanup: lifecycle assertions are more important than cleanup noise.
        }
    }
});

realCodexDescribe('runCodex real Codex resume smoke', { timeout: 180_000 }, () => {
    it('resumes a real Codex thread through the Remcli runCodex message path', async () => {
        await runRunCodexResumeSmoke(getRealCodexModel(), getRealCodexReasoningEffort());
    });
});

async function runRunCodexResumeSmoke(model: string, effort: string): Promise<void> {
    const contextMarker = `REMCLI_CONTEXT_MARKER_${Date.now()}`;
    const realTurnSettings = { model, effort };
    const seedClient = new CodexAppServerClient();
    const beginTurnSpy = vi.spyOn(CodexAppServerClient.prototype, 'beginTurn');
    try {
        const threadId = await seedClient.startThread({
            cwd: process.cwd(),
            sandbox: 'read-only',
            approvalPolicy: 'never',
            model,
        });
        threadIdsToDelete.push(threadId);
        const seedTurn = await seedClient.startTurn({
            threadId,
            prompt: `Запомни для следующего сообщения кодовую метку: ${contextMarker}. Не используй инструменты. Ответь ровно OK.`,
            sandbox: 'read-only',
            approvalPolicy: 'on-request',
            ...realTurnSettings,
        });
        expectTurnSucceeded(seedTurn, 'seed turn', model);
        await seedClient.disconnect();

        fakeSessionState.reset('Какую кодовую метку нужно вернуть из предыдущего сообщения? Не используй инструменты. Ответь только меткой.', model);

        const { runCodex } = await import('@/codex/runCodex');
        await runCodex({
            credentials: {
                token: 'test-token',
                encryption: { type: 'legacy', secret: new Uint8Array(32) },
            },
            startedBy: 'daemon',
            resumeSessionId: threadId,
            reasoningEffort: effort,
        });

        const answer = fakeSessionState.sentCodexMessages.join('\n');
        const errors = fakeSessionState.sentSessionEvents
            .filter((event) => event.isError)
            .map((event) => event.message ?? '')
            .join('\n');

        expect(`${answer}\n${errors}`).not.toContain('Session not found');
        expect(errors).toBe('');
        expect(answer).toContain(contextMarker);
        await fakeSessionState.waitForDeliveryAndAgentOutput();
        expect(fakeSessionState.deliveryStatus).toBe('accepted');
        expect(fakeSessionState.deliveryRejection).toBeNull();
        expect(fakeSessionState.hasObservedAgentOutput).toBe(true);
        expect(fakeSessionState.recordSuccessfulAgentOutput).toHaveBeenCalled();
        expect(getSessionRunnerCredential(REMCLI_SESSION_ID)).toBe(TEST_RUNNER_CREDENTIAL);
        expect(beginTurnSpy).toHaveBeenCalledTimes(2);
        expect(beginTurnSpy).toHaveBeenNthCalledWith(1, expect.objectContaining(realTurnSettings));
        expect(beginTurnSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
            ...realTurnSettings,
            clientUserMessageId: REAL_DELIVERY_ID,
        }));
    } finally {
        beginTurnSpy.mockRestore();
        await seedClient.disconnect().catch(() => undefined);
    }
}
