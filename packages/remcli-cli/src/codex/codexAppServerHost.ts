import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';

import { logger } from '@/ui/logger';
import { redactSensitiveText } from '@/utils/redaction';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_READY_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_READY_POLL_MS = 100;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;

type CodexAppServerProcess = ChildProcessByStdio<null, Readable, Readable>;

export interface CodexAppServerHostHandle {
    endpoint: string;
    processId: number;
    stop: () => Promise<void>;
}

interface StartCodexAppServerHostDeps {
    choosePort?: () => Promise<number>;
    spawnAppServer?: (port: number) => CodexAppServerProcess;
    fetchReady?: (url: string) => Promise<boolean>;
    readyTimeoutMs?: number;
    readyRequestTimeoutMs?: number;
    readyPollMs?: number;
    stopTimeoutMs?: number;
}

export interface CodexAppServerStateSnapshot {
    codexAppServerEndpoint?: string;
    codexAppServerPid?: number;
}

interface CodexAppServerStateUsableDeps {
    fetchReady?: (url: string) => Promise<boolean>;
    isProcessRunning?: (pid: number | undefined) => boolean;
}

export function buildCodexAppServerEndpoint(port: number): string {
    return `ws://${LOOPBACK_HOST}:${port}`;
}

export function buildCodexRemoteTuiCommand(
    endpoint: string,
    threadId: string | undefined,
    reasoningEffort: string | null,
    model?: string,
): string {
    if (reasoningEffort !== null && (typeof reasoningEffort !== 'string' || reasoningEffort.trim() === '')) {
        throw new Error('Codex remote TUI reasoning effort must be a non-empty string or null.');
    }
    const quotedEndpoint = shellQuote(endpoint);
    const reasoningArgument = reasoningEffort === null
        ? ''
        : ` -c ${shellQuote(`model_reasoning_effort=${JSON.stringify(reasoningEffort)}`)}`;
    const modelArgument = model ? ` --model ${shellQuote(model)}` : '';
    if (threadId) {
        return `codex${reasoningArgument}${modelArgument} resume ${shellQuote(threadId)} --remote ${quotedEndpoint}`;
    }
    return `codex${reasoningArgument}${modelArgument} --remote ${quotedEndpoint}`;
}

export function buildCodexAppServerReadyUrl(endpoint: string): string | null {
    try {
        const url = new URL(endpoint);
        if (url.protocol === 'ws:') {
            url.protocol = 'http:';
        } else if (url.protocol === 'wss:') {
            url.protocol = 'https:';
        } else {
            return null;
        }
        url.pathname = '/readyz';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return null;
    }
}

export function isProcessRunning(pid: number | undefined): boolean {
    if (!pid || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

export async function isCodexAppServerStateUsable(
    state: CodexAppServerStateSnapshot | null | undefined,
    deps: CodexAppServerStateUsableDeps = {}
): Promise<boolean> {
    if (!state?.codexAppServerEndpoint) return false;
    const pidIsLive = (deps.isProcessRunning ?? isProcessRunning)(state.codexAppServerPid);
    if (state.codexAppServerPid !== undefined && !pidIsLive) {
        return false;
    }

    const readyUrl = buildCodexAppServerReadyUrl(state.codexAppServerEndpoint);
    if (!readyUrl) return false;
    return await (deps.fetchReady ?? fetchReadyUrl)(readyUrl);
}

export async function startCodexAppServerHost(deps: StartCodexAppServerHostDeps = {}): Promise<CodexAppServerHostHandle> {
    const port = await (deps.choosePort ?? chooseAvailableLoopbackPort)();
    const endpoint = buildCodexAppServerEndpoint(port);
    const proc = (deps.spawnAppServer ?? spawnCodexAppServer)(port);
    const readyUrl = `http://${LOOPBACK_HOST}:${port}/readyz`;
    const processId = proc.pid ?? 0;

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) logger.debug('[CodexAppServerHost][stderr]', redactSensitiveText(text));
    });

    try {
        await waitUntilReady({
            proc,
            readyUrl,
            fetchReady: deps.fetchReady ?? fetchReadyUrl,
            timeoutMs: deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
            requestTimeoutMs: deps.readyRequestTimeoutMs ?? DEFAULT_READY_REQUEST_TIMEOUT_MS,
            pollMs: deps.readyPollMs ?? DEFAULT_READY_POLL_MS,
        });
    } catch (startupError) {
        try {
            await stopProcess(proc, deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
        } catch (cleanupError) {
            throw new Error(
                `Codex app-server failed readiness and cleanup failed: ${formatError(startupError)}; ${formatError(cleanupError)}`,
            );
        }
        throw startupError;
    }

    logger.debug(`[CodexAppServerHost] Started shared Codex app-server at ${endpoint} pid=${processId}`);

    return {
        endpoint,
        processId,
        stop: () => stopProcess(proc, deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS),
    };
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function chooseAvailableLoopbackPort(): Promise<number> {
    return await new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, LOOPBACK_HOST, () => {
            const address = server.address();
            if (!address || typeof address === 'string') {
                server.close(() => reject(new Error('Failed to allocate a loopback port.')));
                return;
            }
            const port = address.port;
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(port);
            });
        });
    });
}

