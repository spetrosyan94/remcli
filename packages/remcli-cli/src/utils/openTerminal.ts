/**
 * Open a Terminal.app window with a given command on macOS via AppleScript.
 */

import { execFile } from 'child_process';
import { logger } from '@/ui/logger';

export async function openTerminalWithCommand(command: string): Promise<void> {
    if (process.platform !== 'darwin') {
        logger.debug('[OPEN_TERMINAL] Not on macOS, skipping terminal open');
        return;
    }

    const script = `
        tell application "Terminal"
            activate
            do script "${escapeAppleScript(command)}"
        end tell
    `;

    return new Promise<void>((resolve) => {
        execFile('osascript', ['-e', script], (error) => {
            if (error) {
                logger.debug(`[OPEN_TERMINAL] Failed to open terminal: ${error.message}`);
            } else {
                logger.debug(`[OPEN_TERMINAL] Terminal opened with command: ${command}`);
            }
            resolve();
        });
    });
}

function escapeAppleScript(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
