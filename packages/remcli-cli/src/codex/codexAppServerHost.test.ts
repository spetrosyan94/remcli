import { EventEmitter } from 'node:events';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

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
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
}

type CodexAppServerProcess = ChildProcessByStdio<null, Readable, Readable>;

function createFakeProcess(): CodexAppServerProcess {
    const proc = new EventEmitter() as FakeProcess;
    proc.pid = 12345;
    proc.stderr = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
    proc.stderr.setEncoding = vi.fn();
    proc.exitCode = null;
    proc.killed = false;
    proc.kill = vi.fn((signal?: NodeJS.Signals | number) => {
        proc.killed = true;
        proc.exitCode = 0;
        queueMicrotask(() => proc.emit('exit', 0, typeof signal === 'string' ? signal : null));
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
        expect(buildCodexRemoteTuiCommand('ws://127.0.0.1:45123')).toBe("codex --remote 'ws://127.0.0.1:45123'");
        expect(buildCodexRemoteTuiCommand('ws://127.0.0.1:45123', 'thread-1')).toBe(
            "codex resume 'thread-1' --remote 'ws://127.0.0.1:45123'"
        );
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

        queueMicrotask(() => proc.emit('exit', 1, null));

        await expect(starting).rejects.toThrow('Codex app-server exited before ready');
    });
});
