import { describe, expect, it } from 'vitest';
import {
    createCodexReplyArguments,
    isRemcliChangeTitleElicitation,
    permissionResultToElicitResult,
} from '../codexMcpClient';

describe('isRemcliChangeTitleElicitation', () => {
    it('accepts only remcli change_title MCP approval requests', () => {
        expect(isRemcliChangeTitleElicitation({
            message: 'Allow the remcli MCP server to run tool "change_title"?',
            _meta: {
                codex_approval_kind: 'mcp_tool_call',
                tool_title: 'Change Chat Title',
                tool_params: { title: 'Тест' },
            },
        })).toBe(true);
    });

    it('rejects other MCP tool approval requests', () => {
        expect(isRemcliChangeTitleElicitation({
            message: 'Allow the filesystem MCP server to run tool "write_file"?',
            _meta: {
                codex_approval_kind: 'mcp_tool_call',
                tool_title: 'Write File',
                tool_params: { path: '/tmp/file.txt' },
            },
        })).toBe(false);
    });

    it('rejects malformed title requests', () => {
        expect(isRemcliChangeTitleElicitation({
            message: 'Allow the remcli MCP server to run tool "change_title"?',
            _meta: {
                codex_approval_kind: 'mcp_tool_call',
                tool_title: 'Change Chat Title',
                tool_params: {},
            },
        })).toBe(false);
    });
});

describe('permissionResultToElicitResult', () => {
    it('maps approved permission decisions to MCP accept action', () => {
        expect(permissionResultToElicitResult({ decision: 'approved' })).toEqual({
            action: 'accept',
            content: {},
        });
        expect(permissionResultToElicitResult({ decision: 'approved_for_session' })).toEqual({
            action: 'accept',
            content: {},
        });
    });

    it('maps denied and abort decisions to MCP decline/cancel actions', () => {
        expect(permissionResultToElicitResult({ decision: 'denied' })).toEqual({
            action: 'decline',
        });
        expect(permissionResultToElicitResult({ decision: 'abort' })).toEqual({
            action: 'cancel',
        });
    });
});

describe('createCodexReplyArguments', () => {
    it('uses threadId for Codex MCP resume/continue calls without deprecated identifiers', () => {
        const args = createCodexReplyArguments('thread-123', 'continue');

        expect(args).toEqual({
            threadId: 'thread-123',
            prompt: 'continue',
        });
        expect(args).not.toHaveProperty('sessionId');
        expect(args).not.toHaveProperty('conversationId');
    });
});
