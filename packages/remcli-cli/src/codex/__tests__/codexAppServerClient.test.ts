import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerClient, codexSandboxToAppServerPolicy } from '../codexAppServerClient';

class FakeWebSocket {
    static instances: FakeWebSocket[] = [];

    readonly sent: string[] = [];
    readyState = 0;
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

async function connectFakeClient(): Promise<{ client: CodexAppServerClient; ws: FakeWebSocket }> {
    FakeWebSocket.instances = [];
    const client = new CodexAppServerClient({
        endpoint: 'ws://127.0.0.1:45123',
        webSocketFactory: (endpoint) => new FakeWebSocket(endpoint),
    });
    const connecting = client.connect();
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('ws://127.0.0.1:45123');
    ws.open();
    await waitForSent(ws, 1);
    const initialize = JSON.parse(ws.sent[0]) as { id: number; method: string };
    expect(initialize.method).toBe('initialize');
    ws.message(JSON.stringify({ id: initialize.id, result: {} }));
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
            params: { item: { type: 'agentMessage', text: 'Ответ' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { turn: { id: 'turn-1', status: 'completed' } },
        }));

        await expect(turn).resolves.toEqual({ content: [], isError: false });
        expect(client.getActiveTurnId()).toBeNull();
        expect(handler).toHaveBeenCalledWith({ type: 'agent_message', message: 'Ответ' });
        expect(handler).toHaveBeenCalledWith({ type: 'task_complete' });

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
            params: { turn: { id: 'turn-1', status: 'completed' } },
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
            params: { turn: { id: 'turn-1', status: 'completed' } },
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
            params: { turn: { id: 'turn-1', status: 'completed' } },
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

        ws.message(JSON.stringify({ method: 'item/completed', params: { item, turnId: 'turn-1' } }));
        ws.message(JSON.stringify({ method: 'item/started', params: { item, turnId: 'turn-1' } }));

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
            params: { turn: { id: 'turn-1', status: 'completed' } },
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
            params: { turn: { id: 'turn-1', status: 'completed' } },
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

    it('removes a generated client id when the turn request fails', async () => {
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

        expect(handler).toHaveBeenCalledWith(expect.objectContaining({
            type: 'user_message',
            source: 'external',
        }));

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
            params: { turn: { id: 'turn-1', status: 'completed' } },
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

        await expect(turnId).rejects.toThrow('Codex app-server did not return a turn id for turn/steer.');

        await client.disconnect();
    });
});
