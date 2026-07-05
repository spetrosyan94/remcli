import type { CodexToolResponse } from '@/codex/types';

const DEFAULT_REAL_CODEX_MODEL = 'gpt-5.3-codex-spark';
const FALLBACK_REAL_CODEX_MODEL = 'gpt-5.4-mini';

export function getRealCodexModelCandidates(): string[] {
    const primary = process.env.REMCLI_REAL_CODEX_MODEL || DEFAULT_REAL_CODEX_MODEL;
    const fallback = process.env.REMCLI_REAL_CODEX_FALLBACK_MODEL || FALLBACK_REAL_CODEX_MODEL;
    return primary === fallback ? [primary] : [primary, fallback];
}

export function responseText(response: CodexToolResponse): string {
    return response.content
        .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n');
}

export function isCodexUsageLimitError(error: unknown): boolean {
    const text = error instanceof Error ? error.message : String(error);
    return /usage limit/i.test(text) || /hit your .*limit/i.test(text);
}

export function expectTurnSucceeded(response: CodexToolResponse, phase: string, model: string): void {
    if (!response.isError) return;
    throw new Error(`Codex ${phase} failed on ${model}: ${responseText(response) || 'unknown app-server error'}`);
}

export async function withCodexModelFallback<T>(
    run: (model: string) => Promise<T>
): Promise<T> {
    const candidates = getRealCodexModelCandidates();
    const usageLimitErrors: string[] = [];

    for (const [index, model] of candidates.entries()) {
        try {
            return await run(model);
        } catch (error) {
            if (isCodexUsageLimitError(error) && index < candidates.length - 1) {
                usageLimitErrors.push(error instanceof Error ? error.message : String(error));
                continue;
            }
            if (usageLimitErrors.length > 0 && error instanceof Error) {
                error.message = `${error.message}\nPrevious model usage-limit errors:\n${usageLimitErrors.join('\n')}`;
            }
            throw error;
        }
    }

    throw new Error(`No Codex real-test model candidates were available: ${candidates.join(', ')}`);
}
