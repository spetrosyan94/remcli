import { describe, expect, it, vi } from 'vitest';

import { createCodexRemoteTuiOpener } from './codexRemoteTui';

describe('createCodexRemoteTuiOpener', () => {
    it('opens a Codex resume TUI for daemon-started sessions with a remote endpoint', () => {
        const openTerminal = vi.fn(async () => true);
        const opener = createCodexRemoteTuiOpener({
            startedBy: 'daemon',
            getEndpoint: () => 'ws://127.0.0.1:45123',
            openTerminal,
        });

        expect(opener.openOnce('thread-1')).toBe(true);

        expect(openTerminal).toHaveBeenCalledWith(
            "codex resume 'thread-1' --remote 'ws://127.0.0.1:45123'"
        );
        expect(opener.hasOpened()).toBe(true);
    });

    it('does not open more than one TUI for the same runner', () => {
        const openTerminal = vi.fn(async () => true);
        const opener = createCodexRemoteTuiOpener({
            startedBy: 'daemon',
            getEndpoint: () => 'ws://127.0.0.1:45123',
            openTerminal,
        });

        expect(opener.openOnce('thread-1')).toBe(true);
        expect(opener.openOnce('thread-2')).toBe(false);

        expect(openTerminal).toHaveBeenCalledTimes(1);
        expect(openTerminal).toHaveBeenCalledWith(
            "codex resume 'thread-1' --remote 'ws://127.0.0.1:45123'"
        );
    });

    it('does not open from manually-started terminal sessions', () => {
        const openTerminal = vi.fn(async () => true);
        const opener = createCodexRemoteTuiOpener({
            startedBy: 'terminal',
            getEndpoint: () => 'ws://127.0.0.1:45123',
            openTerminal,
        });

        expect(opener.openOnce('thread-1')).toBe(false);

        expect(openTerminal).not.toHaveBeenCalled();
    });

    it('does not open when the runner uses a private stdio app-server', () => {
        const openTerminal = vi.fn(async () => true);
        const opener = createCodexRemoteTuiOpener({
            startedBy: 'daemon',
            getEndpoint: () => undefined,
            openTerminal,
        });

        expect(opener.openOnce('thread-1')).toBe(false);

        expect(openTerminal).not.toHaveBeenCalled();
        expect(opener.hasOpened()).toBe(false);
    });
});
