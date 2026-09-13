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
    bindDaemonAntigravityConversation,
    checkIfDaemonRunningAndCleanupStaleState,
    getLiveLegacyDaemonMigrationBlocker,
    getDaemonOwnershipStatus,
    isVerifiedDaemonLive,
    listDaemonSessions,
    preflightDaemonAntigravityRunner,
    reportDaemonAntigravityRunnerBootstrapFailure,
    stopDaemon,
} from './controlClient';
import {
    forgetSessionRunnerCredential,
    rememberSessionRunnerCredential,
} from './p2p/p2pRunnerCredentials';

const ANTIGRAVITY_CLIENT_SESSION_ID = 'remcli-antigravity-client';

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
    vi.unstubAllEnvs();
    forgetSessionRunnerCredential(ANTIGRAVITY_CLIENT_SESSION_ID);
    readDaemonState.mockReset();
    readLegacyDaemonStateDiagnostic.mockReset();
    findAllRemcliProcesses.mockReset();
});

describe('daemon control lifecycle safety', () => {
    it('does not send any lifecycle request for a persisted stopped state', async () => {
        readDaemonState.mockResolvedValue(createDaemonState({
            state: 'stopped',
            stateReason: 'clean-shutdown',
            pid: 999_999,
        }));
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('process not found'), { code: 'ESRCH' });
        });
        findAllRemcliProcesses.mockResolvedValue([]);

        await expect(stopDaemon()).resolves.toBe(true);

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(killSpy).toHaveBeenCalledWith(999_999, 0);
    });

    it('refuses a PID-only force kill when the loopback daemon identity differs', async () => {
        const state = createDaemonState();
        readDaemonState.mockResolvedValue(state);
        const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
            instanceId: 'ed43ef10-18cb-4ae1-aa05-1c08c9a75b2e',
        }), { status: 200 }));
        vi.stubGlobal('fetch', fetchSpy);
        const killSpy = vi.spyOn(process, 'kill');

        await expect(stopDaemon()).resolves.toBe(false);

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
                    throw Object.assign(new Error('daemon exited'), { code: 'ESRCH' });
                }
            }
            return true;
        });
        findAllRemcliProcesses.mockResolvedValue([]);

        await expect(stopDaemon()).resolves.toBe(true);

        expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
            `http://127.0.0.1:${state.httpPort}/identity`,
            `http://127.0.0.1:${state.httpPort}/stop`,
        ]);
        expect(fetchSpy).toHaveBeenNthCalledWith(
            2,
            `http://127.0.0.1:${state.httpPort}/stop`,
            expect.objectContaining({
                body: JSON.stringify({ instanceId: state.instanceId }),
            }),
        );
    });

    it('refuses to report a missing state as stopped while an unverified daemon process exists', async () => {
        readDaemonState.mockResolvedValue(null);
        findAllRemcliProcesses.mockResolvedValue([{
            pid: 50_123,
            type: 'daemon',
            command: 'remcli daemon start-sync',
        }]);
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        await expect(stopDaemon()).resolves.toBe(false);
        await expect(getDaemonOwnershipStatus()).resolves.toBe('unresolved');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reports failure when the verified daemon refuses the stop request', async () => {
        const state = createDaemonState();
        readDaemonState.mockResolvedValue(state);
        const fetchSpy = vi.fn(async (input: string) => {
            if (input.endsWith('/identity')) {
                return new Response(JSON.stringify({ instanceId: state.instanceId }), { status: 200 });
            }
            return new Response(JSON.stringify({ error: 'busy' }), { status: 503 });
        });
        vi.stubGlobal('fetch', fetchSpy);
        const killSpy = vi.spyOn(process, 'kill');

        await expect(stopDaemon()).resolves.toBe(false);

        expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
            `http://127.0.0.1:${state.httpPort}/identity`,
            `http://127.0.0.1:${state.httpPort}/stop`,
        ]);
        expect(killSpy).not.toHaveBeenCalledWith(state.pid, 'SIGKILL');
    });

    it('rejects a replaced daemon instance after a verified stop request', async () => {
        const state = createDaemonState();
        readDaemonState.mockResolvedValue(state);
        let identityCalls = 0;
        const fetchSpy = vi.fn(async (input: string) => {
            if (input.endsWith('/stop')) {
                return new Response(JSON.stringify({}), { status: 200 });
            }

            identityCalls += 1;
            return new Response(JSON.stringify({
                instanceId: identityCalls === 1 ? state.instanceId : 'new-daemon-instance',
            }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchSpy);
        vi.spyOn(process, 'kill').mockReturnValue(true);

        await expect(stopDaemon()).resolves.toBe(false);

        expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
            `http://127.0.0.1:${state.httpPort}/identity`,
            `http://127.0.0.1:${state.httpPort}/stop`,
            `http://127.0.0.1:${state.httpPort}/identity`,
        ]);
    });

    it('classifies only ESRCH as an absent daemon process', async () => {
        const state = createDaemonState({ state: 'stopped', stateReason: 'clean-shutdown' });
        readDaemonState.mockResolvedValue(state);
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('process not found'), { code: 'ESRCH' });
        });
        findAllRemcliProcesses.mockResolvedValue([]);

        await expect(getDaemonOwnershipStatus()).resolves.toBe('absent');
        await expect(stopDaemon()).resolves.toBe(true);
    });

    it('fails closed when process probing returns EPERM', async () => {
        const state = createDaemonState({ state: 'stopped', stateReason: 'clean-shutdown' });
        readDaemonState.mockResolvedValue(state);
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('permission denied'), { code: 'EPERM' });
        });

        await expect(getDaemonOwnershipStatus()).resolves.toBe('unresolved');
        await expect(stopDaemon()).resolves.toBe(false);
        expect(findAllRemcliProcesses).not.toHaveBeenCalled();
    });

    it('fails closed for a stale state when another Remcli daemon is discovered', async () => {
        const state = createDaemonState({ state: 'stopped', stateReason: 'clean-shutdown' });
        readDaemonState.mockResolvedValue(state);
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('process not found'), { code: 'ESRCH' });
        });
        findAllRemcliProcesses.mockResolvedValue([{
            pid: 50_123,
            type: 'daemon',
            command: 'remcli daemon start-sync',
        }]);

        await expect(getDaemonOwnershipStatus()).resolves.toBe('unresolved');
        await expect(stopDaemon()).resolves.toBe(false);
    });

    it('fails closed when Remcli process discovery is unavailable', async () => {
        const state = createDaemonState({ state: 'stopped', stateReason: 'clean-shutdown' });
        readDaemonState.mockResolvedValue(state);
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw Object.assign(new Error('process not found'), { code: 'ESRCH' });
        });
        findAllRemcliProcesses.mockRejectedValue(new Error('ps-list unavailable'));

        await expect(getDaemonOwnershipStatus()).resolves.toBe('unresolved');
        await expect(stopDaemon()).resolves.toBe(false);
    });

    it('does not treat a live daemon with an unreachable control endpoint as stopped', async () => {
        vi.useFakeTimers();
        const state = createDaemonState();
        readDaemonState.mockResolvedValue(state);
        let identityCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: string) => {
            if (input.endsWith('/stop')) {
                return new Response(JSON.stringify({}), { status: 200 });
            }

            identityCalls += 1;
            if (identityCalls === 1) {
                return new Response(JSON.stringify({ instanceId: state.instanceId }), { status: 200 });
            }
            throw new Error('control endpoint closed before process exit');
        }));
        vi.spyOn(process, 'kill').mockReturnValue(true);

        try {
            const stopped = stopDaemon();
            await vi.advanceTimersByTimeAsync(15_000);

            await expect(stopped).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('confirms a verified stop after the control endpoint closes before process exit', async () => {
        vi.useFakeTimers();
        const state = createDaemonState();
        readDaemonState.mockResolvedValue(state);
        let identityCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: string) => {
            if (input.endsWith('/stop')) {
                return new Response(JSON.stringify({}), { status: 200 });
            }

            identityCalls += 1;
            if (identityCalls === 1) {
                return new Response(JSON.stringify({ instanceId: state.instanceId }), { status: 200 });
            }
            throw new Error('control endpoint closed during graceful shutdown');
        }));
        let livenessChecks = 0;
        vi.spyOn(process, 'kill').mockImplementation((_, signal) => {
            if (signal === 0) {
                livenessChecks += 1;
                if (livenessChecks >= 4) {
                    throw Object.assign(new Error('daemon exited'), { code: 'ESRCH' });
                }
            }
            return true;
        });
        findAllRemcliProcesses.mockResolvedValue([]);

        try {
            const stopped = stopDaemon();
            await vi.advanceTimersByTimeAsync(300);

            await expect(stopped).resolves.toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('confirms a verified stop when only start command wrappers remain visible', async () => {
        const state = createDaemonState();
        readDaemonState.mockResolvedValue(state);
        let identityCalls = 0;
        vi.stubGlobal('fetch', vi.fn(async (input: string) => {
            if (input.endsWith('/stop')) {
                return new Response(JSON.stringify({}), { status: 200 });
            }

            identityCalls += 1;
            if (identityCalls === 1) {
                return new Response(JSON.stringify({ instanceId: state.instanceId }), { status: 200 });
            }
            throw new Error('control endpoint closed during graceful shutdown');
        }));
        let livenessChecks = 0;
        vi.spyOn(process, 'kill').mockImplementation((_, signal) => {
            if (signal === 0) {
                livenessChecks += 1;
                if (livenessChecks >= 3) {
                    throw Object.assign(new Error('daemon exited'), { code: 'ESRCH' });
                }
            }
            return true;
        });
        findAllRemcliProcesses.mockResolvedValue([
            {
                pid: 51_001,
                type: 'user-session',
                command: 'sh -c "npm run start:tunnel"',
            },
            {
                pid: 51_002,
                type: 'user-session',
                command: 'node packages/remcli-cli/bin/remcli.mjs daemon start-sync --tunnel',
            },
        ]);

        await expect(stopDaemon()).resolves.toBe(true);
    });

    it('does not treat a removed state file as a stopped daemon while the captured instance is alive', async () => {
        vi.useFakeTimers();
        const state = createDaemonState();
        readDaemonState.mockResolvedValueOnce(state).mockResolvedValue(null);
        vi.stubGlobal('fetch', vi.fn(async (input: string) => {
            if (input.endsWith('/identity')) {
                return new Response(JSON.stringify({ instanceId: state.instanceId }), { status: 200 });
            }
            return new Response(JSON.stringify({}), { status: 200 });
        }));
        vi.spyOn(process, 'kill').mockReturnValue(true);

        try {
            const stopped = stopDaemon();
            await vi.advanceTimersByTimeAsync(15_000);

            await expect(stopped).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not treat a persisted stopped state as a stopped captured instance while it is alive', async () => {
        vi.useFakeTimers();
        const state = createDaemonState();
        readDaemonState.mockResolvedValueOnce(state).mockResolvedValue(createDaemonState({
            state: 'stopped',
            stateReason: 'clean-shutdown',
        }));
        vi.stubGlobal('fetch', vi.fn(async (input: string) => {
            if (input.endsWith('/identity')) {
                return new Response(JSON.stringify({ instanceId: state.instanceId }), { status: 200 });
            }
            return new Response(JSON.stringify({}), { status: 200 });
        }));
        vi.spyOn(process, 'kill').mockReturnValue(true);

        try {
            const stopped = stopDaemon();
            await vi.advanceTimersByTimeAsync(15_000);

            await expect(stopped).resolves.toBe(false);
        } finally {
            vi.useRealTimers();
        }
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

    it('uses the stable authenticated Antigravity control paths and exact request bodies', async () => {
        const state = createDaemonState();
        readDaemonState.mockResolvedValue(state);
        vi.spyOn(process, 'kill').mockReturnValue(true);
        vi.stubEnv('REMCLI_DAEMON_RUNNER_TOKEN', 'antigravity-runner-token');
        rememberSessionRunnerCredential(ANTIGRAVITY_CLIENT_SESSION_ID, 'antigravity-runner-credential');
        const fetchSpy = vi.fn(async (input: string, _init?: RequestInit) => {
            if (input.endsWith('/identity')) {
                return new Response(JSON.stringify({ instanceId: state.instanceId }), { status: 200 });
            }
            if (input.endsWith('/antigravity-runner-preflight')) {
                return new Response(JSON.stringify({
                    type: 'verified',
                    parentRemcliSessionId: 'remcli-antigravity-parent',
                }), { status: 200 });
            }
            if (input.endsWith('/antigravity-runner-bootstrap-failed')) {
                return new Response(JSON.stringify({ accepted: true }), { status: 200 });
            }
            return new Response(JSON.stringify({
                type: 'bound',
                wrapper: {
                    agent: 'antigravity',
                    nativeConversationId: 'conversation-client',
                    remcliSessionId: ANTIGRAVITY_CLIENT_SESSION_ID,
                },
            }), { status: 200 });
        });
        vi.stubGlobal('fetch', fetchSpy);

        await expect(preflightDaemonAntigravityRunner({
            agent: 'antigravity',
            nativeResumeConversationId: 'conversation-client',
            directory: '/tmp/remcli-antigravity-client',
            pid: 41_001,
        })).resolves.toEqual({
            ok: true,
            data: {
                type: 'verified',
                parentRemcliSessionId: 'remcli-antigravity-parent',
            },
        });
        await expect(reportDaemonAntigravityRunnerBootstrapFailure({
            agent: 'antigravity',
            pid: 41_001,
        })).resolves.toEqual({ ok: true, data: { accepted: true } });
        await expect(bindDaemonAntigravityConversation({
            agent: 'antigravity',
            nativeConversationId: 'conversation-client',
            remcliSessionId: ANTIGRAVITY_CLIENT_SESSION_ID,
        })).resolves.toMatchObject({ ok: true, data: { type: 'bound' } });

        expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
            `http://127.0.0.1:${state.httpPort}/identity`,
            `http://127.0.0.1:${state.httpPort}/antigravity-runner-preflight`,
            `http://127.0.0.1:${state.httpPort}/identity`,
            `http://127.0.0.1:${state.httpPort}/antigravity-runner-bootstrap-failed`,
            `http://127.0.0.1:${state.httpPort}/identity`,
            `http://127.0.0.1:${state.httpPort}/antigravity-conversation-bound`,
        ]);
        expect(JSON.parse(fetchSpy.mock.calls[1]![1]!.body as string)).toEqual({
            agent: 'antigravity',
            nativeResumeConversationId: 'conversation-client',
            directory: '/tmp/remcli-antigravity-client',
            pid: 41_001,
            runnerToken: 'antigravity-runner-token',
        });
        expect(JSON.parse(fetchSpy.mock.calls[3]![1]!.body as string)).toEqual({
            agent: 'antigravity',
            pid: 41_001,
            runnerToken: 'antigravity-runner-token',
        });
        expect(JSON.parse(fetchSpy.mock.calls[5]![1]!.body as string)).toEqual({
            agent: 'antigravity',
            nativeConversationId: 'conversation-client',
            remcliSessionId: ANTIGRAVITY_CLIENT_SESSION_ID,
            runnerCredential: 'antigravity-runner-credential',
        });
    });

    it('fails Antigravity control calls locally without a runner token or session credential', async () => {
        vi.stubEnv('REMCLI_DAEMON_RUNNER_TOKEN', '');
        forgetSessionRunnerCredential(ANTIGRAVITY_CLIENT_SESSION_ID);
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);

        await expect(preflightDaemonAntigravityRunner({
            agent: 'antigravity',
            directory: '/tmp/remcli-antigravity-client',
            pid: 41_002,
        })).resolves.toEqual({ ok: false, error: 'Missing daemon runner capability' });
        await expect(reportDaemonAntigravityRunnerBootstrapFailure({
            agent: 'antigravity',
            pid: 41_002,
        })).resolves.toEqual({ ok: false, error: 'Missing daemon runner capability' });
        await expect(bindDaemonAntigravityConversation({
            agent: 'antigravity',
            nativeConversationId: 'conversation-client',
            remcliSessionId: ANTIGRAVITY_CLIENT_SESSION_ID,
        })).resolves.toEqual({ ok: false, error: 'Missing session runner credential' });
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
