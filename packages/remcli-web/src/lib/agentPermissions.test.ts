import { describe, expect, it } from 'vitest';
import {
    getAgentPermissionLabel,
    getAgentPermissionModes,
    getDefaultPermissionMode,
    normalizeAgentPermissionMode,
} from '@/lib/agentPermissions';

describe('agent permission modes', () => {
    it('exposes backend-native permission modes for each agent', () => {
        expect(getAgentPermissionModes('claude')).toEqual(['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
        expect(getAgentPermissionModes('codex')).toEqual(['read-only', 'workspace-write', 'danger-full-access']);
        expect(getAgentPermissionModes('gemini')).toEqual(['manual', 'auto_edit', 'plan']);
        expect(getAgentPermissionModes('cursor')).toEqual(['agent', 'plan', 'ask', 'force', 'auto-review']);
    });

    it('uses the agent-specific initial permission mode', () => {
        expect(getDefaultPermissionMode('claude')).toBe('manual');
        expect(getDefaultPermissionMode('codex')).toBe('workspace-write');
        expect(getDefaultPermissionMode('gemini')).toBe('manual');
        expect(getDefaultPermissionMode('cursor')).toBe('agent');
    });

    it('keeps supported modes unchanged', () => {
        expect(normalizeAgentPermissionMode('codex', 'danger-full-access')).toBe('danger-full-access');
        expect(normalizeAgentPermissionMode('claude', 'acceptEdits')).toBe('acceptEdits');
        expect(normalizeAgentPermissionMode('cursor', 'plan')).toBe('plan');
        expect(normalizeAgentPermissionMode('gemini', 'auto_edit')).toBe('auto_edit');
    });

    it('falls back instead of sending unsupported modes to an agent', () => {
        expect(normalizeAgentPermissionMode('gemini', 'workspace-write')).toBe('manual');
        expect(normalizeAgentPermissionMode('claude', 'read-only')).toBe('manual');
    });

    it('falls back for unsupported Codex modes instead of aliasing them', () => {
        expect(normalizeAgentPermissionMode('codex', 'acceptEdits')).toBe('workspace-write');
    });

    it('uses raw Codex sandbox values as labels', () => {
        expect(getAgentPermissionLabel('codex', 'read-only')).toBe('read-only');
        expect(getAgentPermissionLabel('codex', 'workspace-write')).toBe('workspace-write');
        expect(getAgentPermissionLabel('codex', 'danger-full-access')).toBe('danger-full-access');
    });

    it('keeps non-Codex labels as backend-native permission values', () => {
        expect(getAgentPermissionLabel('gemini', 'auto_edit')).toBe('auto_edit');
        expect(getAgentPermissionLabel('claude', 'acceptEdits')).toBe('acceptEdits');
        expect(getAgentPermissionLabel('cursor', 'auto-review')).toBe('auto-review');
    });
});
