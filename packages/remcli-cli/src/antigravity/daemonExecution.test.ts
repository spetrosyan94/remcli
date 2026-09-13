import { describe, expect, it } from 'vitest';

import { getAntigravityDaemonRunOptions } from './daemonExecution';

describe('getAntigravityDaemonRunOptions', () => {
    it('reads the complete daemon-owned execution tuple', () => {
        expect(getAntigravityDaemonRunOptions('daemon', {
            REMCLI_ANTIGRAVITY_MODEL: 'gemini-3.8-flash-high',
            REMCLI_ANTIGRAVITY_CATALOG_VERSION: 'catalog-v1',
            REMCLI_ANTIGRAVITY_REASONING_EFFORT: 'high',
            REMCLI_ANTIGRAVITY_MODE: 'accept-edits',
            REMCLI_ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS: 'false',
            REMCLI_ANTIGRAVITY_SANDBOX: 'true',
        })).toEqual({
            execution: {
                model: 'gemini-3.8-flash-high',
                catalogVersion: 'catalog-v1',
                reasoningEffort: 'high',
            },
            launchControls: {
                mode: 'accept-edits',
                dangerouslySkipPermissions: false,
                sandbox: true,
            },
        });
    });

    it('does not expose daemon launch state to terminal-owned runs', () => {
        expect(getAntigravityDaemonRunOptions('terminal', {
            REMCLI_ANTIGRAVITY_MODEL: 'model-a',
            REMCLI_ANTIGRAVITY_CATALOG_VERSION: 'catalog-v1',
            REMCLI_ANTIGRAVITY_MODE: 'default',
            REMCLI_ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS: 'true',
            REMCLI_ANTIGRAVITY_SANDBOX: 'false',
        })).toEqual({});
    });

    it.each([
        {},
        {
            REMCLI_ANTIGRAVITY_MODEL: 'model-a',
            REMCLI_ANTIGRAVITY_CATALOG_VERSION: 'catalog-v1',
            REMCLI_ANTIGRAVITY_MODE: 'invalid',
            REMCLI_ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS: 'false',
            REMCLI_ANTIGRAVITY_SANDBOX: 'false',
        },
        {
            REMCLI_ANTIGRAVITY_MODEL: 'model-a',
            REMCLI_ANTIGRAVITY_CATALOG_VERSION: 'catalog-v1',
            REMCLI_ANTIGRAVITY_MODE: 'default',
            REMCLI_ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS: '1',
            REMCLI_ANTIGRAVITY_SANDBOX: 'false',
        },
        {
            REMCLI_ANTIGRAVITY_MODEL: 'model-a',
            REMCLI_ANTIGRAVITY_CATALOG_VERSION: 'catalog-v1',
            REMCLI_ANTIGRAVITY_MODE: 'default',
            REMCLI_ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS: 'false',
            REMCLI_ANTIGRAVITY_SANDBOX: '1',
        },
    ])('fails closed on an incomplete or invalid daemon tuple', (environment) => {
        expect(getAntigravityDaemonRunOptions('daemon', environment)).toEqual({});
    });
});