function spawnCodexAppServer(port: number): CodexAppServerProcess {
    return spawn('codex', ['app-server', '--listen', buildCodexAppServerEndpoint(port)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        ),
    });
}

async function fetchReadyUrl(url: string): Promise<boolean> {
    try {
        const response = await fetch(url);
        return response.ok;
    } catch {
        return false;
    }
}

async function waitUntilReady(options: {
    proc: CodexAppServerProcess;
    readyUrl: string;
    fetchReady: (url: string) => Promise<boolean>;
    timeoutMs: number;
    requestTimeoutMs: number;
    pollMs: number;
}): Promise<void> {
    const deadline = Date.now() + options.timeoutMs;
    let exited = hasProcessCompleted(options.proc);
    let exitText = exited
        ? `code=${options.proc.exitCode ?? 'null'} signal=${options.proc.signalCode ?? 'null'}`
        : '';
    let startupError: Error | undefined;
    let notifyExit: (exitText: string) => void = () => undefined;
    let notifyStartupError: (error: Error) => void = () => undefined;
    const processExitPromise = new Promise<{ kind: 'exit'; exitText: string }>((resolve) => {
        notifyExit = (nextExitText) => resolve({ kind: 'exit', exitText: nextExitText });
    });
    const startupErrorPromise = new Promise<Error>((resolve) => {
        notifyStartupError = resolve;
    });
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        exited = true;
        exitText = `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
        notifyExit(exitText);
    };
    const onError = (error: Error) => {
        startupError = error;
        notifyStartupError(error);
    };
    options.proc.once('exit', onExit);
    options.proc.once('error', onError);

    try {
        while (Date.now() < deadline) {
            if (startupError) {
                throw new Error(`Codex app-server failed to start: ${formatError(startupError)}.`);
            }
            if (exited) {
                throw new Error(`Codex app-server exited before ready (${exitText}).`);
            }
            const remainingTimeoutMs = Math.max(0, deadline - Date.now());
            if (remainingTimeoutMs === 0) break;

            let readinessRequestTimeout: ReturnType<typeof setTimeout> | undefined;
            let readiness: ReadinessOutcome;
            try {
                readiness = await Promise.race([
                    Promise.resolve()
                        .then(() => options.fetchReady(options.readyUrl))
                        .then((isReady) => ({ kind: 'ready' as const, isReady }))
                        .catch((error: unknown) => ({ kind: 'probe-error' as const, error })),
                    processExitPromise,
                    startupErrorPromise.then((error) => ({ kind: 'error' as const, error })),
                    new Promise<{ kind: 'timeout' }>((resolve) => {
                        readinessRequestTimeout = setTimeout(
                            () => resolve({ kind: 'timeout' }),
                            Math.min(options.requestTimeoutMs, remainingTimeoutMs),
                        );
                    }),
                ]);
            } finally {
                if (readinessRequestTimeout !== undefined) clearTimeout(readinessRequestTimeout);
            }

            if (readiness.kind === 'exit') {
                throw new Error(`Codex app-server exited before ready (${readiness.exitText}).`);
            }
            if (readiness.kind === 'error') {
                throw new Error(`Codex app-server failed to start: ${formatError(readiness.error)}.`);
            }
            if (readiness.kind === 'probe-error') {
                throw new Error(`Codex app-server readiness probe failed: ${formatError(readiness.error)}.`);
            }
            if (readiness.kind === 'timeout') {
                throw new Error(`Timed out waiting for Codex app-server readiness at ${options.readyUrl}.`);
            }
            if (readiness.isReady) {
                return;
            }
            const pollTimeoutMs = Math.min(options.pollMs, Math.max(0, deadline - Date.now()));
            let pollTimeout: ReturnType<typeof setTimeout> | undefined;
            let poll: ReadinessWaitOutcome;
            try {
                poll = await Promise.race<ReadinessWaitOutcome>([
                    new Promise<{ kind: 'poll' }>((resolve) => {
                        pollTimeout = setTimeout(() => resolve({ kind: 'poll' }), pollTimeoutMs);
                    }),
                    processExitPromise,
                    startupErrorPromise.then((error) => ({ kind: 'error' as const, error })),
                ]);
            } finally {
                if (pollTimeout !== undefined) clearTimeout(pollTimeout);
            }
            if (poll.kind === 'exit') {
                throw new Error(`Codex app-server exited before ready (${poll.exitText}).`);
            }
            if (poll.kind === 'error') {
                throw new Error(`Codex app-server failed to start: ${formatError(poll.error)}.`);
            }
        }
        if (startupError) {
            throw new Error(`Codex app-server failed to start: ${formatError(startupError)}.`);
        }
        throw new Error(`Timed out waiting for Codex app-server readiness at ${options.readyUrl}.`);
    } finally {
        options.proc.off('exit', onExit);
        options.proc.off('error', onError);
    }
}

type ReadinessOutcome =
    | { kind: 'ready'; isReady: boolean }
    | { kind: 'probe-error'; error: unknown }
    | { kind: 'exit'; exitText: string }
    | { kind: 'error'; error: Error }
    | { kind: 'timeout' };

type ReadinessWaitOutcome =
    | { kind: 'poll' }
    | { kind: 'exit'; exitText: string }
    | { kind: 'error'; error: Error };

function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function hasProcessCompleted(proc: CodexAppServerProcess): boolean {
    return proc.exitCode !== null || proc.signalCode !== null;
}

function waitForProcessExit(proc: CodexAppServerProcess, timeoutMs: number): Promise<boolean> {
    if (hasProcessCompleted(proc)) return Promise.resolve(true);

    return new Promise((resolve) => {
        const timeout = setTimeout(finish, timeoutMs);
        const onExit = () => finish(true);

        function finish(didExit: boolean = false): void {
            clearTimeout(timeout);
            proc.off('exit', onExit);
            resolve(didExit || hasProcessCompleted(proc));
        }

        proc.once('exit', onExit);
        if (hasProcessCompleted(proc)) finish(true);
    });
}

function sendProcessSignal(proc: CodexAppServerProcess, signal: NodeJS.Signals): string | null {
    try {
        return proc.kill(signal) ? null : `signal ${signal} was not delivered`;
    } catch (error) {
        return `signal ${signal} failed: ${formatError(error)}`;
    }
}

async function stopProcess(proc: CodexAppServerProcess, timeoutMs: number): Promise<void> {
    if (hasProcessCompleted(proc)) return;

    const terminateFailure = sendProcessSignal(proc, 'SIGTERM');
    if (await waitForProcessExit(proc, timeoutMs)) return;

    const forceKillFailure = sendProcessSignal(proc, 'SIGKILL');
    if (await waitForProcessExit(proc, timeoutMs)) return;

    const failures = [terminateFailure, forceKillFailure].filter((failure): failure is string => failure !== null);
    const details = failures.length > 0 ? ` (${failures.join('; ')})` : '';
    throw new Error(`Codex app-server process did not exit after SIGTERM and SIGKILL${details}.`);
}
