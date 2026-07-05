import { logger } from '@/ui/logger';
import { openTerminalWithCommand } from '@/utils/openTerminal';
import { buildCodexRemoteTuiCommand } from './codexAppServerHost';

interface CodexRemoteTuiOpenerOptions {
    startedBy?: 'daemon' | 'terminal';
    getEndpoint: () => string | undefined;
    openTerminal?: (command: string) => Promise<boolean>;
}

export interface CodexRemoteTuiOpener {
    openOnce: (threadId: string) => boolean;
    hasOpened: () => boolean;
}

export function createCodexRemoteTuiOpener(options: CodexRemoteTuiOpenerOptions): CodexRemoteTuiOpener {
    const openTerminal = options.openTerminal ?? openTerminalWithCommand;
    let didOpen = false;

    return {
        openOnce(threadId: string): boolean {
            const endpoint = options.getEndpoint();
            if (options.startedBy !== 'daemon' || !endpoint || didOpen) {
                return false;
            }

            didOpen = true;
            const command = buildCodexRemoteTuiCommand(endpoint, threadId);
            void openTerminal(command)
                .then((didOpenTerminal) => {
                    if (didOpenTerminal) {
                        logger.debug(`[Codex] Opened remote TUI for thread ${threadId}`);
                    } else {
                        logger.debug(`[Codex] Remote TUI was not opened for thread ${threadId}`);
                    }
                })
                .catch((error) => {
                    logger.debug('[Codex] Failed to open remote TUI:', error);
                });
            return true;
        },
        hasOpened(): boolean {
            return didOpen;
        },
    };
}
