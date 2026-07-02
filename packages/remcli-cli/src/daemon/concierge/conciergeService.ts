/**
 * Local concierge service.
 *
 * A lightweight, OPTIONAL LLM assistant backed by LM Studio (or any other
 * OpenAI-compatible server on localhost). The concierge greets the user,
 * reports what is currently running, and can start an agent session on an
 * explicit request. It is a router of intent into deterministic tool calls —
 * it never invents daemon state, it only reports what the tools return.
 *
 * No new npm dependencies: uses the built-in global `fetch` plus `zod`
 * (already a project dependency) to validate tool-call arguments.
 */

import { z } from 'zod';
import { isAbsolute, resolve } from 'node:path';
import { stat } from 'node:fs/promises';

import { logger } from '@/ui/logger';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

// ─── Constants ───────────────────────────────────────────────────

/** Maximum LLM round trips before we force a plain-text answer (no tools offered). */
const MAX_TOOL_ITERATIONS = 4;
const MAX_TOOL_CALLS_PER_ROUND = 5;
/** Per-request timeout for a single LLM completion call. */
const LLM_TIMEOUT_MS = 30_000;
/** Timeout for the cheap availability probe against `/models`. */
const PROBE_TIMEOUT_MS = 1_500;

const WHITELISTED_AGENTS = ['claude', 'codex', 'gemini', 'cursor'] as const;

export const CONCIERGE_SYSTEM_PROMPT = [
    'You are Jarvis — the remcli concierge, a small assistant embedded in the remcli daemon.',
    'Introduce yourself as Jarvis. Keep a calm, competent, slightly witty butler tone (think of a loyal AI majordomo), but never let style get in the way of brevity or accuracy.',
    'Greet the user briefly and warmly on first contact.',
    "Always answer in the user's language.",
    'You can ONLY do the following:',
    '  1. Report the status of running agent sessions and of the daemon itself.',
    '  2. Start an agent session (claude, codex, gemini or cursor) ONLY when the user explicitly asks for it.',
    '  3. Explain how to use remcli.',
    'NEVER invent or guess data. To know what is running or the daemon status you MUST call the provided tools.',
    'When the user explicitly asks to start an agent, call spawn_agent_session with an absolute directory path.',
    'For anything beyond these capabilities (writing code, debugging, editing files), advise the user to start a full agent session instead of trying to do it yourself.',
    'Keep replies short and to the point.',
].join('\n');

// ─── Tool definitions (OpenAI function calling) ──────────────────

export const CONCIERGE_TOOLS = [
    {
        type: 'function' as const,
        function: {
            name: 'list_sessions',
            description: 'List the agent sessions currently tracked by the daemon (id, agent, directory, status).',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'get_daemon_status',
            description: 'Get daemon status: version, uptime in seconds, P2P port and tunnel URL.',
            parameters: { type: 'object', properties: {}, required: [] },
        },
    },
    {
        type: 'function' as const,
        function: {
            name: 'spawn_agent_session',
            description: 'Start a new AI agent session in a directory. Call only when the user explicitly asks to start an agent.',
            parameters: {
                type: 'object',
                properties: {
                    agent: {
                        type: 'string',
                        enum: [...WHITELISTED_AGENTS],
                        description: 'Which agent to start.',
                    },
                    directory: {
                        type: 'string',
                        description: 'Absolute path to the project directory. Must already exist.',
                    },
                },
                required: ['agent', 'directory'],
            },
        },
    },
];

// ─── Types ───────────────────────────────────────────────────────

export interface ConciergeConfig {
    /** Base URL of the OpenAI-compatible server, e.g. http://127.0.0.1:1234/v1 */
    url: string;
    /** Model id, or empty string to auto-select the first available model. */
    model: string;
}

export interface ConciergeSessionInfo {
    id: string;
    agent: string;
    directory: string;
    status: string;
}

export interface ConciergeDaemonStatus {
    version: string;
    uptimeSec: number;
    port: number;
    tunnelUrl: string | null;
}

