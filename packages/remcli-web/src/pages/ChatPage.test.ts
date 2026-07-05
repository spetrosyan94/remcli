import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { NormalizedMessage } from '@/lib/protocol/messages';

let buildFeed: typeof import('@/pages/ChatPage').buildFeed;

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
});

afterAll(() => {
    vi.unstubAllGlobals();
});

describe('ChatPage feed mapping', () => {
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
