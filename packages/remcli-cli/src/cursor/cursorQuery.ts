/**
 * Cursor CLI turn runner.
 *
 * Runs one native Cursor headless turn, validates its stream-json lifecycle,
 * and exposes only a safe typed result to the Remcli session runner.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import { logger } from '@/ui/logger';
import { buildCursorTurnArguments, resolveCursorExecutable } from './cursorCli';
import type { CursorLaunchControls } from './cursorLaunchControls';
import type { CursorStreamEvent } from './types';

const FORCE_KILL_TIMEOUT_MS = 1_000;
const MAX_STDERR_BYTES = 8 * 1024;

export type CursorTurnFailureKind = 'aborted' | 'cli-not-found' | 'native' | 'protocol' | 'resume-mismatch';

export interface CursorQueryOptions {
    /** The user prompt to send. It is never logged. */
    prompt: string;
    /** Working directory. */
    cwd?: string;
    /** Model override. */
    model?: string;
    /** Resume session by confirmed native Cursor ID. */
    resumeSessionId?: string;
    /** Abort signal for the native turn. */
    abort?: AbortSignal;
    /** Extra environment variables inherited by the native process. */
    env?: Record<string, string>;
    /** Path to Cursor Agent executable, used by focused tests. */
    executable?: string;
    /** Native Cursor controls validated when this Remcli session was created. */
    launchControls?: CursorLaunchControls;
    /** Remcli's immutable non-interactive workspace-trust policy. */
    trustWorkspace?: boolean;
}

export interface CursorTurnOutcome {
    sessionId: string;
    response: string;
    exitCode: number;
}

export class CursorTurnError extends Error {
    public constructor(
        public readonly kind: CursorTurnFailureKind,
        message: string,
    ) {
        super(message);
        this.name = 'CursorTurnError';
    }
}

interface CursorChildCloseResult {
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    error: Error | null;
}

/** True only for errors that represent a user/daemon interrupt. */
export function isCursorTurnAbortError(error: unknown): error is CursorTurnError {
    return error instanceof CursorTurnError && error.kind === 'aborted';
}

/**
 * Run a single Cursor turn and require a complete native lifecycle.
 *
 * A successful process exit alone is insufficient: Cursor must emit a valid
 * `system/init` identity and a terminal `result` success event.
 */
