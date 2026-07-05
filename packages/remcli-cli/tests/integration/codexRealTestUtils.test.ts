import { afterEach, describe, expect, it } from 'vitest';

import {
    getRealCodexModel,
} from './codexRealTestUtils';

const ORIGINAL_REAL_CODEX_MODEL = process.env.REMCLI_REAL_CODEX_MODEL;

afterEach(() => {
    if (ORIGINAL_REAL_CODEX_MODEL === undefined) {
        delete process.env.REMCLI_REAL_CODEX_MODEL;
    } else {
        process.env.REMCLI_REAL_CODEX_MODEL = ORIGINAL_REAL_CODEX_MODEL;
    }
});

describe('codex real-test model helper', () => {
    it('uses gpt-5.4-mini by default for Remcli-launched real checks', () => {
        delete process.env.REMCLI_REAL_CODEX_MODEL;

        expect(getRealCodexModel()).toBe('gpt-5.4-mini');
    });

    it('allows explicit override for Remcli real checks', () => {
        process.env.REMCLI_REAL_CODEX_MODEL = 'gpt-5.5';

        expect(getRealCodexModel()).toBe('gpt-5.5');
    });
});
