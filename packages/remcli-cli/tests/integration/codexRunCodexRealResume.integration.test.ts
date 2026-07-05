import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentState, Metadata, UserMessage } from '@/api/types';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { expectTurnSucceeded, getRealCodexModel } from './codexRealTestUtils';

const runRealAi = process.env.REMCLI_REAL_AI === '1';
const realCodexDescribe = runRealAi ? describe : describe.skip;

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
    sentCodexMessages: [] as string[],
    sentSessionEvents: [] as CapturedSessionEvent[],
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
        this.sentCodexMessages = [];
        this.sentSessionEvents = [];
        this.agentState = {
            requests: {},
            completedRequests: {},
        };
        this.permissionHandler = undefined;
    },
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            getOrCreateSession: vi.fn(async (opts: { metadata: Metadata }) => ({
                id: 'remcli-real-codex-test-session',
                seq: 1,
                metadata: opts.metadata,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy',
            })),
            sessionSyncClient: vi.fn(() => ({
                sessionId: 'remcli-real-codex-test-session',
                onUserMessage(callback: (message: UserMessage) => void) {
                    queueMicrotask(() => {
                        callback({
                            role: 'user',
                            content: { type: 'text', text: fakeSessionState.prompt },
                            meta: {
                                permissionMode: 'read-only',
                                ...(fakeSessionState.model ? { model: fakeSessionState.model } : {}),
                            },
                        });
                    });
                },
                sendCodexMessage(message: CapturedCodexMessage) {
                    if (message.type === 'message' && typeof message.message === 'string') {
                        if (fakeSessionState.hasCollectedLivePrompt) {
                            fakeSessionState.sentCodexMessages.push(message.message);
                            fakeSessionState.shouldClose = true;
                        }
                    }
                },
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
    notifyDaemonSessionStarted: vi.fn(async () => ({})),
}));

vi.mock('@/persistence', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/persistence')>();
    return {
        ...actual,
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
        private queue: Array<{ message: string; mode: T; hash: string }> = [];
        private waiter: ((hasMessages: boolean) => void) | null = null;
        private didCollect = false;

        constructor(private readonly modeHasher: (mode: T) => string) {}

        push(message: string, mode: T): void {
            this.queue.push({ message, mode, hash: this.modeHasher(mode) });
            if (this.waiter) {
                const waiter = this.waiter;
                this.waiter = null;
                waiter(true);
            }
        }

        async waitForMessagesAndGetAsString(signal?: AbortSignal): Promise<{ message: string; mode: T; isolate: boolean; hash: string } | null> {
            if (this.queue.length > 0) {
                return this.collect();
            }
            if ((this.didCollect && fakeSessionState.shouldClose) || signal?.aborted) {
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

        private collect(): { message: string; mode: T; isolate: boolean; hash: string } {
            const item = this.queue.shift();
            if (!item) throw new Error('Expected queued message.');
            this.didCollect = true;
            fakeSessionState.hasCollectedLivePrompt = true;
            return { message: item.message, mode: item.mode, isolate: false, hash: item.hash };
        }
    }

    return { MessageQueue2: SingleTurnMessageQueue };
});

const threadIdsToDelete: string[] = [];

afterEach(() => {
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
        await runRunCodexResumeSmoke(getRealCodexModel());
    });
});

async function runRunCodexResumeSmoke(model: string): Promise<void> {
    const token = `REMCLI_RUNCODEX_${Date.now()}`;
    const seedClient = new CodexAppServerClient();
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
            prompt: `Контекст для проверки: session_token=${token}. Не используй инструменты. Ответь ровно OK.`,
            sandbox: 'read-only',
            approvalPolicy: 'on-request',
            model,
        });
        expectTurnSucceeded(seedTurn, 'seed turn', model);
        await seedClient.disconnect();

        fakeSessionState.reset('Какое значение session_token было в предыдущем сообщении? Не используй инструменты. Ответь только значением.', model);

        const { runCodex } = await import('@/codex/runCodex');
        await runCodex({
            credentials: {
                token: 'test-token',
                encryption: { type: 'legacy', secret: new Uint8Array(32) },
            },
            startedBy: 'daemon',
            resumeSessionId: threadId,
        });

        const answer = fakeSessionState.sentCodexMessages.join('\n');
        const errors = fakeSessionState.sentSessionEvents
            .filter((event) => event.isError)
            .map((event) => event.message ?? '')
            .join('\n');

        expect(`${answer}\n${errors}`).not.toContain('Session not found');
        expect(errors).toBe('');
        expect(answer).toContain(token);
    } finally {
        await seedClient.disconnect().catch(() => undefined);
    }
}
