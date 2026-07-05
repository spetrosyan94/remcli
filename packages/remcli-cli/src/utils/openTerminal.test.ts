import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { openTerminalWithCommand } from './openTerminal';

const execFileMock = vi.fn<(command: string, args: string[], callback: (error: Error | null) => void) => void>();

vi.mock('child_process', () => ({
    execFile: (...args: Parameters<typeof execFileMock>) => execFileMock(...args),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
    },
}));

describe('openTerminalWithCommand', () => {
    const originalPlatform = process.platform;

    const setPlatform = (platform: NodeJS.Platform): void => {
        Object.defineProperty(process, 'platform', {
            value: platform,
            configurable: true,
        });
    };

    const runScript = (): void => {
        execFileMock.mockImplementation((_: string, __: string[], callback: (error: Error | null) => void) => {
            callback(null);
        });
    };

    beforeEach(() => {
        vi.clearAllMocks();
        setPlatform('linux');
        execFileMock.mockReset();
    });

    afterAll(() => {
        setPlatform(originalPlatform);
    });

    it('skips execution on non-darwin platforms', async () => {
        await openTerminalWithCommand('echo skip');

        expect(execFileMock).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith('[OPEN_TERMINAL] Not on macOS, skipping terminal open');
    });

    it('runs do script in front window when on macOS', async () => {
        const command = 'echo "hello" && printf "path\\\\file"';
        setPlatform('darwin');
        const expectedEscaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

        runScript();

        await openTerminalWithCommand(command);

        expect(execFileMock).toHaveBeenCalledTimes(1);
        expect(execFileMock).toHaveBeenCalledWith(
            'osascript',
            ['-e', expect.stringContaining(`do script "${expectedEscaped}" in front window`)],
            expect.any(Function),
        );
    });

    it('falls back to do script without front window', async () => {
        const command = 'echo "fallback"';
        setPlatform('darwin');
        const expectedEscaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

        runScript();

        await openTerminalWithCommand(command);

        expect(execFileMock).toHaveBeenCalledTimes(1);
        const [, args] = execFileMock.mock.calls[0] as [string, string[], (error: Error | null) => void];
        expect(args[1]).toContain(`do script "${expectedEscaped}" in front window`);
        expect(args[1]).toContain(`do script "${expectedEscaped}"`);
    });

    it('logs and swallows exec errors', async () => {
        const command = 'echo "error"';
        setPlatform('darwin');

        execFileMock.mockImplementation((_: string, __: string[], callback: (error: Error | null) => void) => {
            callback(new Error('apple event failed'));
        });

        await openTerminalWithCommand(command);

        expect(execFileMock).toHaveBeenCalledTimes(1);
        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('[OPEN_TERMINAL] Failed to open terminal: apple event failed'));
    });
});
