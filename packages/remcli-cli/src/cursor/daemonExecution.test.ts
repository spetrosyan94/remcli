import { describe, expect, it } from 'vitest';

import { getCursorDaemonRunOptions } from './daemonExecution';

const daemonEnvironment = {
    REMCLI_CURSOR_MODEL: 'gpt-5.6-luna[reasoning=medium,fast=false]',
    REMCLI_CURSOR_CATALOG_VERSION: 'cursor-catalog-v1',
    REMCLI_CURSOR_EXECUTION_MODE: 'agent',
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
                model: 'gpt-5.6-luna[reasoning=medium,fast=false]',
                catalogVersion: 'cursor-catalog-v1',
            },
            launchControls: {
                executionMode: 'agent',
            },
            runner: {
                executable: 'agent',
                cliFingerprint: '0123456789abcdef',
            },
        });
    });

    it('does not turn partial or invalid daemon variables into a trusted selection', () => {
        expect(getCursorDaemonRunOptions('daemon', {
            REMCLI_CURSOR_MODEL: 'gpt-5.6-luna[reasoning=medium,fast=false]',
            REMCLI_CURSOR_CATALOG_VERSION: 'cursor-catalog-v1',
            REMCLI_CURSOR_EXECUTABLE: 'agent',
            REMCLI_CURSOR_CLI_FINGERPRINT: '0123456789abcdef',
            REMCLI_CURSOR_EXECUTION_MODE: 'unsupported',
        } as NodeJS.ProcessEnv)).toEqual({});
    });

});
