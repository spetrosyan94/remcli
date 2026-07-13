import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { openTerminalWithCommand } from './openTerminal';

interface ExecFileOptions {
    timeout: number;
}

const execFileMock = vi.fn<(command: string, args: string[], options: ExecFileOptions, callback: (error: Error | null) => void) => void>();

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
        execFileMock.mockImplementation((_: string, __: string[], ___: ExecFileOptions, callback: (error: Error | null) => void) => {
            callback(null);
        });
    };

    const mockAppleScriptError = (): void => {
        execFileMock.mockImplementation((_: string, __: string[], ___: ExecFileOptions, callback: (error: Error | null) => void) => {
            callback(new Error('osascript failed for a sensitive command'));
        });
    };

    const getAppleScript = (): string => {
        const call = execFileMock.mock.calls[0];
        if (!call) {
            throw new Error('Expected osascript to be called');
        }

        return call[1][1]!;
    };

    beforeEach(() => {
        vi.clearAllMocks();
        execFileMock.mockReset();
        setPlatform('linux');
    });

    afterAll(() => {
        setPlatform(originalPlatform);
    });

    it('skips execution on non-darwin platforms', async () => {
        await expect(openTerminalWithCommand('echo skip')).resolves.toBe(false);

        expect(execFileMock).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith('[OPEN_TERMINAL] Not on macOS, skipping terminal open');
    });

    it('opens a new Terminal context without injecting into the busy front window', async () => {
        const command = 'echo "hello" && printf "path\\\\file"\nnext-command';
        const expectedEscapedCommand = command
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n');
        setPlatform('darwin');
        runScript();

        await expect(openTerminalWithCommand(command)).resolves.toBe(true);

        expect(execFileMock).toHaveBeenCalledWith(
            'osascript',
            ['-e', expect.stringContaining(`do script "${expectedEscapedCommand}"`)],
            { timeout: 5_000 },
            expect.any(Function),
        );
        expect(getAppleScript()).not.toContain('front window');
    });

    it('logs a generic message and returns null when osascript fails to open a tab', async () => {
        setPlatform('darwin');
        mockAppleScriptError();

        await expect(openTerminalWithCommand('echo sensitive-command')).resolves.toBe(false);

        expect(logger.debug).toHaveBeenCalledWith('[OPEN_TERMINAL] Terminal AppleScript execution failed');
        expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining('sensitive-command'));
    });

});
