/**
 * Cursor native CLI boundary.
 *
 * Keeps executable discovery and argument construction out of the runner so
 * every Cursor turn uses the same explicit, testable native contract.
 */

import { spawnSync } from 'node:child_process';

const CURSOR_EXECUTABLE_CANDIDATES = ['agent', 'cursor-agent'] as const;

export interface CursorTurnArgumentsOptions {
    prompt: string;
    model?: string;
    resumeSessionId?: string;
    mode?: 'agent' | 'plan' | 'ask';
    force?: boolean;
    autoReview?: boolean;
}

export interface CursorExecutableProbe {
    (executable: string): boolean;
}

/**
 * Resolve the current Cursor Agent CLI first, with the previous executable
 * name retained only for installations that have not yet migrated.
 */
export function resolveCursorExecutable(probe: CursorExecutableProbe = canRunCursorExecutable): string | null {
    for (const executable of CURSOR_EXECUTABLE_CANDIDATES) {
        if (probe(executable)) return executable;
    }
    return null;
}

/** Build the exact native arguments used for one non-interactive Cursor turn. */
export function buildCursorTurnArguments(options: CursorTurnArgumentsOptions): string[] {
    if (options.force && options.autoReview) {
        throw new Error('Cursor force and auto-review modes cannot be enabled together.');
    }

    const args = ['--print', '--output-format', 'stream-json', '--trust'];

    if (options.model) args.push('--model', options.model);
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId);
    if (options.mode === 'plan' || options.mode === 'ask') args.push('--mode', options.mode);
    if (options.force) args.push('--force');
    if (options.autoReview) args.push('--auto-review');

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
