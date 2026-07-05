import { describe, it, expect } from 'vitest';
import { mapToClaudeMode, normalizeClaudeMode } from './permissionMode';
import type { ClaudePermissionMode, PermissionMode } from '@/api/types';

describe('mapToClaudeMode', () => {
    describe('non-Claude modes are rejected', () => {
        it.each(['danger-full-access', 'read-only', 'workspace-write', 'agent', 'force'] as PermissionMode[])(
            'rejects %s',
            (mode) => {
                expect(() => mapToClaudeMode(mode)).toThrow('Unsupported Claude permission mode');
            }
        );
    });

    describe('Claude modes pass through unchanged', () => {
        it.each(['manual', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk'] as ClaudePermissionMode[])(
            'passes through %s',
            (mode) => {
                expect(mapToClaudeMode(mode)).toBe(mode);
            }
        );
    });

    describe('all supported PermissionMode values are handled explicitly', () => {
        const allModes: PermissionMode[] = [
            'manual', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk',
            'read-only', 'workspace-write', 'danger-full-access',
            'auto_edit',
            'agent', 'ask', 'force', 'auto-review'
        ];

        it('passes Claude modes and rejects other agents modes', () => {
            const validClaudeModes = ['manual', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk'];

            allModes.forEach(mode => {
                if (validClaudeModes.includes(mode)) {
                    expect(mapToClaudeMode(mode)).toBe(mode);
                } else {
                    expect(() => mapToClaudeMode(mode)).toThrow();
                }
            });
        });
    });

    it('uses manual when mode is missing', () => {
        expect(normalizeClaudeMode(undefined)).toBe('manual');
    });
});
