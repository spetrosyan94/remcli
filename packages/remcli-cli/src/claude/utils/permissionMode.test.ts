import { describe, it, expect } from 'vitest';
import { mapToClaudeMode, normalizeClaudeMode } from './permissionMode';
import type { ClaudePermissionMode, PermissionMode } from '@/api/types';

describe('mapToClaudeMode', () => {
    describe('non-Claude modes fall back to manual', () => {
        it.each(['yolo', 'danger-full-access', 'read-only', 'workspace-write', 'agent', 'force'] as PermissionMode[])(
            'maps %s to manual',
            (mode) => {
                expect(mapToClaudeMode(mode)).toBe('manual');
            }
        );
    });

    describe('Claude modes pass through unchanged', () => {
        it('normalizes default to manual', () => {
            expect(mapToClaudeMode('default')).toBe('manual');
        });

        it.each(['manual', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk'] as ClaudePermissionMode[])(
            'passes through %s',
            (mode) => {
                expect(mapToClaudeMode(mode)).toBe(mode);
            }
        );
    });

    describe('all PermissionMode values are handled', () => {
        const allModes: PermissionMode[] = [
            'manual', 'default', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk',
            'read-only', 'workspace-write', 'danger-full-access',
            'auto_edit', 'yolo',
            'agent', 'ask', 'force', 'auto-review'
        ];

        it('returns a valid Claude mode for every PermissionMode', () => {
            const validClaudeModes = ['manual', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk'];

            allModes.forEach(mode => {
                const result = mapToClaudeMode(mode);
                expect(validClaudeModes).toContain(result);
            });
        });
    });

    it('uses manual when mode is missing', () => {
        expect(normalizeClaudeMode(undefined)).toBe('manual');
    });
});
