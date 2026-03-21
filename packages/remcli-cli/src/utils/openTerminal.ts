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

    // Always use `do script` without `in window` — this reliably creates a new
    // Terminal window. The previous approach used `keystroke "t" using command down`
    // to open a tab, but that keystroke could be sent to the wrong app (e.g. TextEdit)
    // when Terminal wasn't fully focused yet, causing garbage text in other apps.
    const script = `
        tell application "Terminal"
            do script "${escaped}"
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
