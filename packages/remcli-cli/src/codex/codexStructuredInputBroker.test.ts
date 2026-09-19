import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentState } from '@/api/types';
import {
    CodexStructuredInputBroker,
    type CodexStructuredInputResponse,
    type CodexStructuredInputResponseResult,
    type CodexStructuredInputSession,
    type CodexStructuredServerRequestContext,
    type CodexStructuredUrlResult,
} from './codexStructuredInputBroker';

type RpcHandler = (request: unknown) => Promise<unknown>;

class FakeSession implements CodexStructuredInputSession {
    state: AgentState = {};
    readonly handlers = new Map<string, RpcHandler>();

    readonly rpcHandlerManager = {
        registerHandler: <TRequest, TResponse>(
            method: string,
            handler: (request: TRequest) => Promise<TResponse>,
        ): void => {
            this.handlers.set(method, handler as unknown as RpcHandler);
        },
    };

    updateAgentState(handler: (state: AgentState) => AgentState): void {
        this.state = handler(this.state);
    }

    async respond(response: CodexStructuredInputResponse): Promise<CodexStructuredInputResponseResult> {
        const handler = this.handlers.get('codex-structured-input-response');
        if (!handler) throw new Error('structured response handler was not registered');
        return handler(response) as Promise<CodexStructuredInputResponseResult>;
    }

    async getStructuredUrl(requestKey: string): Promise<CodexStructuredUrlResult> {
        const handler = this.handlers.get('codex-structured-input-url');
        if (!handler) throw new Error('structured URL handler was not registered');
        return handler({ requestKey }) as Promise<CodexStructuredUrlResult>;
    }
}

function createContext(
    method: CodexStructuredServerRequestContext['method'],
    nativeRequestId: string | number,
    params: Record<string, unknown>,
    responses: Array<{ nativeRequestId: string | number; result: unknown; generation: number }>,
    options: { generation?: number; current?: boolean } = {},
): CodexStructuredServerRequestContext {
    return {
        method,
        nativeRequestId,
        params,
        transportGeneration: options.generation ?? 1,
        isCurrentScope: () => options.current ?? true,
        respond: (id, result, generation) => {
            responses.push({ nativeRequestId: id, result, generation });
            return true;
        },
    };
}

function toolParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        threadId: 'thread-1',
        turnId: 'turn-1',
        itemId: 'item-1',
        isBlocking: true,
        questions: [
            {
                id: 'free',
                header: 'Free answer',
                question: 'Enter a value',
                isOther: false,
                isSecret: true,
                options: null,
            },
            {
                id: 'choice',
                header: 'Choice',
                question: 'Pick one',
                isOther: true,
                isSecret: false,
                options: [
                    { label: 'one', description: 'First' },
                    { label: 'two', description: 'Second' },
                    { label: 'three', description: 'Third' },
                    { label: 'four', description: 'Fourth' },
                ],
            },
        ],
        ...overrides,
    };
}

function urlParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        threadId: 'thread-1',
        turnId: 'turn-1',
        serverName: 'example',
        mode: 'url',
        message: 'Open the authorization page',
        url: 'https://example.com/authorize?token=private-query#private-fragment',
        elicitationId: 'elicitation-1',
        ...overrides,
    };
}

