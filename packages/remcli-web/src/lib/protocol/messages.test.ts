import { describe, expect, it } from 'vitest';
import { MessageMetaSchema, normalizeRawMessage } from '@/lib/protocol/messages';
import { mergeMessages } from '@/lib/protocol/store';
import type { NormalizedMessage } from '@/lib/protocol/messages';

describe('normalizeRawMessage', () => {
    it('accepts current Codex sandbox permission modes in message meta', () => {
        expect(MessageMetaSchema.parse({ permissionMode: 'workspace-write' }).permissionMode).toBe('workspace-write');
        expect(MessageMetaSchema.parse({ permissionMode: 'danger-full-access' }).permissionMode).toBe('danger-full-access');
    });

    it('rejects removed legacy permission modes', () => {
        expect(() => MessageMetaSchema.parse({ permissionMode: 'default' })).toThrow();
        expect(() => MessageMetaSchema.parse({ permissionMode: 'yolo' })).toThrow();
    });

    it('normalizes a plain user message with meta', () => {
        const result = normalizeRawMessage('m1', 'local-1', 5, 1000, {
            role: 'user',
            content: { type: 'text', text: 'hello agent' },
            meta: { sentFrom: 'web', permissionMode: 'manual' }
        });
        expect(result).toMatchObject({
            id: 'm1',
            localId: 'local-1',
            seq: 5,
            createdAt: 1000,
            role: 'user',
            content: { type: 'text', text: 'hello agent' },
            isSidechain: false,
            meta: { sentFrom: 'web' }
        });
    });

    it('normalizes assistant output with text + tool_use blocks', () => {
        const result = normalizeRawMessage('m2', null, 6, 2000, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'uuid-1',
                    parentUuid: 'uuid-0',
                    message: {
                        role: 'assistant',
                        model: 'claude-sonnet-4',
                        content: [
                            { type: 'text', text: 'Let me check that file.' },
                            { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/a.ts', description: 'Read a.ts' } }
                        ],
                        usage: { input_tokens: 10, output_tokens: 20 }
                    }
                }
            }
        });
        expect(result?.role).toBe('agent');
        const content = (result as Extract<NormalizedMessage, { role: 'agent' }>).content;
        expect(content).toHaveLength(2);
        expect(content[0]).toMatchObject({ type: 'text', text: 'Let me check that file.', uuid: 'uuid-1', parentUUID: 'uuid-0' });
        expect(content[1]).toMatchObject({ type: 'tool-call', id: 'tool-1', name: 'Read', description: 'Read a.ts' });
        expect(result?.usage).toMatchObject({ input_tokens: 10, output_tokens: 20 });
    });

    it('normalizes tool_result with permissions (permission decisions survive)', () => {
        const result = normalizeRawMessage('m3', null, 7, 3000, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'user',
                    uuid: 'uuid-2',
                    message: {
                        role: 'user',
                        content: [{
                            type: 'tool_result',
                            tool_use_id: 'tool-1',
                            content: 'file contents',
                            is_error: false,
                            permissions: { date: 123, result: 'approved', decision: 'approved_for_session' }
                        }]
                    }
                }
            }
        });
        const content = (result as Extract<NormalizedMessage, { role: 'agent' }>).content;
        expect(content[0]).toMatchObject({
            type: 'tool-result',
            tool_use_id: 'tool-1',
            content: 'file contents',
            is_error: false,
            permissions: { date: 123, result: 'approved', decision: 'approved_for_session' }
        });
    });

    it('normalizes hyphenated tool-call content (Codex/Gemini) to tool-call', () => {
        const result = normalizeRawMessage('m4', null, 8, 4000, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'uuid-3',
                    message: {
                        role: 'assistant',
                        model: 'codex',
                        content: [{ type: 'tool-call', callId: 'call-9', name: 'bash', input: { cmd: 'ls' } }]
                    }
                }
            }
        });
        const content = (result as Extract<NormalizedMessage, { role: 'agent' }>).content;
        expect(content[0]).toMatchObject({ type: 'tool-call', id: 'call-9', name: 'bash' });
    });

    it('normalizes ACP permission-request into a tool-call block', () => {
        const result = normalizeRawMessage('m5', null, 9, 5000, {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'gemini',
                data: {
                    type: 'permission-request',
                    permissionId: 'perm-1',
                    toolName: 'write_file',
                    description: 'Write to /tmp/x'
                }
            }
        });
        const content = (result as Extract<NormalizedMessage, { role: 'agent' }>).content;
        expect(content[0]).toMatchObject({ type: 'tool-call', id: 'perm-1', name: 'write_file', description: 'Write to /tmp/x' });
    });

    it('normalizes ACP permission tool-result into a matching tool-result block', () => {
        const result = normalizeRawMessage('m5-result', null, 10, 5001, {
            role: 'agent',
            content: {
                type: 'acp',
                provider: 'gemini',
                data: {
                    type: 'tool-result',
                    callId: 'perm-1',
                    output: { status: 'approved', decision: 'approved' },
                    id: 'result-1',
                    isError: false
                }
            }
        });

        const content = (result as Extract<NormalizedMessage, { role: 'agent' }>).content;
        expect(content[0]).toMatchObject({
            type: 'tool-result',
            tool_use_id: 'perm-1',
            content: { status: 'approved', decision: 'approved' },
            is_error: false
        });
    });

    it('normalizes event records', () => {
        const result = normalizeRawMessage('m6', null, 10, 6000, {
            role: 'agent',
            content: { type: 'event', id: 'e1', data: { type: 'switch', mode: 'remote' } }
        });
        expect(result).toMatchObject({ role: 'event', content: { type: 'switch', mode: 'remote' } });
    });

    it('skips meta and compact-summary messages', () => {
        const meta = normalizeRawMessage('m7', null, 11, 7000, {
            role: 'agent',
            content: {
                type: 'output',
                data: {
                    type: 'assistant',
                    uuid: 'u',
                    isMeta: true,
                    message: { role: 'assistant', model: 'x', content: [] }
                }
            }
        });
        expect(meta).toBeNull();
    });

    it('returns null for unparseable payloads', () => {
        expect(normalizeRawMessage('m8', null, 12, 8000, { role: 'nope' })).toBeNull();
        expect(normalizeRawMessage('m9', null, 13, 9000, 'garbage')).toBeNull();
        expect(normalizeRawMessage('m10', null, 14, 9500, null)).toBeNull();
    });
});

