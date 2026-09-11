/**
 * Cursor native CLI boundary.
 *
 * Keeps executable discovery and the optional interactive TUI command outside
 * the ACP runner.
 */

import { spawnSync } from 'node:child_process';

import {
    isCursorLaunchControls,
    type CursorLaunchControls,
} from './cursorLaunchControls';

export const CURSOR_EXECUTABLE_CANDIDATES = ['agent', 'cursor-agent'] as const;
export type CursorExecutable = typeof CURSOR_EXECUTABLE_CANDIDATES[number];

export interface CursorInteractiveTuiCommandOptions {
    executable: CursorExecutable;
    resumeSessionId: string;
    model?: string;
    launchControls: CursorLaunchControls;
}

export interface CursorExecutableProbe {
    (executable: string): boolean;
}

/**
 * Resolve the current Cursor Agent CLI first, with the previous executable
 * name retained only for installations that have not yet migrated.
 */
export function isCursorExecutable(value: unknown): value is CursorExecutable {
    return value === 'agent' || value === 'cursor-agent';
}

export function resolveCursorExecutable(probe: CursorExecutableProbe = canRunCursorExecutable): CursorExecutable | null {
    for (const executable of CURSOR_EXECUTABLE_CANDIDATES) {
        if (probe(executable)) return executable;
    }
    return null;
}

/** Build the shell command for a daemon-owned interactive Cursor TUI pane. */
export function buildCursorInteractiveTuiCommand(
    options: CursorInteractiveTuiCommandOptions,
): string {
    if (!isCursorExecutable(options.executable)) {
        throw new Error('Cursor executable is invalid.');
    }
    if (typeof options.resumeSessionId !== 'string' || options.resumeSessionId.trim() === '') {
        throw new Error('Cursor resume session ID must be a non-empty string.');
    }
    if (options.model !== undefined
        && (typeof options.model !== 'string' || options.model.trim() === '')) {
        throw new Error('Cursor interactive TUI model must be a non-empty string when provided.');
    }
    if (!isCursorLaunchControls(options.launchControls)) {
        throw new Error('Cursor launch controls are invalid.');
    }

    const args = [
        shellQuote(options.executable),
        '--resume',
        shellQuote(options.resumeSessionId),
    ];

    if (options.model !== undefined) args.push('--model', shellQuote(options.model));
    if (options.launchControls.executionMode === 'plan' || options.launchControls.executionMode === 'ask') {
        args.push('--mode', options.launchControls.executionMode);
    }
    return args.join(' ');
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function canRunCursorExecutable(executable: string): boolean {
    const result = spawnSync(executable, ['--version'], {
        stdio: 'ignore',
        shell: false,
    });

    return result.status === 0;
}
