import { describe, expect, it, vi } from 'vitest';

import {
    CursorCapabilitiesError,
    CursorCapabilitiesService,
    createCursorCapabilitiesSnapshot,
    getDefaultCursorExecution,
    parseCursorModelList,
    validateCursorExecution,
    type CursorModelListResult,
} from './cursorCapabilities';

const MODEL_LIST_OUTPUT = [
    'Available models',
    '',
    'auto - Auto (default)',
    'gpt-5.6-luna-xhigh - GPT-5.6 Luna 1M Extra High',
    '',
    'Tip: use --model <id> (or /model <id> in interactive mode) to switch.',
].join('\n');

const CURRENT_DEFAULT_MODEL_LIST_OUTPUT = MODEL_LIST_OUTPUT.replace(
    'Auto (default)',
    'Auto (current, default)',
);

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
    let resolvePromise!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function createModelListResult(output: string = MODEL_LIST_OUTPUT): CursorModelListResult {
    return { executable: 'agent', output };
}

function expectCapabilityError(action: () => void, code: CursorCapabilitiesError['code']): void {
    let thrown: unknown;
    try {
        action();
    } catch (error) {
        thrown = error;
    }
    expect(thrown).toBeInstanceOf(CursorCapabilitiesError);
    expect((thrown as CursorCapabilitiesError).code).toBe(code);
}

describe('parseCursorModelList', () => {
    it('parses the verified `agent models` layout without exposing the raw list', () => {
        expect(parseCursorModelList(MODEL_LIST_OUTPUT)).toEqual([
            { id: 'auto', displayName: 'Auto', isDefault: true },
            {
                id: 'gpt-5.6-luna-xhigh',
                displayName: 'GPT-5.6 Luna 1M Extra High',
                isDefault: false,
            },
        ]);
    });

    it('accepts the current Cursor CLI default marker without treating the current state as a model name', () => {
        expect(parseCursorModelList(CURRENT_DEFAULT_MODEL_LIST_OUTPUT)).toEqual([
            { id: 'auto', displayName: 'Auto', isDefault: true },
            {
                id: 'gpt-5.6-luna-xhigh',
                displayName: 'GPT-5.6 Luna 1M Extra High',
                isDefault: false,
            },
        ]);
    });

    it.each([
        ['an unexpected header', MODEL_LIST_OUTPUT.replace('Available models', 'Models available')],
        ['a missing recognized footer', MODEL_LIST_OUTPUT.replace(/\nTip:.+$/, '')],
        ['a malformed model row', MODEL_LIST_OUTPUT.replace('gpt-5.6-luna-xhigh -', 'gpt 5.6 luna -')],
        ['a duplicate model ID', MODEL_LIST_OUTPUT.replace('gpt-5.6-luna-xhigh -', 'auto -')],
        ['more than one default', MODEL_LIST_OUTPUT.replace('GPT-5.6 Luna 1M Extra High', 'GPT-5.6 Luna 1M Extra High (default)')],
        ['no explicit provider default', MODEL_LIST_OUTPUT.replace('Auto (default)', 'Auto')],
        [
            'an unknown provider default status marker',
            MODEL_LIST_OUTPUT.replace(
                'GPT-5.6 Luna 1M Extra High',
                'GPT-5.6 Luna 1M Extra High (default, current)',
            ),
        ],
        [
            'a nested unknown provider default status marker',
            MODEL_LIST_OUTPUT.replace(
                'GPT-5.6 Luna 1M Extra High',
                'GPT-5.6 Luna 1M Extra High (default (current))',
            ),
        ],
        [
            'a double-wrapped unknown provider default status marker',
            MODEL_LIST_OUTPUT.replace(
                'GPT-5.6 Luna 1M Extra High',
                'GPT-5.6 Luna 1M Extra High ((default))',
            ),
        ],
        [
            'an unknown provider default status marker without a separator',
            MODEL_LIST_OUTPUT.replace(
                'GPT-5.6 Luna 1M Extra High',
                'GPT-5.6 Luna 1M Extra High(default, current)',
            ),
        ],
        [
            'an unknown provider default status marker after a tab',
            MODEL_LIST_OUTPUT.replace(
                'GPT-5.6 Luna 1M Extra High',
                'GPT-5.6 Luna 1M Extra High\t(default, current)',
            ),
        ],
    ] as const)('fails closed for %s', (_caseName, output) => {
        expect(() => parseCursorModelList(output)).toThrow();
    });
});

describe('Cursor capability snapshot validation', () => {
    it('accepts only an exact, unexpired provider model selection', () => {
        const snapshot = createCursorCapabilitiesSnapshot(MODEL_LIST_OUTPUT, () => 1_000, 5_000);
        const execution = getDefaultCursorExecution(snapshot);

        expect(execution).toEqual({ model: 'auto', catalogVersion: snapshot.catalogVersion });
        expect(() => validateCursorExecution(snapshot, execution ?? undefined, 1_001)).not.toThrow();
        expectCapabilityError(() => validateCursorExecution(snapshot, {
            ...execution!,
            catalogVersion: 'stale-catalog',
        }, 1_001), 'expired');
        expectCapabilityError(() => validateCursorExecution(snapshot, {
            ...execution!,
            model: 'not-account-visible',
        }, 1_001), 'unsupported_selection');
        expectCapabilityError(() => validateCursorExecution(snapshot, execution ?? undefined, 6_000), 'expired');
    });
});

describe('CursorCapabilitiesService', () => {
    it('caches a ready discovery until its TTL expires and then refreshes it', async () => {
        let now = 1_000;
        const readModelList = vi.fn(async () => createModelListResult());
        const service = new CursorCapabilitiesService({
            readModelList,
            now: () => now,
            cacheTtlMs: 5_000,
        });

        const first = await service.getCapabilities();
        const cached = await service.getCapabilities();
        now = 6_000;
        const refreshed = await service.getCapabilities();

        expect(first).toBe(cached);
        expect(refreshed).not.toBe(first);
        expect(readModelList).toHaveBeenCalledTimes(2);
    });

    it('coalesces concurrent discovery and fresh validation before spawn', async () => {
        const initial = createDeferred<CursorModelListResult>();
        const readModelList = vi.fn(() => initial.promise);
        const service = new CursorCapabilitiesService({
            readModelList,
            now: () => 1_000,
            cacheTtlMs: 5_000,
        });

        const first = service.getCapabilities();
        const second = service.getCapabilities();
        expect(readModelList).toHaveBeenCalledOnce();

        initial.resolve(createModelListResult());
        const snapshot = await first;
        await expect(second).resolves.toBe(snapshot);

        await service.validateSelection(getDefaultCursorExecution(snapshot) ?? undefined);
        expect(readModelList).toHaveBeenCalledTimes(2);
    });

    it('returns a typed unavailable snapshot without surfacing raw CLI failure output', async () => {
        const service = new CursorCapabilitiesService({
            readModelList: async () => {
                throw new Error('private provider failure: account=sergey@example.test token=secret');
            },
        });

        const snapshot = await service.getCapabilities();

        expect(snapshot).toEqual({
            agent: 'cursor',
            status: 'unavailable',
            fetchedAt: null,
            expiresAt: null,
            catalogVersion: null,
            models: [],
            errorCode: 'unavailable',
        });
        expect(JSON.stringify(snapshot)).not.toContain('sergey@example.test');
        expect(JSON.stringify(snapshot)).not.toContain('secret');
    });
});
