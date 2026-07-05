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

        ws.message(JSON.stringify({ id: startTurn.id, result: { turn: { id: 'turn-1' } } }));
        ws.message(JSON.stringify({
            method: 'item/completed',
            params: { item: { type: 'agentMessage', text: 'Ответ' } },
        }));
        ws.message(JSON.stringify({
            method: 'turn/completed',
            params: { turn: { id: 'turn-1', status: 'completed' } },
        }));

        await expect(turn).resolves.toEqual({ content: [], isError: false });
        expect(handler).toHaveBeenCalledWith({ type: 'agent_message', message: 'Ответ' });
        expect(handler).toHaveBeenCalledWith({ type: 'task_complete' });

        await client.disconnect();
    });
});
