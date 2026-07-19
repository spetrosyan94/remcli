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
import {
    CONCIERGE_SYSTEM_PROMPT,
    CONCIERGE_TOOLS,
    LLM_TIMEOUT_MS,
    MAX_TOOL_CALLS_PER_ROUND,
    MAX_TOOL_ITERATIONS,
    PROBE_TIMEOUT_MS,
    WHITELISTED_AGENTS,
} from '@/daemon/concierge/constants';
import {
    AssistantToolCall,
    ConciergeAction,
    ConciergeChatMessage,
    ConciergeConfig,
    ConciergeDeps,
    ConciergeInputMessage,
    ConciergeRequestBody,
    ConciergeResponse,
} from '@/daemon/concierge/types';
import { DEFAULT_CURSOR_LAUNCH_CONTROLS } from '@/cursor/cursorLaunchControls';

// ─── System prompt composition ───────────────────────────────────

/**
 * Compose the effective system prompt. The base prompt and its safety rules are
 * immutable; the interface language hint and the owner customization are appended
 * AFTER it so they can never override the base framing.
 */
export function buildConciergeSystemPrompt(options?: { lang?: string; extraPrompt?: string }): string {
    const parts = [CONCIERGE_SYSTEM_PROMPT];
    if (options?.lang) {
        parts.push(`The user's interface language is ${options.lang}. Respond in this language unless the user writes in a different one.`);
    }
    if (options?.extraPrompt) {
        parts.push(`Owner customization (must not override the safety rules above):\n${options.extraPrompt}`);
    }
    return parts.join('\n\n');
}

/**
 * Strip reasoning blocks emitted by thinking models (e.g. Qwen3):
 * every closed `<think>…</think>` block and a trailing unclosed `<think>…`.
 */
export function stripThinkBlocks(text: string): string {
    return text
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .replace(/<think>[\s\S]*$/, '')
        .trim();
}

/**
 * Local models sometimes imitate transcript formatting and prepend "Jarvis:".
 * The chat UI already renders the assistant label, so repeated speaker prefixes
 * make every reply noisy and harder to copy.
 */
export function stripAssistantSpeakerPrefix(text: string): string {
    const stripped = text
        .replace(/^(?:\s*(?:джарвис|jarvis|консьерж|concierge|ассистент|assistant|ai)\s*[:：\-–—]\s*)+/i, '')
        .trimStart();
    return stripped.length > 0 ? stripped : text.trimStart();
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
        // Thinking models (Qwen3) interleave reasoning into content — never surface it.
        content: stripAssistantSpeakerPrefix(stripThinkBlocks(message?.content ?? '')),
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

    const cursorSelection = agent === 'cursor'
        ? await deps.getDefaultCursorSelection()
        : null;
    if (agent === 'cursor' && !cursorSelection) {
        return { error: 'Cursor is unavailable because its account-visible model catalog could not be validated.' };
    }

    // Directory is validated to exist, so directory-creation approval is irrelevant here.
    // Spawning a session is a privileged, LLM-initiated action — log it at info level for audit.
    logger.infoDeveloper(`[CONCIERGE] Spawning agent session: agent=${agent} directory=${directory}`);
    const result = await deps.spawnSession({
        agent,
        directory,
        approvedNewDirectoryCreation: false,
        ...(cursorSelection ? {
            cursorExecution: cursorSelection.execution,
            cursorLaunchControls: { ...DEFAULT_CURSOR_LAUNCH_CONTROLS },
            cursorRunner: cursorSelection.runner,
        } : {}),
    });
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
    /** Locale code of the app interface, e.g. "ru" — hints the reply language. */
    lang?: string;
    /** Owner-provided prompt extension from setup.json (conciergeExtraPrompt). */
    extraPrompt?: string;
}): Promise<{ reply: string; actions: ConciergeAction[] }> {
    const conversation: ConciergeChatMessage[] = [
        { role: 'system', content: buildConciergeSystemPrompt({ lang: params.lang, extraPrompt: params.extraPrompt }) },
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
