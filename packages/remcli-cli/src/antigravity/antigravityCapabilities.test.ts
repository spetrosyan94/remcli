import { describe, expect, it, vi } from 'vitest';
import {
    AntigravityCapabilitiesError,
    AntigravityCapabilitiesService,
    createAntigravityCapabilitiesSnapshot,
    getDefaultAntigravityExecution,
    parseAntigravityModels,
    validateAntigravityExecution,
    validateAntigravitySpawnSelection,
    type AntigravityCapabilitiesSnapshot,
} from './antigravityCapabilities';

const catalog = 'gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)';
const source = { version: '1.2.2', modelsOutput: catalog, currentModelOutput: 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\n' };

describe('Antigravity capabilities', () => {
    it('parses and normalizes account-visible variants exactly', () => {
        const snapshot = createAntigravityCapabilitiesSnapshot(source, () => 1_000, 5_000);
        expect(snapshot.models).toEqual([
            expect.objectContaining({ id: 'claude-sonnet-4-6', supportedReasoningEfforts: [], isDefault: false }),
            expect.objectContaining({ id: 'gemini-3.8-flash', supportedReasoningEfforts: ['high', 'low', 'medium'], isDefault: true, runtimeModels: { high: 'gemini-3.8-flash-high', medium: 'gemini-3.8-flash-medium', low: 'gemini-3.8-flash-low' } }),
        ]);
        expect(getDefaultAntigravityExecution(snapshot)).toMatchObject({ model: 'gemini-3.8-flash-medium', reasoningEffort: 'medium' });
    });

    it.each(['bad line', 'x\tname\textra', 'x\t', 'x\tname\nx\tother'])('rejects malformed or duplicate catalog: %s', (modelsOutput) => {
        expect(() => parseAntigravityModels(modelsOutput)).toThrow();
    });

    it('fails closed on stale and unsupported selections', () => {
        const snapshot = createAntigravityCapabilitiesSnapshot(source, () => 1_000, 5_000);
        const execution = getDefaultAntigravityExecution(snapshot)!;
        expect(() => validateAntigravityExecution(snapshot, execution, 1_001)).not.toThrow();
        expect(() => validateAntigravityExecution(snapshot, execution, 6_000)).toThrowError(AntigravityCapabilitiesError);
        expect(() => validateAntigravityExecution(snapshot, { ...execution, reasoningEffort: 'high', model: 'gemini-3.8-flash-high' }, 1_001)).not.toThrow();
        expect(() => validateAntigravityExecution(snapshot, { ...execution, reasoningEffort: 'high', model: 'gemini-3.8-flash-medium' }, 1_001)).toThrowError(AntigravityCapabilitiesError);
        expect(() => validateAntigravityExecution(snapshot, { model: 'gemini-3.8-flash', catalogVersion: snapshot.catalogVersion! }, 1_001)).toThrowError(AntigravityCapabilitiesError);
        const standalone = createAntigravityCapabilitiesSnapshot({
            ...source,
            modelsOutput: 'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
            currentModelOutput: 'claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)',
        });
        expect(() => validateAntigravityExecution({ ...standalone, expiresAt: 10_000 }, { model: 'claude-sonnet-4-6', catalogVersion: standalone.catalogVersion! }, 1_001)).not.toThrow();
        expect(() => createAntigravityCapabilitiesSnapshot({ ...source, version: 'not-semver' })).toThrow();
    });

    it('requires an exact effort for variants and no effort for standalone models', () => {
        const snapshot = createAntigravityCapabilitiesSnapshot(source, () => 1_000, 5_000);
        const catalogVersion = snapshot.catalogVersion!;

        expect(() => validateAntigravityExecution(snapshot, {
            model: 'gemini-3.8-flash-high',
            catalogVersion,
        }, 1_001)).toThrowError(AntigravityCapabilitiesError);
        expect(() => validateAntigravityExecution(snapshot, {
            model: 'gemini-3.8-flash-high',
            reasoningEffort: 'medium',
            catalogVersion,
        }, 1_001)).toThrowError(AntigravityCapabilitiesError);
        expect(() => validateAntigravityExecution(snapshot, {
            model: 'gemini-3.8-flash-high',
            reasoningEffort: 'high',
            catalogVersion,
        }, 1_001)).not.toThrow();
        expect(() => validateAntigravityExecution(snapshot, {
            model: 'claude-sonnet-4-6',
            reasoningEffort: 'high',
            catalogVersion,
        }, 1_001)).toThrowError(AntigravityCapabilitiesError);
        expect(() => validateAntigravityExecution(snapshot, {
            model: 'claude-sonnet-4-6',
            catalogVersion,
        }, 1_001)).not.toThrow();
    });

    it('validates execution and launch controls against one capability snapshot', () => {
        const discovered = createAntigravityCapabilitiesSnapshot(source, () => 1_000, 5_000);
        const snapshot: AntigravityCapabilitiesSnapshot = {
            ...discovered,
            executionModes: ['default'],
            supportsDangerouslySkipPermissions: false,
            supportsSandbox: false,
        };
        const execution = getDefaultAntigravityExecution(snapshot)!;

        expect(validateAntigravitySpawnSelection(snapshot, execution, {
            mode: 'default',
            dangerouslySkipPermissions: false,
            sandbox: false,
        }, 1_001)).toEqual({
            execution,
            launchControls: { mode: 'default', dangerouslySkipPermissions: false, sandbox: false },
        });
        expect(() => validateAntigravitySpawnSelection(snapshot, execution, {
            mode: 'accept-edits',
            dangerouslySkipPermissions: false,
            sandbox: false,
        }, 1_001)).toThrowError(AntigravityCapabilitiesError);
        expect(() => validateAntigravitySpawnSelection(snapshot, execution, {
            mode: 'default',
            dangerouslySkipPermissions: true,
            sandbox: false,
        }, 1_001)).toThrowError(AntigravityCapabilitiesError);
        expect(() => validateAntigravitySpawnSelection(snapshot, execution, {
            mode: 'default',
            dangerouslySkipPermissions: false,
            sandbox: true,
        }, 1_001)).toThrowError(AntigravityCapabilitiesError);
    });

    it('parses the current model as strict TSV and rejects malformed current output', () => {
        expect(() => createAntigravityCapabilitiesSnapshot({ ...source, currentModelOutput: 'gemini-3.8-flash-medium\n' })).toThrow();
        expect(() => createAntigravityCapabilitiesSnapshot({ ...source, currentModelOutput: `${source.currentModelOutput}gemini-3.8-flash-low\tGemini 3.8 Flash (Low)` })).toThrow();
        expect(() => createAntigravityCapabilitiesSnapshot({
            ...source,
            currentModelOutput: 'gemini-3.8-flash\tGemini 3.8 Flash\n',
        })).toThrow('not in the account-visible catalog');
    });

    it('keeps a suffix-mismatched display as an independent model', () => {
        const snapshot = createAntigravityCapabilitiesSnapshot({
            ...source,
            modelsOutput: 'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\ngemini-3.8-flash-high\tGemini 3.8 Flash (Experimental)',
            currentModelOutput: 'gemini-3.8-flash-high\tGemini 3.8 Flash (Experimental)',
        });
        expect(snapshot.models.map((model) => model.id)).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash-high']);
        expect(snapshot.models.find((model) => model.id === 'gemini-3.8-flash-high')).toMatchObject({ supportedReasoningEfforts: [] });
    });

    it('accepts future patch/minor semver and fingerprints the actual version', () => {
        const future = createAntigravityCapabilitiesSnapshot({ ...source, version: '1.3.0' });
        const futurePatch = createAntigravityCapabilitiesSnapshot({ ...source, version: '1.2.3' });
        expect(future.status).toBe('ready');
        expect(future.catalogVersion).not.toBe(futurePatch.catalogVersion);
        for (const version of ['1.2.1', '2.0.0']) {
            expect(() => createAntigravityCapabilitiesSnapshot({ ...source, version })).toThrow();
        }
    });

    it('returns unavailable after a discovery timeout and never exposes stale data', async () => {
        const service = new AntigravityCapabilitiesService({ readCatalog: () => Promise.reject(new Error('timeout')), now: () => 1_000 });
        await expect(service.getCapabilities()).resolves.toMatchObject({ status: 'unavailable', errorCode: 'unavailable', models: [] });
    });

    it('invalidates a previously cached catalog when a forced refresh fails', async () => {
        const readCatalog = vi.fn()
            .mockResolvedValueOnce(source)
            .mockRejectedValue(new Error('timeout'));
        const service = new AntigravityCapabilitiesService({ readCatalog, now: () => 1_000 });

        await expect(service.getCapabilities()).resolves.toMatchObject({ status: 'ready' });
        await expect(service.getCapabilities(true)).resolves.toMatchObject({ status: 'unavailable' });
        await expect(service.getCapabilities()).resolves.toMatchObject({ status: 'unavailable' });
        expect(readCatalog).toHaveBeenCalledTimes(3);
    });

    it('uses the exact three discovery commands and no model request', async () => {
        const calls: string[][] = [];
        const run = vi.fn(async (command: { args: string[] }) => {
            calls.push(command.args);
            if (command.args[0] === '--version') return { stdout: '1.2.2\n', stderr: '' };
            if (command.args[0] === 'models') return { stdout: catalog, stderr: '' };
            return { stdout: 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n', stderr: '' };
        });
        const service = new AntigravityCapabilitiesService({ run });
        await expect(service.getCapabilities()).resolves.toMatchObject({ status: 'ready' });
        expect(calls).toEqual([['--version'], ['models'], ['-p', '/model']]);
    });

    it('returns the validated exact runtime selection to the daemon', async () => {
        const service = new AntigravityCapabilitiesService({ readCatalog: async () => source, now: () => 1_000 });
        const snapshot = await service.getCapabilities();
        const execution = getDefaultAntigravityExecution(snapshot)!;
        await expect(service.validateSelection(execution)).resolves.toEqual(execution);
    });

    it('refreshes once and atomically validates a spawn selection', async () => {
        const service = new AntigravityCapabilitiesService({ readCatalog: async () => source, now: () => 1_000 });
        const snapshot = createAntigravityCapabilitiesSnapshot(source, () => 1_000);
        const getCapabilities = vi.spyOn(service, 'getCapabilities').mockResolvedValue(snapshot);
        const execution = getDefaultAntigravityExecution(snapshot)!;
        const launchControls = { mode: 'plan', dangerouslySkipPermissions: true, sandbox: true } as const;

        await expect(service.validateSpawnSelection(execution, launchControls)).resolves.toEqual({
            execution,
            launchControls,
        });
        expect(getCapabilities).toHaveBeenCalledOnce();
        expect(getCapabilities).toHaveBeenCalledWith(true);
    });

    it('rejects unsupported launch controls from the same refreshed snapshot', async () => {
        const service = new AntigravityCapabilitiesService({ readCatalog: async () => source, now: () => 1_000 });
        const discovered = createAntigravityCapabilitiesSnapshot(source, () => 1_000);
        const snapshot: AntigravityCapabilitiesSnapshot = {
            ...discovered,
            executionModes: ['default'],
            supportsDangerouslySkipPermissions: false,
            supportsSandbox: false,
        };
        const getCapabilities = vi.spyOn(service, 'getCapabilities').mockResolvedValue(snapshot);
        const execution = getDefaultAntigravityExecution(snapshot)!;

        await expect(service.validateSpawnSelection(execution, {
            mode: 'accept-edits',
            dangerouslySkipPermissions: false,
            sandbox: false,
        })).rejects.toMatchObject({ code: 'unsupported_selection' });
        await expect(service.validateSpawnSelection(execution, {
            mode: 'default',
            dangerouslySkipPermissions: true,
            sandbox: false,
        })).rejects.toMatchObject({ code: 'unsupported_selection' });
        await expect(service.validateSpawnSelection(execution, {
            mode: 'default',
            dangerouslySkipPermissions: false,
            sandbox: true,
        })).rejects.toMatchObject({ code: 'unsupported_selection' });
        expect(getCapabilities).toHaveBeenCalledTimes(3);
        expect(getCapabilities).toHaveBeenCalledWith(true);
    });
});
