import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Client, RequestPermissionRequest, SessionNotification } from '@agentclientprotocol/sdk';
import {
    CursorAcpClient,
    type CursorChild,
    type CursorConnection,
    type CursorPermissionDecision,
} from './cursorAcpClient';

function makeChild() {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child: CursorChild = {
        stdin: new PassThrough(), stdout, stderr,
        kill: vi.fn((signal?: NodeJS.Signals) => {
            if (signal === 'SIGKILL') stdout.emit('end');
            return true;
        }),
        on(event, listener) { childListeners[event].push(listener); return child; },
        once(event, listener) { childListeners[event].push(listener); return child; },
    };
    const childListeners: Record<'error' | 'exit', Array<(...args: unknown[]) => void>> = { error: [], exit: [] };
    return { child, childListeners, stderr };
}

function setup(overrides: Partial<{
    session: { sessionId: string; modes: { availableModes: Array<{ id: string; name: string }>; currentModeId: string }; models: { availableModels: Array<{ modelId: string; name: string }>; currentModelId: string } };
    init: { protocolVersion: number; loadSession: boolean; authMethods: Array<{ id: string }> };
    loadError: Error;
    loadResponse: { modes?: ReturnType<typeof session>['modes']; models?: ReturnType<typeof session>['models'] };
}> = {}) {
    const fake = makeChild();
    const calls: string[] = [];
    let client: Client | undefined;
    let promptResolve: ((value: { stopReason: string }) => void) | undefined;
    const connection: CursorConnection = {
        initialize: vi.fn(async () => ({ protocolVersion: overrides.init?.protocolVersion ?? 1, agentCapabilities: { loadSession: overrides.init?.loadSession ?? true }, authMethods: (overrides.init?.authMethods ?? [{ id: 'cursor_login' }]).map((method) => ({ ...method, name: method.id })) })),
        authenticate: vi.fn(async (params) => { calls.push(`auth:${params.methodId}`); return {}; }),
        newSession: vi.fn(async () => { calls.push('new'); return overrides.session ?? session(); }),
        loadSession: vi.fn(async () => {
            calls.push('load');
            if (overrides.loadError) throw overrides.loadError;
            if (overrides.loadResponse) return overrides.loadResponse;
            const loaded = overrides.session ?? session('loaded');
            const { sessionId: _sessionId, ...state } = loaded;
            return state;
        }),
        setSessionMode: vi.fn(async (params) => { calls.push(`mode:${params.modeId}`); }),
        setSessionModel: vi.fn(async (params) => { calls.push(`model:${params.modelId}`); }),
        prompt: vi.fn(() => new Promise<{ stopReason: string }>((resolve) => { promptResolve = resolve; })),
        cancel: vi.fn(async () => { calls.push('cancel'); promptResolve?.({ stopReason: 'cancelled' }); }),
    };
    const clientFactory = vi.fn((_child: CursorChild, callbacks: Client) => { client = callbacks; return connection; });
    const clientInstance = new CursorAcpClient({
        cwd: '/workspace', mode: 'agent', model: 'cursor-model',
        spawn: vi.fn(() => fake.child), connectionFactory: clientFactory,
        shutdownTimeoutMs: 1,
    });
    return { client: clientInstance, connection, calls, fake, setProtocolClient: (callbacks: Client) => { client = callbacks; }, get protocolClient() { return client!; } };
}

function session(sessionId = 'new-session') {
    return {
        sessionId,
        modes: { availableModes: [{ id: 'agent', name: 'Agent' }, { id: 'plan', name: 'Plan' }, { id: 'ask', name: 'Ask' }], currentModeId: 'agent' },
        models: { availableModels: [{ modelId: 'cursor-model', name: 'Cursor model' }], currentModelId: 'cursor-model' },
    };
}

