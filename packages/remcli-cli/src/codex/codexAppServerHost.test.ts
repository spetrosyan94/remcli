import { EventEmitter } from 'node:events';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import {
    buildCodexAppServerEndpoint,
    buildCodexAppServerReadyUrl,
    buildCodexRemoteTuiCommand,
    isCodexAppServerStateUsable,
    startCodexAppServerHost,
} from './codexAppServerHost';

interface FakeProcess extends EventEmitter {
    pid: number;
    stderr: EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
}

type CodexAppServerProcess = ChildProcessByStdio<null, Readable, Readable>;

function emitProcessExit(
    proc: EventEmitter & Pick<FakeProcess, 'exitCode' | 'signalCode'>,
    code: number | null,
    signal: NodeJS.Signals | null,
): void {
    proc.exitCode = code;
    proc.signalCode = signal;
    proc.emit('exit', code, signal);
}

function createFakeProcess(): CodexAppServerProcess {
    const proc = new EventEmitter() as FakeProcess;
    proc.pid = 12345;
    proc.stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    proc.stderr.setEncoding = vi.fn();
    proc.exitCode = null;
    proc.signalCode = null;
    proc.killed = false;
    proc.kill = vi.fn((signal?: NodeJS.Signals | number) => {
        proc.killed = true;
        queueMicrotask(() => emitProcessExit(
            proc,
            typeof signal === 'string' ? null : 0,
            typeof signal === 'string' ? signal : null,
        ));
        return true;
    });
    return proc as unknown as CodexAppServerProcess;
}

