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
                force: false,
                autoReview: false,
                sandbox: 'local-configuration',
                approveMcps: false,
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
            executionMode: 'agent',
            get force(): boolean {
                didReadAccessor = true;
                return false;
            },
            autoReview: false,
            sandbox: 'local-configuration',
            approveMcps: false,
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
