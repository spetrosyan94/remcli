import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonLifecycleState, DaemonLocallyPersistedState } from '@/persistence';

const readDaemonState = vi.hoisted(() => vi.fn());
const readLegacyDaemonStateDiagnostic = vi.hoisted(() => vi.fn());
const findAllRemcliProcesses = vi.hoisted(() => vi.fn());

vi.mock('@/persistence', () => ({
    readDaemonState,
    readLegacyDaemonStateDiagnostic,
}));

vi.mock('./doctor', () => ({
    findAllRemcliProcesses,
}));

import {
    checkIfDaemonRunningAndCleanupStaleState,
    getLiveLegacyDaemonMigrationBlocker,
    isVerifiedDaemonLive,
    listDaemonSessions,
    stopDaemon,
} from './controlClient';

function createDaemonState(
    overrides: Partial<DaemonLocallyPersistedState> = {},
): DaemonLocallyPersistedState {
    return {
        schemaVersion: 1,
        instanceId: '3d8c88c3-e2e4-4b0c-a4e1-5ff1f4bb2e7c',
        state: 'running',
        stateReason: 'ready',
        pid: process.pid,
        httpPort: 50123,
        startedAtMs: 1_783_120_000_000,
        startedWithCliVersion: '0.0.1',
        ownedChildPids: [],
        ...overrides,
    };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    readDaemonState.mockReset();
    readLegacyDaemonStateDiagnostic.mockReset();
    findAllRemcliProcesses.mockReset();
});

describe('daemon control lifecycle safety', () => {
    it('does not send any lifecycle request for a persisted stopped state', async () => {
        readDaemonState.mockResolvedValue(createDaemonState({
            state: 'stopped',
            stateReason: 'clean-shutdown',
        }));
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const killSpy = vi.spyOn(process, 'kill');

        await stopDaemon();

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(killSpy).not.toHaveBeenCalled();
    });

    it('refuses a PID-only force kill when the loopback daemon identity differs', async () => {
        const state = createDaemonState();
        readDaemonState.mockResolvedValue(state);
        const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
            instanceId: 'ed43ef10-18cb-4ae1-aa05-1c08c9a75b2e',
        }), { status: 200 }));
        vi.stubGlobal('fetch', fetchSpy);
        const killSpy = vi.spyOn(process, 'kill');

        await stopDaemon();

        expect(killSpy).toHaveBeenCalledWith(state.pid, 0);
        expect(killSpy).not.toHaveBeenCalledWith(state.pid, 'SIGKILL');
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy).toHaveBeenCalledWith(
            `http://127.0.0.1:${state.httpPort}/identity`,
            expect.any(Object),
        );
    });

    it.each([
        ['starting', 'startup'],
        ['stopping', 'remcli-cli-request'],
        ['stopped', 'clean-shutdown'],
        ['failed', 'startup-failed'],
    ] as const)('rejects session control while daemon is %s', async (
        state: DaemonLifecycleState,
        stateReason: DaemonLocallyPersistedState['stateReason'],
    ) => {
        readDaemonState.mockResolvedValue(createDaemonState({ state, stateReason }));
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        await expect(listDaemonSessions()).resolves.toEqual([]);

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('allows a verified stop while the daemon is still starting', async () => {
        const state = createDaemonState({ state: 'starting', stateReason: 'startup' });
        readDaemonState.mockResolvedValue(state);
        const fetchSpy = vi.fn(async (input: string) => {
            if (input.endsWith('/identity')) {
                return new Response(JSON.stringify({ instanceId: state.instanceId }), { status: 200 });
            }
            return new Response(JSON.stringify({}), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchSpy);
        let livenessChecks = 0;
        vi.spyOn(process, 'kill').mockImplementation((_, signal) => {
            if (signal === 0) {
                livenessChecks += 1;
                if (livenessChecks > 1) {
                    throw new Error('daemon exited');
                }
            }
            return true;
        });

        await stopDaemon();

        expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
            `http://127.0.0.1:${state.httpPort}/identity`,
            `http://127.0.0.1:${state.httpPort}/stop`,
        ]);
    });

    it('keeps readiness and liveness separate during shutdown', async () => {
        const state = createDaemonState({
            state: 'stopping',
            stateReason: 'remcli-cli-request',
        });
        readDaemonState.mockResolvedValue(state);
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            instanceId: state.instanceId,
        }), { status: 200 })));

        await expect(checkIfDaemonRunningAndCleanupStaleState()).resolves.toBe(false);
        await expect(isVerifiedDaemonLive()).resolves.toBe(true);
    });

    it('reports a live legacy daemon only as a migration blocker', async () => {
        const legacyState = { pid: process.pid, httpPort: 50123, startedWithCliVersion: '0.0.1' };
        readLegacyDaemonStateDiagnostic.mockResolvedValue(legacyState);
        findAllRemcliProcesses.mockResolvedValue([{
            pid: legacyState.pid,
            type: 'daemon',
            command: 'remcli daemon start-sync',
        }]);

        await expect(getLiveLegacyDaemonMigrationBlocker()).resolves.toEqual(legacyState);

        expect(findAllRemcliProcesses).toHaveBeenCalledOnce();
    });

    it('does not block migration when a legacy PID was reused by another process', async () => {
        const legacyState = { pid: process.pid, httpPort: 50123, startedWithCliVersion: '0.0.1' };
        readLegacyDaemonStateDiagnostic.mockResolvedValue(legacyState);
        findAllRemcliProcesses.mockResolvedValue([{
            pid: legacyState.pid,
            type: 'user-session',
            command: 'unrelated-command',
        }]);

        await expect(getLiveLegacyDaemonMigrationBlocker()).resolves.toBeNull();
    });

    it('does not mistake a new daemon start wrapper for the legacy daemon', async () => {
        const legacyState = { pid: 45123, httpPort: 50123, startedWithCliVersion: '0.0.1' };
        readLegacyDaemonStateDiagnostic.mockResolvedValue(legacyState);
        findAllRemcliProcesses.mockResolvedValue([{
            pid: legacyState.pid,
            type: 'daemon',
            command: 'remcli daemon start',
        }]);

        await expect(getLiveLegacyDaemonMigrationBlocker()).resolves.toBeNull();
    });
});
