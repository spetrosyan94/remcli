/**
 * Cursor native CLI boundary.
 *
 * Keeps executable discovery and argument construction out of the runner so
 * every Cursor turn uses the same explicit, testable native contract.
 */

import { spawnSync } from 'node:child_process';

import {
    DEFAULT_CURSOR_LAUNCH_CONTROLS,
    isCursorLaunchControls,
    type CursorLaunchControls,
} from './cursorLaunchControls';

export const CURSOR_EXECUTABLE_CANDIDATES = ['agent', 'cursor-agent'] as const;
export type CursorExecutable = typeof CURSOR_EXECUTABLE_CANDIDATES[number];

export interface CursorTurnArgumentsOptions {
    prompt: string;
    model?: string;
    resumeSessionId?: string;
    launchControls?: CursorLaunchControls;
    /** Remcli's immutable non-interactive workspace-trust policy. */
    trustWorkspace?: boolean;
}

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

/** Build the exact native arguments used for one non-interactive Cursor turn. */
export function buildCursorTurnArguments(options: CursorTurnArgumentsOptions): string[] {
    const launchControls = options.launchControls ?? DEFAULT_CURSOR_LAUNCH_CONTROLS;
    if (!isCursorLaunchControls(launchControls)) {
        throw new Error('Cursor launch controls are invalid.');
    }

    const args = ['--print', '--output-format', 'stream-json'];

    if (options.trustWorkspace) args.push('--trust');
    if (options.model) args.push('--model', options.model);
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
    if (launchControls.executionMode === 'plan' || launchControls.executionMode === 'ask') {
        args.push('--mode', launchControls.executionMode);
    }
    if (launchControls.force) args.push('--force');
    if (launchControls.autoReview) args.push('--auto-review');
    if (launchControls.sandbox === 'enabled' || launchControls.sandbox === 'disabled') {
        args.push('--sandbox', launchControls.sandbox);
    }
    if (launchControls.approveMcps) args.push('--approve-mcps');

    args.push(options.prompt);
    return args;
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
    if (options.launchControls.force) args.push('--force');
    if (options.launchControls.autoReview) args.push('--auto-review');
    if (options.launchControls.sandbox === 'enabled' || options.launchControls.sandbox === 'disabled') {
        args.push('--sandbox', options.launchControls.sandbox);
    }
    if (options.launchControls.approveMcps) args.push('--approve-mcps');

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
