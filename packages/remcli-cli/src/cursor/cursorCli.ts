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

function canRunCursorExecutable(executable: string): boolean {
    const result = spawnSync(executable, ['--version'], {
        stdio: 'ignore',
        shell: false,
    });

    return result.status === 0;
}
