import { afterEach, describe, expect, it, vi } from 'vitest';

import { logger } from '@/ui/logger';
import {
    createDaemonReplacementArgs,
    createDaemonReplacementStarter,
    createDaemonRestartIntent,
    createDaemonStartupAbortController,
    createDaemonShutdownRequestChannel,
    cleanupDaemonStartupFailure,
    handleUnexpectedTunnelStop,
    performDaemonShutdown,
    runDaemonShutdownLifecycle,
    type DaemonShutdownDependencies,
} from './run';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('daemon shutdown lifecycle', () => {
    it('aborts delayed startup readiness when daemon state ownership is lost', async () => {
        const startupAbort = createDaemonStartupAbortController();
        const delayedReadiness = new Promise<void>(() => undefined);
        const waitForReadiness = startupAbort.race(delayedReadiness);

        startupAbort.abort(new Error('Daemon state ownership changed.'));

        await expect(waitForReadiness).rejects.toThrow('Daemon state ownership changed.');
        expect(() => startupAbort.throwIfAborted()).toThrow('Daemon state ownership changed.');
    });

    it('releases every available startup resource after a later startup failure', async () => {
        const machineSocketHandle = { close: vi.fn() };
        const killAllSessions = vi.fn(async () => undefined);
        const codexAppServerHost = {
            endpoint: 'ws://127.0.0.1:45123',
            processId: 45123,
            stop: vi.fn(async () => undefined),
        };
        const tunnelStop = vi.fn();
        const freeWhisper = vi.fn(async () => undefined);
        const stopTts = vi.fn(async () => {
            throw new Error('TTS cleanup failed');
        });
        const flushP2PStore = vi.fn();
        const stopP2PServer = vi.fn(async () => undefined);
        const stopControlServer = vi.fn(async () => undefined);
        const persistFailedState = vi.fn(async () => undefined);
        const stopCaffeinate = vi.fn(async () => undefined);
        const releaseDaemonLock = vi.fn(async () => undefined);

        await cleanupDaemonStartupFailure({
            machineSocketHandle: machineSocketHandle as never,
            killAllSessions,
            codexAppServerHost,
            tunnelStop,
            freeWhisper,
            stopTts,
            flushP2PStore,
            stopP2PServer,
            stopControlServer,
            persistFailedState,
            stopCaffeinate,
            releaseDaemonLock,
        });

        expect(machineSocketHandle.close).toHaveBeenCalledOnce();
        expect(killAllSessions).toHaveBeenCalledOnce();
        expect(codexAppServerHost.stop).toHaveBeenCalledOnce();
        expect(tunnelStop).toHaveBeenCalledOnce();
        expect(freeWhisper).toHaveBeenCalledOnce();
        expect(stopTts).toHaveBeenCalledOnce();
        expect(flushP2PStore).toHaveBeenCalledOnce();
        expect(stopP2PServer).toHaveBeenCalledOnce();
        expect(stopControlServer).toHaveBeenCalledOnce();
        expect(persistFailedState).toHaveBeenCalledOnce();
        expect(stopCaffeinate).toHaveBeenCalledOnce();
        expect(releaseDaemonLock).toHaveBeenCalledOnce();
    });

    it('clears and persists LAN-only state only for the active failed tunnel', async () => {
        const activeStop = vi.fn();
        const staleStop = vi.fn();
        let activeGeneration = 3;
        let currentStop: (() => void) | null = activeStop;
        const clearActiveTunnel = vi.fn(() => {
            activeGeneration += 1;
            currentStop = null;
        });
        const persistDaemonState = vi.fn(async () => undefined);
        const reportUnexpectedStop = vi.fn();

        handleUnexpectedTunnelStop({
            generation: 2,
            stop: staleStop,
            canApplyFailureFallback: () => true,
            getActiveGeneration: () => activeGeneration,
            getActiveStop: () => currentStop,
            clearActiveTunnel,
            persistDaemonState,
            reportUnexpectedStop,
        });

        expect(clearActiveTunnel).not.toHaveBeenCalled();
        expect(persistDaemonState).not.toHaveBeenCalled();
        expect(reportUnexpectedStop).not.toHaveBeenCalled();

        handleUnexpectedTunnelStop({
            generation: 3,
            stop: activeStop,
            canApplyFailureFallback: () => true,
            getActiveGeneration: () => activeGeneration,
            getActiveStop: () => currentStop,
            clearActiveTunnel,
            persistDaemonState,
            reportUnexpectedStop,
        });
        await Promise.resolve();

        expect(clearActiveTunnel).toHaveBeenCalledOnce();
        expect(persistDaemonState).toHaveBeenCalledOnce();
        expect(reportUnexpectedStop).toHaveBeenCalledOnce();
        expect(activeGeneration).toBe(4);
        expect(currentStop).toBeNull();
    });

    it('does not retain a tunnel URL when it exits before publication', async () => {
        const activeStop = vi.fn();
        let activeGeneration = 3;
        let currentStop: (() => void) | null = activeStop;
        let tunnelUrl: string | undefined = 'https://not-logged.trycloudflare.com';
        const persistDaemonState = vi.fn(async () => undefined);

        handleUnexpectedTunnelStop({
            generation: 3,
            stop: activeStop,
            canApplyFailureFallback: () => true,
            getActiveGeneration: () => activeGeneration,
            getActiveStop: () => currentStop,
            clearActiveTunnel: () => {
                activeGeneration += 1;
                currentStop = null;
                tunnelUrl = undefined;
            },
            persistDaemonState,
            reportUnexpectedStop: vi.fn(),
        });
        await Promise.resolve();

        expect(tunnelUrl).toBeUndefined();
        expect(persistDaemonState).toHaveBeenCalledOnce();
    });

    it('does not apply LAN fallback when cleanup has made a tunnel failure ineligible', () => {
        const activeStop = vi.fn();
        const clearActiveTunnel = vi.fn();
        const persistDaemonState = vi.fn(async () => undefined);
        const reportUnexpectedStop = vi.fn();

        handleUnexpectedTunnelStop({
            generation: 3,
            stop: activeStop,
            canApplyFailureFallback: () => false,
            getActiveGeneration: () => 3,
            getActiveStop: () => activeStop,
            clearActiveTunnel,
            persistDaemonState,
            reportUnexpectedStop,
        });

        expect(clearActiveTunnel).not.toHaveBeenCalled();
        expect(persistDaemonState).not.toHaveBeenCalled();
        expect(reportUnexpectedStop).not.toHaveBeenCalled();
    });

    it('lets an explicit stop cancel a queued auto-update restart', () => {
        const restartIntent = createDaemonRestartIntent();

        restartIntent.recordShutdownRequest(true);
        expect(restartIntent.shouldRestart()).toBe(true);

        restartIntent.recordShutdownRequest(false);
        restartIntent.recordShutdownRequest(true);

        expect(restartIntent.shouldRestart()).toBe(false);
    });

    it('preserves tunnel mode in the spawned auto-update replacement', () => {
        expect(createDaemonReplacementArgs(false)).toEqual(['daemon', 'start']);
        expect(createDaemonReplacementArgs(true)).toEqual(['daemon', 'start', '--tunnel']);

        const restartIntent = createDaemonRestartIntent();
        restartIntent.recordShutdownRequest(true);
        const replacement = { unref: vi.fn() };
        const spawnReplacement = vi.fn(() => replacement);

        const didStart = createDaemonReplacementStarter(
            restartIntent,
            true,
            spawnReplacement as unknown as typeof import('@/utils/spawnRemcliCLI').spawnRemcliCLI,
        )();

        expect(didStart).toBe(true);
        expect(spawnReplacement).toHaveBeenCalledWith(['daemon', 'start', '--tunnel'], {
            detached: true,
            stdio: 'ignore',
            env: process.env,
        });
        expect(replacement.unref).toHaveBeenCalledOnce();
    });

    it('does not start an auto-update replacement after an explicit stop arrives during cleanup', async () => {
        const restartIntent = createDaemonRestartIntent();
        const shutdownRequestChannel = createDaemonShutdownRequestChannel();
        const replacement = { unref: vi.fn() };
        const spawnReplacement = vi.fn(() => replacement);
        const restartAfterRelease = vi.fn(createDaemonReplacementStarter(
            restartIntent,
            true,
            spawnReplacement as unknown as typeof import('@/utils/spawnRemcliCLI').spawnRemcliCLI,
        ));
        let resolveCleanupStarted: () => void = () => {
            throw new Error('Cleanup did not start.');
        };
        let resolveCleanup: () => void = () => {
            throw new Error('Cleanup did not block.');
        };
        const cleanupStarted = new Promise<void>((resolve) => {
            resolveCleanupStarted = resolve;
        });
        const allowCleanup = new Promise<void>((resolve) => {
            resolveCleanup = resolve;
        });
        const persistStoppedState = vi.fn(async () => undefined);
        const releaseDaemonLock = vi.fn(async () => undefined);
        const exitCodes: number[] = [];

        const enqueueShutdown = (restartAfterShutdown: boolean, source: 'exception' | 'remcli-cli') => {
            restartIntent.recordShutdownRequest(restartAfterShutdown);
            shutdownRequestChannel.enqueueShutdownRequest({ source, restartAfterShutdown });
        };
        const shutdownLifecycle = runDaemonShutdownLifecycle({
            waitForShutdownRequest: shutdownRequestChannel.waitForShutdownRequest,
            cleanupAndShutdown: async () => performDaemonShutdown({
                machineSocketHandle: null,
                killAllSessions: async () => {
                    resolveCleanupStarted();
                    await allowCleanup;
                },
                codexAppServerHost: null,
                tunnelStop: null,
                freeWhisper: async () => undefined,
                stopTts: async () => undefined,
                flushP2PStore: () => undefined,
                stopP2PServer: async () => undefined,
                stopControlServer: async () => undefined,
                persistStoppedState,
                stopCaffeinate: async () => undefined,
                releaseDaemonLock,
                restartAfterRelease,
            }, (code) => exitCodes.push(code)),
        });

        enqueueShutdown(true, 'exception');
        await cleanupStarted;
        enqueueShutdown(false, 'remcli-cli');
        resolveCleanup();
        await shutdownLifecycle;

        expect(persistStoppedState).toHaveBeenCalledOnce();
        expect(releaseDaemonLock).toHaveBeenCalledOnce();
        expect(restartAfterRelease).toHaveBeenCalledOnce();
        expect(restartAfterRelease).toHaveReturnedWith(false);
        expect(spawnReplacement).not.toHaveBeenCalled();
        expect(replacement.unref).not.toHaveBeenCalled();
        expect(exitCodes).toEqual([0]);
    });

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
        const persistStoppedState = vi.fn(async () => {
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
        let replacementObservedReleasedLock = false;
        const restartAfterRelease = vi.fn(() => {
            replacementObservedReleasedLock = !isDaemonLockHeld;
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
            persistStoppedState,
            stopCaffeinate,
            releaseDaemonLock,
            restartAfterRelease,
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
                    expect(persistStoppedState).not.toHaveBeenCalled();
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
        expect(persistStoppedState).toHaveBeenCalledOnce();
        expect(releaseDaemonLock).toHaveBeenCalledOnce();
        expect(restartAfterRelease).toHaveBeenCalledOnce();
        expect(replacementObservedReleasedLock).toBe(true);
        expect(ownerState).toBeUndefined();
        expect(isDaemonLockHeld).toBe(false);
        expect(exitCodes).toEqual([0]);
    });
});
