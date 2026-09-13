import { spawn } from 'node:child_process';

export const ANTIGRAVITY_EXECUTABLE = 'agy' as const;
export const ANTIGRAVITY_MIN_SUPPORTED_VERSION = '1.2.2' as const;
export const ANTIGRAVITY_SUPPORTED_MAJOR = 1 as const;
export const ANTIGRAVITY_DISCOVERY_TIMEOUT_MS = 5_000;
export const ANTIGRAVITY_DISCOVERY_MAX_OUTPUT_BYTES = 256 * 1_024;

export type AntigravityExecutionMode = 'default' | 'accept-edits' | 'plan';
export type AntigravityNativeMode = AntigravityExecutionMode;

export interface AntigravityCommand {
    executable: typeof ANTIGRAVITY_EXECUTABLE;
    args: string[];
}

export interface AntigravityLaunchControls {
    mode?: AntigravityNativeMode;
    dangerouslySkipPermissions?: boolean;
    sandbox?: boolean;
}

export type AntigravityRunOptions = AntigravityLaunchControls;

export interface AntigravityCommandResult {
    stdout: string;
    stderr: string;
}

export type AntigravityCommandRunner = (
    command: AntigravityCommand,
    operation: string,
) => Promise<AntigravityCommandResult>;
export type AntigravityProcessSpawner = typeof spawn;
export type AntigravityKillProcess = (child: ReturnType<typeof spawn>, signal: NodeJS.Signals) => void;

export function buildAntigravityVersionCommand(): AntigravityCommand {
    return { executable: ANTIGRAVITY_EXECUTABLE, args: ['--version'] };
}

export function buildAntigravityModelsCommand(): AntigravityCommand {
    return { executable: ANTIGRAVITY_EXECUTABLE, args: ['models'] };
}

/** `/model` is a provider command, not a model request. */
export function buildAntigravityCurrentModelCommand(): AntigravityCommand {
    return { executable: ANTIGRAVITY_EXECUTABLE, args: ['-p', '/model'] };
}

export function buildAntigravityCommand(options: AntigravityLaunchControls = {}): AntigravityCommand {
    const mode = options.mode ?? 'default';
    if (mode !== 'default' && mode !== 'accept-edits' && mode !== 'plan') {
        throw new Error('Antigravity execution mode is invalid.');
    }
    if (options.dangerouslySkipPermissions !== undefined
        && typeof options.dangerouslySkipPermissions !== 'boolean') {
        throw new Error('Antigravity dangerous permission profile is invalid.');
    }
    if (options.sandbox !== undefined && typeof options.sandbox !== 'boolean') {
        throw new Error('Antigravity sandbox setting is invalid.');
    }

    const args: string[] = [];
    if (mode !== 'default') args.push('--mode', mode);
    if (options.dangerouslySkipPermissions) args.push('--dangerously-skip-permissions');
    if (options.sandbox) args.push('--sandbox');
    return { executable: ANTIGRAVITY_EXECUTABLE, args };
}

export function runAntigravityCommand(
    command: AntigravityCommand,
    operation: string,
    timeoutMs: number = ANTIGRAVITY_DISCOVERY_TIMEOUT_MS,
    maxOutputBytes: number = ANTIGRAVITY_DISCOVERY_MAX_OUTPUT_BYTES,
    spawnProcess: AntigravityProcessSpawner = spawn,
    killProcess: AntigravityKillProcess = terminate,
): Promise<AntigravityCommandResult> {
    if (command.executable !== ANTIGRAVITY_EXECUTABLE || !Array.isArray(command.args)
        || command.args.some((arg) => typeof arg !== 'string' || arg.includes('\u0000'))) {
        return Promise.reject(new Error('Antigravity command is invalid.'));
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
        return Promise.reject(new Error('Antigravity command limits are invalid.'));
    }

    return new Promise((resolve, reject) => {
        const child = spawnProcess(command.executable, command.args, {
            detached: process.platform !== 'win32',
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
        const terminateWithEscalation = (): void => {
            killProcess(child, 'SIGTERM');
            forceKillTimer = setTimeout(() => killProcess(child, 'SIGKILL'), 250);
            forceKillTimer.unref();
        };
        const timeout = setTimeout(() => {
            if (settled) return;
            terminateWithEscalation();
            settleReject(new Error(`Antigravity ${operation} timed out.`), true);
        }, timeoutMs);
        timeout.unref();

        const clearTimers = (): void => {
            clearTimeout(timeout);
            if (forceKillTimer) clearTimeout(forceKillTimer);
        };
        const settleReject = (error: Error, preserveForceKill = false): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (!preserveForceKill && forceKillTimer) clearTimeout(forceKillTimer);
            reject(error);
        };
        const addOutput = (target: Buffer[], chunk: Buffer): void => {
            if (settled) return;
            outputBytes += chunk.byteLength;
            if (outputBytes > maxOutputBytes) {
                terminateWithEscalation();
                settleReject(new Error(`Antigravity ${operation} exceeded the output limit.`), true);
                return;
            }
            target.push(chunk);
        };

        child.stdout.on('data', (chunk: Buffer) => addOutput(stdout, chunk));
        child.stderr.on('data', (chunk: Buffer) => addOutput(stderr, chunk));
        child.once('error', (error) => settleReject(error));
        child.once('close', (code) => {
            // A detached POSIX process group can outlive its leader. Keep an
            // already scheduled SIGKILL even when the leader closes on TERM.
            if (settled) return;
            if (code !== 0) {
                settleReject(new Error(`Antigravity ${operation} failed.`));
                return;
            }
            settled = true;
            clearTimers();
            resolve({
                stdout: Buffer.concat(stdout).toString('utf8'),
                stderr: Buffer.concat(stderr).toString('utf8'),
            });
        });
    });
}

function terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
    if (!child.pid) return;
    try {
        if (process.platform !== 'win32') process.kill(-child.pid, signal);
        else child.kill(signal);
    } catch {
        try { child.kill(signal); } catch { /* process already exited */ }
    }
}
