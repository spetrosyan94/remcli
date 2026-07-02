import { describe, it, expect, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
    logger: { debug: () => {}, infoDeveloper: () => {} },
}));

import {
    probeConcierge,
    buildConciergeRequestBody,
    parseConciergeResponse,
    executeToolCall,
    CONCIERGE_SYSTEM_PROMPT,
    CONCIERGE_TOOLS,
    ConciergeDeps,
} from './conciergeService';

// ---- Helpers ----

function makeDeps(overrides?: Partial<ConciergeDeps>): ConciergeDeps {
    return {
        listSessions: () => [],
        spawnSession: async () => ({ type: 'success', sessionId: 'sess-123' }),
        getDaemonStatus: () => ({ version: '1.0.0', uptimeSec: 42, port: 12345, tunnelUrl: null }),
        ...overrides,
    };
}

// ---- Request body construction ----

describe('buildConciergeRequestBody', () => {
    it('includes the system prompt and tools when includeTools is true', () => {
        const body = buildConciergeRequestBody({
            model: 'test-model',
            messages: [
                { role: 'system', content: CONCIERGE_SYSTEM_PROMPT },
                { role: 'user', content: 'hi' },
            ],
            includeTools: true,
        });

        expect(body.model).toBe('test-model');
        expect(body.stream).toBe(false);
        expect(body.messages[0]).toEqual({ role: 'system', content: CONCIERGE_SYSTEM_PROMPT });
        expect(body.tools).toBe(CONCIERGE_TOOLS);
        expect(body.tool_choice).toBe('auto');

        const toolNames = CONCIERGE_TOOLS.map((t) => t.function.name);
        expect(toolNames).toEqual(['list_sessions', 'get_daemon_status', 'spawn_agent_session']);
    });

    it('omits tools on the forced-text final round', () => {
        const body = buildConciergeRequestBody({
            model: 'test-model',
            messages: [{ role: 'user', content: 'hi' }],
            includeTools: false,
        });
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
    });
});

// ---- Response parsing ----

describe('parseConciergeResponse', () => {
    it('extracts tool_calls from an assistant message', () => {
        const parsed = parseConciergeResponse({
            choices: [
                {
                    message: {
                        content: '',
                        tool_calls: [
                            {
                                id: 'call_1',
                                type: 'function',
                                function: { name: 'list_sessions', arguments: '{}' },
                            },
                        ],
                    },
                },
            ],
        });
        expect(parsed.toolCalls).toHaveLength(1);
        expect(parsed.toolCalls[0].function.name).toBe('list_sessions');
        expect(parsed.content).toBe('');
    });

    it('returns plain text when there are no tool calls', () => {
        const parsed = parseConciergeResponse({
            choices: [{ message: { content: 'Hello there!' } }],
        });
        expect(parsed.toolCalls).toHaveLength(0);
        expect(parsed.content).toBe('Hello there!');
    });

    it('handles a malformed / empty response gracefully', () => {
        const parsed = parseConciergeResponse({});
        expect(parsed.content).toBe('');
        expect(parsed.toolCalls).toHaveLength(0);
    });
});

// ---- Tool execution: deterministic tools ----

describe('executeToolCall — deterministic tools', () => {
    it('list_sessions returns the daemon session list', async () => {
        const deps = makeDeps({
            listSessions: () => [{ id: 's1', agent: 'claude', directory: '/tmp/proj', status: 'running' }],
        });
        const result = await executeToolCall('list_sessions', '{}', deps);
        expect(result).toEqual({ sessions: [{ id: 's1', agent: 'claude', directory: '/tmp/proj', status: 'running' }] });
    });

    it('get_daemon_status returns the daemon status', async () => {
        const result = await executeToolCall('get_daemon_status', '{}', makeDeps());
        expect(result).toEqual({ version: '1.0.0', uptimeSec: 42, port: 12345, tunnelUrl: null });
    });

    it('returns an error for an unknown tool', async () => {
        const result = await executeToolCall('unknown_tool', '{}', makeDeps());
        expect(result).toHaveProperty('error');
    });
});

// ---- Tool execution: spawn_agent_session validation ----

describe('executeToolCall — spawn_agent_session validation', () => {
    it('rejects a bad agent from the whitelist without spawning', async () => {
        const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: 'x' }));
        const deps = makeDeps({ spawnSession: spawn });
        const result = await executeToolCall(
            'spawn_agent_session',
            JSON.stringify({ agent: 'evil', directory: '/tmp' }),
            deps,
        );
        expect(result).toHaveProperty('error');
        expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects a relative directory without spawning', async () => {
        const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: 'x' }));
        const deps = makeDeps({ spawnSession: spawn });
        const result = await executeToolCall(
            'spawn_agent_session',
            JSON.stringify({ agent: 'claude', directory: 'relative/path' }),
            deps,
        );
        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toMatch(/absolute/i);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects a non-existent absolute directory without spawning', async () => {
        const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: 'x' }));
        const deps = makeDeps({ spawnSession: spawn });
        const result = await executeToolCall(
            'spawn_agent_session',
            JSON.stringify({ agent: 'claude', directory: '/nonexistent-remcli-concierge-dir-xyz' }),
            deps,
        );
        expect(result).toHaveProperty('error');
        expect((result as { error: string }).error).toMatch(/does not exist/i);
        expect(spawn).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON arguments', async () => {
        const result = await executeToolCall('spawn_agent_session', 'not json', makeDeps());
        expect(result).toHaveProperty('error');
    });

    it('spawns for a valid agent + existing absolute directory', async () => {
        const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: 'sess-ok' }));
        const deps = makeDeps({ spawnSession: spawn });
        // process.cwd() is guaranteed to exist and be absolute.
        const result = await executeToolCall(
            'spawn_agent_session',
            JSON.stringify({ agent: 'claude', directory: process.cwd() }),
            deps,
        );
        expect(spawn).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledWith(
            expect.objectContaining({ agent: 'claude', directory: process.cwd() }),
        );
        expect(result).toEqual({ type: 'success', sessionId: 'sess-ok' });
    });
});

// ---- probeConcierge against an unreachable port ----

describe('probeConcierge', () => {
    it('returns available:false against an unreachable port (ECONNREFUSED)', async () => {
        // Port 9 (discard) is virtually never listening → immediate connection refusal.
        const result = await probeConcierge({ url: 'http://127.0.0.1:9/v1', model: '' });
        expect(result.available).toBe(false);
        expect(result.model).toBeUndefined();
    });
});
