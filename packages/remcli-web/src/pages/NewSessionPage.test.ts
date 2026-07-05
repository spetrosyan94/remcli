import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let agentOptions: Array<{ id: string; models: string[] }> = [];
let getModelOverride = (_model: string): string | null => {
    throw new Error('NewSessionPage module was not loaded');
};
let modelOverrideState = (_model: string, _hasExplicitModelSelection: boolean): { model?: string | null } => {
    throw new Error('NewSessionPage module was not loaded');
};

beforeAll(async () => {
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
    });
    vi.stubGlobal('navigator', {
        language: 'en-US',
        languages: ['en-US'],
    });

    const pageModule = await import('@/pages/NewSessionPage');
    agentOptions = pageModule.AGENT_OPTIONS;
    getModelOverride = pageModule.getModelOverride;
    modelOverrideState = pageModule.modelOverrideState;
});

afterAll(() => {
    vi.unstubAllGlobals();
});

describe('NewSessionPage model selection', () => {
    it('uses Codex default without a concrete model override', () => {
        const codex = agentOptions.find((option) => option.id === 'codex');

        expect(codex?.models[0]).toBe('default');
        expect(getModelOverride(codex?.models[0] ?? '')).toBeNull();
    });

    it('does not send model metadata for the initial default selection', () => {
        expect(modelOverrideState('default', false)).toEqual({});
    });

    it('sends explicit default as a deliberate model reset only after user selection', () => {
        expect(modelOverrideState('default', true)).toEqual({ model: null });
    });

    it('exposes current Codex model choices after default', () => {
        const codex = agentOptions.find((option) => option.id === 'codex');

        expect(codex?.models).toEqual([
            'default',
            'gpt-5.5',
            'gpt-5.4',
            'gpt-5.4-mini',
            'gpt-5.3-codex-spark'
        ]);
    });

    it('does not expose stale Codex model ids', () => {
        const codex = agentOptions.find((option) => option.id === 'codex');

        expect(codex?.models).not.toContain('gpt-5.3-codex');
        expect(codex?.models).not.toContain('gpt-5.2');
        expect(codex?.models).not.toContain('gpt-5.1-codex-mini');
    });

    it('keeps explicit non-default model overrides intact', () => {
        expect(getModelOverride('sonnet')).toBe('sonnet');
    });
});