export async function runCursorTurn(
    options: CursorQueryOptions,
    onEvent: (event: CursorStreamEvent) => void | Promise<void>,
): Promise<CursorTurnOutcome> {
    const executable = options.executable ?? resolveCursorExecutable();
    if (!executable) {
        throw new CursorTurnError(
            'cli-not-found',
            'Cursor Agent CLI was not found. Install Cursor CLI (`agent`) and restart the daemon.',
        );
    }

    const args = buildCursorTurnArguments(options);
    const spawnEnv = { ...process.env, ...options.env };
    const startedAt = Date.now();

    logger.debug(
        `[cursor] Starting native turn executable=${executable} executionMode=${options.launchControls?.executionMode ?? 'agent'} hasResume=${Boolean(options.resumeSessionId)} hasModel=${Boolean(options.model)}`,
    );

    let child: ChildProcess;
    try {
        child = spawn(executable, args, {
            cwd: options.cwd ?? process.cwd(),
            stdio: ['ignore', 'pipe', 'pipe'],
            env: spawnEnv,
            detached: process.platform !== 'win32',
            shell: false,
        });
    } catch {
        throw new CursorTurnError(
            'cli-not-found',
            'Cursor Agent CLI could not be started. Check that `agent` is installed and available to the daemon.',
        );
    }

    if (!child.stdout || !child.stderr) {
        throw new CursorTurnError('protocol', 'Cursor CLI did not expose a readable response stream.');
    }

    const readline = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let stderr = '';
    let wasAborted = options.abort?.aborted ?? false;
    let forceKillTimer: NodeJS.Timeout | null = null;
    let closeResult: CursorChildCloseResult | null = null;
    let resolveClose: ((result: CursorChildCloseResult) => void) | null = null;
    const closed = new Promise<CursorChildCloseResult>((resolve) => {
        resolveClose = resolve;
    });

    const settleClose = (result: CursorChildCloseResult) => {
        if (closeResult) return;
        closeResult = result;
        resolveClose?.(result);
    };

    child.once('error', (error) => {
        readline.close();
        settleClose({ exitCode: null, signal: null, error });
    });
    child.once('close', (exitCode, signal) => {
        settleClose({ exitCode, signal, error: null });
    });
    child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length >= MAX_STDERR_BYTES) return;
        stderr += chunk.toString().slice(0, MAX_STDERR_BYTES - stderr.length);
    });

    const terminate = (signal: NodeJS.Signals) => {
        if (closeResult || !child.pid) return;

        try {
            if (process.platform !== 'win32') {
                process.kill(-child.pid, signal);
            } else {
                child.kill(signal);
            }
        } catch {
            try {
                child.kill(signal);
            } catch {
                // The process has already exited between the checks above.
            }
        }
    };

    const terminateWithFallback = () => {
        terminate('SIGTERM');
        if (!forceKillTimer) {
            forceKillTimer = setTimeout(() => terminate('SIGKILL'), FORCE_KILL_TIMEOUT_MS);
            forceKillTimer.unref();
        }
    };

    const handleAbort = () => {
        wasAborted = true;
        terminateWithFallback();
    };

    options.abort?.addEventListener('abort', handleAbort, { once: true });
    if (wasAborted) handleAbort();

    let initEvent: CursorStreamEvent | null = null;
    let resultEvent: CursorStreamEvent | null = null;
    let assistantText = '';
    let lifecycleStage: 'awaiting-init' | 'awaiting-result' = 'awaiting-init';
    let protocolError: CursorTurnError | null = null;

    try {
        for await (const line of readline) {
            if (wasAborted) break;

            const trimmed = line.trim();
            if (!trimmed) continue;

            let event: CursorStreamEvent;
            try {
                event = parseCursorStreamEvent(trimmed);
            } catch {
                protocolError = new CursorTurnError(
                    'protocol',
                    'Cursor CLI returned an invalid response stream. Start a new Cursor session and try again.',
                );
                terminateWithFallback();
                break;
            }

            if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string') {
                if (options.resumeSessionId && event.session_id !== options.resumeSessionId) {
                    protocolError = new CursorTurnError(
                        'resume-mismatch',
                        'Cursor resumed a different native session. The existing session was not changed.',
                    );
                    terminateWithFallback();
                    break;
                }
                if (initEvent?.session_id && initEvent.session_id !== event.session_id) {
                    assistantText = '';
                }
                initEvent = event;
                lifecycleStage = 'awaiting-result';
            }

            if (event.type === 'result') {
                if (lifecycleStage !== 'awaiting-result') {
                    protocolError = new CursorTurnError(
                        'protocol',
                        'Cursor CLI reported a terminal result before confirming a native session ID.',
                    );
                    terminateWithFallback();
                    break;
                }
                resultEvent = event;
            }

            if (
                event.type === 'assistant'
                && (!initEvent?.session_id || (event.session_id && event.session_id !== initEvent.session_id))
            ) {
                continue;
            }

            if (event.type === 'assistant') {
                assistantText += getAssistantEventText(event);
            }

            try {
                await onEvent(event);
            } catch (error) {
                protocolError = error instanceof CursorTurnError
                    ? error
                    : new CursorTurnError(
                        'native',
                        'Cursor CLI response could not be delivered to this session. Retry the turn.',
                    );
                terminateWithFallback();
                break;
            }
        }
    } finally {
        readline.close();
        options.abort?.removeEventListener('abort', handleAbort);
        if (wasAborted || protocolError) {
            terminateWithFallback();
        }

        const result = await closed;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (options.abort?.aborted) {
            wasAborted = true;
        }

        const durationMs = Date.now() - startedAt;
        logger.debug(
            `[cursor] Native turn closed exitCode=${result.exitCode ?? 'null'} signal=${result.signal ?? 'none'} durationMs=${durationMs}`,
        );

        if (result.error && !wasAborted && !protocolError) {
            throw toCursorTurnError(result.error, stderr);
        }
    }

    if (wasAborted) {
        throw new CursorTurnError('aborted', 'Cursor turn was aborted.');
    }
    if (protocolError) throw protocolError;

    const finalResult = await closed;
    if (finalResult.exitCode !== 0) {
        throw toCursorTurnError(null, stderr);
    }
    if (!initEvent?.session_id) {
        throw new CursorTurnError('protocol', 'Cursor CLI did not confirm a native session ID.');
    }
    if (!resultEvent || resultEvent.subtype !== 'success' || resultEvent.is_error === true) {
        throw toCursorTurnError(null, stderr);
    }
    if (resultEvent.session_id && resultEvent.session_id !== initEvent.session_id) {
        throw new CursorTurnError(
            'resume-mismatch',
            'Cursor reported inconsistent native session IDs. The existing session was not changed.',
        );
    }

    const terminalResult = typeof resultEvent.result === 'string' ? resultEvent.result : '';
    return {
        sessionId: initEvent.session_id,
        response: terminalResult.trim() ? terminalResult : assistantText,
        exitCode: finalResult.exitCode,
    };
}

function getAssistantMessageText(event: CursorStreamEvent): string {
    const content = event.message?.content;
    if (!Array.isArray(content)) return '';

    return content
        .filter((part): part is { type: 'text'; text: string } => (
            isRecord(part) && part.type === 'text' && typeof part.text === 'string'
        ))
        .map((part) => part.text)
        .join('');
}

function getAssistantEventText(event: CursorStreamEvent): string {
    const messageText = getAssistantMessageText(event);
    const partialText = typeof event.text_delta === 'string'
        ? event.text_delta
        : typeof event.text === 'string'
            ? event.text
            : '';

    if (!messageText || !partialText || messageText.endsWith(partialText)) {
        return messageText || partialText;
    }

    return messageText + partialText;
}

function parseCursorStreamEvent(line: string): CursorStreamEvent {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || typeof value.type !== 'string') {
        throw new Error('Invalid Cursor stream event.');
    }

    return value as unknown as CursorStreamEvent;
}

function toCursorTurnError(processError: Error | null, stderr: string): CursorTurnError {
    if (processError && (processError as NodeJS.ErrnoException).code === 'ENOENT') {
        return new CursorTurnError(
            'cli-not-found',
            'Cursor Agent CLI was not found. Install Cursor CLI (`agent`) and restart the daemon.',
        );
    }

    if (/auth|login|unauthori[sz]ed|api[ _-]?key/i.test(stderr)) {
        return new CursorTurnError(
            'native',
            'Cursor CLI authentication failed. Run `agent login` on this machine, then retry.',
        );
    }
    if (/session|chat/i.test(stderr) && /not found|unknown|invalid/i.test(stderr)) {
        return new CursorTurnError(
            'native',
            'Cursor session could not be resumed. It may no longer exist in this workspace.',
        );
    }

    return new CursorTurnError(
        'native',
        'Cursor CLI could not complete this turn. Check the local Cursor terminal and retry.',
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
