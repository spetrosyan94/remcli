import { describe, expect, it } from 'vitest';
import { codexSandboxToAppServerPolicy } from '../codexAppServerClient';

describe('codexSandboxToAppServerPolicy', () => {
    it('maps Codex read-only sandbox to app-server readOnly policy', () => {
        expect(codexSandboxToAppServerPolicy('read-only')).toEqual({
            type: 'readOnly',
            networkAccess: false,
        });
    });

    it('maps Codex workspace-write sandbox to app-server workspaceWrite policy', () => {
        expect(codexSandboxToAppServerPolicy('workspace-write')).toEqual({
            type: 'workspaceWrite',
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
        });
    });

    it('maps Codex danger-full-access sandbox to app-server dangerFullAccess policy', () => {
        expect(codexSandboxToAppServerPolicy('danger-full-access')).toEqual({
            type: 'dangerFullAccess',
        });
    });
});