describe('mergeMessages (seq order + dedup)', () => {
    const message = (id: string, seq: number | null, createdAt: number, localId: string | null = null): NormalizedMessage => ({
        id,
        localId,
        seq,
        createdAt,
        role: 'user',
        content: { type: 'text', text: id },
        isSidechain: false
    });

    it('sorts chronologically by createdAt, seq as tie-breaker', () => {
        const merged = mergeMessages([], [
            message('c', 3, 30),
            message('local-2', null, 55),
            message('a', 1, 10),
            message('local-1', null, 50),
            message('b', 2, 20)
        ]);
        expect(merged.map((m) => m.id)).toEqual(['a', 'b', 'c', 'local-1', 'local-2']);
    });

    it('keeps an unacked local echo (seq=null) before a later agent reply with seq', () => {
        // Daemon skips the sender socket on new-message broadcast, so the local
        // echo never gets a seq — the later agent reply must still sort after it.
        const withEcho = mergeMessages([], [message('m1', 1, 10), message('local-echo', null, 50, 'local-echo')]);
        const merged = mergeMessages(withEcho, [message('agent-reply', 2, 60)]);
        expect(merged.map((m) => m.id)).toEqual(['m1', 'local-echo', 'agent-reply']);
    });

    it('deduplicates by id (latest copy wins)', () => {
        const first = mergeMessages([], [message('a', 1, 10)]);
        const merged = mergeMessages(first, [message('a', 1, 10), message('b', 2, 20)]);
        expect(merged).toHaveLength(2);
        expect(merged.map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('replaces the local echo when the server copy arrives with matching localId', () => {
        const localEcho = message('local-42', null, 100, 'local-42');
        const withEcho = mergeMessages([], [localEcho]);
        expect(withEcho).toHaveLength(1);

        const serverCopy = message('server-id-1', 7, 105, 'local-42');
        const merged = mergeMessages(withEcho, [serverCopy]);
        expect(merged).toHaveLength(1);
        expect(merged[0].id).toBe('server-id-1');
        expect(merged[0].seq).toBe(7);
    });
});
