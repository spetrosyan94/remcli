import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';

const { mockExecSync, mockSpawn } = vi.hoisted(() => ({
    mockExecSync: vi.fn(),
    mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
    execSync: mockExecSync,
    spawn: mockSpawn,
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

import { startCloudflaredTunnel } from './tunnel';

interface FakeCloudflaredProcess extends EventEmitter {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    unref: ReturnType<typeof vi.fn>;
}

function createFakeCloudflaredProcess(): FakeCloudflaredProcess {
    const process = new EventEmitter() as FakeCloudflaredProcess;
    process.stdout = new PassThrough();
    process.stderr = new PassThrough();
    process.kill = vi.fn(() => true);
    process.unref = vi.fn();
    return process;
}

describe('cloudflared tunnel lifecycle', () => {
    beforeEach(() => {
        mockExecSync.mockReturnValue('/usr/local/bin/cloudflared\n');
        mockSpawn.mockReset();
    });

    it('waits for an edge-registration message after receiving the public URL', async () => {
        const process = createFakeCloudflaredProcess();
        mockSpawn.mockReturnValue(process);

        let hasSettled = false;
        const tunnelPromise = startCloudflaredTunnel(43123);
        void tunnelPromise.then(() => {
            hasSettled = true;
        });

        process.stderr.write('INF tunnel available at https://example.trycloudflare.com');
        await Promise.resolve();

        expect(hasSettled).toBe(false);

        process.stderr.write('INF Registered tunnel connection connIndex=0');

        await expect(tunnelPromise).resolves.toMatchObject({
            url: 'https://example.trycloudflare.com',
        });
        expect(vi.mocked(logger.debug).mock.calls.flat().join(' ')).not.toContain('example.trycloudflare.com');
    });

    it('waits for the public URL when edge registration arrives first', async () => {
        const process = createFakeCloudflaredProcess();
        mockSpawn.mockReturnValue(process);

        let hasSettled = false;
        const tunnelPromise = startCloudflaredTunnel(43123);
        void tunnelPromise.then(() => {
            hasSettled = true;
        });

        process.stderr.write('INF Registered tunnel connection connIndex=0');
        await Promise.resolve();

        expect(hasSettled).toBe(false);

        process.stderr.write('INF tunnel available at https://example.trycloudflare.com');

        await expect(tunnelPromise).resolves.toMatchObject({
            url: 'https://example.trycloudflare.com',
        });
    });

    it('recognizes URL and edge-registration messages split across output chunks', async () => {
        const process = createFakeCloudflaredProcess();
        mockSpawn.mockReturnValue(process);

        const tunnelPromise = startCloudflaredTunnel(43123);
        process.stderr.write('INF tunnel available at https://example.trycl');
        process.stderr.write('oudflare.com');
        process.stderr.write('INF Registered tunnel ');
        process.stderr.write('connection connIndex=0');

        await expect(tunnelPromise).resolves.toMatchObject({
            url: 'https://example.trycloudflare.com',
        });
    });

    it('returns null and kills cloudflared after startup timeout', async () => {
        vi.useFakeTimers();

        try {
            const process = createFakeCloudflaredProcess();
            mockSpawn.mockReturnValue(process);

            const tunnelPromise = startCloudflaredTunnel(43123);
            await vi.advanceTimersByTimeAsync(30_000);

            await expect(tunnelPromise).resolves.toBeNull();
            expect(process.kill).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports an actionable safe message when a URL has no edge registration', async () => {
        vi.useFakeTimers();
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            const process = createFakeCloudflaredProcess();
            mockSpawn.mockReturnValue(process);

            const tunnelPromise = startCloudflaredTunnel(43123);
            process.stderr.write('INF tunnel available at https://not-logged.trycloudflare.com');
            await vi.advanceTimersByTimeAsync(30_000);

            await expect(tunnelPromise).resolves.toBeNull();
            expect(consoleLog).toHaveBeenCalledWith(
                '  cloudflared did not connect to the Cloudflare edge; check your DNS or VPN and restart the tunnel.'
            );
            expect(consoleLog.mock.calls.flat().join(' ')).not.toContain('not-logged.trycloudflare.com');
        } finally {
            consoleLog.mockRestore();
            vi.useRealTimers();
        }
    });

    it('prioritizes missing edge registration over a zero exit after receiving a URL', async () => {
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            const process = createFakeCloudflaredProcess();
            mockSpawn.mockReturnValue(process);

            const tunnelPromise = startCloudflaredTunnel(43123);
            process.stderr.write('INF tunnel available at https://not-logged.trycloudflare.com');
            process.emit('exit', 0);
            process.emit('close', 0);

            await expect(tunnelPromise).resolves.toBeNull();
            expect(consoleLog).toHaveBeenCalledWith(
                '  cloudflared did not connect to the Cloudflare edge; check your DNS or VPN and restart the tunnel.'
            );
            const terminalOutput = consoleLog.mock.calls.flat().join(' ');
            expect(terminalOutput).not.toContain('exit code 0');
            expect(terminalOutput).not.toContain('not-logged.trycloudflare.com');
        } finally {
            consoleLog.mockRestore();
        }
    });

    it('keeps buffered URL output after a zero exit until close can classify the failure', async () => {
        const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

        try {
            const process = createFakeCloudflaredProcess();
            mockSpawn.mockReturnValue(process);

            const tunnelPromise = startCloudflaredTunnel(43123);
            process.emit('exit', 0);
            process.stderr.write('INF tunnel available at https://not-logged.trycloudflare.com');
            process.emit('close', 0);

            await expect(tunnelPromise).resolves.toBeNull();
            expect(consoleLog).toHaveBeenCalledWith(
                '  cloudflared did not connect to the Cloudflare edge; check your DNS or VPN and restart the tunnel.'
            );
            const terminalOutput = consoleLog.mock.calls.flat().join(' ');
            expect(terminalOutput).not.toContain('exit code 0');
            expect(terminalOutput).not.toContain('not-logged.trycloudflare.com');
        } finally {
            consoleLog.mockRestore();
        }
    });

    it('settles startup immediately when cloudflared emits an error before edge registration', async () => {
        const process = createFakeCloudflaredProcess();
        mockSpawn.mockReturnValue(process);

        const tunnelPromise = startCloudflaredTunnel(43123);
        process.stderr.write('INF tunnel available at https://example.trycloudflare.com');
        process.emit('error', new Error('spawn failed'));

        await expect(tunnelPromise).resolves.toBeNull();
    });

    it('waits for child stdio to close after cloudflared exits before failing startup', async () => {
        const process = createFakeCloudflaredProcess();
        mockSpawn.mockReturnValue(process);

        let hasSettled = false;
        const tunnelPromise = startCloudflaredTunnel(43123);
        void tunnelPromise.then(() => {
            hasSettled = true;
        });
        process.emit('exit', 1);
        await Promise.resolve();

        expect(hasSettled).toBe(false);

        process.emit('close', 1);

        await expect(tunnelPromise).resolves.toBeNull();
    });

    it('delivers one unexpected stop to a listener subscribed after process exit', async () => {
        const process = createFakeCloudflaredProcess();
        mockSpawn.mockReturnValue(process);

        const tunnelPromise = startCloudflaredTunnel(43123);
        process.stderr.write('INF tunnel established https://example.trycloudflare.com');
        process.stderr.write('INF Registered tunnel connection connIndex=0');
        const tunnel = await tunnelPromise;
        expect(tunnel).not.toBeNull();
        expect(vi.mocked(logger.debug).mock.calls.flat().join(' ')).not.toContain('example.trycloudflare.com');

        process.emit('error', new Error('connection lost'));
        process.emit('exit', 1);

        const onUnexpectedStop = vi.fn();
        tunnel?.onUnexpectedStop(onUnexpectedStop);

        expect(onUnexpectedStop).toHaveBeenCalledOnce();
    });

    it('delivers one unexpected stop to a late listener after an exit-only failure', async () => {
        const process = createFakeCloudflaredProcess();
        mockSpawn.mockReturnValue(process);

        const tunnelPromise = startCloudflaredTunnel(43123);
        process.stderr.write('INF tunnel established https://example.trycloudflare.com');
        process.stderr.write('INF Registered tunnel connection connIndex=0');
        const tunnel = await tunnelPromise;
        expect(tunnel).not.toBeNull();

        process.emit('exit', 1);

        const onUnexpectedStop = vi.fn();
        tunnel?.onUnexpectedStop(onUnexpectedStop);

        expect(onUnexpectedStop).toHaveBeenCalledOnce();
    });

    it('does not report an expected stop as a tunnel failure', async () => {
        const process = createFakeCloudflaredProcess();
        mockSpawn.mockReturnValue(process);

        const tunnelPromise = startCloudflaredTunnel(43123);
        process.stderr.write('INF tunnel established https://example.trycloudflare.com');
        process.stderr.write('INF Registered tunnel connection connIndex=0');
        const tunnel = await tunnelPromise;
        expect(tunnel).not.toBeNull();

        const onUnexpectedStop = vi.fn();
        tunnel?.onUnexpectedStop(onUnexpectedStop);
        tunnel?.stop();
        process.emit('exit', 0);

        expect(onUnexpectedStop).not.toHaveBeenCalled();
    });
});
