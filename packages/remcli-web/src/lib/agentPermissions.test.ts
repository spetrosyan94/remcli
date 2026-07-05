import { describe, expect, it } from 'vitest';
import {
    getAgentPermissionModes,
    getDefaultPermissionMode,
    normalizeAgentPermissionMode,
} from '@/lib/agentPermissions';

describe('agent permission modes', () => {
    it('exposes backend-native permission modes for each agent', () => {
        expect(getAgentPermissionModes('claude')).toEqual(['plan', 'default', 'acceptEdits', 'bypassPermissions']);
        expect(getAgentPermissionModes('codex')).toEqual(['read-only', 'default', 'safe-yolo', 'yolo']);
        expect(getAgentPermissionModes('gemini')).toEqual(['read-only', 'default', 'safe-yolo', 'yolo']);
        expect(getAgentPermissionModes('cursor')).toEqual(['read-only', 'plan', 'default', 'yolo']);
    });

    it('uses default as the initial mode when the agent supports it', () => {
        expect(getDefaultPermissionMode('claude')).toBe('default');
        expect(getDefaultPermissionMode('codex')).toBe('default');
        expect(getDefaultPermissionMode('gemini')).toBe('default');
        expect(getDefaultPermissionMode('cursor')).toBe('default');
    });

    it('keeps supported modes unchanged', () => {
        expect(normalizeAgentPermissionMode('codex', 'safe-yolo')).toBe('safe-yolo');
        expect(normalizeAgentPermissionMode('claude', 'acceptEdits')).toBe('acceptEdits');
        expect(normalizeAgentPermissionMode('cursor', 'plan')).toBe('plan');
    });

    it('falls back instead of sending unsupported modes to an agent', () => {
        expect(normalizeAgentPermissionMode('gemini', 'plan')).toBe('default');
        expect(normalizeAgentPermissionMode('claude', 'read-only')).toBe('default');
        expect(normalizeAgentPermissionMode('cursor', 'safe-yolo')).toBe('default');
    });
});
