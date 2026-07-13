import { afterEach, describe, expect, it } from 'vitest';

import {
    getRealCodexModel,
    getRealCodexReasoningEffort,
} from './codexRealTestUtils';

const ORIGINAL_REAL_CODEX_MODEL = process.env.REMCLI_REAL_CODEX_MODEL;
const ORIGINAL_REAL_CODEX_REASONING_EFFORT = process.env.REMCLI_REAL_CODEX_REASONING_EFFORT;

afterEach(() => {
    if (ORIGINAL_REAL_CODEX_MODEL === undefined) {
        delete process.env.REMCLI_REAL_CODEX_MODEL;
    } else {
        process.env.REMCLI_REAL_CODEX_MODEL = ORIGINAL_REAL_CODEX_MODEL;
    }

    if (ORIGINAL_REAL_CODEX_REASONING_EFFORT === undefined) {
        delete process.env.REMCLI_REAL_CODEX_REASONING_EFFORT;
    } else {
        process.env.REMCLI_REAL_CODEX_REASONING_EFFORT = ORIGINAL_REAL_CODEX_REASONING_EFFORT;
    }
});

describe('codex real-test policy helper', () => {
    it('uses gpt-5.6-luna with xhigh reasoning by default for Remcli-launched real checks', () => {
        delete process.env.REMCLI_REAL_CODEX_MODEL;
        delete process.env.REMCLI_REAL_CODEX_REASONING_EFFORT;

        expect(getRealCodexModel()).toBe('gpt-5.6-luna');
        expect(getRealCodexReasoningEffort()).toBe('xhigh');
    });

    it('allows explicit model override for Remcli real checks', () => {
        process.env.REMCLI_REAL_CODEX_MODEL = 'gpt-5.5';

        expect(getRealCodexModel()).toBe('gpt-5.5');
    });

    it('allows explicit reasoning effort override for Remcli real checks', () => {
        process.env.REMCLI_REAL_CODEX_REASONING_EFFORT = 'medium';

        expect(getRealCodexReasoningEffort()).toBe('medium');
    });
});