describe('codex app-server host helpers', () => {
    it('builds loopback websocket endpoints and remote TUI commands', () => {
        expect(buildCodexAppServerEndpoint(45123)).toBe('ws://127.0.0.1:45123');
        expect(buildCodexAppServerReadyUrl('ws://127.0.0.1:45123')).toBe('http://127.0.0.1:45123/readyz');
        expect(buildCodexAppServerReadyUrl('wss://codex.local/ws')).toBe('https://codex.local/readyz');
        expect(buildCodexAppServerReadyUrl('http://127.0.0.1:45123')).toBeNull();
        expect(buildCodexRemoteTuiCommand('ws://127.0.0.1:45123', undefined, null)).toBe(
            "codex --remote 'ws://127.0.0.1:45123'"
        );
        expect(buildCodexRemoteTuiCommand('ws://127.0.0.1:45123', 'thread-1', null)).toBe(
            "codex resume 'thread-1' --remote 'ws://127.0.0.1:45123'"
        );
        expect(buildCodexRemoteTuiCommand('ws://127.0.0.1:45123', 'thread-1', 'high')).toBe(
            "codex -c 'model_reasoning_effort=\"high\"' resume 'thread-1' --remote 'ws://127.0.0.1:45123'"
        );
        expect(buildCodexRemoteTuiCommand('ws://127.0.0.1:45123', 'thread-1', null, 'gpt-5.6-no-reasoning')).toBe(
            "codex --model 'gpt-5.6-no-reasoning' resume 'thread-1' --remote 'ws://127.0.0.1:45123'"
        );
        expect(buildCodexRemoteTuiCommand('ws://127.0.0.1:45123', 'thread-1', 'xhigh', 'gpt-5.6-luna')).toBe(
            "codex -c 'model_reasoning_effort=\"xhigh\"' --model 'gpt-5.6-luna' resume 'thread-1' --remote 'ws://127.0.0.1:45123'"
        );
        expect(() => buildCodexRemoteTuiCommand(
            'ws://127.0.0.1:45123',
            'thread-1',
            undefined as unknown as null,
        )).toThrow('Codex remote TUI reasoning effort must be a non-empty string or null.');
        expect(() => buildCodexRemoteTuiCommand(
            'ws://127.0.0.1:45123',
            'thread-1',
            1 as unknown as null,
        )).toThrow('Codex remote TUI reasoning effort must be a non-empty string or null.');
    });

    it('treats shared app-server state as usable only when pid and readiness are healthy', async () => {
        const state = {
            codexAppServerEndpoint: 'ws://127.0.0.1:45123',
            codexAppServerPid: 12345,
        };

        await expect(isCodexAppServerStateUsable(state, {
            isProcessRunning: () => true,
            fetchReady: async () => true,
        })).resolves.toBe(true);

        await expect(isCodexAppServerStateUsable(state, {
            isProcessRunning: () => false,
            fetchReady: async () => true,
        })).resolves.toBe(false);

        await expect(isCodexAppServerStateUsable(state, {
            isProcessRunning: () => true,
            fetchReady: async () => false,
        })).resolves.toBe(false);
    });

    it('starts a shared codex app-server and waits for readiness', async () => {
        const proc = createFakeProcess();
        const fetchReady = vi.fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const spawnAppServer = vi.fn(() => proc);

        const handle = await startCodexAppServerHost({
            choosePort: async () => 45123,
            spawnAppServer,
            fetchReady,
            readyPollMs: 1,
            readyTimeoutMs: 100,
            stopTimeoutMs: 100,
        });

        expect(spawnAppServer).toHaveBeenCalledWith(45123);
        expect(fetchReady).toHaveBeenCalledWith('http://127.0.0.1:45123/readyz');
        expect(handle).toMatchObject({
            endpoint: 'ws://127.0.0.1:45123',
            processId: 12345,
        });

        await handle.stop();
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('fails fast when app-server exits before readiness', async () => {
        const proc = createFakeProcess();
        const starting = startCodexAppServerHost({
            choosePort: async () => 45123,
            spawnAppServer: () => proc,
            fetchReady: async () => false,
            readyPollMs: 1,
            readyTimeoutMs: 100,
        });

        queueMicrotask(() => emitProcessExit(proc, 1, null));

        await expect(starting).rejects.toThrow('Codex app-server exited before ready');
    });

    it('rejects without redundant cleanup when a pending readiness probe observes an exited process', async () => {
        const proc = createFakeProcess();
        let resolveFetchStarted: (() => void) | undefined;
        const fetchStarted = new Promise<void>((resolve) => {
            resolveFetchStarted = resolve;
        });
        const fetchReady = vi.fn(() => {
            resolveFetchStarted?.();
            return new Promise<boolean>(() => undefined);
        });
        const starting = startCodexAppServerHost({
            choosePort: async () => 45123,
            spawnAppServer: () => proc,
            fetchReady,
            readyTimeoutMs: 100,
            readyRequestTimeoutMs: 100,
            stopTimeoutMs: 100,
        });

        await fetchStarted;
        emitProcessExit(proc, 1, null);

        await expect(starting).rejects.toThrow('Codex app-server exited before ready (code=1 signal=null).');
        expect(proc.kill).not.toHaveBeenCalled();
        expect(proc.listenerCount('exit')).toBe(0);
        expect(proc.listenerCount('error')).toBe(0);
    });

    it('preserves a signal-based readiness failure without redundant cleanup signals or waits', async () => {
        const proc = createFakeProcess();
        const stopTimeoutMs = 5;
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
        proc.kill = vi.fn(() => {
            throw new Error('cleanup signal must not be sent');
        });

        let resolveFetchStarted: (() => void) | undefined;
        const fetchStarted = new Promise<void>((resolve) => {
            resolveFetchStarted = resolve;
        });
        const fetchReady = vi.fn(() => {
            resolveFetchStarted?.();
            return new Promise<boolean>(() => undefined);
        });
        const starting = startCodexAppServerHost({
            choosePort: async () => 45123,
            spawnAppServer: () => proc,
            fetchReady,
            readyTimeoutMs: 100,
            readyRequestTimeoutMs: 100,
            stopTimeoutMs,
        });

        try {
            await fetchStarted;
            emitProcessExit(proc, null, 'SIGTERM');

            await expect(starting).rejects.toThrow(
                'Codex app-server exited before ready (code=null signal=SIGTERM).',
            );
            expect(proc.kill).not.toHaveBeenCalled();
            expect(setTimeoutSpy.mock.calls.some((call) => call[1] === stopTimeoutMs)).toBe(false);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it('rejects and reaps the app-server when a readiness probe never resolves', async () => {
        const proc = createFakeProcess();

        await expect(startCodexAppServerHost({
            choosePort: async () => 45123,
            spawnAppServer: () => proc,
            fetchReady: async () => await new Promise<boolean>(() => undefined),
            readyTimeoutMs: 100,
            readyRequestTimeoutMs: 5,
            stopTimeoutMs: 100,
        })).rejects.toThrow('Timed out waiting for Codex app-server readiness');

        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('fails controllably when spawning the app-server emits an error', async () => {
        const proc = createFakeProcess();
        const starting = startCodexAppServerHost({
            choosePort: async () => 45123,
            spawnAppServer: () => proc,
            fetchReady: async () => await new Promise<boolean>(() => undefined),
            readyPollMs: 1,
            readyTimeoutMs: 100,
            stopTimeoutMs: 100,
        });

        queueMicrotask(() => proc.emit('error', new Error('spawn codex ENOENT')));

        await expect(starting).rejects.toThrow('Codex app-server failed to start: spawn codex ENOENT.');
        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('reaps the spawned app-server when readiness times out', async () => {
        const proc = createFakeProcess();

        await expect(startCodexAppServerHost({
            choosePort: async () => 45123,
            spawnAppServer: () => proc,
            fetchReady: async () => false,
            readyPollMs: 1,
            readyTimeoutMs: 5,
            stopTimeoutMs: 5,
        })).rejects.toThrow('Timed out waiting for Codex app-server readiness');

        expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('falls back to SIGKILL after delivered SIGTERM does not exit the app-server', async () => {
        const proc = createFakeProcess();
        const fakeProc = proc as unknown as FakeProcess;
        const originalKill = proc.kill;
        const stopTimeoutMs = 5;
        proc.kill = vi.fn((signal?: NodeJS.Signals | number) => {
            fakeProc.killed = true;
            if (signal === 'SIGTERM') return true;
            return originalKill(signal);
        });
        vi.useFakeTimers();

        try {
            const handle = await startCodexAppServerHost({
                choosePort: async () => 45123,
                spawnAppServer: () => proc,
                fetchReady: async () => true,
                stopTimeoutMs,
            });
            const stopping = handle.stop();

            expect(proc.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
            expect(proc.kill).toHaveBeenCalledTimes(1);
            expect(proc.exitCode).toBeNull();
            expect(proc.signalCode).toBeNull();

            await vi.advanceTimersByTimeAsync(stopTimeoutMs - 1);
            expect(proc.kill).toHaveBeenCalledTimes(1);
            expect(proc.exitCode).toBeNull();
            expect(proc.signalCode).toBeNull();

            await vi.advanceTimersByTimeAsync(1);
            await stopping;
        } finally {
            vi.useRealTimers();
        }

        expect(proc.kill).toHaveBeenCalledTimes(2);
        expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
        expect(proc.exitCode).toBeNull();
        expect(proc.signalCode).toBe('SIGKILL');
        expect(fakeProc.killed).toBe(true);
    });

    it('rejects stop when the app-server cannot be terminated', async () => {
        const proc = createFakeProcess();
        const handle = await startCodexAppServerHost({
            choosePort: async () => 45123,
            spawnAppServer: () => proc,
            fetchReady: async () => true,
            stopTimeoutMs: 5,
        });
        proc.kill = vi.fn(() => false);

        await expect(handle.stop()).rejects.toThrow(
            'Codex app-server process did not exit after SIGTERM and SIGKILL',
        );

        expect(proc.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
        expect(proc.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    });

    it('redacts credentials from shared app-server stderr diagnostics', async () => {
        const proc = createFakeProcess();
        const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
        const cookie = 'host-stderr-cookie-value';

        try {
            const handle = await startCodexAppServerHost({
                choosePort: async () => 45123,
                spawnAppServer: () => proc,
                fetchReady: async () => true,
            });
            proc.stderr.emit('data', `Cookie: ${cookie}`);

            const diagnostics = JSON.stringify(debug.mock.calls);
            expect(diagnostics).toContain('[REDACTED]');
            expect(diagnostics).not.toContain(cookie);

            await handle.stop();
        } finally {
            debug.mockRestore();
        }
    });
});
