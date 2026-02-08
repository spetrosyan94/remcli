/**
 * Open a Terminal.app tab/window with a given command on macOS via AppleScript.
 *
 * Three cases:
 * - Terminal NOT running: `activate` creates a default window, `do script in front window` reuses it.
 * - Terminal running WITH windows: Cmd+T creates a new tab, `do script in front window` runs in it.
 * - Terminal running WITHOUT windows: `do script` creates a new window.
 */

import { execFile } from 'child_process';
import { logger } from '@/ui/logger';

export async function openTerminalWithCommand(command: string): Promise<void> {
    if (process.platform !== 'darwin') {
        logger.debug('[OPEN_TERMINAL] Not on macOS, skipping terminal open');
        return;
    }

    const escaped = escapeAppleScript(command);

    const script = `
        set termWasRunning to application "Terminal" is running
        tell application "Terminal"
            if termWasRunning then
                activate
                if (count of windows) > 0 then
                    -- Create a new tab in the existing window via Cmd+T
                    tell application "System Events"
                        tell process "Terminal"
                            keystroke "t" using command down
                        end tell
                    end tell
                    delay 0.3
                    do script "${escaped}" in front window
                else
                    do script "${escaped}"
                end if
            else
                -- Terminal not running: activate creates default window, reuse it
                activate
                delay 0.5
                do script "${escaped}" in front window
            end if
            activate
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
