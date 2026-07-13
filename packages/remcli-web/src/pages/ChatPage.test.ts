import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@/lib/protocol/messages';
import { mergeMessages } from '@/lib/protocol/store';
import type { Session } from '@/lib/protocol/types';

let buildFeed: typeof import('@/pages/ChatPage').buildFeed;
let agentSessionIdOf: typeof import('@/pages/ChatPage').agentSessionIdOf;
let createMessageLoadQueue: typeof import('@/pages/ChatPage').createMessageLoadQueue;
let getMessageLoadScope: typeof import('@/pages/ChatPage').getMessageLoadScope;
let mergeMessagePagination: typeof import('@/pages/ChatPage').mergeMessagePagination;
let parseNavState: typeof import('@/pages/ChatPage').parseNavState;

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

beforeAll(async () => {
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
    });
    vi.stubGlobal('navigator', {
        language: 'en-US',
        languages: ['en-US'],
    });

    const pageModule = await import('@/pages/ChatPage');
    buildFeed = pageModule.buildFeed;
    agentSessionIdOf = pageModule.agentSessionIdOf;
    createMessageLoadQueue = pageModule.createMessageLoadQueue;
    getMessageLoadScope = pageModule.getMessageLoadScope;
    mergeMessagePagination = pageModule.mergeMessagePagination;
    parseNavState = pageModule.parseNavState;
});

afterAll(() => {
    vi.unstubAllGlobals();
});

