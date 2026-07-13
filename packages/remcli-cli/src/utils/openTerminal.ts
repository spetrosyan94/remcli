/**
 * Open a new Terminal.app context with a given command on macOS via AppleScript.
 *
 * Plain `do script` creates a new terminal window or tab depending on the user's
 * Terminal.app preferences. Do not target `front window`: it can inject the
 * command into an already busy tmux tab and silently fail to attach.
 */

import { execFile } from 'child_process';
import { logger } from '@/ui/logger';

const OPEN_TERMINAL_TIMEOUT_MS = 5_000;

export async function openTerminalWithCommand(command: string): Promise<boolean> {
    if (process.platform !== 'darwin') {
        logger.debug('[OPEN_TERMINAL] Not on macOS, skipping terminal open');
        return false;
    }

    const escaped = escapeAppleScript(command);
    const script = `tell application "Terminal"
activate
do script "${escaped}"
end tell`;

    return new Promise<boolean>((resolve) => {
        execFile('osascript', ['-e', script], { timeout: OPEN_TERMINAL_TIMEOUT_MS }, (error) => {
            if (error) {
                logger.debug('[OPEN_TERMINAL] Terminal AppleScript execution failed');
                resolve(false);
                return;
            }
            logger.debug('[OPEN_TERMINAL] Terminal context opened');
            resolve(true);
        });
    });
}

function escapeAppleScript(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n');
}
