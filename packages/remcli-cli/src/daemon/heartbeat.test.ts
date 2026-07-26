import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import type { DaemonLocallyPersistedState } from '@/persistence';

import { runDaemonHeartbeat, startHeartbeatLoop } from './heartbeat';

const originalHeartbeatInterval = process.env.REMCLI_DAEMON_HEARTBEAT_INTERVAL;

afterEach(() => {
    vi.useRealTimers();
    if (originalHeartbeatInterval === undefined) {
        delete process.env.REMCLI_DAEMON_HEARTBEAT_INTERVAL;
    } else {
        process.env.REMCLI_DAEMON_HEARTBEAT_INTERVAL = originalHeartbeatInterval;
    }
});

function createDaemonState(instanceId = '3d8c88c3-e2e4-4b0c-a4e1-5ff1f4bb2e7c'): DaemonLocallyPersistedState {
    return {
        schemaVersion: 1,
        instanceId,
        state: 'running',
        stateReason: 'ready',
        pid: process.pid,
        httpPort: 50123,
        startedAtMs: 1_783_120_000_000,
        startedWithCliVersion: configuration.currentCliVersion,
        ownedChildPids: [50124],
    };
}

describe('daemon heartbeat lifecycle ownership', () => {
    it('persists a heartbeat only while the same running instance owns the state snapshot', async () => {
        const state = createDaemonState();
        const pruneDeadSessions = vi.fn();
        const requestShutdown = vi.fn();
        const persistHeartbeat = vi.fn();

        await runDaemonHeartbeat({
            instanceId: state.instanceId,
            pruneDeadSessions,
            requestShutdown,
            isStateWriterActive: () => true,
            persistHeartbeat,
            getDaemonState: async () => state,
            getProjectVersion: () => configuration.currentCliVersion,
            getNow: () => 1_783_120_001_000,
            isCodexAppServerStateUsable: async () => true,
        });

        expect(pruneDeadSessions).toHaveBeenCalledOnce();
        expect(requestShutdown).not.toHaveBeenCalled();
        expect(persistHeartbeat).toHaveBeenCalledWith(state, 1_783_120_001_000, true);
    });

    it('fails closed after an owner change and never writes a stale heartbeat', async () => {
        const currentState = createDaemonState('ed43ef10-18cb-4ae1-aa05-1c08c9a75b2e');
        const requestShutdown = vi.fn();
        const persistHeartbeat = vi.fn();

        await runDaemonHeartbeat({
            instanceId: '3d8c88c3-e2e4-4b0c-a4e1-5ff1f4bb2e7c',
            pruneDeadSessions: vi.fn(),
            requestShutdown,
            isStateWriterActive: () => true,
            persistHeartbeat,
            getDaemonState: async () => currentState,
            getProjectVersion: () => configuration.currentCliVersion,
            isCodexAppServerStateUsable: async () => true,
        });

        expect(requestShutdown).toHaveBeenCalledWith('exception', 'Daemon state ownership changed.');
        expect(persistHeartbeat).not.toHaveBeenCalled();
    });

    it('requests a replacement only after version-mismatch shutdown completes', async () => {
        const state = createDaemonState();
        const requestShutdown = vi.fn();

        await runDaemonHeartbeat({
            instanceId: state.instanceId,
            pruneDeadSessions: vi.fn(),
            requestShutdown,
            isStateWriterActive: () => true,
            persistHeartbeat: vi.fn(),
            getDaemonState: async () => state,
            getProjectVersion: () => 'next-cli-version',
            isCodexAppServerStateUsable: async () => true,
        });

        expect(requestShutdown).toHaveBeenCalledWith(
            'exception',
            'Daemon CLI version changed.',
            true,
        );
    });

    it('does not overlap ticks and waits for an in-flight heartbeat during shutdown', async () => {
        vi.useFakeTimers();
        process.env.REMCLI_DAEMON_HEARTBEAT_INTERVAL = '10';
        const state = createDaemonState();
        let resolvePersist: (() => void) | undefined;
        const pendingPersist = new Promise<void>((resolve) => {
            resolvePersist = resolve;
        });
        const persistHeartbeat = vi.fn(() => pendingPersist);
        const heartbeat = startHeartbeatLoop({
            instanceId: state.instanceId,
            pruneDeadSessions: vi.fn(),
            requestShutdown: vi.fn(),
            isStateWriterActive: () => true,
            persistHeartbeat,
            getDaemonState: async () => state,
            getProjectVersion: () => configuration.currentCliVersion,
            isCodexAppServerStateUsable: async () => true,
        });

        await vi.advanceTimersByTimeAsync(10);
        await Promise.resolve();
        expect(persistHeartbeat).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(100);
        expect(persistHeartbeat).toHaveBeenCalledOnce();

        heartbeat.stop();
        resolvePersist?.();
        await heartbeat.waitForIdle();

        await vi.advanceTimersByTimeAsync(100);
        expect(persistHeartbeat).toHaveBeenCalledOnce();
    });
});
