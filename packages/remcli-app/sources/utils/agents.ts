export const AGENTS = {
    CLAUDE: 'claude',
    CODEX: 'codex',
    CURSOR: 'cursor',
    GEMINI: 'gemini',
} as const;

export type AIAgent = typeof AGENTS[keyof typeof AGENTS];
export const AGENT_CYCLE: AIAgent[] = [AGENTS.CLAUDE, AGENTS.CODEX, AGENTS.CURSOR, AGENTS.GEMINI];
export const DEFAULT_AGENT: AIAgent = AGENTS.CLAUDE;

export function nextAgent(current: AIAgent, isAvailable: (agent: AIAgent) => boolean = () => true): AIAgent {
    const available = AGENT_CYCLE.filter(isAvailable);
    if (available.length === 0) return DEFAULT_AGENT;
    const idx = available.indexOf(current);
    return available[(idx + 1) % available.length];
}