describe('CodexStructuredInputBroker', () => {
    afterEach(() => {
        vi.clearAllTimers();
        vi.useRealTimers();
    });

    it('normalizes requestUserInput fields and submits string answers by question id', async () => {
        const session = new FakeSession();
        const responses: Array<{ nativeRequestId: string | number; result: unknown; generation: number }> = [];
        const broker = new CodexStructuredInputBroker(session);

        broker.handleServerRequest(createContext(
            'item/tool/requestUserInput',
            41,
            toolParams(),
            responses,
        ));

        const state = session.state.codexStructuredRequests;
        expect(state).toBeDefined();
        const request = Object.values(state ?? {})[0];
        expect(request).toMatchObject({
            kind: 'tool-input',
            isBlocking: true,
            fields: [
                {
                    id: 'free',
                    type: 'text',
                    label: 'Free answer',
                    description: 'Enter a value',
                    required: true,
                    isSecret: true,
                },
                {
                    id: 'choice',
                    type: 'select',
                    allowOther: true,
                    options: [
                        { value: 'one', label: 'one', description: 'First' },
                        { value: 'two', label: 'two', description: 'Second' },
                        { value: 'three', label: 'three', description: 'Third' },
                        { value: 'four', label: 'four', description: 'Fourth' },
                    ],
                },
            ],
        });
        expect(JSON.stringify(session.state)).not.toContain('private-secret');
        expect(request).not.toHaveProperty('nativeRequestId');

        const result = await session.respond({
            requestKey: request.requestKey,
            submissionId: 'submission-1',
            action: 'submit',
            answers: {
                free: ['private-secret'],
                choice: ['custom answer'],
            },
        });

        expect(result).toEqual({ status: 'submitted' });
        expect(responses).toEqual([{
            nativeRequestId: 41,
            generation: 1,
            result: {
                answers: {
                    free: { answers: ['private-secret'] },
                    choice: { answers: ['custom answer'] },
                },
            },
        }]);
        expect(session.state.codexStructuredRequests).toBeUndefined();
        expect(await session.respond({
            requestKey: request.requestKey,
            submissionId: 'duplicate',
            action: 'cancel',
        })).toEqual({ status: 'already-resolved' });
    });

    it('normalizes mixed MCP form fields and returns typed content', async () => {
        const session = new FakeSession();
        const responses: Array<{ nativeRequestId: string | number; result: unknown; generation: number }> = [];
        const broker = new CodexStructuredInputBroker(session);
        broker.handleServerRequest(createContext(
            'mcpServer/elicitation/request',
            'mcp-1',
            {
                threadId: 'thread-1',
                turnId: 'turn-1',
                serverName: 'example',
                mode: 'form',
                message: 'Complete the form',
                requestedSchema: {
                    type: 'object',
                    required: ['text', 'number', 'integer', 'select', 'multi'],
                    properties: {
                        text: { type: 'string', title: 'Text', minLength: 2, maxLength: 10 },
                        number: { type: 'number', minimum: 1, maximum: 3 },
                        integer: { type: 'integer', minimum: 1, maximum: 3 },
                        flag: { type: 'boolean', default: true },
                        select: { type: 'string', enum: ['a', 'b'], enumNames: ['A', 'B'] },
                        multi: {
                            type: 'array',
                            minItems: 1,
                            maxItems: 4,
                            items: {
                                anyOf: [
                                    { const: 'x', title: 'X' },
                                    { const: 'y', title: 'Y' },
                                    { const: 'z', title: 'Z' },
                                    { const: 'w', title: 'W' },
                                ],
                            },
                        },
                        emptyMulti: {
                            type: 'array',
                            items: { anyOf: [{ const: 'x', title: 'X' }] },
                        },
                    },
                },
            },
            responses,
        ));

        const request = Object.values(session.state.codexStructuredRequests ?? {})[0];
        expect(request).toMatchObject({
            kind: 'mcp-form',
            serverName: 'example',
            fields: [
                { id: 'text', type: 'text', minLength: 2, maxLength: 10 },
                { id: 'number', type: 'number', minimum: 1, maximum: 3 },
                { id: 'integer', type: 'integer', minimum: 1, maximum: 3 },
                { id: 'flag', type: 'boolean', defaultValue: true },
                {
                    id: 'select',
                    type: 'select',
                    options: [
                        { value: 'a', label: 'A' },
                        { value: 'b', label: 'B' },
                    ],
                },
                { id: 'multi', type: 'multiselect', maxItems: 4 },
                { id: 'emptyMulti', type: 'multiselect' },
            ],
        });

        await session.respond({
            requestKey: request.requestKey,
            submissionId: 'submission-2',
            action: 'submit',
            answers: {
                text: ['hello'],
                number: ['2.5'],
                integer: ['2'],
                select: ['b'],
                multi: ['x', 'z'],
                emptyMulti: [],
            },
        });

        expect(responses[0]).toEqual({
            nativeRequestId: 'mcp-1',
            generation: 1,
            result: {
                action: 'accept',
                content: {
                    text: 'hello',
                    number: 2.5,
                    integer: 2,
                    flag: true,
                    select: 'b',
                    multi: ['x', 'z'],
                    emptyMulti: [],
                },
                _meta: null,
            },
        });
        expect(JSON.stringify(session.state)).not.toContain('hello');
    });

    it('publishes and validates MCP string formats without changing text field types', async () => {
        const session = new FakeSession();
        const responses: Array<{ nativeRequestId: string | number; result: unknown; generation: number }> = [];
        const broker = new CodexStructuredInputBroker(session);
        broker.handleServerRequest(createContext(
            'mcpServer/elicitation/request',
            'formatted-form',
            {
                threadId: 'thread-1',
                turnId: 'turn-1',
                serverName: 'example',
                mode: 'form',
                message: 'Formatted values',
                requestedSchema: {
                    type: 'object',
                    required: ['email', 'uri', 'date', 'timestamp'],
                    properties: {
                        email: { type: 'string', format: 'email' },
                        uri: { type: 'string', format: 'uri' },
                        date: { type: 'string', format: 'date' },
                        timestamp: { type: 'string', format: 'date-time' },
                    },
                },
            },
            responses,
        ));

        const request = Object.values(session.state.codexStructuredRequests ?? {})[0];
        expect(request.fields).toEqual([
            expect.objectContaining({ id: 'email', type: 'text', format: 'email' }),
            expect.objectContaining({ id: 'uri', type: 'text', format: 'uri' }),
            expect.objectContaining({ id: 'date', type: 'text', format: 'date' }),
            expect.objectContaining({ id: 'timestamp', type: 'text', format: 'date-time' }),
        ]);

        await expect(session.respond({
            requestKey: request.requestKey,
            submissionId: 'invalid-format',
            action: 'submit',
            content: {
                email: 'not-an-email',
                uri: 'https://example.com/value',
                date: '2026-02-30',
                timestamp: '2026-09-19T12:00:00Z',
            },
        })).rejects.toThrow('Invalid structured input response.');
        expect(responses).toEqual([]);

        await expect(session.respond({
            requestKey: request.requestKey,
            submissionId: 'valid-format',
            action: 'submit',
            content: {
                email: 'user@example.com',
                uri: 'https://example.com/value?kept=provider-content',
                date: '2026-09-19',
                timestamp: '2026-09-19T12:00:00+05:00',
            },
        })).resolves.toEqual({ status: 'submitted' });
        expect(responses[0]).toMatchObject({
            nativeRequestId: 'formatted-form',
            result: { action: 'accept' },
        });
    });

    it('rejects unsupported, invalid, oversized, and unsafe URL requests fail-closed', () => {
        const session = new FakeSession();
        const warnings: string[] = [];
        const responses: Array<{ nativeRequestId: string | number; result: unknown; generation: number }> = [];
        const broker = new CodexStructuredInputBroker(session, { onWarning: (message) => warnings.push(message) });

        broker.handleServerRequest(createContext(
            'mcpServer/elicitation/request',
            1,
            {
                threadId: 'thread-1',
                turnId: 'turn-1',
                serverName: 'example',
                mode: 'openai/form',
                message: 'unsupported',
                requestedSchema: { type: 'object', properties: {} },
            },
            responses,
        ));
        broker.handleServerRequest(createContext(
            'mcpServer/elicitation/request',
            2,
            {
                threadId: 'thread-1',
                turnId: 'turn-1',
                serverName: 'example',
                mode: 'unknown',
                message: 'unsupported',
            },
            responses,
        ));
        broker.handleServerRequest(createContext(
            'mcpServer/elicitation/request',
            3,
            {
                threadId: 'thread-1',
                turnId: 'turn-1',
                serverName: 'example',
                mode: 'url',
                message: 'unsafe',
                url: 'https://user:password@example.com/form',
                elicitationId: 'elicitation-1',
            },
            responses,
        ));
        broker.handleServerRequest(createContext(
            'mcpServer/elicitation/request',
            4,
            {
                threadId: 'thread-1',
                turnId: 'turn-1',
                serverName: 'example',
                mode: 'form',
                message: 'too many fields',
                requestedSchema: {
                    type: 'object',
                    properties: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [
                        `field-${index}`,
                        { type: 'string' },
                    ])),
                },
            },
            responses,
        ));
        broker.handleServerRequest(createContext(
            'mcpServer/elicitation/request',
            5,
            {
                threadId: 'thread-1',
                turnId: 'turn-1',
                mode: 'form',
                message: 'missing server name',
                requestedSchema: { type: 'object', properties: {} },
            },
            responses,
        ));
        broker.handleServerRequest(createContext(
            'mcpServer/elicitation/request',
            6,
            {
                threadId: 'thread-1',
                turnId: 'turn-1',
                serverName: 'example',
                mode: 'form',
                message: 'unknown format',
                requestedSchema: {
                    type: 'object',
                    properties: { value: { type: 'string', format: 'hostname' } },
                },
            },
            responses,
        ));
        broker.handleServerRequest(createContext(
            'mcpServer/elicitation/request',
            7,
            {
                threadId: 'thread-1',
                turnId: 'turn-1',
                serverName: 'example',
                mode: 'form',
                message: 'invalid formatted default',
                requestedSchema: {
                    type: 'object',
                    properties: { value: { type: 'string', format: 'date', default: '2026-02-30' } },
                },
            },
            responses,
        ));

        expect(session.state.codexStructuredRequests).toBeUndefined();
        expect(responses).toEqual([
            { nativeRequestId: 1, generation: 1, result: { action: 'cancel', content: null, _meta: null } },
            { nativeRequestId: 2, generation: 1, result: { action: 'cancel', content: null, _meta: null } },
            { nativeRequestId: 3, generation: 1, result: { action: 'cancel', content: null, _meta: null } },
            { nativeRequestId: 4, generation: 1, result: { action: 'cancel', content: null, _meta: null } },
            { nativeRequestId: 5, generation: 1, result: { action: 'cancel', content: null, _meta: null } },
            { nativeRequestId: 6, generation: 1, result: { action: 'cancel', content: null, _meta: null } },
            { nativeRequestId: 7, generation: 1, result: { action: 'cancel', content: null, _meta: null } },
        ]);
        expect(warnings).toHaveLength(7);
    });

    it('keeps exact scope and generation, resolves races idempotently, and cleans up on timeout', async () => {
        vi.useFakeTimers();
        let now = 10_000;
        const session = new FakeSession();
        const warnings: string[] = [];
        const responses: Array<{ nativeRequestId: string | number; result: unknown; generation: number }> = [];
        const broker = new CodexStructuredInputBroker(session, {
            timeoutMs: 100,
            now: () => now,
            onWarning: (message) => warnings.push(message),
        });

        broker.handleServerRequest(createContext(
            'item/tool/requestUserInput',
            7,
            toolParams({ autoResolutionMs: 100 }),
            responses,
            { generation: 3 },
        ));
        const request = Object.values(session.state.codexStructuredRequests ?? {})[0];

        broker.handleServerRequestResolved({
            threadId: 'foreign-thread',
            nativeRequestId: 7,
            transportGeneration: 3,
        });
        broker.handleServerRequestResolved({
            threadId: 'thread-1',
            nativeRequestId: 7,
            transportGeneration: 2,
        });
        broker.handleServerRequestResolved({
            threadId: 'thread-1',
            nativeRequestId: '7',
            transportGeneration: 3,
        });
        expect(session.state.codexStructuredRequests?.[request.requestKey]).toBeDefined();

        broker.handleServerRequestResolved({
            threadId: 'thread-1',
            nativeRequestId: 7,
            transportGeneration: 3,
        });
        expect(session.state.codexStructuredRequests).toBeUndefined();
        expect(await session.respond({
            requestKey: request.requestKey,
            submissionId: 'late',
            action: 'cancel',
        })).toEqual({ status: 'already-resolved' });

        broker.handleServerRequest(createContext(
            'item/tool/requestUserInput',
            8,
            toolParams({ autoResolutionMs: 100 }),
            responses,
            { generation: 4, current: false },
        ));
        expect(responses.at(-1)).toEqual({
            nativeRequestId: 8,
            generation: 4,
            result: { answers: {} },
        });

        broker.handleServerRequest(createContext(
            'item/tool/requestUserInput',
            9,
            toolParams({ autoResolutionMs: 100 }),
            responses,
            { generation: 5 },
        ));
        now += 100;
        vi.advanceTimersByTime(100);
        expect(session.state.codexStructuredRequests).toBeUndefined();
        expect(responses.at(-1)).toEqual({
            nativeRequestId: 9,
            generation: 5,
            result: { answers: {} },
        });
        expect(warnings).toContain('Codex structured input timed out and was canceled.');
    });

    it('keeps raw MCP URLs private, rebinds URL access by session epoch, and preserves native ids', async () => {
        const firstSession = new FakeSession();
        const secondSession = new FakeSession();
        const responses: Array<{ nativeRequestId: string | number; result: unknown; generation: number }> = [];
        const broker = new CodexStructuredInputBroker(firstSession);

        const registration = broker.registerMcpUrlRequest(createContext(
            'mcpServer/elicitation/request',
            'pending-1',
            urlParams({
                message: 'Open https://example.com/authorize?token=private-query#private-fragment',
            }),
            responses,
            { generation: 11 },
        ));
        expect(registration).not.toBeNull();
        const request = Object.values(firstSession.state.codexStructuredRequests ?? {})[0];
        expect(request).toMatchObject({
            kind: 'mcp-url',
            displayUrl: 'https://example.com/authorize',
        });
        expect(JSON.stringify(firstSession.state)).not.toContain('private-query');
        expect(JSON.stringify(firstSession.state)).not.toContain('private-fragment');
        expect(JSON.stringify(registration?.permissionInput)).not.toContain('private-query');
        expect(await firstSession.getStructuredUrl(request.requestKey)).toEqual({
            url: 'https://example.com/authorize?token=private-query#private-fragment',
        });

        broker.updateSession(secondSession);
        expect(secondSession.state.codexStructuredRequests).toEqual({ [request.requestKey]: request });
        expect(secondSession.handlers.has('codex-structured-input-response')).toBe(true);
        expect(secondSession.handlers.has('codex-structured-input-url')).toBe(true);
        await expect(firstSession.getStructuredUrl(request.requestKey)).rejects.toThrow('Structured URL is not available.');
        await expect(secondSession.getStructuredUrl(request.requestKey)).resolves.toEqual({
            url: 'https://example.com/authorize?token=private-query#private-fragment',
        });
        await expect(firstSession.respond({
            requestKey: request.requestKey,
            submissionId: 'stale-session',
            action: 'cancel',
        })).resolves.toEqual({ status: 'already-resolved' });

        broker.clearForTransport(10);
        expect(secondSession.state.codexStructuredRequests).toBeDefined();
        expect(broker.resolveMcpUrlPermission(request.requestKey, 'approved_for_session')).toEqual({ status: 'submitted' });
        expect(secondSession.state.codexStructuredRequests).toBeUndefined();
        expect(responses).toEqual([{
            nativeRequestId: 'pending-1',
            generation: 11,
            result: { action: 'accept', content: null, _meta: null },
        }]);
        await expect(secondSession.getStructuredUrl(request.requestKey)).rejects.toThrow('Structured URL is not available.');
    });

    it.each([
        ['submit', 'accept'],
        ['decline', 'decline'],
        ['cancel', 'cancel'],
    ] as const)('submits MCP URL action %s through the typed response RPC', async (action, nativeAction) => {
        const session = new FakeSession();
        const responses: Array<{ nativeRequestId: string | number; result: unknown; generation: number }> = [];
        const cancelPermissionWaiter = vi.fn();
        const broker = new CodexStructuredInputBroker(session);
        broker.setPermissionWaiterCancelSink(cancelPermissionWaiter);
        broker.registerMcpUrlRequest(createContext(
            'mcpServer/elicitation/request',
            77,
            urlParams(),
            responses,
            { generation: 14 },
        ));
        const request = Object.values(session.state.codexStructuredRequests ?? {})[0];

        const result = await session.respond({
            requestKey: request.requestKey,
            submissionId: `url-${action}`,
            action,
        });

        expect(result).toEqual({ status: 'submitted' });
        expect(cancelPermissionWaiter).toHaveBeenCalledOnce();
        expect(cancelPermissionWaiter).toHaveBeenCalledWith(request.requestKey);
        expect(responses).toEqual([{
            nativeRequestId: 77,
            generation: 14,
            result: { action: nativeAction, content: null, _meta: null },
        }]);
        await expect(session.respond({
            requestKey: request.requestKey,
            submissionId: `stale-${action}`,
            action,
        })).resolves.toEqual({ status: 'already-resolved' });
        expect(responses).toHaveLength(1);
    });

    it('rejects answers and content for MCP URL responses', async () => {
        const session = new FakeSession();
        const responses: Array<{ nativeRequestId: string | number; result: unknown; generation: number }> = [];
        const broker = new CodexStructuredInputBroker(session);
        broker.registerMcpUrlRequest(createContext(
            'mcpServer/elicitation/request',
            'url-with-content',
            urlParams(),
            responses,
        ));
        const request = Object.values(session.state.codexStructuredRequests ?? {})[0];

        await expect(session.respond({
            requestKey: request.requestKey,
            submissionId: 'invalid-url-content',
            action: 'submit',
            content: {},
        })).rejects.toThrow('Invalid structured input response.');
        expect(session.state.codexStructuredRequests?.[request.requestKey]).toBeDefined();
        expect(responses).toEqual([]);
        broker.clearAll();
    });

    it('clears provider and runner lifecycle requests with fail-closed native responses where possible', () => {
        const session = new FakeSession();
        const responses: Array<{ nativeRequestId: string | number; result: unknown; generation: number }> = [];
        const broker = new CodexStructuredInputBroker(session);

        const disconnected = broker.registerMcpUrlRequest(createContext(
            'mcpServer/elicitation/request',
            'pending-2',
            urlParams({ elicitationId: 'elicitation-2' }),
            responses,
            { generation: 12 },
        ));
        expect(disconnected).not.toBeNull();
        broker.clearForTransport(12);
        expect(session.state.codexStructuredRequests).toBeUndefined();
        expect(responses).toEqual([]);

        broker.handleServerRequest(createContext(
            'item/tool/requestUserInput',
            44,
            toolParams(),
            responses,
            { generation: 13 },
        ));
        broker.clearForTurn('thread-1', 'turn-1', 'turn-interrupted');
        expect(responses.at(-1)).toEqual({ nativeRequestId: 44, generation: 13, result: { answers: {} } });

        broker.registerMcpUrlRequest(createContext(
            'mcpServer/elicitation/request',
            45,
            urlParams({ elicitationId: 'elicitation-3' }),
            responses,
            { generation: 14 },
        ));
        broker.clearAll('session-cleanup');
        expect(responses.at(-1)).toEqual({
            nativeRequestId: 45,
            generation: 14,
            result: { action: 'cancel', content: null, _meta: null },
        });
    });
});