/** Deterministic daemon capabilities the concierge is allowed to use. */
export interface ConciergeDeps {
    listSessions: () => ConciergeSessionInfo[];
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    getDaemonStatus: () => ConciergeDaemonStatus;
}

/** A message from the client history (only user/assistant turns). */
export interface ConciergeInputMessage {
    role: 'user' | 'assistant';
    content: string;
}

/** What the concierge actually did, surfaced to the UI. */
export interface ConciergeAction {
    tool: string;
    result: unknown;
}

interface AssistantToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

type ConciergeChatMessage =
    | { role: 'system' | 'user'; content: string }
    | { role: 'assistant'; content: string; tool_calls?: AssistantToolCall[] }
    | { role: 'tool'; tool_call_id: string; content: string };

interface ConciergeRequestBody {
    model: string;
    messages: ConciergeChatMessage[];
    tools?: typeof CONCIERGE_TOOLS;
    tool_choice?: 'auto';
    temperature: number;
    stream: false;
}

interface ConciergeResponse {
    choices?: Array<{
        message?: {
            content?: string | null;
            tool_calls?: AssistantToolCall[];
        };
    }>;
}

// ─── URL helpers ─────────────────────────────────────────────────

function stripTrailingSlash(url: string): string {
    return url.replace(/\/+$/, '');
}

// ─── Availability probe ──────────────────────────────────────────

/**
 * Cheap probe against `{url}/models`. Never throws — an offline LM Studio is a
 * normal condition. Returns the resolved model (config model if set, otherwise
 * the first advertised model).
 */
export async function probeConcierge(config: ConciergeConfig): Promise<{ available: boolean; model?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const response = await fetch(`${stripTrailingSlash(config.url)}/models`, {
            signal: controller.signal,
        });
        if (!response.ok) {
            return { available: false };
        }
        const data = (await response.json()) as { data?: Array<{ id?: string }> };
        if (config.model) {
            return { available: true, model: config.model };
        }
        const firstModel = data.data?.find((m) => typeof m.id === 'string' && m.id.length > 0)?.id;
        if (!firstModel) {
            return { available: false };
        }
        return { available: true, model: firstModel };
    } catch {
        // ECONNREFUSED / abort / parse error — treat as unavailable.
        return { available: false };
    } finally {
        clearTimeout(timeout);
    }
}

// ─── Request body construction ───────────────────────────────────

export function buildConciergeRequestBody(params: {
    model: string;
    messages: ConciergeChatMessage[];
    includeTools: boolean;
}): ConciergeRequestBody {
    return {
        model: params.model,
        messages: params.messages,
        tools: params.includeTools ? CONCIERGE_TOOLS : undefined,
        tool_choice: params.includeTools ? 'auto' : undefined,
        temperature: 0.3,
        stream: false,
    };
}

// ─── Response parsing ────────────────────────────────────────────

export function parseConciergeResponse(response: ConciergeResponse): {
    content: string;
    toolCalls: AssistantToolCall[];
} {
    const message = response.choices?.[0]?.message;
    return {
        content: message?.content ?? '',
        toolCalls: message?.tool_calls ?? [],
    };
}

// ─── Tool execution ──────────────────────────────────────────────

const SpawnArgsSchema = z.object({
    agent: z.enum(WHITELISTED_AGENTS),
    directory: z.string().min(1),
});

async function executeSpawnAgentSession(rawArgs: string, deps: ConciergeDeps): Promise<unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawArgs);
    } catch {
        return { error: 'Invalid tool arguments: not valid JSON.' };
    }

    const validation = SpawnArgsSchema.safeParse(parsed);
    if (!validation.success) {
        const detail = validation.error.issues.map((i) => `${i.path.join('.') || 'arg'}: ${i.message}`).join('; ');
        return { error: `Invalid arguments for spawn_agent_session: ${detail}` };
    }

    const { agent } = validation.data;

    if (!isAbsolute(validation.data.directory)) {
        return { error: `Directory must be an absolute path, got: "${validation.data.directory}".` };
    }
    // Canonicalize (collapses embedded '..' segments) so logs and session tracking see one form.
    const directory = resolve(validation.data.directory);

    try {
        const info = await stat(directory);
        if (!info.isDirectory()) {
            return { error: `Path exists but is not a directory: "${directory}".` };
        }
    } catch {
        return { error: `Directory does not exist: "${directory}".` };
    }

    // Directory is validated to exist, so directory-creation approval is irrelevant here.
    // Spawning a session is a privileged, LLM-initiated action — log it at info level for audit.
    logger.infoDeveloper(`[CONCIERGE] Spawning agent session: agent=${agent} directory=${directory}`);
    const result = await deps.spawnSession({ agent, directory, approvedNewDirectoryCreation: false });
    return result;
}

