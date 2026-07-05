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
try
    do script "${escaped}"
on error errorMessage
    error errorMessage
end try
end tell`;

    return new Promise<boolean>((resolve) => {
        execFile('osascript', ['-e', script], { timeout: OPEN_TERMINAL_TIMEOUT_MS }, (error) => {
            if (error) {
                logger.debug(`[OPEN_TERMINAL] Failed to open terminal: ${error.message}`);
                resolve(false);
                return;
            } else {
                logger.debug(`[OPEN_TERMINAL] Terminal opened with command: ${command}`);
            }

            resolve(true);
        });
    });
}

function escapeAppleScript(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
