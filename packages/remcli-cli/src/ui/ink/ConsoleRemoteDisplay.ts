/**
 * Console-based remote mode display.
 * Replaces Ink (React for terminal) to avoid full-screen rendering conflicts with tmux.
 * Uses simple stdout.write with chalk for formatting — text scrolls like a normal log.
 */

import chalk from 'chalk';
import { logger } from '@/ui/logger';

export type ConsoleMessageType = 'user' | 'assistant' | 'system' | 'tool' | 'result' | 'status';

interface ConsoleRemoteDisplayOptions {
    onExit: () => void;
    onSwitch: () => void;
    logPath?: string;
}

export class ConsoleRemoteDisplay {
    /** Agent label for assistant messages (set from init message model name) */
    agentLabel = 'Assistant';

    private confirmMode: 'exit' | 'switch' | null = null;
    private confirmTimeout: NodeJS.Timeout | null = null;
    private destroyed = false;
    private readonly onExit: () => void;
    private readonly onSwitch: () => void;
    private readonly stdinHandler: (data: Buffer) => void;

    constructor(options: ConsoleRemoteDisplayOptions) {
        this.onExit = options.onExit;
        this.onSwitch = options.onSwitch;

        // Print header
        this.writeLine(chalk.gray('─'.repeat(40)));
        this.writeLine(chalk.green.bold('Remote Mode') + chalk.gray(' — messages from Claude session'));
        this.writeLine(chalk.gray('Space×2: local mode | Ctrl-C×2: exit'));
        this.writeLine(chalk.gray('─'.repeat(40)));

        // Raw mode stdin listener for key handling
        this.stdinHandler = this.handleKey.bind(this);
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
            process.stdin.resume();
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', this.stdinHandler);
        }
    }

    private handleKey(data: Buffer): void {
        if (this.destroyed) return;

        const str = data.toString();

        // Ctrl-C = \x03
        if (str === '\x03') {
            if (this.confirmMode === 'exit') {
                this.resetConfirm();
                logger.debug('[ConsoleRemoteDisplay] Double Ctrl-C — exiting');
                this.onExit();
            } else {
                this.setConfirm('exit');
                this.writeLine(chalk.red.bold('Press Ctrl-C again to exit'));
            }
            return;
        }

        // Space = ' '
        if (str === ' ') {
            if (this.confirmMode === 'switch') {
                this.resetConfirm();
                logger.debug('[ConsoleRemoteDisplay] Double space — switching');
                this.onSwitch();
            } else {
                this.setConfirm('switch');
                this.writeLine(chalk.yellow.bold('Press space again to switch to local mode'));
            }
            return;
        }

        // Any other key cancels confirmation
        if (this.confirmMode) {
            this.resetConfirm();
        }
    }

    private setConfirm(mode: 'exit' | 'switch'): void {
        this.confirmMode = mode;
        if (this.confirmTimeout) {
            clearTimeout(this.confirmTimeout);
        }
        this.confirmTimeout = setTimeout(() => {
            this.confirmMode = null;
            this.confirmTimeout = null;
        }, 15000);
    }

    private resetConfirm(): void {
        this.confirmMode = null;
        if (this.confirmTimeout) {
            clearTimeout(this.confirmTimeout);
            this.confirmTimeout = null;
        }
    }

    writeMessage(content: string, type: ConsoleMessageType): void {
        if (this.destroyed) return;

        switch (type) {
            case 'user':
                this.writeLine(chalk.magenta(content));
                break;
            case 'assistant':
                this.writeLine(chalk.cyan(content));
                break;
            case 'system':
                this.writeLine(chalk.blue(content));
                break;
            case 'tool':
                this.writeLine(chalk.yellow(content));
                break;
            case 'result':
                this.writeLine(chalk.green(content));
                break;
            case 'status':
                this.writeLine(chalk.gray(content));
                break;
            default:
                this.writeLine(content);
        }
    }

    private writeLine(text: string): void {
        if (this.destroyed) return;
        process.stdout.write(text + '\n');
    }

    destroy(): void {
        if (this.destroyed) return;
        this.destroyed = true;

        this.resetConfirm();

        if (process.stdin.isTTY) {
            process.stdin.removeListener('data', this.stdinHandler);
            process.stdin.setRawMode(false);
        }
    }
}
