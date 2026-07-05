import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@/lib/protocol/messages';
import type { Session } from '@/lib/protocol/types';

let buildFeed: typeof import('@/pages/ChatPage').buildFeed;
let agentSessionIdOf: typeof import('@/pages/ChatPage').agentSessionIdOf;
let parseNavState: typeof import('@/pages/ChatPage').parseNavState;

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
    parseNavState = pageModule.parseNavState;
});

afterAll(() => {
    vi.unstubAllGlobals();
});

describe('ChatPage feed mapping', () => {
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
