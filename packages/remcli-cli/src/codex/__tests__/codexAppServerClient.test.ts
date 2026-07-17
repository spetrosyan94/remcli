import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import {
    CodexAppServerClient,
    CodexAppServerActiveTurnHandoffError,
    CodexAppServerAmbiguousThreadStartError,
    CodexAppServerJsonRpcError,
    CodexAppServerThreadStateError,
    CodexAppServerTransportError,
    codexSandboxToAppServerPolicy,
} from '../codexAppServerClient';

class FakeWebSocket {
    static instances: FakeWebSocket[] = [];

    readonly sent: string[] = [];
    readyState = 0;
    closeCalls = 0;
    private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
    }

    addEventListener(type: string, listener: (event: unknown) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: (event: unknown) => void): void {
        const listeners = this.listeners.get(type) ?? [];
        this.listeners.set(type, listeners.filter((current) => current !== listener));
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.closeCalls += 1;
        this.readyState = 3;
        this.emit('close', {});
    }

    open(): void {
        this.readyState = 1;
        this.emit('open', {});
    }

    message(data: string): void {
        this.emit('message', { data });
    }

    error(): void {
        this.emit('error', { type: 'error' });
    }

    private emit(type: string, event: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

async function waitForSent(ws: FakeWebSocket, count: number): Promise<void> {
    const deadline = Date.now() + 1000;
    while (ws.sent.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(ws.sent.length).toBeGreaterThanOrEqual(count);
}

function createFakeClient(): CodexAppServerClient {
    return new CodexAppServerClient({
        endpoint: 'ws://127.0.0.1:45123',
        webSocketFactory: (endpoint) => new FakeWebSocket(endpoint),
    });
}

async function initializeFakeWebSocket(ws: FakeWebSocket): Promise<void> {
    ws.open();
    await waitForSent(ws, 1);
    const initialize = JSON.parse(ws.sent[0]) as { id: number; method: string };
    expect(initialize.method).toBe('initialize');
    ws.message(JSON.stringify({ id: initialize.id, result: {} }));
}

async function connectFakeClient(): Promise<{ client: CodexAppServerClient; ws: FakeWebSocket }> {
    FakeWebSocket.instances = [];
    const client = createFakeClient();
    const connecting = client.connect();
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('ws://127.0.0.1:45123');
    await initializeFakeWebSocket(ws);
    await connecting;
    return { client, ws };
}

interface UserMessageTrackingState {
    ownUserMessageIds: Map<string, string | null>;
    recentOwnUserMessageIds: { size: number };
    activeUserMessageItemIds: Map<string, string | null>;
    recentUserMessageItemIds: { size: number };
}

function getUserMessageTrackingState(client: CodexAppServerClient): UserMessageTrackingState {
    return client as unknown as UserMessageTrackingState;
}

describe('codexSandboxToAppServerPolicy', () => {
    it('maps Codex read-only sandbox to app-server readOnly policy', () => {
        expect(codexSandboxToAppServerPolicy('read-only')).toEqual({
            type: 'readOnly',
            networkAccess: false,
        });
    });

    it('maps Codex workspace-write sandbox to app-server workspaceWrite policy', () => {
        expect(codexSandboxToAppServerPolicy('workspace-write')).toEqual({
            type: 'workspaceWrite',
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        });
    });

    it('maps Codex danger-full-access sandbox to app-server dangerFullAccess policy', () => {
        expect(codexSandboxToAppServerPolicy('danger-full-access')).toEqual({
            type: 'dangerFullAccess',
        });
    });
});

describe('CodexAppServerClient websocket transport', () => {
    it('initializes against a shared websocket endpoint', async () => {
        const { client, ws } = await connectFakeClient();

        expect(ws.sent.map((payload) => JSON.parse(payload))).toEqual([
            expect.objectContaining({ method: 'initialize' }),
            { method: 'initialized', params: {} },
        ]);

        await client.disconnect();
    });

    it('fails closed after a lost thread/start response even when a foreign thread/started arrives', async () => {
        const { client, ws } = await connectFakeClient();
        const threadIds = vi.fn();
        client.setThreadIdChangeHandler(threadIds);

        const startedThread = client.startThread({
            cwd: '/workspace',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(ws, 3);
        const startRequest = JSON.parse(ws.sent[2]) as { method: string };
        expect(startRequest.method).toBe('thread/start');

        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'foreign-thread-without-correlation' } },
        }));
        ws.close();

        await expect(startedThread).rejects.toMatchObject({
            name: 'CodexAppServerAmbiguousThreadStartError',
            reason: 'response-lost',
        });
        expect(client.getActiveThreadId()).toBeNull();
        expect(threadIds).not.toHaveBeenCalled();
        const methods = FakeWebSocket.instances.flatMap((socket) => socket.sent)
            .map((payload) => JSON.parse(payload).method);
        expect(methods.filter((method) => method === 'thread/start')).toHaveLength(1);
        expect(methods).not.toContain('thread/resume');

        await client.disconnect();
    });

    it('blocks a second start after a lost thread/start response', async () => {
        const { client, ws } = await connectFakeClient();
        const threadIds = vi.fn();
        client.setThreadIdChangeHandler(threadIds);

        const startedThread = client.startThread({
            cwd: '/workspace',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(ws, 3);
        ws.close();

        await expect(startedThread).rejects.toMatchObject({
            name: 'CodexAppServerAmbiguousThreadStartError',
            reason: 'response-lost',
        });
        expect(client.getActiveThreadId()).toBeNull();
        expect(threadIds).not.toHaveBeenCalled();
        await expect(client.startThread({
            cwd: '/workspace',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        })).rejects.toMatchObject({
            name: 'CodexAppServerAmbiguousThreadStartError',
            reason: 'previous-start-ambiguous',
        });
        expect(FakeWebSocket.instances.flatMap((socket) => socket.sent)
            .map((payload) => JSON.parse(payload).method)
            .filter((method) => method === 'thread/start')).toHaveLength(1);

        await client.disconnect();
    });

    it('ignores late thread notifications after an ambiguous start', async () => {
        const { client, ws } = await connectFakeClient();
        const threadIds = vi.fn();
        client.setThreadIdChangeHandler(threadIds);

        const startedThread = client.startThread({
            cwd: '/workspace',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(ws, 3);
        ws.close();

        await expect(startedThread).rejects.toMatchObject({
            name: 'CodexAppServerAmbiguousThreadStartError',
            reason: 'response-lost',
        });

        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'late-unknown-thread' } },
        }));

        expect(client.getActiveThreadId()).toBeNull();
        expect(threadIds).not.toHaveBeenCalled();
        await expect(client.startThread({
            cwd: '/workspace',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        })).rejects.toMatchObject({
            name: 'CodexAppServerAmbiguousThreadStartError',
            reason: 'previous-start-ambiguous',
        });
        expect(FakeWebSocket.instances.flatMap((socket) => socket.sent)
            .map((payload) => JSON.parse(payload).method)
            .filter((method) => method === 'thread/start')).toHaveLength(1);

        await client.disconnect();
    });

    it('uses the thread/start response rather than an uncorrelated notification', async () => {
        const { client, ws } = await connectFakeClient();
        const threadIds = vi.fn();
        client.setThreadIdChangeHandler(threadIds);

        const startedThread = client.startThread({
            cwd: '/workspace',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(ws, 3);
        const startRequest = JSON.parse(ws.sent[2]) as { id: number };
        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'thread-from-notification' } },
        }));
        ws.message(JSON.stringify({
            id: startRequest.id,
            result: { thread: { id: 'thread-from-response' } },
        }));

        await expect(startedThread).resolves.toBe('thread-from-response');
        expect(client.getActiveThreadId()).toBe('thread-from-response');
        expect(threadIds).toHaveBeenCalledExactlyOnceWith('thread-from-response');

        await client.disconnect();
    });

    it('keeps a confirmed native thread and ignores late foreign lifecycle and item notifications', async () => {
        const { client, ws } = await connectFakeClient();
        const threadIds = vi.fn();
        const handler = vi.fn();
        client.setThreadIdChangeHandler(threadIds);
        client.setHandler(handler);

        const startedThread = client.startThread({
            cwd: '/workspace',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(ws, 3);
        const startRequest = JSON.parse(ws.sent[2]) as { id: number };
        ws.message(JSON.stringify({
            id: startRequest.id,
            result: { thread: { id: 'native-thread' } },
        }));
        await expect(startedThread).resolves.toBe('native-thread');
        expect(threadIds).toHaveBeenCalledExactlyOnceWith('native-thread');

        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'foreign-thread' } },
        }));
        ws.message(JSON.stringify({
            method: 'thread/status/changed',
            params: { threadId: 'foreign-thread' },
        }));
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'foreign-thread', turn: { id: 'foreign-turn' } },
        }));
        ws.message(JSON.stringify({
            method: 'item/started',
            params: {
                threadId: 'foreign-thread',
                turnId: 'foreign-turn',
                item: { type: 'commandExecution', command: 'foreign command' },
            },
        }));
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: {
                threadId: 'foreign-thread',
                turnId: 'foreign-turn',
                item: { type: 'agentMessage', text: 'foreign agent message' },
            },
        }));
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: {
                threadId: 'foreign-thread',
                turnId: 'foreign-turn',
                item: {
                    id: 'foreign-user-item',
                    type: 'userMessage',
                    content: [{ type: 'text', text: 'foreign user message' }],
                },
            },
        }));
        ws.message(JSON.stringify({
            method: 'turn/diff/updated',
            params: { threadId: 'foreign-thread', turnId: 'foreign-turn', diff: 'foreign diff' },
        }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'foreign-thread', turn: { id: 'foreign-turn', status: 'completed' } },
        }));

        expect(client.getActiveThreadId()).toBe('native-thread');
        expect(client.getActiveTurnId()).toBeNull();
        expect(threadIds).toHaveBeenCalledExactlyOnceWith('native-thread');
        expect(handler).not.toHaveBeenCalled();

        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'native-thread', turn: { id: 'native-turn' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'foreign-thread', turn: { id: 'native-turn', status: 'completed' } },
        }));
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: {
                turnId: 'native-turn',
                item: { type: 'agentMessage', text: 'native agent message' },
            },
        }));
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: {
                turnId: 'unknown-turn',
                item: { type: 'agentMessage', text: 'unassociated agent message' },
            },
        }));

        expect(client.getActiveTurnId()).toBe('native-turn');
        expect(handler).toHaveBeenCalledWith({ type: 'task_started' });
        expect(handler).not.toHaveBeenCalledWith({ type: 'task_complete' });
        expect(handler).toHaveBeenCalledWith({
            type: 'agent_message',
            message: 'native agent message',
            origin: 'live',
        });
        expect(handler).not.toHaveBeenCalledWith({
            type: 'agent_message',
            message: 'unassociated agent message',
            origin: 'live',
        });

        await client.disconnect();
    });

    it('times out a lost thread/start response on a live websocket without real delay', async () => {
        const { client, ws } = await connectFakeClient();
        const threadIds = vi.fn();
        client.setThreadIdChangeHandler(threadIds);
        vi.useFakeTimers();

        try {
            const startedThread = client.startThread({
                cwd: '/workspace',
                sandbox: 'workspace-write',
                approvalPolicy: 'on-request',
            });
            const rejection = expect(startedThread).rejects.toMatchObject({
                name: 'CodexAppServerAmbiguousThreadStartError',
                reason: 'response-lost',
            });

            await vi.advanceTimersByTimeAsync(0);
            expect(JSON.parse(ws.sent[2])).toMatchObject({ method: 'thread/start' });
            expect(ws.closeCalls).toBe(0);

            await vi.advanceTimersByTimeAsync(10_000);
            await rejection;

            expect(ws.closeCalls).toBeGreaterThan(0);
            expect(client.getActiveThreadId()).toBeNull();
            expect(threadIds).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }

        await client.disconnect();
    });

    it('redacts credentials before logging app-server payload diagnostics', async () => {
        const { client, ws } = await connectFakeClient();
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const cookie = 'client-cookie-value';
        const setCookie = 'client-set-cookie-value';
        const bearer = 'client-bearer-value';
        const authToken = 'client-auth-token-value';
        const apiKey = 'client-api-key-value';
        const underscoreAuthToken = 'client-underscore-auth-token-value';

        try {
            ws.message(JSON.stringify({
                method: 'thread/started',
                params: {
                    thread: { id: 'native-thread' },
                    headers: {
                        Cookie: cookie,
                        'Set-Cookie': setCookie,
                        Authorization: `Bearer ${bearer}`,
                        'X-Auth-Token': authToken,
                    },
                    quotedHeader: `"Authorization": "Bearer ${bearer}"`,
                    quotedCredentials: `{"api_key":"${apiKey}","x_auth_token":"${underscoreAuthToken}"}`,
                },
            }));
            ws.message(`Set-Cookie: ${setCookie}`);

            const diagnostics = JSON.stringify(debug.mock.calls);
            expect(diagnostics).toContain('[REDACTED]');
            expect(diagnostics).not.toContain(cookie);
            expect(diagnostics).not.toContain(setCookie);
            expect(diagnostics).not.toContain(bearer);
            expect(diagnostics).not.toContain(authToken);
            expect(diagnostics).not.toContain(apiKey);
            expect(diagnostics).not.toContain(underscoreAuthToken);

            await client.disconnect();
        } finally {
            debug.mockRestore();
        }
    });

    it('closes an opened websocket when initialize does not respond and allows a later reconnect', async () => {
        FakeWebSocket.instances = [];
        const client = createFakeClient();
        vi.useFakeTimers();

        try {
            const firstConnection = client.connect();
            const firstConnectionRejection = expect(firstConnection)
                .rejects.toBeInstanceOf(CodexAppServerTransportError);
            const firstWebSocket = FakeWebSocket.instances[0];
            firstWebSocket.open();
            await vi.advanceTimersByTimeAsync(0);
            expect(JSON.parse(firstWebSocket.sent[0])).toMatchObject({ method: 'initialize' });

            await vi.advanceTimersByTimeAsync(10_000);
            await firstConnectionRejection;
            expect(firstWebSocket.closeCalls).toBeGreaterThan(0);
            expect((client as unknown as { pendingRequests: Map<number, unknown> }).pendingRequests.size).toBe(0);
        } finally {
            vi.useRealTimers();
        }

        const retryConnection = client.connect();
        const retryWebSocket = FakeWebSocket.instances[1];
        await initializeFakeWebSocket(retryWebSocket);
        await expect(retryConnection).resolves.toBeUndefined();
        await client.disconnect();
    });

    it.each([
        ['closes before open', (ws: FakeWebSocket) => ws.close()],
        ['errors before open', (ws: FakeWebSocket) => ws.error()],
    ])('rejects a websocket that %s as a transient transport error', async (_name, trigger) => {
        FakeWebSocket.instances = [];
        const client = createFakeClient();
        const connection = client.connect();
        const ws = FakeWebSocket.instances[0];

        trigger(ws);

        await expect(connection).rejects.toBeInstanceOf(CodexAppServerTransportError);
        expect(ws.closeCalls).toBeGreaterThan(0);
        await client.disconnect();
    });

    it('rejects a JSON-RPC initialize validation response without classifying it as transport failure', async () => {
        FakeWebSocket.instances = [];
        const client = createFakeClient();
        const connection = client.connect();
        const ws = FakeWebSocket.instances[0];

        ws.open();
        await waitForSent(ws, 1);
        const initialize = JSON.parse(ws.sent[0]) as { id: number; method: string };
        ws.message(JSON.stringify({
            id: initialize.id,
            error: { code: -32602, message: 'Invalid initialize parameters' },
        }));

        await expect(connection).rejects.toBeInstanceOf(CodexAppServerJsonRpcError);
        expect(ws.closeCalls).toBeGreaterThan(0);
        await client.disconnect();
    });

    it('starts turns and forwards agent messages from app-server notifications', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);

        const turn = client.startTurn({
            threadId: 'thread-1',
            prompt: 'Тест',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
            model: 'gpt-5.3-codex-spark',
        });

        await waitForSent(ws, 3);
        const startTurn = JSON.parse(ws.sent[2]) as { id: number; method: string; params: any };
        expect(startTurn.method).toBe('turn/start');
        expect(startTurn.params.threadId).toBe('thread-1');
        expect(startTurn.params.input[0].text).toBe('Тест');
        expect(startTurn.params.model).toBe('gpt-5.3-codex-spark');
        expect(startTurn.params.clientUserMessageId).toEqual(expect.any(String));

        ws.message(JSON.stringify({ id: startTurn.id, result: { turn: { id: 'turn-1' } } }));
        await vi.waitFor(() => {
            expect(client.getActiveTurnId()).toBe('turn-1');
        });
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: { type: 'agentMessage', text: 'Ответ' },
            },
        }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        }));

        await expect(turn).resolves.toEqual({ content: [], isError: false });
        expect(client.getActiveTurnId()).toBeNull();
        expect(handler).toHaveBeenCalledWith({
            type: 'agent_message',
            message: 'Ответ',
            origin: 'live',
        });
        expect(handler).toHaveBeenCalledWith({ type: 'task_complete' });

        await client.disconnect();
    });

    it('releases an interrupted turn barrier only for the matching active interrupted completion', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        const controller = new AbortController();
        client.setHandler(handler);

        const startedTurnPromise = client.beginTurn({
            threadId: 'thread-1',
            prompt: 'Останови текущую работу',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
            signal: controller.signal,
        });
        await waitForSent(ws, 3);
        const startTurn = JSON.parse(ws.sent[2]) as { id: number; method: string };
        ws.message(JSON.stringify({ id: startTurn.id, result: { turn: { id: 'turn-1' } } }));
        const startedTurn = await startedTurnPromise;
        const abortedCompletion = startedTurn.completion.catch((error: unknown) => error);

        controller.abort();
        await waitForSent(ws, 4);
        const interrupt = JSON.parse(ws.sent[3]) as {
            method: string;
            params: { threadId: string; turnId: string };
        };
        expect(interrupt).toEqual(expect.objectContaining({
            method: 'turn/interrupt',
            params: { threadId: 'thread-1', turnId: 'turn-1' },
        }));
        expect(client.getActiveTurnId()).toBe('turn-1');
        expect(client.isTurnInterrupting('turn-1')).toBe(true);

        const interruptionSettled = client.waitForInterruptedTurn({
            threadId: 'thread-1',
            turnId: 'turn-1',
            timeoutMs: 1_000,
        });
        let interruptionSettledBeforeMatchingEvent = false;
        void interruptionSettled.then(() => {
            interruptionSettledBeforeMatchingEvent = true;
        });
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'foreign-thread', turn: { id: 'turn-1', status: 'interrupted' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: {
                threadId: 'thread-1',
                turn: { id: 'turn-1', status: 'failed', error: { message: 'turn failed' } },
            },
        }));
        await Promise.resolve();

        expect(interruptionSettledBeforeMatchingEvent).toBe(false);
        expect(client.getActiveTurnId()).toBe('turn-1');
        expect(client.isTurnInterrupting('turn-1')).toBe(true);
        expect(handler).not.toHaveBeenCalledWith({ type: 'task_complete' });

        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
        }));

        await expect(interruptionSettled).resolves.toBeUndefined();
        const abortError = await abortedCompletion;
        expect(abortError).toMatchObject({ name: 'AbortError' });
        expect(client.getActiveTurnId()).toBeNull();
        expect(client.isTurnInterrupting('turn-1')).toBe(false);
        expect(handler).toHaveBeenCalledWith({ type: 'turn_aborted' });
        expect(handler).not.toHaveBeenCalledWith({ type: 'task_complete' });

        await client.disconnect();
    });

    it('does not release an interrupted barrier from a stale predecessor completion', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);

        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'terminal-thread' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-1' } },
        }));

        const interrupting = client.interruptActiveTurn();
        await waitForSent(ws, 3);
        const interrupt = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(interrupt.method).toBe('turn/interrupt');
        ws.message(JSON.stringify({ id: interrupt.id, result: {} }));
        await expect(interrupting).resolves.toBeUndefined();

        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-2' } },
        }));
        handler.mockClear();
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-1', status: 'interrupted' } },
        }));

        expect(client.getActiveTurnId()).toBe('terminal-turn-2');
        expect(client.isTurnInterrupting('terminal-turn-1')).toBe(true);
        expect(handler).not.toHaveBeenCalled();

        await client.disconnect();
    });

    it('releases a matching interrupted barrier from a socket-recovery snapshot before the next delivery', async () => {
        const { client, ws } = await connectFakeClient();
        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'terminal-thread' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-1' } },
        }));

        const interrupting = client.interruptActiveTurn();
        await waitForSent(ws, 3);
        const interrupt = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(interrupt.method).toBe('turn/interrupt');
        ws.message(JSON.stringify({ id: interrupt.id, result: {} }));
        await expect(interrupting).resolves.toBeUndefined();

        const interruptedSettled = client.waitForInterruptedTurn({
            threadId: 'terminal-thread',
            turnId: 'terminal-turn-1',
            timeoutMs: 1_000,
        });
        ws.close();

        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(2);
        });
        const recoveryWs = FakeWebSocket.instances[1];
        await initializeFakeWebSocket(recoveryWs);
        await waitForSent(recoveryWs, 3);
        const recoveryRead = JSON.parse(recoveryWs.sent[2]) as { id: number; method: string };
        expect(recoveryRead.method).toBe('thread/read');
        recoveryWs.message(JSON.stringify({
            id: recoveryRead.id,
            result: {
                thread: {
                    id: 'terminal-thread',
                    status: { type: 'idle' },
                    turns: [{ id: 'terminal-turn-1', status: 'interrupted', items: [] }],
                },
            },
        }));

        await expect(interruptedSettled).resolves.toBeUndefined();
        expect(client.getActiveTurnId()).toBeNull();
        expect(client.isTurnInterrupting('terminal-turn-1')).toBe(false);

        const nextTurn = client.beginTurn({
            threadId: 'terminal-thread',
            prompt: 'Следующий prompt после recovery',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(recoveryWs, 4);
        const nextStart = JSON.parse(recoveryWs.sent[3]) as { id: number; method: string };
        expect(nextStart.method).toBe('turn/start');
        recoveryWs.message(JSON.stringify({ id: nextStart.id, result: { turn: { id: 'terminal-turn-2' } } }));

        const startedNextTurn = await nextTurn;
        recoveryWs.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-2', status: 'completed' } },
        }));
        await expect(startedNextTurn.completion).resolves.toEqual({ content: [], isError: false });
        await client.disconnect();
    });

    it('keeps a predecessor interrupt barrier closed when recovery finds a successor active turn', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);
        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'terminal-thread' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-1' } },
        }));

        const interrupting = client.interruptActiveTurn();
        await waitForSent(ws, 3);
        const interrupt = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(interrupt.method).toBe('turn/interrupt');
        ws.message(JSON.stringify({ id: interrupt.id, result: {} }));
        await expect(interrupting).resolves.toBeUndefined();

        let interruptedWaiterSettled = false;
        const interruptedSettled = client.waitForInterruptedTurn({
            threadId: 'terminal-thread',
            turnId: 'terminal-turn-1',
            timeoutMs: 10_000,
        }).then(
            () => {
                interruptedWaiterSettled = true;
            },
            () => {
                interruptedWaiterSettled = true;
            },
        );
        const successorSnapshot = {
            thread: {
                id: 'terminal-thread',
                status: { type: 'active', activeFlags: [] },
                turns: [
                    {
                        id: 'terminal-turn-1',
                        status: 'interrupted',
                        items: [{
                            id: 'recovery-predecessor-agent-message',
                            type: 'agentMessage',
                            text: 'Сообщение predecessor turn',
                        }],
                    },
                    {
                        id: 'terminal-turn-2',
                        status: 'inProgress',
                        items: [{
                            id: 'recovery-successor-agent-message',
                            type: 'agentMessage',
                            text: 'Сообщение successor turn',
                        }],
                    },
                ],
            },
        };
        ws.close();

        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(2);
        });
        const recoveryWs = FakeWebSocket.instances[1];
        await initializeFakeWebSocket(recoveryWs);
        await waitForSent(recoveryWs, 3);
        const recoveryRead = JSON.parse(recoveryWs.sent[2]) as { id: number; method: string };
        expect(recoveryRead.method).toBe('thread/read');
        recoveryWs.message(JSON.stringify({ id: recoveryRead.id, result: successorSnapshot }));

        await waitForSent(recoveryWs, 4);
        const attachThread = JSON.parse(recoveryWs.sent[3]) as { id: number; method: string };
        expect(attachThread.method).toBe('thread/resume');
        recoveryWs.message(JSON.stringify({ id: attachThread.id, result: { thread: { id: 'terminal-thread' } } }));

        await waitForSent(recoveryWs, 5);
        const attachedThreadRead = JSON.parse(recoveryWs.sent[4]) as { id: number; method: string };
        expect(attachedThreadRead.method).toBe('thread/read');
        recoveryWs.message(JSON.stringify({ id: attachedThreadRead.id, result: successorSnapshot }));

        await vi.waitFor(() => {
            expect(client.getActiveTurnId()).toBe('terminal-turn-2');
        });
        expect(client.isTurnInterrupting('terminal-turn-1')).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(interruptedWaiterSettled).toBe(false);
        expect(handler.mock.calls
            .filter(([event]) => event.type === 'agent_message')
            .map(([event]) => event.message),
        ).toEqual([
            'Сообщение predecessor turn',
            'Сообщение successor turn',
        ]);
        expect(handler).not.toHaveBeenCalledWith({ type: 'turn_aborted' });
        await client.disconnect();
        await interruptedSettled;
    });

    it('keeps the barrier closed after a rejected interrupt request and a non-interrupted completion', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);

        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'terminal-thread' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn' } },
        }));

        const interrupting = client.interruptActiveTurn();
        await waitForSent(ws, 3);
        const interrupt = JSON.parse(ws.sent[2]) as { id: number };
        ws.message(JSON.stringify({
            id: interrupt.id,
            error: { code: -32000, message: 'interrupt rejected' },
        }));

        await expect(interrupting).rejects.toThrow('interrupt rejected');
        await expect(client.waitForInterruptedTurn({
            threadId: 'terminal-thread',
            turnId: 'terminal-turn',
        })).rejects.toThrow('interrupt rejected');
        expect(client.getActiveTurnId()).toBe('terminal-turn');
        expect(client.isTurnInterrupting('terminal-turn')).toBe(true);

        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn', status: 'completed' } },
        }));

        expect(client.getActiveTurnId()).toBe('terminal-turn');
        expect(client.isTurnInterrupting('terminal-turn')).toBe(true);
        expect(handler).not.toHaveBeenCalledWith({ type: 'task_complete' });

        await client.disconnect();
    });

    it('fails closed after an interrupt request timeout without waiting in real time', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);
        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'terminal-thread' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn' } },
        }));

        vi.useFakeTimers();
        try {
            const interrupting = client.interruptActiveTurn();
            const interruptionFailure = expect(interrupting)
                .rejects.toThrow('Timed out waiting for Codex app-server turn/interrupt.');
            expect(JSON.parse(ws.sent[2])).toMatchObject({ method: 'turn/interrupt' });

            await vi.advanceTimersByTimeAsync(10_000);

            await interruptionFailure;
            await expect(client.waitForInterruptedTurn({
                threadId: 'terminal-thread',
                turnId: 'terminal-turn',
            })).rejects.toThrow('Timed out waiting for Codex app-server turn/interrupt.');
            expect(client.getActiveTurnId()).toBe('terminal-turn');
            expect(client.isTurnInterrupting('terminal-turn')).toBe(true);
            expect(handler).not.toHaveBeenCalledWith({ type: 'task_complete' });
        } finally {
            await client.disconnect();
            vi.useRealTimers();
        }
    });

    it('keeps the barrier closed when the matching interrupted completion does not arrive before its settle timeout', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);
        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'terminal-thread' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn' } },
        }));

        const interrupting = client.interruptActiveTurn();
        await waitForSent(ws, 3);
        const interrupt = JSON.parse(ws.sent[2]) as { id: number };
        ws.message(JSON.stringify({ id: interrupt.id, result: {} }));
        await expect(interrupting).resolves.toBeUndefined();

        vi.useFakeTimers();
        try {
            const interruptedCompletion = client.waitForInterruptedTurn({
                threadId: 'terminal-thread',
                turnId: 'terminal-turn',
                timeoutMs: 1,
            });
            const interruptionFailure = expect(interruptedCompletion)
                .rejects.toThrow('Timed out waiting for Codex interrupted turn to settle.');

            await vi.advanceTimersByTimeAsync(1);

            await interruptionFailure;
            expect(client.getActiveTurnId()).toBe('terminal-turn');
            expect(client.isTurnInterrupting('terminal-turn')).toBe(true);
            await expect(client.waitForInterruptedTurn({
                threadId: 'terminal-thread',
                turnId: 'terminal-turn',
            })).rejects.toThrow('Timed out waiting for Codex interrupted turn to settle.');
            expect(handler).not.toHaveBeenCalledWith({ type: 'task_complete' });

            ws.message(JSON.stringify({
                method: 'turn/completed',
                params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn', status: 'interrupted' } },
            }));

            expect(client.getActiveTurnId()).toBeNull();
            expect(client.isTurnInterrupting('terminal-turn')).toBe(false);
            await expect(client.waitForInterruptedTurn({
                threadId: 'terminal-thread',
                turnId: 'terminal-turn',
            })).resolves.toBeUndefined();
        } finally {
            await client.disconnect();
            vi.useRealTimers();
        }
    });

    it('emits task_complete only for a successful current active turn', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);

        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'terminal-thread' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-1' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-2' } },
        }));

        handler.mockClear();
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-1', status: 'completed' } },
        }));
        expect(client.getActiveTurnId()).toBe('terminal-turn-2');
        expect(handler).not.toHaveBeenCalled();

        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: {
                threadId: 'terminal-thread',
                turn: { id: 'terminal-turn-2', status: 'failed', error: { message: 'active failure' } },
            },
        }));

        expect(client.getActiveTurnId()).toBeNull();
        expect(handler).toHaveBeenCalledWith({ type: 'agent_error', message: 'active failure' });
        expect(handler).not.toHaveBeenCalledWith({ type: 'task_complete' });

        await client.disconnect();
    });

    it('clears the active turn when turn/completed arrives before the turn/start response', async () => {
        const { client, ws } = await connectFakeClient();

        const startedTurnPromise = client.beginTurn({
            threadId: 'thread-1',
            prompt: 'Проверь раннее завершение',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });

        await waitForSent(ws, 3);
        const startTurn = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(startTurn.method).toBe('turn/start');

        // Current app-server notification shape is { threadId, turn }.
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: { id: 'turn-early-complete' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-early-complete', status: 'completed' } },
        }));
        ws.message(JSON.stringify({ id: startTurn.id, result: { turn: { id: 'turn-early-complete' } } }));

        const startedTurn = await startedTurnPromise;
        await expect(startedTurn.completion).resolves.toEqual({ content: [], isError: false });
        expect(client.getActiveTurnId()).toBeNull();

        await client.disconnect();
    });

    it('recovers an active websocket turn, reattaches it, and does not replay agent items twice', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);

        const startedTurnPromise = client.beginTurn({
            threadId: 'thread-1',
            prompt: 'Продолжи после reconnect',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(ws, 3);
        const startTurn = JSON.parse(ws.sent[2]) as { id: number; method: string };
        ws.message(JSON.stringify({ id: startTurn.id, result: { turn: { id: 'turn-1' } } }));
        const startedTurn = await startedTurnPromise;

        const replayedAgentItem = {
            id: 'agent-item-1',
            type: 'agentMessage',
            text: 'Ответ до потери сокета',
        };
        const terminalUserItem = {
            id: 'terminal-user-item-1',
            type: 'userMessage',
            content: [{ type: 'text', text: 'Prompt из native terminal во время reconnect' }],
        };
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: { turnId: 'turn-1', item: replayedAgentItem },
        }));
        expect(handler).toHaveBeenCalledWith({
            type: 'agent_message',
            message: replayedAgentItem.text,
            origin: 'live',
        });

        ws.close();
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(2);
        });
        const recoveryWs = FakeWebSocket.instances[1];
        await initializeFakeWebSocket(recoveryWs);

        await waitForSent(recoveryWs, 3);
        const recoveryRead = JSON.parse(recoveryWs.sent[2]) as { id: number; method: string };
        expect(recoveryRead.method).toBe('thread/read');
        recoveryWs.message(JSON.stringify({
            id: recoveryRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'turn-1',
                        status: 'inProgress',
                        items: [replayedAgentItem, terminalUserItem],
                    }],
                },
            },
        }));

        await waitForSent(recoveryWs, 4);
        const attachThread = JSON.parse(recoveryWs.sent[3]) as { id: number; method: string };
        expect(attachThread.method).toBe('thread/resume');
        recoveryWs.message(JSON.stringify({
            id: attachThread.id,
            result: {
                thread: {
                    id: 'thread-1',
                },
            },
        }));

        await waitForSent(recoveryWs, 5);
        const attachedThreadRead = JSON.parse(recoveryWs.sent[4]) as { id: number; method: string };
        expect(attachedThreadRead.method).toBe('thread/read');
        recoveryWs.message(JSON.stringify({
            id: attachedThreadRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'turn-1',
                        status: 'inProgress',
                        items: [replayedAgentItem, terminalUserItem],
                    }],
                },
            },
        }));

        await vi.waitFor(() => {
            expect(handler).toHaveBeenCalledWith({
                type: 'user_message',
                itemId: terminalUserItem.id,
                text: 'Prompt из native terminal во время reconnect',
                content: terminalUserItem.content,
                clientId: null,
                source: 'external',
            });
        });
        expect(client.getActiveTurnId()).toBe('turn-1');
        const replayedAgentEvents = handler.mock.calls.filter(([event]) => (
            event.type === 'agent_message' && event.message === replayedAgentItem.text
        ));
        expect(replayedAgentEvents).toHaveLength(1);

        recoveryWs.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        }));
        await expect(startedTurn.completion).resolves.toEqual({ content: [], isError: false });

        await client.disconnect();
    });

    it('recovers an active turn once after a forced websocket send failure', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);

        const startedTurnPromise = client.beginTurn({
            threadId: 'thread-1',
            prompt: 'Продолжи после принудительного закрытия',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(ws, 3);
        const startTurn = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(startTurn.method).toBe('turn/start');
        ws.message(JSON.stringify({ id: startTurn.id, result: { turn: { id: 'turn-1' } } }));
        const startedTurn = await startedTurnPromise;

        const replayedAgentItem = {
            id: 'forced-close-agent-item',
            type: 'agentMessage',
            text: 'Ответ до принудительного закрытия',
        };
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: { turnId: 'turn-1', item: replayedAgentItem },
        }));
        expect(handler).toHaveBeenCalledWith({
            type: 'agent_message',
            message: replayedAgentItem.text,
            origin: 'live',
        });

        ws.readyState = 0;
        const failedRequest = (client as unknown as {
            request(method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
        }).request('thread/read', { threadId: 'thread-1', includeTurns: true });
        await expect(failedRequest).rejects.toBeInstanceOf(CodexAppServerTransportError);
        expect(ws.closeCalls).toBe(1);

        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(2);
        });
        const recoveryWs = FakeWebSocket.instances[1];
        await initializeFakeWebSocket(recoveryWs);

        await waitForSent(recoveryWs, 3);
        const recoveryRead = JSON.parse(recoveryWs.sent[2]) as { id: number; method: string };
        expect(recoveryRead.method).toBe('thread/read');
        recoveryWs.message(JSON.stringify({
            id: recoveryRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'turn-1',
                        status: 'inProgress',
                        items: [replayedAgentItem],
                    }],
                },
            },
        }));

        await waitForSent(recoveryWs, 4);
        const attachThread = JSON.parse(recoveryWs.sent[3]) as { id: number; method: string };
        expect(attachThread.method).toBe('thread/resume');
        recoveryWs.message(JSON.stringify({ id: attachThread.id, result: { thread: { id: 'thread-1' } } }));

        await waitForSent(recoveryWs, 5);
        const attachedThreadRead = JSON.parse(recoveryWs.sent[4]) as { id: number; method: string };
        expect(attachedThreadRead.method).toBe('thread/read');
        recoveryWs.message(JSON.stringify({
            id: attachedThreadRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'turn-1',
                        status: 'inProgress',
                        items: [replayedAgentItem],
                    }],
                },
            },
        }));

        await vi.waitFor(() => {
            expect(client.getActiveTurnId()).toBe('turn-1');
        });
        expect(FakeWebSocket.instances).toHaveLength(2);
        const replayedAgentEvents = handler.mock.calls.filter(([event]) => (
            event.type === 'agent_message' && event.message === replayedAgentItem.text
        ));
        expect(replayedAgentEvents).toHaveLength(1);

        recoveryWs.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        }));
        await expect(startedTurn.completion).resolves.toEqual({ content: [], isError: false });

        await client.disconnect();
    });

    it('resumes a stored thread before reading its loaded active turn', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);

        const resumedThread = client.resumeThread({
            threadId: 'thread-1',
            cwd: '/workspace',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(ws, 3);
        const resume = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(resume.method).toBe('thread/resume');
        ws.message(JSON.stringify({
            id: resume.id,
            result: {
                thread: {
                    id: 'thread-1',
                },
            },
        }));

        await waitForSent(ws, 4);
        const read = JSON.parse(ws.sent[3]) as { id: number; method: string; params: unknown };
        expect(read.method).toBe('thread/read');
        expect(read.params).toEqual({ threadId: 'thread-1', includeTurns: true });
        ws.message(JSON.stringify({
            id: read.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'active-turn-1',
                        status: 'inProgress',
                        items: [{ id: 'active-agent-item', type: 'agentMessage', text: 'Уже выполняю' }],
                    }],
                },
            },
        }));

        await expect(resumedThread).resolves.toBe('thread-1');
        expect(client.getActiveThreadId()).toBe('thread-1');
        expect(client.getActiveTurnId()).toBe('active-turn-1');
        expect(handler).toHaveBeenCalledWith({
            type: 'agent_message',
            message: 'Уже выполняю',
            origin: 'replay',
        });

        await client.disconnect();
    });

    it('ignores foreign turn and item notifications while thread/resume is awaiting its response', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        const threadIds = vi.fn();
        client.setHandler(handler);
        client.setThreadIdChangeHandler(threadIds);

        const resumedThread = client.resumeThread({
            threadId: 'native-thread',
            cwd: '/workspace',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(ws, 3);
        const resume = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(resume.method).toBe('thread/resume');

        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'foreign-thread' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'foreign-thread', turn: { id: 'foreign-turn' } },
        }));
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: {
                threadId: 'foreign-thread',
                turnId: 'foreign-turn',
                item: { type: 'agentMessage', text: 'foreign resume item' },
            },
        }));

        expect(client.getActiveThreadId()).toBeNull();
        expect(client.getActiveTurnId()).toBeNull();
        expect(threadIds).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();

        ws.message(JSON.stringify({
            id: resume.id,
            result: { thread: { id: 'native-thread' } },
        }));
        await waitForSent(ws, 4);
        const read = JSON.parse(ws.sent[3]) as { id: number; method: string };
        expect(read.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: read.id,
            result: {
                thread: {
                    id: 'native-thread',
                    status: { type: 'idle' },
                    turns: [],
                },
            },
        }));

        await expect(resumedThread).resolves.toBe('native-thread');
        expect(client.getActiveThreadId()).toBe('native-thread');
        expect(threadIds).toHaveBeenCalledExactlyOnceWith('native-thread');

        await client.disconnect();
    });

    it('hydrates an idle-disconnect terminal turn before a phone delivery chooses turn/start', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);
        const terminalUserItem = {
            id: 'terminal-user-item-after-idle-disconnect',
            type: 'userMessage',
            content: [{ type: 'text', text: 'Prompt from the native terminal after an idle disconnect' }],
        };

        const hydration = client.hydrateThreadIfNeeded('thread-1');
        await waitForSent(ws, 3);
        const snapshotRead = JSON.parse(ws.sent[2]) as { id: number; method: string; params: unknown };
        expect(snapshotRead).toMatchObject({
            method: 'thread/read',
            params: { threadId: 'thread-1', includeTurns: true },
        });
        ws.message(JSON.stringify({
            id: snapshotRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'terminal-turn-after-idle-disconnect',
                        status: 'inProgress',
                        items: [terminalUserItem],
                    }],
                },
            },
        }));

        await waitForSent(ws, 4);
        const attach = JSON.parse(ws.sent[3]) as { id: number; method: string; params: unknown };
        expect(attach).toMatchObject({
            method: 'thread/resume',
            params: { threadId: 'thread-1' },
        });
        ws.message(JSON.stringify({ id: attach.id, result: { thread: { id: 'thread-1' } } }));

        await waitForSent(ws, 5);
        const attachedRead = JSON.parse(ws.sent[4]) as { id: number; method: string; params: unknown };
        expect(attachedRead).toMatchObject({
            method: 'thread/read',
            params: { threadId: 'thread-1', includeTurns: true },
        });
        ws.message(JSON.stringify({
            id: attachedRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'terminal-turn-after-idle-disconnect',
                        status: 'inProgress',
                        items: [terminalUserItem],
                    }],
                },
            },
        }));

        await hydration;
        expect(client.getActiveThreadId()).toBe('thread-1');
        expect(client.getActiveTurnId()).toBe('terminal-turn-after-idle-disconnect');
        expect(handler).toHaveBeenCalledWith({
            type: 'user_message',
            itemId: terminalUserItem.id,
            text: 'Prompt from the native terminal after an idle disconnect',
            content: terminalUserItem.content,
            clientId: null,
            source: 'external',
        });

        await client.disconnect();
    });

    it('fails hydration when thread/read returns an error instead of treating the thread as idle', async () => {
        const { client, ws } = await connectFakeClient();

        const hydration = client.hydrateThreadIfNeeded('thread-1');
        await waitForSent(ws, 3);
        const snapshotRead = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(snapshotRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: snapshotRead.id,
            error: { code: -32602, message: 'Invalid thread/read parameters' },
        }));

        await expect(hydration).rejects.toThrow('Invalid thread/read parameters');
        expect(ws.sent.map((payload) => JSON.parse(payload).method)).not.toContain('thread/resume');
        expect(client.getActiveThreadId()).toBeNull();
        expect(client.getActiveTurnId()).toBeNull();

        await client.disconnect();
    });

    it('treats only the fresh-thread pre-materialization response as a hydration no-op', async () => {
        const { client, ws } = await connectFakeClient();

        const hydration = client.hydrateThreadIfNeeded('thread-1');
        await waitForSent(ws, 3);
        const snapshotRead = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(snapshotRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: snapshotRead.id,
            error: {
                code: -32600,
                message: 'thread thread-1 is not materialized yet; includeTurns is unavailable before first user message',
            },
        }));

        await expect(hydration).resolves.toBeUndefined();
        expect(ws.sent.map((payload) => JSON.parse(payload).method)).not.toContain('thread/resume');
        expect(client.getActiveThreadId()).toBeNull();
        expect(client.getActiveTurnId()).toBeNull();

        await client.disconnect();
    });

    it.each([
        {
            code: -32001,
            message: 'thread thread-1 is not materialized yet; includeTurns is unavailable before first user message',
        },
        {
            code: -32600,
            message: 'thread different-thread is not materialized yet; includeTurns is unavailable before first user message',
        },
    ])('fails closed for a near-match fresh-thread hydration error: %#', async ({ code, message }) => {
        const { client, ws } = await connectFakeClient();

        const hydration = client.hydrateThreadIfNeeded('thread-1');
        await waitForSent(ws, 3);
        const snapshotRead = JSON.parse(ws.sent[2]) as { id: number; method: string };
        ws.message(JSON.stringify({ id: snapshotRead.id, error: { code, message } }));

        await expect(hydration).rejects.toBeInstanceOf(CodexAppServerJsonRpcError);
        expect(ws.sent.map((payload) => JSON.parse(payload).method)).not.toContain('thread/resume');
        await client.disconnect();
    });

    it('treats a stored notLoaded hydration snapshot as a no-op before a later resume', async () => {
        const { client, ws } = await connectFakeClient();

        const hydration = client.hydrateThreadIfNeeded('thread-1');
        await waitForSent(ws, 3);
        const hydrationRead = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(hydrationRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: hydrationRead.id,
            result: { thread: { id: 'thread-1', status: { type: 'notLoaded' } } },
        }));

        await expect(hydration).resolves.toBeUndefined();
        expect(ws.sent.map((payload) => JSON.parse(payload).method)).not.toContain('thread/resume');

        const resume = client.resumeThread({
            threadId: 'thread-1',
            cwd: '/workspace',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(ws, 4);
        const resumeRequest = JSON.parse(ws.sent[3]) as { id: number; method: string };
        expect(resumeRequest.method).toBe('thread/resume');
        ws.message(JSON.stringify({ id: resumeRequest.id, result: { thread: { id: 'thread-1' } } }));

        await waitForSent(ws, 5);
        const runtimeRead = JSON.parse(ws.sent[4]) as { id: number; method: string };
        expect(runtimeRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: runtimeRead.id,
            result: { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } },
        }));

        await expect(resume).resolves.toBe('thread-1');
        await client.disconnect();
    });

    it.each([
        [{ type: 'systemError' }, [], 'system error'],
        [{ type: 'unknown' }, [], 'unknown status'],
        [{ type: 'active', activeFlags: 'invalid' }, [], 'invalid active status'],
        [{ type: 'active', activeFlags: [] }, [], 'active status without a turn'],
        [{ type: 'idle' }, [{ id: 'unexpected-active-turn', status: 'inProgress', items: [] }], 'idle status with an active turn'],
    ])('fails closed for invalid loaded thread/read %s during hydration', async (status, turns, _reason) => {
        const { client, ws } = await connectFakeClient();

        const hydration = client.hydrateThreadIfNeeded('thread-1');
        await waitForSent(ws, 3);
        const read = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(read.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: read.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status,
                    turns,
                },
            },
        }));

        await expect(hydration).rejects.toBeInstanceOf(CodexAppServerThreadStateError);
        expect(ws.sent.map((payload) => JSON.parse(payload).method)).not.toContain('thread/resume');
        expect(client.getActiveThreadId()).toBeNull();
        expect(client.getActiveTurnId()).toBeNull();
        await client.disconnect();
    });

    it('permits turn/start only after a confirmed idle thread snapshot', async () => {
        const { client, ws } = await connectFakeClient();
        const deliveryId = 'p2p:thread-1:idle-start';
        const started = client.beginTurn({
            threadId: 'thread-1',
            prompt: 'Начни только из idle состояния',
            clientUserMessageId: deliveryId,
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });

        await waitForSent(ws, 3);
        const read = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(read.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: read.id,
            result: { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } },
        }));

        await waitForSent(ws, 4);
        const start = JSON.parse(ws.sent[3]) as { id: number; method: string; params: { clientUserMessageId: string } };
        expect(start).toMatchObject({
            method: 'turn/start',
            params: { clientUserMessageId: deliveryId },
        });
        ws.message(JSON.stringify({ id: start.id, result: { turn: { id: 'turn-from-idle' } } }));

        const startedTurn = await started;
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-from-idle', status: 'completed' } },
        }));
        await expect(startedTurn.completion).resolves.toEqual({ content: [], isError: false });
        await client.disconnect();
    });

    it('starts exactly one first turn when the fresh thread has no readable turns yet', async () => {
        const { client, ws } = await connectFakeClient();
        const deliveryId = 'p2p:thread-1:fresh-first-turn';
        const started = client.beginTurn({
            threadId: 'thread-1',
            prompt: 'Первый prompt fresh thread',
            clientUserMessageId: deliveryId,
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });

        await waitForSent(ws, 3);
        const preflightRead = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(preflightRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: preflightRead.id,
            error: {
                code: -32600,
                message: 'thread thread-1 is not materialized yet; includeTurns is unavailable before first user message',
            },
        }));

        await waitForSent(ws, 4);
        const startTurn = JSON.parse(ws.sent[3]) as {
            id: number;
            method: string;
            params: { clientUserMessageId: string };
        };
        expect(startTurn).toMatchObject({
            method: 'turn/start',
            params: { clientUserMessageId: deliveryId },
        });
        expect(ws.sent.map((payload) => JSON.parse(payload).method).filter((method) => method === 'turn/start'))
            .toHaveLength(1);
        ws.message(JSON.stringify({ id: startTurn.id, result: { turn: { id: 'fresh-turn-1' } } }));

        const startedTurn = await started;
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'fresh-turn-1', status: 'completed' } },
        }));
        await expect(startedTurn.completion).resolves.toEqual({ content: [], isError: false });
        await client.disconnect();
    });

    it('exposes a typed handoff when a native turn starts after the idle begin preflight', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);
        const deliveryId = 'p2p:thread-1:handoff-after-idle';
        const terminalUserItem = {
            id: 'terminal-user-item-after-idle-preflight',
            type: 'userMessage',
            clientId: 'native-codex-tui',
            content: [{ type: 'text', text: 'Prompt из native terminal после idle preflight' }],
        };

        const begin = client.beginTurn({
            threadId: 'thread-1',
            prompt: 'Телефонный prompt',
            clientUserMessageId: deliveryId,
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(ws, 3);
        const preflightRead = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(preflightRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: preflightRead.id,
            result: { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } },
        }));

        await waitForSent(ws, 4);
        const startTurn = JSON.parse(ws.sent[3]) as {
            id: number;
            method: string;
            params: { clientUserMessageId: string };
        };
        expect(startTurn).toMatchObject({
            method: 'turn/start',
            params: { clientUserMessageId: deliveryId },
        });
        ws.message(JSON.stringify({
            id: startTurn.id,
            error: { code: -32001, message: 'Another turn is already active.' },
        }));

        await waitForSent(ws, 5);
        const reconciliationRead = JSON.parse(ws.sent[4]) as { id: number; method: string };
        expect(reconciliationRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: reconciliationRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'terminal-turn-after-idle-preflight',
                        status: 'inProgress',
                        items: [terminalUserItem],
                    }],
                },
            },
        }));

        await waitForSent(ws, 6);
        const attachThread = JSON.parse(ws.sent[5]) as { id: number; method: string };
        expect(attachThread.method).toBe('thread/resume');
        ws.message(JSON.stringify({ id: attachThread.id, result: { thread: { id: 'thread-1' } } }));

        await waitForSent(ws, 7);
        const attachedThreadRead = JSON.parse(ws.sent[6]) as { id: number; method: string };
        expect(attachedThreadRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: attachedThreadRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'terminal-turn-after-idle-preflight',
                        status: 'inProgress',
                        items: [terminalUserItem],
                    }],
                },
            },
        }));

        const handoff = await begin.catch((error: unknown) => error);
        expect(handoff).toBeInstanceOf(CodexAppServerActiveTurnHandoffError);
        expect(handoff).toMatchObject({
            threadId: 'thread-1',
            turnId: 'terminal-turn-after-idle-preflight',
        });
        expect(client.getActiveThreadId()).toBe('thread-1');
        expect(client.getActiveTurnId()).toBe('terminal-turn-after-idle-preflight');
        expect(handler).toHaveBeenCalledWith({
            type: 'user_message',
            itemId: terminalUserItem.id,
            text: 'Prompt из native terminal после idle preflight',
            content: terminalUserItem.content,
            clientId: terminalUserItem.clientId,
            source: 'external',
        });
        expect(ws.sent.map((payload) => JSON.parse(payload).method).filter((method) => method === 'turn/start'))
            .toHaveLength(1);

        await client.disconnect();
    });

    it('fails closed when runtime status is invalid after thread/resume', async () => {
        const { client, ws } = await connectFakeClient();
        const resume = client.resumeThread({
            threadId: 'thread-1',
            cwd: '/workspace',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });

        await waitForSent(ws, 3);
        const resumeRequest = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(resumeRequest.method).toBe('thread/resume');
        ws.message(JSON.stringify({ id: resumeRequest.id, result: { thread: { id: 'thread-1' } } }));

        await waitForSent(ws, 4);
        const read = JSON.parse(ws.sent[3]) as { id: number; method: string };
        expect(read.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: read.id,
            result: { thread: { id: 'thread-1', status: { type: 'systemError' }, turns: [] } },
        }));

        await expect(resume).rejects.toBeInstanceOf(CodexAppServerThreadStateError);
        expect(ws.sent.map((payload) => JSON.parse(payload).method)).not.toContain('turn/start');
        await client.disconnect();
    });

    it('bounds hydration thread/read requests instead of waiting for the default turn timeout', async () => {
        const { client, ws } = await connectFakeClient();
        vi.useFakeTimers();

        try {
            const hydration = client.hydrateThreadIfNeeded('thread-1');
            const hydrationRejection = expect(hydration).rejects
                .toThrow('Timed out waiting for Codex app-server thread/read.');
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(10_000);

            await hydrationRejection;
            expect(ws.sent.map((payload) => JSON.parse(payload).method)).not.toContain('thread/resume');
        } finally {
            vi.useRealTimers();
            await client.disconnect();
        }
    });

    it('reattaches a successor turn before surfacing a terminal turn/steer conflict', async () => {
        const { client, ws } = await connectFakeClient();
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'thread-1', turn: { id: 'turn-1' } },
        }));

        const steeredTurn = client.steerTurn({
            threadId: 'thread-1',
            expectedTurnId: 'turn-1',
            prompt: 'Телефонный prompt после terminal turn',
            clientUserMessageId: 'p2p:thread-1:2',
        });
        await waitForSent(ws, 3);
        const preflightRead = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(preflightRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: preflightRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{ id: 'turn-1', status: 'inProgress', items: [] }],
                },
            },
        }));

        await waitForSent(ws, 4);
        const steer = JSON.parse(ws.sent[3]) as { id: number; method: string };
        expect(steer.method).toBe('turn/steer');
        ws.message(JSON.stringify({
            id: steer.id,
            error: { code: -32001, message: 'expectedTurnId is no longer active' },
        }));

        const successorSnapshot = {
            thread: {
                id: 'thread-1',
                status: { type: 'active', activeFlags: [] },
                turns: [
                    { id: 'turn-1', status: 'completed', items: [] },
                    { id: 'turn-2', status: 'inProgress', items: [] },
                ],
            },
        };
        await waitForSent(ws, 5);
        const reconciliationRead = JSON.parse(ws.sent[4]) as { id: number; method: string };
        expect(reconciliationRead.method).toBe('thread/read');
        ws.message(JSON.stringify({ id: reconciliationRead.id, result: successorSnapshot }));

        await waitForSent(ws, 6);
        const completionRead = JSON.parse(ws.sent[5]) as { id: number; method: string };
        expect(completionRead.method).toBe('thread/read');
        ws.message(JSON.stringify({ id: completionRead.id, result: successorSnapshot }));

        await waitForSent(ws, 7);
        const attachThread = JSON.parse(ws.sent[6]) as { id: number; method: string };
        expect(attachThread.method).toBe('thread/resume');
        ws.message(JSON.stringify({ id: attachThread.id, result: { thread: { id: 'thread-1' } } }));

        await waitForSent(ws, 8);
        const attachedThreadRead = JSON.parse(ws.sent[7]) as { id: number; method: string };
        expect(attachedThreadRead.method).toBe('thread/read');
        ws.message(JSON.stringify({ id: attachedThreadRead.id, result: successorSnapshot }));

        await expect(steeredTurn).rejects.toThrow('expectedTurnId is no longer active');
        expect(client.getActiveTurnId()).toBe('turn-2');

        await client.disconnect();
    });

    it('rejoins a reconciled in-progress turn before accepting a replayed delivery and streams its lifecycle', async () => {
        const deliveryId = 'p2p:session-replay:1';
        FakeWebSocket.instances = [];

        const firstClient = createFakeClient();
        const firstConnection = firstClient.connect();
        const firstWs = FakeWebSocket.instances[0];
        await initializeFakeWebSocket(firstWs);
        await firstConnection;

        const firstAttempt = firstClient.beginTurn({
            threadId: 'thread-1',
            prompt: 'Телефонный prompt',
            clientUserMessageId: deliveryId,
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        await waitForSent(firstWs, 3);
        const firstRead = JSON.parse(firstWs.sent[2]) as { id: number; method: string };
        expect(firstRead.method).toBe('thread/read');
        firstWs.message(JSON.stringify({
            id: firstRead.id,
            result: { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } },
        }));

        await waitForSent(firstWs, 4);
        const acceptedStart = JSON.parse(firstWs.sent[3]) as {
            id: number;
            method: string;
            params: { clientUserMessageId: string };
        };
        expect(acceptedStart).toMatchObject({
            method: 'turn/start',
            params: { clientUserMessageId: deliveryId },
        });

        // The app-server accepted the native user item, but the transport lost
        // the response before Remcli could ACK the P2P delivery.
        firstWs.close();
        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(2);
        });
        FakeWebSocket.instances[1].close();
        await expect(firstAttempt).rejects.toThrow('websocket');
        await firstClient.disconnect();

        const replayClient = createFakeClient();
        const replayHandler = vi.fn();
        replayClient.setHandler(replayHandler);
        const replayConnection = replayClient.connect();
        const replayWs = FakeWebSocket.instances[2];
        await initializeFakeWebSocket(replayWs);
        await replayConnection;

        const replayAttempt = replayClient.beginTurn({
            threadId: 'thread-1',
            prompt: 'Телефонный prompt',
            clientUserMessageId: deliveryId,
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        let replayAccepted = false;
        void replayAttempt.then(() => {
            replayAccepted = true;
        });
        await waitForSent(replayWs, 3);
        const replayRead = JSON.parse(replayWs.sent[2]) as { id: number; method: string };
        expect(replayRead.method).toBe('thread/read');
        replayWs.message(JSON.stringify({
            id: replayRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'native-turn-1',
                        status: 'inProgress',
                        items: [{
                            id: 'native-user-item-1',
                            type: 'userMessage',
                            clientId: deliveryId,
                            content: [{ type: 'text', text: 'Телефонный prompt' }],
                        }],
                    }],
                },
            },
        }));

        await waitForSent(replayWs, 4);
        const attachThread = JSON.parse(replayWs.sent[3]) as {
            id: number;
            method: string;
            params: { threadId: string };
        };
        expect(attachThread).toEqual(expect.objectContaining({
            method: 'thread/resume',
            params: { threadId: 'thread-1' },
        }));
        await Promise.resolve();
        expect(replayAccepted).toBe(false);
        replayWs.message(JSON.stringify({
            id: attachThread.id,
            result: { thread: { id: 'thread-1' } },
        }));

        await waitForSent(replayWs, 5);
        const attachedThreadRead = JSON.parse(replayWs.sent[4]) as { id: number; method: string };
        expect(attachedThreadRead.method).toBe('thread/read');
        replayWs.message(JSON.stringify({
            id: attachedThreadRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'native-turn-1',
                        status: 'inProgress',
                        items: [{
                            id: 'native-user-item-1',
                            type: 'userMessage',
                            clientId: deliveryId,
                            content: [{ type: 'text', text: 'Телефонный prompt' }],
                        }],
                    }],
                },
            },
        }));

        const replayedTurn = await replayAttempt;
        const nativeStartRequests = FakeWebSocket.instances
            .flatMap((socket) => socket.sent.map((payload) => JSON.parse(payload) as { method?: string }))
            .filter((request) => request.method === 'turn/start');
        expect(nativeStartRequests).toHaveLength(1);
        expect(replayWs.sent.map((payload) => JSON.parse(payload).method)).not.toContain('turn/start');

        replayWs.message(JSON.stringify({
            method: 'item/completed',
            params: {
                turnId: 'native-turn-1',
                item: { id: 'native-agent-item-1', type: 'agentMessage', text: 'Ответ после attach' },
            },
        }));
        replayWs.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'native-turn-1', status: 'completed' } },
        }));
        await expect(replayedTurn.completion).resolves.toEqual({ content: [], isError: false });
        expect(replayHandler).toHaveBeenCalledWith({
            type: 'agent_message',
            message: 'Ответ после attach',
            origin: 'live',
        });
        expect(replayHandler).toHaveBeenCalledWith({ type: 'task_complete' });

        await replayClient.disconnect();
    });

    it('replays a reconciled completed turn history before resolving the replayed delivery', async () => {
        const { client, ws } = await connectFakeClient();
        const deliveryId = 'p2p:session-completed-replay:3';
        const handler = vi.fn();
        const beginResolved = vi.fn();
        const completionResolved = vi.fn();
        client.setHandler(handler);

        const startedTurnPromise = client.beginTurn({
            threadId: 'thread-1',
            prompt: 'Телефонный prompt',
            clientUserMessageId: deliveryId,
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
        void startedTurnPromise.then(beginResolved);

        await waitForSent(ws, 3);
        const reconciliationRead = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(reconciliationRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: reconciliationRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'idle' },
                    turns: [{
                        id: 'completed-native-turn-3',
                        status: 'completed',
                        items: [
                            {
                                id: 'native-user-item-3',
                                type: 'userMessage',
                                clientId: deliveryId,
                                content: [{ type: 'text', text: 'Телефонный prompt' }],
                            },
                            {
                                id: 'native-agent-item-3',
                                type: 'agentMessage',
                                text: 'Восстановленный ответ',
                            },
                        ],
                    }],
                },
            },
        }));

        const startedTurn = await startedTurnPromise;
        void startedTurn.completion.then(completionResolved);
        await expect(startedTurn.completion).resolves.toEqual({
            content: [{ type: 'text', text: 'Восстановленный ответ' }],
            isError: false,
        });

        expect(handler).toHaveBeenCalledWith({
            type: 'agent_message',
            message: 'Восстановленный ответ',
            origin: 'replay',
        });
        const agentMessageCall = handler.mock.invocationCallOrder.find((_, index) => (
            handler.mock.calls[index][0].type === 'agent_message'
        ));
        expect(agentMessageCall).toBeLessThan(beginResolved.mock.invocationCallOrder[0]);
        expect(agentMessageCall).toBeLessThan(completionResolved.mock.invocationCallOrder[0]);
        expect(ws.sent.map((payload) => JSON.parse(payload).method)).not.toContain('turn/start');
        expect(ws.sent.map((payload) => JSON.parse(payload).method)).not.toContain('thread/resume');

        await client.disconnect();
    });

    it('reconciles an accepted turn/steer after its RPC response is lost without sending it again', async () => {
        const { client, ws } = await connectFakeClient();
        const deliveryId = 'p2p:session-steer:2';

        const steeredTurn = client.steerTurn({
            threadId: 'thread-1',
            expectedTurnId: 'active-turn-1',
            prompt: 'Уточнение с телефона',
            clientUserMessageId: deliveryId,
        });
        await waitForSent(ws, 3);
        const preflightRead = JSON.parse(ws.sent[2]) as { id: number; method: string };
        expect(preflightRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: preflightRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{ id: 'active-turn-1', status: 'inProgress', items: [] }],
                },
            },
        }));

        await waitForSent(ws, 4);
        const firstSteer = JSON.parse(ws.sent[3]) as {
            method: string;
            params: { clientUserMessageId: string };
        };
        expect(firstSteer).toMatchObject({
            method: 'turn/steer',
            params: { clientUserMessageId: deliveryId },
        });
        ws.close();

        await vi.waitFor(() => {
            expect(FakeWebSocket.instances).toHaveLength(2);
        });
        const reconnectWs = FakeWebSocket.instances[1];
        await initializeFakeWebSocket(reconnectWs);
        await waitForSent(reconnectWs, 3);
        const reconciliationRead = JSON.parse(reconnectWs.sent[2]) as { id: number; method: string };
        expect(reconciliationRead.method).toBe('thread/read');
        reconnectWs.message(JSON.stringify({
            id: reconciliationRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'steered-turn-2',
                        status: 'inProgress',
                        items: [{
                            id: 'native-user-item-2',
                            type: 'userMessage',
                            clientId: deliveryId,
                            content: [{ type: 'text', text: 'Уточнение с телефона' }],
                        }],
                    }],
                },
            },
        }));

        await waitForSent(reconnectWs, 4);
        const attachThread = JSON.parse(reconnectWs.sent[3]) as {
            id: number;
            method: string;
            params: { threadId: string };
        };
        expect(attachThread).toEqual(expect.objectContaining({
            method: 'thread/resume',
            params: { threadId: 'thread-1' },
        }));
        reconnectWs.message(JSON.stringify({
            id: attachThread.id,
            result: { thread: { id: 'thread-1' } },
        }));

        await waitForSent(reconnectWs, 5);
        const attachedThreadRead = JSON.parse(reconnectWs.sent[4]) as { id: number; method: string };
        expect(attachedThreadRead.method).toBe('thread/read');
        reconnectWs.message(JSON.stringify({
            id: attachedThreadRead.id,
            result: {
                thread: {
                    id: 'thread-1',
                    status: { type: 'active', activeFlags: [] },
                    turns: [{
                        id: 'steered-turn-2',
                        status: 'inProgress',
                        items: [{
                            id: 'native-user-item-2',
                            type: 'userMessage',
                            clientId: deliveryId,
                            content: [{ type: 'text', text: 'Уточнение с телефона' }],
                        }],
                    }],
                },
            },
        }));

        await expect(steeredTurn).resolves.toBe('steered-turn-2');
        const steerRequests = FakeWebSocket.instances
            .flatMap((socket) => socket.sent.map((payload) => JSON.parse(payload) as { method?: string }))
            .filter((request) => request.method === 'turn/steer');
        expect(steerRequests).toHaveLength(1);
        expect(reconnectWs.sent.map((payload) => JSON.parse(payload).method)).not.toContain('turn/steer');

        await client.disconnect();
    });

    it('tracks an external terminal turn and keeps a newer active turn after a stale completion', async () => {
        const { client, ws } = await connectFakeClient();
        const threadIds = vi.fn();
        client.setThreadIdChangeHandler(threadIds);

        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'terminal-thread' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-1' } },
        }));

        expect(client.getActiveThreadId()).toBe('terminal-thread');
        expect(client.getActiveTurnId()).toBe('terminal-turn-1');
        expect(threadIds).toHaveBeenLastCalledWith('terminal-thread');

        const firstCompletion = client.waitForTurnCompletion({
            threadId: 'terminal-thread',
            turnId: 'terminal-turn-1',
        });
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-1', status: 'completed' } },
        }));
        await expect(firstCompletion).resolves.toEqual({ content: [], isError: false });
        expect(client.getActiveTurnId()).toBeNull();

        ws.message(JSON.stringify({
            method: 'turn/started',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-2' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-1', status: 'completed' } },
        }));

        expect(client.getActiveTurnId()).toBe('terminal-turn-2');

        const secondCompletion = client.waitForTurnCompletion({
            threadId: 'terminal-thread',
            turnId: 'terminal-turn-2',
        });
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'terminal-thread', turn: { id: 'terminal-turn-2', status: 'completed' } },
        }));
        await expect(secondCompletion).resolves.toEqual({ content: [], isError: false });

        await client.disconnect();
    });

    it('forwards model and effort together in the turn/start payload', async () => {
        const { client, ws } = await connectFakeClient();

        const turn = client.startTurn({
            threadId: 'thread-1',
            prompt: 'Проверь payload',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
            model: 'gpt-5.3-codex-spark',
            effort: 'high',
        });

        await waitForSent(ws, 3);
        const startTurn = JSON.parse(ws.sent[2]) as {
            id: number;
            method: string;
            params: {
                model: string;
                effort: string;
                clientUserMessageId: string;
            };
        };
        expect(startTurn).toMatchObject({
            method: 'turn/start',
            params: {
                model: 'gpt-5.3-codex-spark',
                effort: 'high',
                clientUserMessageId: expect.any(String),
            },
        });

        ws.message(JSON.stringify({ id: startTurn.id, result: { turn: { id: 'turn-1' } } }));
        await vi.waitFor(() => {
            expect(client.getActiveTurnId()).toBe('turn-1');
        });
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        }));

        await expect(turn).resolves.toEqual({ content: [], isError: false });
        await client.disconnect();
    });

    it('steers additional user input into an active turn', async () => {
        const { client, ws } = await connectFakeClient();

        const turnId = client.steerTurn({
            threadId: 'thread-1',
            expectedTurnId: 'turn-1',
            prompt: 'Добавь это в текущую задачу',
        });

        await waitForSent(ws, 3);
        const steerTurn = JSON.parse(ws.sent[2]) as { id: number; method: string; params: any };
        expect(steerTurn.method).toBe('turn/steer');
        expect(steerTurn.params.threadId).toBe('thread-1');
        expect(steerTurn.params.expectedTurnId).toBe('turn-1');
        expect(steerTurn.params.input).toEqual([
            { type: 'text', text: 'Добавь это в текущую задачу', text_elements: [] },
        ]);
        expect(steerTurn.params.clientUserMessageId).toEqual(expect.any(String));

        ws.message(JSON.stringify({ id: steerTurn.id, result: { turnId: 'turn-1' } }));

        await expect(turnId).resolves.toBe('turn-1');
        expect(client.getActiveTurnId()).toBe('turn-1');

        await client.disconnect();
    });

    it('uses distinct client user message ids for started and steered turns', async () => {
        const { client, ws } = await connectFakeClient();

        const startedTurnPromise = client.beginTurn({
            threadId: 'thread-1',
            prompt: 'Начни задачу',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });

        await waitForSent(ws, 3);
        const startTurn = JSON.parse(ws.sent[2]) as {
            id: number;
            params: { clientUserMessageId: string };
        };
        ws.message(JSON.stringify({ id: startTurn.id, result: { turn: { id: 'turn-1' } } }));
        const startedTurn = await startedTurnPromise;

        const steeredTurnPromise = client.steerTurn({
            threadId: 'thread-1',
            expectedTurnId: 'turn-1',
            prompt: 'Уточнение',
        });

        await waitForSent(ws, 4);
        const steerTurn = JSON.parse(ws.sent[3]) as {
            id: number;
            params: { clientUserMessageId: string };
        };
        expect(startTurn.params.clientUserMessageId).not.toBe(steerTurn.params.clientUserMessageId);

        ws.message(JSON.stringify({ id: steerTurn.id, result: { turnId: 'turn-1' } }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        }));

        await expect(steeredTurnPromise).resolves.toBe('turn-1');
        await expect(startedTurn.completion).resolves.toEqual({ content: [], isError: false });

        await client.disconnect();
    });

    it('emits an external user message once across item lifecycle notifications', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);
        const item = {
            id: 'item-native-message',
            type: 'userMessage',
            clientId: 'native-codex-tui',
            content: [{ type: 'text', text: 'Сообщение из native TUI' }],
        };

        ws.message(JSON.stringify({ method: 'item/started', params: { item, turnId: 'turn-1' } }));
        ws.message(JSON.stringify({ method: 'item/completed', params: { item, turnId: 'turn-1' } }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        }));
        ws.message(JSON.stringify({ method: 'item/started', params: { item, turnId: 'turn-1' } }));

        const userMessageEvents = handler.mock.calls.filter(([event]) => event.type === 'user_message');
        expect(userMessageEvents).toHaveLength(1);
        expect(handler).toHaveBeenCalledWith({
            type: 'user_message',
            itemId: 'item-native-message',
            text: 'Сообщение из native TUI',
            content: [{ type: 'text', text: 'Сообщение из native TUI' }],
            clientId: 'native-codex-tui',
            source: 'external',
        });

        await client.disconnect();
    });

    it('does not duplicate a user message when item completion arrives before item start', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);
        const item = {
            id: 'item-completed-first',
            type: 'userMessage',
            clientId: 'native-codex-tui',
            content: [{ type: 'text', text: 'Сначала completed' }],
        };

        ws.message(JSON.stringify({
            method: 'thread/started',
            params: { thread: { id: 'thread-1' } },
        }));
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: { threadId: 'thread-1', turnId: 'turn-1', item },
        }));
        ws.message(JSON.stringify({
            method: 'item/started',
            params: { threadId: 'thread-1', turnId: 'turn-1', item },
        }));

        const userMessageEvents = handler.mock.calls.filter(([event]) => event.type === 'user_message');
        expect(userMessageEvents).toHaveLength(1);
        expect(userMessageEvents[0][0]).toMatchObject({
            itemId: 'item-completed-first',
            source: 'external',
        });

        await client.disconnect();
    });

    it('keeps a started user message deduplicated when its turn completes first', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);
        const item = {
            id: 'item-turn-completed-first',
            type: 'userMessage',
            clientId: 'native-codex-tui',
            content: [{ type: 'text', text: 'Turn завершился раньше item' }],
        };

        ws.message(JSON.stringify({ method: 'item/started', params: { item, turnId: 'turn-1' } }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        }));
        ws.message(JSON.stringify({ method: 'item/completed', params: { item, turnId: 'turn-1' } }));

        const userMessageEvents = handler.mock.calls.filter(([event]) => event.type === 'user_message');
        expect(userMessageEvents).toHaveLength(1);

        await client.disconnect();
    });

    it('classifies messages with a tracked client id as own without comparing text', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);

        const turn = client.startTurn({
            threadId: 'thread-1',
            prompt: 'Одинаковый текст',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });

        await waitForSent(ws, 3);
        const startTurn = JSON.parse(ws.sent[2]) as {
            id: number;
            params: { clientUserMessageId: string };
        };
        ws.message(JSON.stringify({ id: startTurn.id, result: { turn: { id: 'turn-1' } } }));
        await vi.waitFor(() => {
            expect(client.getActiveTurnId()).toBe('turn-1');
        });

        ws.message(JSON.stringify({
            method: 'item/started',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    id: 'item-own-message',
                    type: 'userMessage',
                    clientId: startTurn.params.clientUserMessageId,
                    content: [{ type: 'text', text: 'Одинаковый текст' }],
                },
            },
        }));
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    id: 'item-own-message',
                    type: 'userMessage',
                    clientId: startTurn.params.clientUserMessageId,
                    content: [{ type: 'text', text: 'Одинаковый текст' }],
                },
            },
        }));
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: {
                threadId: 'thread-1',
                turnId: 'turn-1',
                item: {
                    id: 'item-external-message',
                    type: 'userMessage',
                    clientId: 'native-codex-tui',
                    content: [{ type: 'text', text: 'Одинаковый текст' }],
                },
            },
        }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        }));

        await expect(turn).resolves.toEqual({ content: [], isError: false });
        expect(handler).toHaveBeenNthCalledWith(1, {
            type: 'user_message',
            itemId: 'item-own-message',
            text: 'Одинаковый текст',
            content: [{ type: 'text', text: 'Одинаковый текст' }],
            clientId: startTurn.params.clientUserMessageId,
            source: 'own',
        });
        expect(handler).toHaveBeenNthCalledWith(2, {
            type: 'user_message',
            itemId: 'item-external-message',
            text: 'Одинаковый текст',
            content: [{ type: 'text', text: 'Одинаковый текст' }],
            clientId: 'native-codex-tui',
            source: 'external',
        });

        await client.disconnect();
    });

    it('removes a generated client id and drops an unassociated item when the turn request fails', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);

        const turn = client.startTurn({
            threadId: 'thread-1',
            prompt: 'Не должен остаться в tracking',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });

        await waitForSent(ws, 3);
        const startTurn = JSON.parse(ws.sent[2]) as {
            id: number;
            params: { clientUserMessageId: string };
        };
        ws.message(JSON.stringify({
            id: startTurn.id,
            error: { message: 'turn/start failed' },
        }));
        await waitForSent(ws, 4);
        const reconciliationRead = JSON.parse(ws.sent[3]) as { id: number; method: string };
        expect(reconciliationRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: reconciliationRead.id,
            result: { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } },
        }));

        await expect(turn).rejects.toThrow('turn/start failed');
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: {
                turnId: 'turn-1',
                item: {
                    id: 'item-after-request-failure',
                    type: 'userMessage',
                    clientId: startTurn.params.clientUserMessageId,
                    content: [{ type: 'text', text: 'Не stale own message' }],
                },
            },
        }));

        expect(handler).not.toHaveBeenCalled();

        await client.disconnect();
    });

    it('cleans pending own ids on turn completion while preserving late item classification', async () => {
        const { client, ws } = await connectFakeClient();
        const handler = vi.fn();
        client.setHandler(handler);

        const turn = client.startTurn({
            threadId: 'thread-1',
            prompt: 'Сообщение без item notification',
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });

        await waitForSent(ws, 3);
        const startTurn = JSON.parse(ws.sent[2]) as {
            id: number;
            params: { clientUserMessageId: string };
        };
        ws.message(JSON.stringify({ id: startTurn.id, result: { turn: { id: 'turn-1' } } }));
        await vi.waitFor(() => {
            expect(client.getActiveTurnId()).toBe('turn-1');
        });
        expect(getUserMessageTrackingState(client).ownUserMessageIds.size).toBe(1);

        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
        }));
        await expect(turn).resolves.toEqual({ content: [], isError: false });
        expect(getUserMessageTrackingState(client).ownUserMessageIds.size).toBe(0);

        ws.message(JSON.stringify({
            method: 'item/completed',
            params: {
                turnId: 'turn-1',
                item: {
                    id: 'late-own-item',
                    type: 'userMessage',
                    clientId: startTurn.params.clientUserMessageId,
                    content: [{ type: 'text', text: 'Позднее own item' }],
                },
            },
        }));

        expect(handler).toHaveBeenCalledWith(expect.objectContaining({
            type: 'user_message',
            source: 'own',
        }));

        await client.disconnect();
    });

    it('bounds active and recent user message tracking during a long session', async () => {
        const { client, ws } = await connectFakeClient();
        client.setHandler(() => {});
        const messageCount = 600;

        for (let index = 0; index < messageCount; index += 1) {
            ws.message(JSON.stringify({
                method: 'item/completed',
                params: {
                    turnId: `turn-item-${index}`,
                    item: {
                        id: `item-${index}`,
                        type: 'userMessage',
                        clientId: `native-${index}`,
                        content: [{ type: 'text', text: `Сообщение ${index}` }],
                    },
                },
            }));
        }

        const steerRequests = Array.from({ length: messageCount }, (_, index) => client.steerTurn({
            threadId: 'thread-1',
            expectedTurnId: 'turn-1',
            prompt: `Уточнение ${index}`,
        }));
        await waitForSent(ws, messageCount + 2);

        const requests = ws.sent.slice(2).map((payload) => JSON.parse(payload) as { id: number });
        for (const request of requests) {
            ws.message(JSON.stringify({ id: request.id, result: { turnId: 'turn-1' } }));
        }
        await expect(Promise.all(steerRequests)).resolves.toHaveLength(messageCount);

        const tracking = getUserMessageTrackingState(client);
        expect(tracking.activeUserMessageItemIds.size).toBe(0);
        expect(tracking.recentUserMessageItemIds.size).toBeLessThan(messageCount);
        expect(tracking.ownUserMessageIds.size).toBeLessThan(messageCount);
        expect(tracking.recentOwnUserMessageIds.size).toBeLessThan(messageCount);

        await client.disconnect();
    });

    it('fails turn steering when app-server response has no turn id', async () => {
        const { client, ws } = await connectFakeClient();

        const turnId = client.steerTurn({
            threadId: 'thread-1',
            expectedTurnId: 'turn-1',
            prompt: 'Текст',
        });

        await waitForSent(ws, 3);
        const steerTurn = JSON.parse(ws.sent[2]) as { id: number };
        ws.message(JSON.stringify({ id: steerTurn.id, result: {} }));
        await waitForSent(ws, 4);
        const reconciliationRead = JSON.parse(ws.sent[3]) as { id: number; method: string };
        expect(reconciliationRead.method).toBe('thread/read');
        ws.message(JSON.stringify({
            id: reconciliationRead.id,
            result: { thread: { id: 'thread-1', status: { type: 'idle' }, turns: [] } },
        }));

        await expect(turnId).rejects.toThrow('Codex app-server did not return a turn id for turn/steer.');

        await client.disconnect();
    });
});
