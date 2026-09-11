import { describe, expect, it, vi } from 'vitest';
import type { SessionModelState } from '@agentclientprotocol/sdk';

import {
    CursorCapabilitiesError,
    CursorCapabilitiesService,
    createCursorCapabilitiesSnapshot,
    getDefaultCursorExecution,
    normalizeCursorAcpModels,
    validateCursorExecution,
    type CursorAcpCatalogResult,
} from './cursorCapabilities';

const ACP_MODELS: SessionModelState = {
    availableModels: [
        { modelId: 'gpt-5.6-luna[reasoning=medium,fast=false]', name: 'GPT-5.6 Luna' },
        { modelId: 'claude-opus-5[thinking=true,effort=high]', name: 'Claude Opus 5' },
    ],
    currentModelId: 'gpt-5.6-luna[reasoning=medium,fast=false]',
};

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

function createCatalogResult(models: SessionModelState = ACP_MODELS): CursorAcpCatalogResult {
    return { executable: 'agent', version: 'controlled-cursor-agent 1.0.0', models };
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

describe('normalizeCursorAcpModels', () => {
    it('preserves exact ACP model IDs and marks only the current model as default', () => {
        expect(normalizeCursorAcpModels(ACP_MODELS)).toEqual([
            {
                id: 'gpt-5.6-luna[reasoning=medium,fast=false]',
                displayName: 'GPT-5.6 Luna',
                isDefault: true,
            },
            {
                id: 'claude-opus-5[thinking=true,effort=high]',
                displayName: 'Claude Opus 5',
                isDefault: false,
            },
        ]);
    });

    it.each([
        ['no advertised models', { availableModels: [], currentModelId: 'one' }],
        ['an empty model ID', { availableModels: [{ modelId: '', name: 'One' }], currentModelId: '' }],
        ['an empty display name', { availableModels: [{ modelId: 'one', name: '  ' }], currentModelId: 'one' }],
        ['a duplicate model ID', { availableModels: [{ modelId: 'one', name: 'One' }, { modelId: 'one', name: 'Other' }], currentModelId: 'one' }],
        ['a missing current model', { availableModels: [{ modelId: 'one', name: 'One' }], currentModelId: 'two' }],
        ['a current ID with surrounding whitespace', { availableModels: [{ modelId: 'one', name: 'One' }], currentModelId: ' one' }],
    ] as const)('fails closed for %s', (_caseName, modelState) => {
        expect(() => normalizeCursorAcpModels(modelState as unknown as SessionModelState)).toThrow();
    });
});

describe('Cursor capability snapshot validation', () => {
    it('accepts only an exact, unexpired ACP selection', () => {
        const snapshot = createCursorCapabilitiesSnapshot(ACP_MODELS, () => 1_000, 5_000);
        const execution = getDefaultCursorExecution(snapshot);

        expect(execution).toEqual({
            model: 'gpt-5.6-luna[reasoning=medium,fast=false]',
            catalogVersion: snapshot.catalogVersion,
        });
        expect(() => validateCursorExecution(snapshot, execution ?? undefined, 1_001)).not.toThrow();
        expectCapabilityError(() => validateCursorExecution(snapshot, {
            ...execution!,
            catalogVersion: 'stale-catalog',
        }, 1_001), 'expired');
        expectCapabilityError(() => validateCursorExecution(snapshot, {
            ...execution!,
            model: 'gpt-5.6-luna-xhigh',
        }, 1_001), 'unsupported_selection');
        expectCapabilityError(() => validateCursorExecution(snapshot, execution ?? undefined, 6_000), 'expired');
    });

    it('binds the catalog version to the verified CLI identity', () => {
        const agentSnapshot = createCursorCapabilitiesSnapshot(
            ACP_MODELS,
            () => 1_000,
            5_000,
            { executable: 'agent', cliFingerprint: '0123456789abcdef' },
        );
        const fallbackSnapshot = createCursorCapabilitiesSnapshot(
            ACP_MODELS,
            () => 1_000,
            5_000,
            { executable: 'cursor-agent', cliFingerprint: 'fedcba9876543210' },
        );

        expect(agentSnapshot.catalogVersion).not.toBe(fallbackSnapshot.catalogVersion);
    });
});

describe('CursorCapabilitiesService', () => {
    it('caches a ready discovery and refreshes it only after its TTL expires', async () => {
        let now = 1_000;
        const readCatalog = vi.fn(async () => createCatalogResult());
        const service = new CursorCapabilitiesService({
            readCatalog,
            now: () => now,
            cacheTtlMs: 5_000,
        });

        const first = await service.getCapabilities();
        const cached = await service.getCapabilities();
        now = 6_000;
        const refreshed = await service.getCapabilities();

        expect(first).toBe(cached);
        expect(refreshed).not.toBe(first);
        expect(readCatalog).toHaveBeenCalledTimes(2);
    });

    it('coalesces concurrent discovery and validates a fresh selection without another ACP session', async () => {
        const initial = createDeferred<CursorAcpCatalogResult>();
        const readCatalog = vi.fn(() => initial.promise);
        const service = new CursorCapabilitiesService({
            readCatalog,
            now: () => 1_000,
            cacheTtlMs: 5_000,
        });

        const first = service.getCapabilities();
        const second = service.getCapabilities();
        expect(readCatalog).toHaveBeenCalledOnce();

        initial.resolve(createCatalogResult());
        const snapshot = await first;
        await expect(second).resolves.toBe(snapshot);

        await service.validateSelection(getDefaultCursorExecution(snapshot) ?? undefined);
        expect(readCatalog).toHaveBeenCalledOnce();
    });

    it('refreshes an expired catalog before validating selection', async () => {
        let now = 1_000;
        const readCatalog = vi.fn(async () => createCatalogResult());
        const service = new CursorCapabilitiesService({
            readCatalog,
            now: () => now,
            cacheTtlMs: 5_000,
        });
        const first = await service.getCapabilities();
        now = 6_000;

        await expect(service.validateSelection(getDefaultCursorExecution(first) ?? undefined)).resolves.toEqual({
            executable: 'agent',
            cliFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
        });
        expect(readCatalog).toHaveBeenCalledTimes(2);
    });

    it('returns the current ACP identity only with a freshly validated provider default', async () => {
        const service = new CursorCapabilitiesService({
            readCatalog: async () => createCatalogResult(),
            now: () => 1_000,
        });

        const selection = await service.getDefaultSelection();

        expect(selection).toEqual({
            execution: {
                model: 'gpt-5.6-luna[reasoning=medium,fast=false]',
                catalogVersion: expect.any(String),
            },
            runner: {
                executable: 'agent',
                cliFingerprint: expect.stringMatching(/^[a-f0-9]{16}$/),
            },
        });
    });

    it('returns a typed unavailable snapshot without surfacing raw ACP failure details', async () => {
        const service = new CursorCapabilitiesService({
            readCatalog: async () => {
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
