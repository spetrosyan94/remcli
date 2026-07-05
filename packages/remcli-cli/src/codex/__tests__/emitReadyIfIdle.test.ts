import { describe, expect, it, vi } from 'vitest';
import {
    CODEX_DEFAULT_PERMISSION_MODE,
    emitReadyIfIdle,
    resolveCodexPermissionConfig,
} from '../runCodex';

describe('emitReadyIfIdle', () => {
    it('emits ready and notification when queue is idle', () => {
        const sendReady = vi.fn();
        const notify = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: null,
            queueSize: () => 0,
            shouldExit: false,
            sendReady,
            notify,
        });

        expect(emitted).toBe(true);
        expect(sendReady).toHaveBeenCalledTimes(1);
        expect(notify).toHaveBeenCalledTimes(1);
    });

    it('skips when a message is still pending', () => {
        const sendReady = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: {},
            queueSize: () => 0,
            shouldExit: false,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });

    it('skips when queue still has items', () => {
        const sendReady = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: null,
            queueSize: () => 2,
            shouldExit: false,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });

    it('skips when shutdown is requested', () => {
        const sendReady = vi.fn();

        const emitted = emitReadyIfIdle({
            pending: null,
            queueSize: () => 0,
            shouldExit: true,
            sendReady,
        });

        expect(emitted).toBe(false);
        expect(sendReady).not.toHaveBeenCalled();
    });
});

describe('resolveCodexPermissionConfig', () => {
    it('uses workspace-write as Codex runtime default permission', () => {
        expect(CODEX_DEFAULT_PERMISSION_MODE).toBe('workspace-write');
    });

    it('maps read-only to a read-only sandbox with interactive approval', () => {
        expect(resolveCodexPermissionConfig('read-only')).toEqual({
            sandbox: 'read-only',
            approvalPolicy: 'on-request',
        });
    });

    it('maps workspace-write to the workspace sandbox with interactive approval', () => {
        expect(resolveCodexPermissionConfig('workspace-write')).toEqual({
            sandbox: 'workspace-write',
            approvalPolicy: 'on-request',
        });
    });

    it('maps danger-full-access to unrestricted sandbox without approval prompts', () => {
        expect(resolveCodexPermissionConfig('danger-full-access')).toEqual({
            sandbox: 'danger-full-access',
            approvalPolicy: 'never',
        });
    });

    it.each([
        'read-only',
        'workspace-write',
        'danger-full-access',
    ] as const)('does not use deprecated on-failure for %s', (permissionMode) => {
        expect(resolveCodexPermissionConfig(permissionMode).approvalPolicy).not.toBe('on-failure');
    });
});
