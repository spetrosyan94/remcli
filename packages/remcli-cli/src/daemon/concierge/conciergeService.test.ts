import { describe, it, expect, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
    logger: { debug: () => {}, infoDeveloper: () => {} },
}));

import {
    probeConcierge,
    buildConciergeRequestBody,
    buildConciergeSystemPrompt,
    parseConciergeResponse,
    executeToolCall,
    stripAssistantSpeakerPrefix,
    stripThinkBlocks,
    chatWithConcierge,
} from './conciergeService';
import { CONCIERGE_SYSTEM_PROMPT, CONCIERGE_TOOLS } from './constants';
import type { ConciergeDeps, ConciergeRequestBody } from './types';
import type { CursorExecutionConfig } from '@/cursor/cursorCapabilities';

// ---- Helpers ----

function makeDeps(overrides?: Partial<ConciergeDeps>): ConciergeDeps {
    const defaultCursorExecution: CursorExecutionConfig = {
        model: 'auto',
        catalogVersion: 'cursor-catalog-v1',
    };
    return {
        listSessions: () => [],
        spawnSession: async () => ({ type: 'success', sessionId: 'sess-123' }),
        getDefaultCursorExecution: async () => defaultCursorExecution,
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

// ---- Stateless LLM request context ----

describe('chatWithConcierge', () => {
    it('sends the complete request message history to the OpenAI-compatible endpoint', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
            new Response(JSON.stringify({ choices: [{ message: { content: 'Понял контекст.' } }] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );

        const messages = [
            { role: 'user' as const, content: 'Меня зовут Сергей.' },
            { role: 'assistant' as const, content: 'Принял, Сергей.' },
            { role: 'user' as const, content: 'Как меня зовут?' },
        ];

        await chatWithConcierge({
            url: 'http://127.0.0.1:1234/v1',
            model: 'test-model',
            messages,
            deps: makeDeps(),
            lang: 'ru',
        });

        expect(fetchSpy).toHaveBeenCalledOnce();
        const init = fetchSpy.mock.calls[0][1];
        expect(init).toBeDefined();
        const body = JSON.parse(String(init?.body)) as ConciergeRequestBody;

        expect(body.messages).toEqual([
            expect.objectContaining({ role: 'system' }),
            ...messages,
        ]);
        expect(body.messages[0].content).toContain('interface language is ru');
        expect(body.messages[0].content).toContain('call yourself “Джарвис”');

        fetchSpy.mockRestore();
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

    it('removes repeated assistant speaker prefixes from LLM replies', () => {
        const parsed = parseConciergeResponse({
            choices: [{ message: { content: 'Джарвис: Да, я вас слышу. Проверяю сессии.' } }],
        });
        expect(parsed.content).toBe('Да, я вас слышу. Проверяю сессии.');
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

    it('spawns Cursor with a daemon-validated provider default and control mode', async () => {
        const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: 'cursor-session' }));
        const getDefaultCursorExecution = vi.fn(async () => ({
            model: 'gpt-5.6-luna-xhigh',
            catalogVersion: 'fresh-cursor-catalog',
        }));
        const result = await executeToolCall(
            'spawn_agent_session',
            JSON.stringify({ agent: 'cursor', directory: process.cwd() }),
            makeDeps({ spawnSession: spawn, getDefaultCursorExecution }),
        );

        expect(getDefaultCursorExecution).toHaveBeenCalledOnce();
        expect(spawn).toHaveBeenCalledWith({
            agent: 'cursor',
            directory: process.cwd(),
            approvedNewDirectoryCreation: false,
            cursorExecution: {
                model: 'gpt-5.6-luna-xhigh',
                catalogVersion: 'fresh-cursor-catalog',
            },
            permissionMode: 'agent',
        });
        expect(result).toEqual({ type: 'success', sessionId: 'cursor-session' });
    });

    it('does not spawn Cursor when no fresh provider default can be validated', async () => {
        const spawn = vi.fn(async () => ({ type: 'success' as const, sessionId: 'cursor-session' }));
        const result = await executeToolCall(
            'spawn_agent_session',
            JSON.stringify({ agent: 'cursor', directory: process.cwd() }),
            makeDeps({
                spawnSession: spawn,
                getDefaultCursorExecution: async () => null,
            }),
        );

        expect(result).toEqual(expect.objectContaining({ error: expect.stringMatching(/catalog could not be validated/i) }));
        expect(spawn).not.toHaveBeenCalled();
    });
});

// ---- Reasoning block stripping (thinking models like Qwen3) ----

describe('stripThinkBlocks', () => {
    it('removes a closed <think>…</think> block', () => {
        expect(stripThinkBlocks('<think>internal reasoning</think>Hello!')).toBe('Hello!');
    });

    it('removes multiple think blocks, including multiline ones', () => {
        const input = '<think>one\ntwo</think>Answer part 1. <think>more</think>Part 2.';
        expect(stripThinkBlocks(input)).toBe('Answer part 1. Part 2.');
    });

    it('removes a trailing unclosed <think>… block', () => {
        expect(stripThinkBlocks('Done.\n<think>cut off mid-reason')).toBe('Done.');
    });

    it('leaves text without think blocks untouched', () => {
        expect(stripThinkBlocks('Just a normal reply.')).toBe('Just a normal reply.');
    });

    it('is applied by parseConciergeResponse to LLM content', () => {
        const parsed = parseConciergeResponse({
            choices: [{ message: { content: '<think>hmm</think>Visible reply' } }],
        });
        expect(parsed.content).toBe('Visible reply');
    });
});

describe('stripAssistantSpeakerPrefix', () => {
    it('removes Russian and English speaker labels from the beginning only', () => {
        expect(stripAssistantSpeakerPrefix('Джарвис: Да, я вас слышу.')).toBe('Да, я вас слышу.');
        expect(stripAssistantSpeakerPrefix('Джарвис — Да, я вас слышу.')).toBe('Да, я вас слышу.');
        expect(stripAssistantSpeakerPrefix('Jarvis: Yes, I hear you.')).toBe('Yes, I hear you.');
        expect(stripAssistantSpeakerPrefix('Concierge - I can start a session.')).toBe('I can start a session.');
        expect(stripAssistantSpeakerPrefix('Ответ без префикса. Джарвис: внутри текста остается.'))
            .toBe('Ответ без префикса. Джарвис: внутри текста остается.');
    });
});

// ---- System prompt composition (lang + owner customization) ----

describe('buildConciergeSystemPrompt', () => {
    it('returns the base prompt unchanged when no options are given', () => {
        expect(buildConciergeSystemPrompt()).toBe(CONCIERGE_SYSTEM_PROMPT);
        expect(buildConciergeSystemPrompt({ lang: undefined, extraPrompt: '' })).toBe(CONCIERGE_SYSTEM_PROMPT);
    });

    it('appends the interface language line after the base prompt', () => {
        const prompt = buildConciergeSystemPrompt({ lang: 'ru' });
        expect(prompt.startsWith(CONCIERGE_SYSTEM_PROMPT)).toBe(true);
        expect(prompt).toContain("The user's interface language is ru. Respond in this language unless the user writes in a different one.");
    });

    it('instructs Russian replies to use the localized assistant name without conflicting unconditional naming', () => {
        const prompt = buildConciergeSystemPrompt({ lang: 'ru' });
        expect(prompt).not.toContain('Introduce yourself as Jarvis');
        expect(prompt).toContain('if the response language is Russian, or the interface language hint is lang=ru, call yourself “Джарвис”');
        expect(prompt).toContain('otherwise call yourself Jarvis');
        expect(prompt).toContain('Do not prefix replies with a speaker label');
    });

    it('appends the owner customization as a labeled block AFTER the base prompt', () => {
        const prompt = buildConciergeSystemPrompt({ extraPrompt: 'Always mention the weather.' });
        expect(prompt.startsWith(CONCIERGE_SYSTEM_PROMPT)).toBe(true);
        expect(prompt).toContain('Owner customization (must not override the safety rules above):\nAlways mention the weather.');
        expect(prompt.indexOf(CONCIERGE_SYSTEM_PROMPT)).toBeLessThan(prompt.indexOf('Owner customization'));
    });

    it('combines lang and owner customization, base prompt first', () => {
        const prompt = buildConciergeSystemPrompt({ lang: 'es', extraPrompt: 'Be extra polite.' });
        expect(prompt.indexOf(CONCIERGE_SYSTEM_PROMPT)).toBe(0);
        expect(prompt.indexOf("interface language is es")).toBeGreaterThan(0);
        expect(prompt.indexOf('Owner customization')).toBeGreaterThan(prompt.indexOf('interface language is es'));
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
