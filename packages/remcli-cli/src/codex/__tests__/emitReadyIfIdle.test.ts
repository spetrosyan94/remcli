import { describe, expect, it, vi } from 'vitest';
import { createCodexStartConfig, emitReadyIfIdle } from '../runCodex';

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

describe('createCodexStartConfig', () => {
    it('uses the user prompt without injecting title instructions or remcli MCP config', () => {
        const config = createCodexStartConfig({
            prompt: 'Тест',
            sandbox: 'workspace-write',
            approvalPolicy: 'untrusted',
            model: 'gpt-5.5',
        });

        expect(config).toEqual({
            prompt: 'Тест',
            sandbox: 'workspace-write',
            'approval-policy': 'untrusted',
            model: 'gpt-5.5',
        });
        expect(config.prompt).not.toContain('change_title');
        expect(config.config).toBeUndefined();
    });

    it('omits model when Codex should use its default', () => {
        const config = createCodexStartConfig({
            prompt: 'Hello',
            sandbox: 'read-only',
            approvalPolicy: 'never',
        });

        expect(config).toEqual({
            prompt: 'Hello',
            sandbox: 'read-only',
            'approval-policy': 'never',
        });
    });
});