/**
 * Execute a single tool call against the deterministic daemon capabilities.
 * Never throws for bad input — returns an `{ error }` payload that is fed back
 * to the LLM so it can explain the failure to the user.
 */
export async function executeToolCall(name: string, rawArgs: string, deps: ConciergeDeps): Promise<unknown> {
    switch (name) {
        case 'list_sessions':
            return { sessions: deps.listSessions() };
        case 'get_daemon_status':
            return deps.getDaemonStatus();
        case 'spawn_agent_session':
            return executeSpawnAgentSession(rawArgs, deps);
        default:
            return { error: `Unknown tool: ${name}` };
    }
}

// ─── LLM call ────────────────────────────────────────────────────

async function callConciergeLLM(url: string, body: ConciergeRequestBody): Promise<ConciergeResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
        const response = await fetch(`${stripTrailingSlash(url)}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            throw new Error(`Concierge LLM returned ${response.status}: ${text.slice(0, 200)}`);
        }
        return (await response.json()) as ConciergeResponse;
    } finally {
        clearTimeout(timeout);
    }
}

// ─── Chat loop ───────────────────────────────────────────────────

/**
 * Run a bounded tool-calling conversation. Tools are offered on every round
 * except the last, where the model is forced to produce a plain-text answer.
 */
export async function chatWithConcierge(params: {
    url: string;
    model: string;
    messages: ConciergeInputMessage[];
    deps: ConciergeDeps;
}): Promise<{ reply: string; actions: ConciergeAction[] }> {
    const conversation: ConciergeChatMessage[] = [
        { role: 'system', content: CONCIERGE_SYSTEM_PROMPT },
        ...params.messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    const actions: ConciergeAction[] = [];

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        const isLastIteration = iteration === MAX_TOOL_ITERATIONS - 1;
        const body = buildConciergeRequestBody({
            model: params.model,
            messages: conversation,
            includeTools: !isLastIteration,
        });

        const response = await callConciergeLLM(params.url, body);
        const { content, toolCalls } = parseConciergeResponse(response);

        // No tools requested, or we are on the forced-text final round → done.
        if (toolCalls.length === 0 || isLastIteration) {
            return { reply: content, actions };
        }

        conversation.push({ role: 'assistant', content, tool_calls: toolCalls });
        // Guardrails: at most MAX_TOOL_CALLS_PER_ROUND executed per LLM round, and only
        // one session spawn per conversation — a runaway model must not fork the machine.
        for (const call of toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND)) {
            let result: unknown;
            if (call.function.name === 'spawn_agent_session' && actions.some((a) => a.tool === 'spawn_agent_session')) {
                result = { error: 'Only one session can be spawned per conversation.' };
            } else {
                result = await executeToolCall(call.function.name, call.function.arguments, params.deps);
            }
            actions.push({ tool: call.function.name, result });
            conversation.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
            logger.debug(`[CONCIERGE] Tool executed: ${call.function.name}`);
        }
        for (const skipped of toolCalls.slice(MAX_TOOL_CALLS_PER_ROUND)) {
            conversation.push({
                role: 'tool',
                tool_call_id: skipped.id,
                content: JSON.stringify({ error: `Tool call limit (${MAX_TOOL_CALLS_PER_ROUND} per round) exceeded; call skipped.` }),
            });
        }
    }

    // Unreachable: the last iteration always returns above.
    return { reply: '', actions };
}
