import { describe, expect, it } from 'vitest';

import { getCursorDaemonRunOptions } from './daemonExecution';

const daemonEnvironment = {
    REMCLI_CURSOR_MODEL: 'gpt-5.6-luna-xhigh',
    REMCLI_CURSOR_CATALOG_VERSION: 'cursor-catalog-v1',
    REMCLI_CURSOR_EXECUTION_MODE: 'agent',
    REMCLI_CURSOR_FORCE: 'false',
    REMCLI_CURSOR_AUTO_REVIEW: 'true',
    REMCLI_CURSOR_SANDBOX: 'enabled',
    REMCLI_CURSOR_APPROVE_MCPS: 'true',
    REMCLI_CURSOR_EXECUTABLE: 'agent',
    REMCLI_CURSOR_CLI_FINGERPRINT: '0123456789abcdef',
} as NodeJS.ProcessEnv;

describe('getCursorDaemonRunOptions', () => {
    it('does not let a terminal invocation inherit daemon-only Cursor selection variables', () => {
        expect(getCursorDaemonRunOptions('terminal', daemonEnvironment)).toEqual({});
        expect(getCursorDaemonRunOptions(undefined, daemonEnvironment)).toEqual({});
    });

    it('passes the daemon-injected selection only to a daemon-owned runner', () => {
        expect(getCursorDaemonRunOptions('daemon', daemonEnvironment)).toEqual({
            execution: {
                model: 'gpt-5.6-luna-xhigh',
                catalogVersion: 'cursor-catalog-v1',
            },
            launchControls: {
                executionMode: 'agent',
                force: false,
                autoReview: true,
                sandbox: 'enabled',
                approveMcps: true,
            },
            runner: {
                executable: 'agent',
                cliFingerprint: '0123456789abcdef',
            },
        });
    });

    it('does not turn partial or invalid daemon variables into a trusted selection', () => {
        expect(getCursorDaemonRunOptions('daemon', {
            REMCLI_CURSOR_MODEL: 'gpt-5.6-luna-xhigh',
            REMCLI_CURSOR_CATALOG_VERSION: 'cursor-catalog-v1',
            REMCLI_CURSOR_EXECUTION_MODE: 'agent',
            REMCLI_CURSOR_FORCE: 'not-a-boolean',
            REMCLI_CURSOR_AUTO_REVIEW: 'false',
            REMCLI_CURSOR_SANDBOX: 'local-configuration',
            REMCLI_CURSOR_APPROVE_MCPS: 'false',
            REMCLI_CURSOR_EXECUTABLE: 'agent',
            REMCLI_CURSOR_CLI_FINGERPRINT: '0123456789abcdef',
        } as NodeJS.ProcessEnv)).toEqual({});
    });

});
