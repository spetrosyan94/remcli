import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import {
    createDaemonShutdownRequestChannel,
    performDaemonShutdown,
    runDaemonShutdownLifecycle,
    type DaemonShutdownDependencies,
} from './run';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('daemon shutdown lifecycle', () => {
    it('retries shared Codex host stop from a signal buffered while the first stop is pending', async () => {
        let ownerState: { codexAppServerEndpoint: string; codexAppServerPid: number } | undefined = {
            codexAppServerEndpoint: 'ws://127.0.0.1:45123',
            codexAppServerPid: 45123,
        };
        let isDaemonLockHeld = true;
        let isInitialStop = true;
        let resolveFirstStop: () => void = () => {
            throw new Error('First Codex app-server stop was not pending.');
        };
        let resolveFirstStopStarted: () => void = () => {
            throw new Error('First Codex app-server stop did not start.');
        };
        const firstStop = new Promise<void>((resolve) => {
            resolveFirstStop = resolve;
        });
        const firstStopStarted = new Promise<void>((resolve) => {
            resolveFirstStopStarted = resolve;
        });
        const stopError = new Error('Codex app-server stop failed; authorization: Bearer super-secret');
        const stop = vi.fn(async () => {
            if (isInitialStop) {
                isInitialStop = false;
                resolveFirstStopStarted();
                await firstStop;
                throw stopError;
            }
        });
        const cleanupDaemonState = vi.fn(async () => {
            ownerState = undefined;
        });
        const tunnelStop = vi.fn();
        const freeWhisper = vi.fn(async () => undefined);
        const stopTts = vi.fn(async () => undefined);
        const flushP2PStore = vi.fn();
        const stopP2PServer = vi.fn(async () => undefined);
        const stopControlServer = vi.fn(async () => undefined);
        const stopCaffeinate = vi.fn(async () => undefined);
        const releaseDaemonLock = vi.fn(async () => {
            isDaemonLockHeld = false;
        });
        const exitCodes: number[] = [];
        const warning = vi.spyOn(logger, 'warn');
        const codexAppServerHost = {
            endpoint: 'ws://127.0.0.1:45123',
            processId: 45123,
            stop,
        };
        const dependencies: DaemonShutdownDependencies = {
            machineSocketHandle: null,
            killAllSessions: async () => undefined,
            codexAppServerHost,
            tunnelStop,
            freeWhisper,
            stopTts,
            flushP2PStore,
            stopP2PServer,
            stopControlServer,
            cleanupDaemonState,
            stopCaffeinate,
            releaseDaemonLock,
        };

        const shutdownRequestChannel = createDaemonShutdownRequestChannel();
        const lifecycleEvents: string[] = [];

        const shutdownLifecycle = runDaemonShutdownLifecycle({
            waitForShutdownRequest: async () => {
                const request = await shutdownRequestChannel.waitForShutdownRequest();
                lifecycleEvents.push('shutdown-request');
                return request;
            },
            cleanupAndShutdown: async () => {
                const shutdownResult = await performDaemonShutdown(dependencies, (code) => exitCodes.push(code));
                lifecycleEvents.push(`shutdown-${shutdownResult}`);
                if (shutdownResult === 'retry') {
                    expect(tunnelStop).not.toHaveBeenCalled();
                    expect(freeWhisper).not.toHaveBeenCalled();
                    expect(stopTts).not.toHaveBeenCalled();
                    expect(flushP2PStore).not.toHaveBeenCalled();
                    expect(stopP2PServer).not.toHaveBeenCalled();
                    expect(stopControlServer).not.toHaveBeenCalled();
                    expect(cleanupDaemonState).not.toHaveBeenCalled();
                    expect(releaseDaemonLock).not.toHaveBeenCalled();
                    expect(ownerState).toEqual({
                        codexAppServerEndpoint: 'ws://127.0.0.1:45123',
                        codexAppServerPid: 45123,
                    });
                    expect(isDaemonLockHeld).toBe(true);
                    expect(exitCodes).toEqual([]);
                }
                return shutdownResult;
            },
        });

        shutdownRequestChannel.enqueueShutdownRequest({ source: 'remcli-cli' });
        await firstStopStarted;
        shutdownRequestChannel.enqueueShutdownRequest({ source: 'os-signal' });
        expect(stop).toHaveBeenCalledOnce();
        expect(lifecycleEvents).toEqual(['shutdown-request']);

        resolveFirstStop();
        await shutdownLifecycle;

        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining('Failed to stop shared Codex app-server'),
            expect.objectContaining({
                message: expect.stringContaining('authorization: Bearer [REDACTED]'),
            }),
        );
        expect(warning.mock.calls.flat().join(' ')).not.toContain('super-secret');
        expect(stop).toHaveBeenCalledTimes(2);
        expect(stop.mock.contexts).toEqual([codexAppServerHost, codexAppServerHost]);
        expect(lifecycleEvents).toEqual([
            'shutdown-request',
            'shutdown-retry',
            'shutdown-request',
            'shutdown-completed',
        ]);
        expect(tunnelStop).toHaveBeenCalledOnce();
        expect(freeWhisper).toHaveBeenCalledOnce();
        expect(stopTts).toHaveBeenCalledOnce();
        expect(flushP2PStore).toHaveBeenCalledOnce();
        expect(stopP2PServer).toHaveBeenCalledOnce();
        expect(stopControlServer).toHaveBeenCalledOnce();
        expect(stopCaffeinate).toHaveBeenCalledOnce();
        expect(cleanupDaemonState).toHaveBeenCalledOnce();
        expect(releaseDaemonLock).toHaveBeenCalledOnce();
        expect(ownerState).toBeUndefined();
        expect(isDaemonLockHeld).toBe(false);
        expect(exitCodes).toEqual([0]);
    });
});
