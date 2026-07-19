import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NormalizedMessage } from '@/lib/protocol/messages';
import { mergeMessages } from '@/lib/protocol/store';
import type { Session } from '@/lib/protocol/types';

let buildFeed: typeof import('@/pages/ChatPage').buildFeed;
let MarkdownMessage: typeof import('@/pages/ChatPage').MarkdownMessage;
let agentSessionIdOf: typeof import('@/pages/ChatPage').agentSessionIdOf;
let createMessageLoadQueue: typeof import('@/pages/ChatPage').createMessageLoadQueue;
let getMessageLoadScope: typeof import('@/pages/ChatPage').getMessageLoadScope;
let mergeMessagePagination: typeof import('@/pages/ChatPage').mergeMessagePagination;
let parseNavState: typeof import('@/pages/ChatPage').parseNavState;
let buildCursorResumeNavigationState: typeof import('@/pages/ChatPage').buildCursorResumeNavigationState;
let mergeLineageMessages: typeof import('@/pages/ChatPage').mergeLineageMessages;
let requestLineageParentHistory: typeof import('@/pages/ChatPage').requestLineageParentHistory;
let resolveLineageParent: typeof import('@/pages/ChatPage').resolveLineageParent;
let shouldRequestLineageParentInitialPage: typeof import('@/pages/ChatPage').shouldRequestLineageParentInitialPage;
let createLineageRefreshAttemptGate: typeof import('@/pages/ChatPage').createLineageRefreshAttemptGate;
let getLineageHistoryScopeTransition: typeof import('@/pages/ChatPage').getLineageHistoryScopeTransition;
let getLineageHistoryRequestIdentity: typeof import('@/pages/ChatPage').getLineageHistoryRequestIdentity;
let createChatMessageSender: typeof import('@/pages/ChatPage').createChatMessageSender;
let LineageHistoryNotice: typeof import('@/pages/ChatPage').LineageHistoryNotice;

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
    MarkdownMessage = pageModule.MarkdownMessage;
    agentSessionIdOf = pageModule.agentSessionIdOf;
    createMessageLoadQueue = pageModule.createMessageLoadQueue;
    getMessageLoadScope = pageModule.getMessageLoadScope;
    mergeMessagePagination = pageModule.mergeMessagePagination;
    parseNavState = pageModule.parseNavState;
    buildCursorResumeNavigationState = pageModule.buildCursorResumeNavigationState;
    mergeLineageMessages = pageModule.mergeLineageMessages;
    requestLineageParentHistory = pageModule.requestLineageParentHistory;
    resolveLineageParent = pageModule.resolveLineageParent;
    shouldRequestLineageParentInitialPage = pageModule.shouldRequestLineageParentInitialPage;
    createLineageRefreshAttemptGate = pageModule.createLineageRefreshAttemptGate;
    getLineageHistoryScopeTransition = pageModule.getLineageHistoryScopeTransition;
    getLineageHistoryRequestIdentity = pageModule.getLineageHistoryRequestIdentity;
    createChatMessageSender = pageModule.createChatMessageSender;
    LineageHistoryNotice = pageModule.LineageHistoryNotice;
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

    it('renders trusted parent messages once before the child segment', () => {
        const parentMessages: NormalizedMessage[] = [
            {
                id: 'parent-1', localId: null, seq: 1, createdAt: 1000, isSidechain: false,
                role: 'user', content: { type: 'text', text: 'Parent prompt' },
            },
            {
                id: 'parent-2', localId: null, seq: 2, createdAt: 2000, isSidechain: false,
                role: 'agent', content: [{ type: 'text', text: 'Parent answer', uuid: 'parent-2', parentUUID: null }],
            },
            {
                id: 'parent-2', localId: null, seq: 2, createdAt: 2000, isSidechain: false,
                role: 'agent', content: [{ type: 'text', text: 'Parent answer', uuid: 'parent-2', parentUUID: null }],
            },
        ];
        const childMessages: NormalizedMessage[] = [
            parentMessages[1],
            {
                id: 'child-1', localId: null, seq: 1, createdAt: 3000, isSidechain: false,
                role: 'user', content: { type: 'text', text: 'Child prompt' },
            },
        ];

        const groups = mergeLineageMessages(parentMessages, childMessages);

        expect([...groups.parentMessages, ...groups.childMessages].map((message) => message.id))
            .toEqual(['parent-1', 'parent-2', 'child-1']);
    });

    it('rejects a missing, self-referencing, foreign-agent, or foreign-workspace parent', () => {
        const child = {
            id: 'child-session',
            metadata: {
                path: '/workspace', host: 'host', machineId: 'machine', flavor: 'cursor',
                resumedFromRemcliSessionId: 'missing-parent',
            },
        } as Session;

        expect(resolveLineageParent(child, [child])).toMatchObject({ parentId: null, isKnown: false });

        const selfReferencingChild = {
            ...child,
            metadata: { ...child.metadata, resumedFromRemcliSessionId: child.id },
        } as Session;
        expect(resolveLineageParent(selfReferencingChild, [selfReferencingChild])).toMatchObject({
            parentId: null,
            isKnown: true,
        });

        const foreignAgentParent = {
            id: 'missing-parent',
            metadata: { ...child.metadata, flavor: 'codex' },
        } as Session;
        expect(resolveLineageParent(child, [foreignAgentParent])).toMatchObject({ parentId: null, isKnown: true });

        const foreignWorkspaceParent = {
            id: 'missing-parent',
            metadata: { ...child.metadata, resumedFromRemcliSessionId: undefined, path: '/other-workspace' },
        } as Session;
        expect(resolveLineageParent(child, [foreignWorkspaceParent])).toMatchObject({ parentId: null, isKnown: true });

        const foreignMachineParent = {
            id: 'missing-parent',
            metadata: { ...child.metadata, machineId: 'other-machine' },
        } as Session;
        expect(resolveLineageParent(child, [foreignMachineParent])).toMatchObject({ parentId: null, isKnown: true });
    });

    it('requests parent history through the existing protocol loader', async () => {
        const requestMessages = vi.fn(async (sessionId: string) => ({
            total: 2,
            hasMore: false,
            consumed: 2,
            nextOffset: 2,
            sessionId,
        }));

        await requestLineageParentHistory('parent-session', requestMessages);

        expect(requestMessages).toHaveBeenCalledTimes(1);
        expect(requestMessages).toHaveBeenCalledWith('parent-session');
    });

    it('requests the first parent page even when cached messages are already marked loaded', () => {
        // isLoaded has no pagination metadata, so the cached-store case must not skip this request.
        expect(shouldRequestLineageParentInitialPage('parent-session', null)).toBe(true);
        expect(shouldRequestLineageParentInitialPage('parent-session', 'parent-session')).toBe(false);
    });

    it('keeps the initial parent request stable across StrictMode replay and a temporary missing snapshot', () => {
        let scope = null;
        const first = getLineageHistoryScopeTransition(scope, 'child-session', 'parent-session');
        scope = first.scope;
        const requestIdentity = getLineageHistoryRequestIdentity('child-session', 'parent-session');

        expect(first.shouldReset).toBe(true);
        expect(shouldRequestLineageParentInitialPage(requestIdentity, null)).toBe(true);

        const strictReplay = getLineageHistoryScopeTransition(scope, 'child-session', 'parent-session');
        scope = strictReplay.scope;
        expect(strictReplay.shouldReset).toBe(false);
        expect(shouldRequestLineageParentInitialPage(requestIdentity, requestIdentity)).toBe(false);

        const missingParent = getLineageHistoryScopeTransition(scope, 'child-session', null);
        scope = missingParent.scope;
        expect(missingParent.shouldReset).toBe(false);

        const reappearedParent = getLineageHistoryScopeTransition(scope, 'child-session', 'parent-session');
        scope = reappearedParent.scope;
        expect(reappearedParent.shouldReset).toBe(false);
        expect(shouldRequestLineageParentInitialPage(requestIdentity, requestIdentity)).toBe(false);

        const nextRoute = getLineageHistoryScopeTransition(scope, 'next-child-session', 'parent-session');
        const nextRequestIdentity = getLineageHistoryRequestIdentity('next-child-session', 'parent-session');
        expect(nextRoute.shouldReset).toBe(true);
        expect(nextRequestIdentity).not.toBe(requestIdentity);
        expect(shouldRequestLineageParentInitialPage(nextRequestIdentity, requestIdentity)).toBe(true);
    });

    it('invokes missing-parent refresh only for the initial snapshot of each candidate', () => {
        const gate = createLineageRefreshAttemptGate();
        const refresh = vi.fn();
        const refreshIfNeeded = (candidateId: string | null, isKnown: boolean): void => {
            if (gate.consumeInitialAttempt(candidateId, isKnown)) refresh();
        };

        refreshIfNeeded('missing-parent', false);
        refreshIfNeeded('missing-parent', false);
        refreshIfNeeded('missing-parent', true);
        expect(refresh).toHaveBeenCalledTimes(1);

        refreshIfNeeded('known-parent', true);
        refreshIfNeeded('known-parent', false);
        expect(refresh).toHaveBeenCalledTimes(1);

        refreshIfNeeded('new-parent', false);
        expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('loads one cached parent initial page and keeps its pagination metadata', async () => {
        const page = {
            total: 3,
            hasMore: true,
            consumed: 2,
            nextOffset: 2,
            sessionId: 'parent-session',
        };
        const requestMessages = vi.fn(async (sessionId: string) => ({ ...page, sessionId }));

        const loadedPage = await requestLineageParentHistory('parent-session', requestMessages);
        const pagination = mergeMessagePagination(
            { offset: 0, total: 0, hasMore: false },
            loadedPage,
            'initial',
        );

        expect(requestMessages).toHaveBeenCalledTimes(1);
        expect(requestMessages).toHaveBeenCalledWith('parent-session');
        expect(pagination).toEqual({ offset: 2, total: 3, hasMore: true });
    });

    it('renders a visible inline degraded notice for unavailable parent history', () => {
        const markup = renderToStaticMarkup(React.createElement(LineageHistoryNotice, { state: 'unavailable' }));

        expect(markup).toContain('role="status"');
        expect(markup).toContain('data-lineage-notice="unavailable"');
        expect(markup).toContain('previous history unavailable');
        const noticeElement = markup.match(/<div[^>]*>/)?.[0] ?? '';
        expect(noticeElement).not.toContain('rounded-xl');
        expect(noticeElement).not.toContain('border');
        expect(noticeElement).not.toContain('bg-');
    });

    it('sends new input through the child session id only', async () => {
        const calls: string[] = [];
        const sendMessage = async (sessionId: string, text: string): Promise<void> => {
            calls.push(`${sessionId}:${text}`);
        };

        const sendChildMessage = createChatMessageSender('child-session', sendMessage);
        await sendChildMessage('Child prompt');

        expect(calls).toEqual(['child-session:Child prompt']);
        expect(calls).not.toContain('parent-session:Child prompt');
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

    it('builds a non-URL Cursor resume navigation payload with the native session identity', () => {
        const navigationState = buildCursorResumeNavigationState({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            resumeSessionId: 'cursor-native-session-id',
            resumeSessionName: 'Cursor lifecycle review',
        });

        expect(navigationState).toEqual({
            cursorResume: {
                machineId: 'machine-1',
                directory: '/workspace/remcli',
                resumeSessionId: 'cursor-native-session-id',
                resumeSessionName: 'Cursor lifecycle review',
            },
        });
        expect(JSON.stringify(navigationState)).not.toContain('permissionMode');
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

describe('ChatPage Markdown output', () => {
    it('preserves semantic blocks while wrapping long paths, links, and code', () => {
        const longPath = '/Users/solidhard1/Projects/pet-projects/remcli/packages/remcli-web/src/pages/ChatPage.tsx:1164';
        const markup = renderToStaticMarkup(React.createElement(MarkdownMessage, {
            text: [
                '## Terminal output',
                '',
                `Inspect ${longPath} and [the design guide](https://example.com/remcli/design).`,
                '',
                '- keep `workspace-write` readable',
                '- preserve the long path above',
                '',
                '1. render paragraphs',
                '2. keep list spacing',
                '',
                '```ts',
                `const source = '${longPath}';`,
                '```',
            ].join('\n'),
        }));

        expect(markup).toContain('<p');
        expect(markup).toContain('<h2');
        expect(markup).toContain('<ul');
        expect(markup).toContain('<ol');
        expect(markup).toContain('<pre');
        expect(markup).toContain('<code>');
        expect(markup).toContain('href="https://example.com/remcli/design"');
        expect(markup).toContain('font-mono');
        expect(markup).toContain('text-accent');
        expect(markup).toContain('[overflow-wrap:anywhere]');
        expect(markup).toContain(longPath);
    });

    it('does not turn unsafe Markdown URLs into clickable links', () => {
        const markup = renderToStaticMarkup(React.createElement(MarkdownMessage, {
            text: '[unsafe](javascript:alert(1)) <img src=x onerror=alert(1)>',
        }));

        expect(markup).not.toContain('href=');
        expect(markup).toContain('javascript:alert(1)');
        expect(markup).toContain('&lt;img');
    });

    it('keeps balanced parentheses in an allowed link destination', () => {
        const href = 'https://en.wikipedia.org/wiki/Function_(mathematics)';
        const markup = renderToStaticMarkup(React.createElement(MarkdownMessage, {
            text: `[CommonMark destination](${href})`,
        }));

        expect(markup).toContain(`href="${href}"`);
        expect(markup).toContain('CommonMark destination');
    });
});
