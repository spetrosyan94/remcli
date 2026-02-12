import type { ModelMode, PermissionMode } from '@/components/PermissionModeSelector';

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

// ---------------------------------------------------------------------------
//  Model configuration per agent
// ---------------------------------------------------------------------------

/** Single model option displayed in the selector UI */
export interface AgentModelOption {
    value: ModelMode;
    /** Brand name displayed as-is. Empty string = use translated "Default" label */
    label: string;
    /** Key suffix for t('agentInput.model.${descriptionKey}') */
    descriptionKey: 'defaultDesc' | 'mostCapable' | 'balanced' | 'fast' | 'fastest';
}

/** Full model config for an agent */
export interface AgentModelConfig {
    /** Options shown in the model selector UI */
    options: readonly AgentModelOption[];
    /** Default model when none selected or after agent switch */
    defaultMode: ModelMode;
    /** All valid model values (includes options + hidden modes like adaptiveUsage) */
    validModes: readonly ModelMode[];
}

export const AGENT_MODELS: Record<AIAgent, AgentModelConfig> = {
    claude: {
        options: [
            { value: 'default', label: '', descriptionKey: 'defaultDesc' },
            { value: 'sonnet', label: 'Claude Sonnet', descriptionKey: 'balanced' },
            { value: 'opus', label: 'Claude Opus', descriptionKey: 'mostCapable' },
            { value: 'haiku', label: 'Claude Haiku', descriptionKey: 'fastest' },
        ],
        defaultMode: 'default',
        validModes: ['default', 'adaptiveUsage', 'sonnet', 'opus', 'haiku'],
    },
    codex: {
        options: [
            { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', descriptionKey: 'mostCapable' },
            { value: 'gpt-5.3', label: 'GPT-5.3', descriptionKey: 'balanced' },
        ],
        defaultMode: 'gpt-5.3-codex',
        validModes: ['gpt-5.3-codex', 'gpt-5.3'],
    },
    cursor: {
        options: [
            { value: 'default', label: '', descriptionKey: 'defaultDesc' },
            { value: 'opus-4.6', label: 'Claude 4.6 Opus', descriptionKey: 'mostCapable' },
            { value: 'composer-1.5', label: 'Composer 1.5', descriptionKey: 'balanced' },
            { value: 'gemini-3-pro', label: 'Gemini 3 Pro', descriptionKey: 'fast' },
            { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', descriptionKey: 'fast' },
        ],
        defaultMode: 'default',
        validModes: ['default', 'opus-4.6', 'composer-1.5', 'gemini-3-pro', 'gpt-5.3-codex'],
    },
    gemini: {
        options: [
            { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', descriptionKey: 'balanced' },
            { value: 'gemini-3-pro', label: 'Gemini 3 Pro', descriptionKey: 'mostCapable' },
            { value: 'gemini-3-flash', label: 'Gemini 3 Flash', descriptionKey: 'fast' },
        ],
        defaultMode: 'gemini-2.5-pro',
        validModes: ['gemini-2.5-pro', 'gemini-3-pro', 'gemini-3-flash'],
    },
};

// ---------------------------------------------------------------------------
//  Permission mode configuration per agent
// ---------------------------------------------------------------------------

export const AGENT_PERMISSIONS: Record<AIAgent, readonly PermissionMode[]> = {
    claude: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
    codex: ['default', 'read-only', 'safe-yolo', 'yolo'],
    cursor: ['default', 'plan', 'read-only', 'yolo'],
    gemini: ['default', 'read-only', 'safe-yolo', 'yolo'],
};

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------

/** Check if a model mode is valid for a given agent */
export function isValidModelForAgent(agent: AIAgent, mode: ModelMode): boolean {
    return AGENT_MODELS[agent]?.validModes.includes(mode) ?? false;
}

/** Check if a permission mode is valid for a given agent */
export function isValidPermissionForAgent(agent: AIAgent, mode: PermissionMode): boolean {
    return AGENT_PERMISSIONS[agent]?.includes(mode) ?? false;
}

/** Get default model for an agent */
export function getDefaultModel(agent: AIAgent): ModelMode {
    return AGENT_MODELS[agent]?.defaultMode ?? 'default';
}
