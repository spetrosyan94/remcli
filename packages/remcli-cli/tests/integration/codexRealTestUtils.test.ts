import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    getRealCodexModelCandidates,
    isCodexUsageLimitError,
    withCodexModelFallback,
} from './codexRealTestUtils';

const ORIGINAL_REAL_CODEX_MODEL = process.env.REMCLI_REAL_CODEX_MODEL;
const ORIGINAL_REAL_CODEX_FALLBACK_MODEL = process.env.REMCLI_REAL_CODEX_FALLBACK_MODEL;

afterEach(() => {
    if (ORIGINAL_REAL_CODEX_MODEL === undefined) {
        delete process.env.REMCLI_REAL_CODEX_MODEL;
    } else {
        process.env.REMCLI_REAL_CODEX_MODEL = ORIGINAL_REAL_CODEX_MODEL;
    }

    if (ORIGINAL_REAL_CODEX_FALLBACK_MODEL === undefined) {
        delete process.env.REMCLI_REAL_CODEX_FALLBACK_MODEL;
    } else {
        process.env.REMCLI_REAL_CODEX_FALLBACK_MODEL = ORIGINAL_REAL_CODEX_FALLBACK_MODEL;
    }
});

describe('codex real-test model fallback helpers', () => {
    it('uses Spark first and gpt-5.4-mini as the default fallback', () => {
        delete process.env.REMCLI_REAL_CODEX_MODEL;
        delete process.env.REMCLI_REAL_CODEX_FALLBACK_MODEL;

        expect(getRealCodexModelCandidates()).toEqual([
            'gpt-5.3-codex-spark',
            'gpt-5.4-mini',
        ]);
    });

    it('does not duplicate the candidate when primary and fallback are the same', () => {
        process.env.REMCLI_REAL_CODEX_MODEL = 'gpt-5.4-mini';
        delete process.env.REMCLI_REAL_CODEX_FALLBACK_MODEL;

        expect(getRealCodexModelCandidates()).toEqual(['gpt-5.4-mini']);
    });

    it('detects Codex usage-limit errors', () => {
        expect(isCodexUsageLimitError(new Error("You've hit your usage limit for GPT-5.3-Codex-Spark."))).toBe(true);
        expect(isCodexUsageLimitError(new Error('Timed out waiting for Codex turn to complete.'))).toBe(false);
    });

    it('retries the fallback model only for usage-limit failures', async () => {
        delete process.env.REMCLI_REAL_CODEX_MODEL;
        delete process.env.REMCLI_REAL_CODEX_FALLBACK_MODEL;
        const run = vi.fn(async (model: string) => {
            if (model === 'gpt-5.3-codex-spark') {
                throw new Error("You've hit your usage limit for GPT-5.3-Codex-Spark.");
            }
            return model;
        });

        await expect(withCodexModelFallback(run)).resolves.toBe('gpt-5.4-mini');
        expect(run).toHaveBeenCalledTimes(2);
        expect(run).toHaveBeenNthCalledWith(1, 'gpt-5.3-codex-spark');
        expect(run).toHaveBeenNthCalledWith(2, 'gpt-5.4-mini');
    });

    it('does not retry non-limit failures', async () => {
        const run = vi.fn(async () => {
            throw new Error('Session not found for thread_id: test');
        });

        await expect(withCodexModelFallback(run)).rejects.toThrow('Session not found');
        expect(run).toHaveBeenCalledTimes(1);
    });
});
