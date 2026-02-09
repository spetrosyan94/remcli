/**
 * AI Agent Constants
 *
 * Single source of truth for all supported AI agents in the CLI.
 * Used for subcommand routing, session metadata, profile compatibility, etc.
 */

export const AI_AGENTS = ['claude', 'codex', 'cursor', 'gemini'] as const;

export type AIAgent = typeof AI_AGENTS[number];

export const DEFAULT_AGENT: AIAgent = 'claude';

/** Check if a string is a valid agent name */
export function isValidAgent(value: string): value is AIAgent {
    return AI_AGENTS.includes(value as AIAgent);
}

/** Resolve agent from options with fallback to default */
export function resolveAgent(value: string | undefined): AIAgent {
    return value && isValidAgent(value) ? value : DEFAULT_AGENT;
}
