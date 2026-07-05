import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';

import { logger } from '@/ui/logger';

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_READY_TIMEOUT_MS = 10_000;
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

export function buildCodexRemoteTuiCommand(endpoint: string, threadId?: string): string {
    const quotedEndpoint = shellQuote(endpoint);
    if (threadId) {
        return `codex resume ${shellQuote(threadId)} --remote ${quotedEndpoint}`;
    }
    return `codex --remote ${quotedEndpoint}`;
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
        if (text) logger.debug('[CodexAppServerHost][stderr]', text);
    });

    await waitUntilReady({
        proc,
        readyUrl,
        fetchReady: deps.fetchReady ?? fetchReadyUrl,
        timeoutMs: deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        pollMs: deps.readyPollMs ?? DEFAULT_READY_POLL_MS,
    });

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
    pollMs: number;
}): Promise<void> {
    const deadline = Date.now() + options.timeoutMs;
    let exited = false;
    let exitText = '';
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        exited = true;
        exitText = `code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    };
    options.proc.once('exit', onExit);

    try {
        while (Date.now() < deadline) {
            if (exited) {
                throw new Error(`Codex app-server exited before ready (${exitText}).`);
            }
            if (await options.fetchReady(options.readyUrl)) {
                return;
            }
            await sleep(options.pollMs);
        }
        throw new Error(`Timed out waiting for Codex app-server readiness at ${options.readyUrl}.`);
    } finally {
        options.proc.off('exit', onExit);
    }
}

async function stopProcess(proc: CodexAppServerProcess, timeoutMs: number): Promise<void> {
    if (proc.exitCode !== null || proc.killed) return;

    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            proc.off('exit', finish);
            resolve();
        };
        const timeout = setTimeout(() => {
            try {
                proc.kill('SIGKILL');
            } catch {
                // best effort
            }
            finish();
        }, timeoutMs);

        proc.once('exit', finish);
        try {
            proc.kill('SIGTERM');
        } catch {
            finish();
        }
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
