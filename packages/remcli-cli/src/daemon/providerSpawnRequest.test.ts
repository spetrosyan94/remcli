import { describe, expect, it } from 'vitest';

import {
    ProviderSpawnRequestError,
    parseProviderSpawnRequest,
} from './providerSpawnRequest';

describe('parseProviderSpawnRequest', () => {
    it('maps a valid Codex request into a provider-native contract', () => {
        expect(parseProviderSpawnRequest({
            type: 'spawn-in-directory',
            agent: 'codex',
            directory: '/workspace',
            permissionMode: 'workspace-write',
            codexExecution: {
                model: 'gpt-5.6-terra',
                reasoningEffort: 'high',
                catalogVersion: 'catalog-v1',
            },
        })).toEqual({
            agent: 'codex',
            directory: '/workspace',
            permissionMode: 'workspace-write',
            codexExecution: {
                model: 'gpt-5.6-terra',
                reasoningEffort: 'high',
                catalogVersion: 'catalog-v1',
            },
        });
    });

    it('maps a valid Antigravity request and requires both native control blocks', () => {
        expect(parseProviderSpawnRequest({
            type: 'spawn-in-directory',
            agent: 'antigravity',
            directory: '/workspace',
            antigravityExecution: {
                model: 'model-a-high',
                reasoningEffort: 'high',
                catalogVersion: 'catalog-v1',
            },
            antigravityLaunchControls: {
                mode: 'accept-edits',
                dangerouslySkipPermissions: false,
                sandbox: true,
            },
        })).toEqual({
            agent: 'antigravity',
            directory: '/workspace',
            antigravityExecution: {
                model: 'model-a-high',
                reasoningEffort: 'high',
                catalogVersion: 'catalog-v1',
            },
            antigravityLaunchControls: {
                mode: 'accept-edits',
                dangerouslySkipPermissions: false,
                sandbox: true,
            },
        });
    });

    it.each([
        { antigravityExecution: { model: 'model-a', catalogVersion: 'catalog-v1' } },
        { antigravityLaunchControls: { mode: 'default', dangerouslySkipPermissions: false, sandbox: false } },
        { antigravityExecution: { model: 'model-a', catalogVersion: 'catalog-v1' }, antigravityLaunchControls: { mode: 'default', sandbox: false } },
        { antigravityExecution: { model: 'model-a', catalogVersion: 'catalog-v1' }, antigravityLaunchControls: { mode: 'default', dangerouslySkipPermissions: false } },
        { antigravityExecution: { model: 'model-a', catalogVersion: 'catalog-v1' }, antigravityLaunchControls: { mode: 'default', dangerouslySkipPermissions: false, sandbox: 'inherit' } },
        { antigravityExecution: { model: 'model-a', catalogVersion: 'catalog-v1' }, antigravityLaunchControls: { mode: 'default', dangerouslySkipPermissions: false, sandbox: false, unknown: true } },
        { antigravityExecution: { model: 'model-a', catalogVersion: 'catalog-v1' }, antigravityLaunchControls: { mode: 'default', dangerouslySkipPermissions: false, sandbox: false }, permissionMode: 'plan' },
    ])('rejects incomplete or generic Antigravity controls', (controls) => {
        expect(() => parseProviderSpawnRequest({
            type: 'spawn-in-directory',
            agent: 'antigravity',
            directory: '/workspace',
            ...controls,
        })).toThrow(ProviderSpawnRequestError);
    });

    it('rejects environment variables from an Antigravity spawn request', () => {
        expect(() => parseProviderSpawnRequest({
            type: 'spawn-in-directory',
            agent: 'antigravity',
            directory: '/workspace',
            environmentVariables: {
                ANTHROPIC_MODEL: 'foreign-model-control',
            },
            antigravityExecution: {
                model: 'model-a',
                catalogVersion: 'catalog-v1',
            },
            antigravityLaunchControls: {
                mode: 'default',
                dangerouslySkipPermissions: false,
                sandbox: false,
            },
        })).toThrow(ProviderSpawnRequestError);
    });

    it('rejects accessor-backed and non-plain Antigravity launch controls without invoking them', () => {
        let didReadAccessor = false;
        const accessorControls = {
            mode: 'default',
            dangerouslySkipPermissions: false,
            get sandbox(): boolean {
                didReadAccessor = true;
                return false;
            },
        };
        const inheritedControls = Object.create({ sandbox: false }) as {
            mode: 'default';
            dangerouslySkipPermissions: false;
        };
        inheritedControls.mode = 'default';
        inheritedControls.dangerouslySkipPermissions = false;
        const execution = { model: 'model-a', catalogVersion: 'catalog-v1' };

        for (const antigravityLaunchControls of [accessorControls, inheritedControls]) {
            expect(() => parseProviderSpawnRequest({
                type: 'spawn-in-directory',
                agent: 'antigravity',
                directory: '/workspace',
                antigravityExecution: execution,
                antigravityLaunchControls,
            })).toThrow(ProviderSpawnRequestError);
        }
        expect(didReadAccessor).toBe(false);
    });

    it.each([
        ['missing envelope', {
            agent: 'claude',
            directory: '/workspace',
        }],
        ['unknown envelope', {
            type: 'spawn-in-project',
            agent: 'claude',
            directory: '/workspace',
        }],
        ['foreign transport field', {
            type: 'spawn-in-directory',
            agent: 'claude',
            directory: '/workspace',
            unexpectedTransportField: true,
        }],
    ])('rejects %s before provider-native parsing', (_caseName, request) => {
        expect(() => parseProviderSpawnRequest(request)).toThrow(ProviderSpawnRequestError);
    });

    it.each([
        { directory: '/workspace' },
        { agent: 'unknown', directory: '/workspace' },
        {
            type: 'spawn-in-directory',
            agent: 'claude',
            directory: '/workspace',
            codexExecution: { model: 'gpt-5.6-terra', catalogVersion: 'catalog-v1' },
        },
        {
            type: 'spawn-in-directory',
            agent: 'cursor',
            directory: '/workspace',
            cursorExecution: { model: 'cursor-model', catalogVersion: 'catalog-v1' },
            cursorLaunchControls: {
                executionMode: 'agent',
            },
            cursorRunner: { executable: 'agent', cliFingerprint: '0123456789abcdef' },
        },
    ])('rejects missing, unknown, or foreign provider data', (request) => {
        expect(() => parseProviderSpawnRequest(request)).toThrow(ProviderSpawnRequestError);
    });

    it('rejects inherited and accessor-backed provider fields', () => {
        const inheritedRequest = Object.create({ agent: 'claude' }) as { type: string; directory: string };
        inheritedRequest.type = 'spawn-in-directory';
        inheritedRequest.directory = '/workspace';
        const accessorRequest = {
            type: 'spawn-in-directory',
            directory: '/workspace',
            get agent(): string {
                return 'claude';
            },
        };

        expect(() => parseProviderSpawnRequest(inheritedRequest)).toThrow(ProviderSpawnRequestError);
        expect(() => parseProviderSpawnRequest(accessorRequest)).toThrow(ProviderSpawnRequestError);
    });

    it('rejects a nested Cursor accessor without invoking it', () => {
        let didReadAccessor = false;
        const cursorLaunchControls = {
            get executionMode(): string {
                didReadAccessor = true;
                return 'agent';
            },
        };

        expect(() => parseProviderSpawnRequest({
            type: 'spawn-in-directory',
            agent: 'cursor',
            directory: '/workspace',
            cursorExecution: { model: 'cursor-model', catalogVersion: 'catalog-v1' },
            cursorLaunchControls,
        })).toThrow(ProviderSpawnRequestError);
        expect(didReadAccessor).toBe(false);
    });
});