describe('CursorAcpClient', () => {
    it('initializes protocol 1, authenticates advertised cursor_login, and creates one session', async () => {
        const h = setup();
        await expect(h.client.start()).resolves.toMatchObject({ sessionId: 'new-session' });
        expect(h.calls).toEqual(['auth:cursor_login', 'new', 'mode:agent', 'model:cursor-model']);
        expect(h.connection.newSession).toHaveBeenCalledTimes(1);
        expect(h.connection.loadSession).not.toHaveBeenCalled();
    });

    it('loads without creating a replacement session', async () => {
        const h = setup({ init: { protocolVersion: 1, loadSession: true, authMethods: [] } });
        const client = new CursorAcpClient({ cwd: '/workspace', mode: 'agent', model: 'cursor-model', resumeSessionId: 'parent', spawn: vi.fn(() => h.fake.child), connectionFactory: vi.fn((_child, callbacks) => { h.setProtocolClient(callbacks); return h.connection; }), shutdownTimeoutMs: 1 });
        await expect(client.start()).resolves.toMatchObject({ sessionId: 'parent' });
        expect(h.calls).toContain('load');
        expect(h.calls).not.toContain('new');
    });

    it('fails closed when loading fails', async () => {
        const h = setup({ loadError: new Error('secret prompt should not escape') });
        const client = new CursorAcpClient({ cwd: '/workspace', mode: 'agent', model: 'cursor-model', resumeSessionId: 'parent', spawn: vi.fn(() => h.fake.child), connectionFactory: vi.fn(() => h.connection), shutdownTimeoutMs: 1 });
        await expect(client.start()).rejects.toThrow('Cursor ACP session failed.');
        expect(h.calls).toEqual(['auth:cursor_login', 'load']);
    });

    it('uses the validated requested mode and model when load omits optional capability states', async () => {
        const h = setup({ loadResponse: {} });
        const client = new CursorAcpClient({
            cwd: '/workspace',
            mode: 'plan',
            model: 'cursor-model',
            resumeSessionId: 'parent',
            spawn: vi.fn(() => h.fake.child),
            connectionFactory: vi.fn(() => h.connection),
            shutdownTimeoutMs: 1,
        });
        await expect(client.start()).resolves.toMatchObject({
            sessionId: 'parent',
            modes: { currentModeId: 'plan' },
            models: { currentModelId: 'cursor-model' },
        });
        expect(h.calls).toContain('mode:plan');
        expect(h.calls).toContain('model:cursor-model');
    });

    it('resumes with the provider model unchanged when load omits optional model state', async () => {
        const h = setup({ loadResponse: {} });
        const client = new CursorAcpClient({
            cwd: '/workspace',
            mode: 'agent',
            resumeSessionId: 'parent',
            spawn: vi.fn(() => h.fake.child),
            connectionFactory: vi.fn(() => h.connection),
            shutdownTimeoutMs: 1,
        });

        await expect(client.start()).resolves.toEqual({
            sessionId: 'parent',
            modes: { availableModes: [{ id: 'agent', name: 'Agent' }], currentModeId: 'agent' },
        });
        expect(h.calls).toContain('mode:agent');
        expect(h.connection.setSessionModel).not.toHaveBeenCalled();
        expect(h.calls).not.toContain('new');
    });

    it('bounds ACP control requests and terminates the owned process on timeout', async () => {
        const h = setup();
        h.connection.initialize = vi.fn((): Promise<never> => new Promise<never>(() => undefined));
        const client = new CursorAcpClient({
            cwd: '/workspace',
            spawn: vi.fn(() => h.fake.child),
            connectionFactory: vi.fn(() => h.connection),
            requestTimeoutMs: 5,
            shutdownTimeoutMs: 1,
        });
        await expect(client.start()).rejects.toThrow('Cursor ACP session failed.');
        expect(h.fake.child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it.each([
        ['mode', { session: { ...session(), modes: { ...session().modes, availableModes: [{ id: 'ask', name: 'Ask' }] } } }],
        ['model', { session: { ...session(), models: { ...session().models, availableModels: [{ modelId: 'other-model', name: 'Other model' }] } } }],
    ])('rejects an unavailable requested %s before setters', async (_kind, overrides) => {
        const h = setup(overrides);
        await expect(h.client.start()).rejects.toThrow('Cursor ACP session failed.');
        expect(h.connection.setSessionMode).not.toHaveBeenCalled();
        expect(h.connection.setSessionModel).not.toHaveBeenCalled();
    });

    it('delivers structured updates and serializes prompts', async () => {
        const updates: SessionNotification[] = [];
        const h = setup();
        const client = new CursorAcpClient({ cwd: '/workspace', mode: 'agent', model: 'cursor-model', onSessionUpdate: (update) => { updates.push(update); }, spawn: vi.fn(() => h.fake.child), connectionFactory: vi.fn((_child, callbacks) => { h.setProtocolClient(callbacks); return h.connection; }) });
        await client.start();
        const first = client.prompt('first prompt');
        await expect(client.prompt('second prompt')).rejects.toThrow('already active');
        await h.protocolClient.sessionUpdate!({ sessionId: 'new-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } as SessionNotification);
        h.protocolClient.extNotification?.('cursor/progress', { safe: true });
        h.protocolClient.requestPermission!({ sessionId: 'new-session', toolCall: {} as never, options: [] });
        await client.cancel();
        await expect(first).resolves.toEqual({ stopReason: 'cancelled' });
        expect(updates[0].update.sessionUpdate).toBe('agent_message_chunk');
    });

    it.each<CursorPermissionDecision>(['allow_once', 'allow_always', 'reject_once'])('maps permission decision %s to exact option kind', async (decision) => {
        const h = setup();
        const onPermission = vi.fn(async () => decision);
        const client = new CursorAcpClient({ cwd: '/workspace', mode: 'agent', model: 'cursor-model', onPermission, spawn: vi.fn(() => h.fake.child), connectionFactory: vi.fn((_child, callbacks) => { h.setProtocolClient(callbacks); return h.connection; }) });
        await client.start();
        const request = { sessionId: 'new-session', toolCall: {} as never, options: [{ optionId: `wrong-${decision}`, kind: decision, name: 'visible' }] } as RequestPermissionRequest;
        await expect(h.protocolClient.requestPermission!(request)).resolves.toEqual({ outcome: { outcome: 'selected', optionId: `wrong-${decision}` } });
    });

    it('rejects permission when the requested decision kind is absent', async () => {
        const h = setup();
        const client = new CursorAcpClient({ cwd: '/workspace', mode: 'agent', model: 'cursor-model', onPermission: async () => 'allow_always', spawn: vi.fn(() => h.fake.child), connectionFactory: vi.fn((_child, callbacks) => { h.setProtocolClient(callbacks); return h.connection; }) });
        await client.start();
        await expect(h.protocolClient.requestPermission!({ sessionId: 'new-session', toolCall: {} as never, options: [{ optionId: 'reject', kind: 'reject_once', name: 'reject' }] })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    });

    it('delegates supported Cursor blocking extensions and fails unknown methods closed', async () => {
        const extension = vi.fn(async (method: string) => method === 'cursor/ask_question'
            ? { outcome: { outcome: 'answered', answers: [] } }
            : { outcome: { outcome: 'accepted' } });
        const h = setup();
        const client = new CursorAcpClient({ cwd: '/workspace', mode: 'agent', model: 'cursor-model', onExtension: extension, spawn: vi.fn(() => h.fake.child), connectionFactory: vi.fn((_child, callbacks) => { h.setProtocolClient(callbacks); return h.connection; }) });
        await client.start();
        await expect(h.protocolClient.extMethod!('cursor/ask_question', { toolCallId: 'question' })).resolves.toEqual({ outcome: { outcome: 'answered', answers: [] } });
        await expect(h.protocolClient.extMethod!('cursor/create_plan', { toolCallId: 'plan' })).resolves.toEqual({ outcome: { outcome: 'accepted' } });
        await expect(h.protocolClient.extMethod!('cursor/unknown', { private: true })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
        expect(extension).toHaveBeenCalledTimes(2);
    });

    it('cancels the active prompt and handles child crash without raw details', async () => {
        const errors: Error[] = [];
        const h = setup();
        const client = new CursorAcpClient({ cwd: '/workspace', mode: 'agent', model: 'cursor-model', onError: (error) => errors.push(error), spawn: vi.fn(() => h.fake.child), connectionFactory: vi.fn((_child, callbacks) => { h.setProtocolClient(callbacks); return h.connection; }) });
        await client.start();
        const prompt = client.prompt('do not expose this prompt');
        h.fake.childListeners.exit.forEach((listener) => listener(1, null));
        await expect(prompt).rejects.toThrow('Cursor ACP process exited unexpectedly.');
        expect(errors).toHaveLength(1);
        expect(errors[0].message).not.toContain('do not expose');
    });

    it('disposes with bounded SIGTERM then SIGKILL', async () => {
        const h = setup();
        await h.client.start();
        await h.client.dispose();
        expect(h.fake.child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
        expect(h.fake.child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    });
});
