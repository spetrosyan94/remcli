import type { CodexToolResponse } from '@/codex/types';

const DEFAULT_REAL_CODEX_MODEL = 'gpt-5.4-mini';

export function getRealCodexModel(): string {
    return process.env.REMCLI_REAL_CODEX_MODEL || DEFAULT_REAL_CODEX_MODEL;
}

export function responseText(response: CodexToolResponse): string {
    return response.content
        .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n');
}

export function expectTurnSucceeded(response: CodexToolResponse, phase: string, model: string): void {
    if (!response.isError) return;
    throw new Error(`Codex ${phase} failed on ${model}: ${responseText(response) || 'unknown app-server error'}`);
}