describe('ChatPage feed mapping', () => {
    it('keeps reconnect merge identity-stable at the pagination boundary', () => {
        const existing: NormalizedMessage[] = [
            {
                id: 'server-1',
                localId: null,
                seq: 1,
                createdAt: 1000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'Initial prompt' }
            },
            {
                id: 'local-2',
                localId: 'local-2',
                seq: null,
                createdAt: 2000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'Optimistic prompt' }
            }
        ];
        const refreshed: NormalizedMessage[] = [
            {
                id: 'server-1',
                localId: null,
                seq: 1,
                createdAt: 1000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'Initial prompt' }
            },
            {
                id: 'server-2',
                localId: 'local-2',
                seq: 2,
                createdAt: 2000,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'Optimistic prompt' }
            }
        ];

        const merged = mergeMessages(existing, refreshed);

        expect(merged.map((message) => message.id)).toEqual(['server-1', 'server-2']);
        const initialPagination = mergeMessagePagination(
            { offset: 0, total: 0, hasMore: false },
            { total: 3, nextOffset: 2 },
            'initial'
        );
        expect(initialPagination).toEqual({ offset: 2, total: 3, hasMore: true });
        expect(mergeMessagePagination(
            { offset: 0, total: 0, hasMore: false },
            { total: 3, nextOffset: 2 },
            'refresh'
        )).toEqual({ offset: 2, total: 3, hasMore: true });

        const withOlderHistory = mergeMessages(merged, [{
            id: 'server-0',
            localId: null,
            seq: 0,
            createdAt: 500,
            isSidechain: false,
            role: 'user',
            content: { type: 'text', text: 'Earlier prompt' }
        }]);

        expect(withOlderHistory.map((message) => message.id)).toEqual(['server-0', 'server-1', 'server-2']);
        expect(mergeMessagePagination(initialPagination, { total: 3, nextOffset: 3 }, 'older'))
            .toEqual({ offset: 3, total: 3, hasMore: false });
    });

    it('keeps the pending raw cursor at the reconnect page boundary when more than one page arrived offline', () => {
        const initialTotal = 20;
        const reconnectedTotal = initialTotal + 151;
        const rawRecords = Array.from(
            { length: reconnectedTotal },
            (_, index) => `raw-${reconnectedTotal - index}`,
        );
        const loadedRecords = new Set(rawRecords.slice(-initialTotal));
        const requestedOffsets: number[] = [];
        const fetchPage = (offset: number) => {
            requestedOffsets.push(offset);
            const records = rawRecords.slice(offset, offset + 150);
            for (const record of records) loadedRecords.add(record);
            return {
                total: reconnectedTotal,
                nextOffset: offset + records.length,
            };
        };

        const reconnectPage = fetchPage(0);
        const afterReconnect = mergeMessagePagination(
            { offset: initialTotal, total: initialTotal, hasMore: false },
            reconnectPage,
            'refresh',
        );

        expect(afterReconnect).toEqual({ offset: 150, total: reconnectedTotal, hasMore: true });

        const olderPage = fetchPage(afterReconnect.offset);
        const afterOlderPage = mergeMessagePagination(afterReconnect, olderPage, 'older');

        expect(requestedOffsets).toEqual([0, 150]);
        expect(afterOlderPage).toEqual({
            offset: reconnectedTotal,
            total: reconnectedTotal,
            hasMore: false,
        });
        expect([...loadedRecords].sort()).toEqual([...rawRecords].sort());
    });

    it('waits for older-history scroll restoration before a reconnect refresh starts', async () => {
        const queue = createMessageLoadQueue();
        const olderPageLoaded = createDeferred<void>();
        const scrollRestored = createDeferred<void>();
        const events: string[] = [];
        const refresh = vi.fn(async () => {
            events.push('refresh:start');
        });

        const olderRequest = queue.enqueue(async () => {
            events.push('older:start');
            await olderPageLoaded.promise;
            events.push('older:page-loaded');
            await scrollRestored.promise;
            events.push('older:scroll-restored');
        });
        const reconnectRefresh = queue.enqueueReconnect(refresh);

        await flushPromises();
        expect(events).toEqual(['older:start']);
        expect(refresh).not.toHaveBeenCalled();

        olderPageLoaded.resolve();
        await flushPromises();
        expect(events).toEqual(['older:start', 'older:page-loaded']);
        expect(refresh).not.toHaveBeenCalled();

        scrollRestored.resolve();
        await Promise.all([olderRequest, reconnectRefresh]);
        expect(events).toEqual(['older:start', 'older:page-loaded', 'older:scroll-restored', 'refresh:start']);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('coalesces a reconnect burst while the current refresh is in flight', async () => {
        const queue = createMessageLoadQueue();
        const refreshCompleted = createDeferred<void>();
        const refresh = vi.fn(async () => {
            await refreshCompleted.promise;
        });

        const firstRefresh = queue.enqueueReconnect(refresh);
        await flushPromises();
        const secondRefresh = queue.enqueueReconnect(refresh);

        expect(secondRefresh).toBe(firstRefresh);
        expect(refresh).toHaveBeenCalledTimes(1);

        refreshCompleted.resolve();
        await Promise.all([firstRefresh, secondRefresh]);
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it('starts session B loads without waiting for a hanging older-history request from session A', async () => {
        const olderRequestCompleted = createDeferred<void>();
        const initialBCompleted = createDeferred<void>();
        const olderA = vi.fn(async () => {
            await olderRequestCompleted.promise;
        });
        const initialB = vi.fn(async () => {
            await initialBCompleted.promise;
        });
        const reconnectB = vi.fn(async () => undefined);

        const scopeA = getMessageLoadScope(null, 'session-a');
        const olderARequest = scopeA.queue.enqueue(olderA);
        await flushPromises();
        expect(olderA).toHaveBeenCalledTimes(1);

        const scopeB = getMessageLoadScope(scopeA, 'session-b');
        const initialBRequest = scopeB.queue.enqueue(initialB);
        const reconnectBRequest = scopeB.queue.enqueueReconnect(reconnectB);
        await flushPromises();

        expect(scopeB.generation).toBe(scopeA.generation + 1);
        expect(initialB).toHaveBeenCalledTimes(1);
        expect(reconnectB).not.toHaveBeenCalled();

        initialBCompleted.resolve();
        await Promise.all([initialBRequest, reconnectBRequest]);
        expect(reconnectB).toHaveBeenCalledTimes(1);

        olderRequestCompleted.resolve();
        await olderARequest;
    });

    it('keeps absent model override distinct from explicit model reset', () => {
        expect(parseNavState({ permissionMode: 'workspace-write' })).toEqual({
            permissionMode: 'workspace-write',
            model: undefined,
            hasModelOverride: false,
        });

        expect(parseNavState({ permissionMode: 'workspace-write', model: null })).toEqual({
            permissionMode: 'workspace-write',
            model: null,
            hasModelOverride: true,
        });

        expect(parseNavState({ permissionMode: 'workspace-write', model: 'gpt-5.6-luna' })).toEqual({
            permissionMode: 'workspace-write',
            model: 'gpt-5.6-luna',
            hasModelOverride: true,
        });
    });

    it('uses native agent session ids for resume instead of the remcli session id', () => {
        const baseSession = {
            id: 'remcli-session-id',
            metadata: {
                agentSessionId: 'agent-session-id',
                codexSessionId: 'codex-thread-id',
                claudeSessionId: 'claude-session-id',
                geminiSessionId: 'gemini-session-id',
                cursorSessionId: 'cursor-session-id',
            },
        } as Session;

        expect(agentSessionIdOf(baseSession, 'codex')).toBe('codex-thread-id');
        expect(agentSessionIdOf(baseSession, 'claude')).toBe('claude-session-id');
        expect(agentSessionIdOf(baseSession, 'gemini')).toBe('gemini-session-id');
        expect(agentSessionIdOf(baseSession, 'cursor')).toBe('cursor-session-id');
    });

    it('falls back to generic agentSessionId when provider-specific resume id is absent', () => {
        const session = {
            id: 'remcli-session-id',
            metadata: {
                agentSessionId: 'native-agent-session-id',
            },
        } as Session;

        expect(agentSessionIdOf(session, 'codex')).toBe('native-agent-session-id');
        expect(agentSessionIdOf(session, 'claude')).toBe('native-agent-session-id');
        expect(agentSessionIdOf(session, 'gemini')).toBe('native-agent-session-id');
        expect(agentSessionIdOf(session, 'cursor')).toBe('native-agent-session-id');
    });

    it('renders agent error events as visible error feed groups', () => {
        const messages: NormalizedMessage[] = [{
            id: 'event-1',
            localId: null,
            seq: 1,
            createdAt: 1000,
            isSidechain: false,
            role: 'event',
            content: {
                type: 'message',
                message: 'The selected model is not supported.',
                isError: true
            }
        }];

        const feed = buildFeed(messages, 'codex');

        expect(feed).toHaveLength(1);
        expect(feed[0]).toMatchObject({
            kind: 'agent-group',
            tone: 'error',
            texts: ['The selected model is not supported.']
        });
    });

    it('does not attach tool calls after an error event to the previous agent group', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'agent-1',
                localId: null,
                seq: 1,
                createdAt: 1000,
                isSidechain: false,
                role: 'agent',
                content: [{
                    type: 'text',
                    text: 'Before error',
                    uuid: 'agent-1',
                    parentUUID: null
                }]
            },
            {
                id: 'event-1',
                localId: null,
                seq: 2,
                createdAt: 2000,
                isSidechain: false,
                role: 'event',
                content: {
                    type: 'message',
                    message: 'Model is not supported.',
                    isError: true
                }
            },
            {
                id: 'agent-2',
                localId: null,
                seq: 3,
                createdAt: 3000,
                isSidechain: false,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'tool-1',
                    name: 'Bash',
                    input: { command: 'npm test' },
                    description: null,
                    uuid: 'agent-2',
                    parentUUID: null
                }]
            }
        ];

        const feed = buildFeed(messages, 'codex');

        expect(feed).toHaveLength(3);
        expect(feed[0]).toMatchObject({ kind: 'agent-group', texts: ['Before error'], items: [] });
        expect(feed[1]).toMatchObject({ kind: 'agent-group', tone: 'error', texts: ['Model is not supported.'], items: [] });
        expect(feed[2]).toMatchObject({
            kind: 'agent-group',
            texts: [],
            items: [{ kind: 'tool', id: 'agent-2:tool-1', tool: 'Bash' }]
        });
    });

    it('closes a Gemini permission tool card when a matching tool-result arrives', () => {
        const messages: NormalizedMessage[] = [
            {
                id: 'permission-1',
                localId: null,
                seq: 1,
                createdAt: 1000,
                isSidechain: false,
                role: 'agent',
                content: [{
                    type: 'tool-call',
                    id: 'perm-1',
                    name: 'change_title',
                    input: { title: 'New title' },
                    description: 'Change title',
                    uuid: 'permission-1',
                    parentUUID: null
                }]
            },
            {
                id: 'permission-result-1',
                localId: null,
                seq: 2,
                createdAt: 1001,
                isSidechain: false,
                role: 'agent',
                content: [{
                    type: 'tool-result',
                    tool_use_id: 'perm-1',
                    content: { status: 'approved', decision: 'approved' },
                    is_error: false,
                    uuid: 'permission-result-1',
                    parentUUID: null
                }]
            }
        ];

        const feed = buildFeed(messages, 'gemini');

        expect(feed).toHaveLength(1);
        expect(feed[0]).toMatchObject({
            kind: 'agent-group',
            items: [{
                kind: 'tool',
                tool: 'change_title',
                state: 'success'
            }]
        });
    });
});
