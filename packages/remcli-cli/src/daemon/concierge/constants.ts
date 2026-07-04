/**
 * Constants for the local concierge service: limits, timeouts, the immutable
 * base system prompt and the OpenAI function-calling tool definitions.
 */

// ─── Constants ───────────────────────────────────────────────────

/** Maximum LLM round trips before we force a plain-text answer (no tools offered). */
export const MAX_TOOL_ITERATIONS = 4;
export const MAX_TOOL_CALLS_PER_ROUND = 5;
/**
 * Per-request timeout for a single LLM completion call.
 * 60s: the first call after a local model loads (cold prompt processing on a
 * 3-4B model with tools) reliably exceeds 30s on Apple Silicon.
 */
export const LLM_TIMEOUT_MS = 60_000;
/** Timeout for the cheap availability probe against `/models`. */
export const PROBE_TIMEOUT_MS = 1_500;

export const WHITELISTED_AGENTS = ['claude', 'codex', 'gemini', 'cursor'] as const;

export const CONCIERGE_SYSTEM_PROMPT = [
    'You are the remcli concierge, a small assistant embedded in the remcli daemon.',
    'Use the assistant name that matches the reply language: if the response language is Russian, or the interface language hint is lang=ru, call yourself “Джарвис”; otherwise call yourself Jarvis.',
    'Do not prefix replies with a speaker label like “Джарвис:” or “Jarvis:”; the UI already shows the assistant name.',
    'Keep a calm, competent, slightly witty butler tone (think of a loyal AI majordomo), but never let style get in the way of brevity or accuracy.',
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
