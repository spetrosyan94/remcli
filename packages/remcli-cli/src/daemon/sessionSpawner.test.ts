import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';

const tmuxMocks = vi.hoisted(() => ({
    executeTmuxCommand: vi.fn(),
    getSessionStatus: vi.fn(async () => 'missing'),
    getWindowInfo: vi.fn(),
    getPaneInfo: vi.fn(),
    ownedPanes: new Map<string, { windowId: string; sessionName: string; paneId: string; panePid: number; ownerMarker?: string }>(),
    ensureSessionExists: vi.fn(async () => true),
    createSessionWithPane: vi.fn(async (sessionName: string) => ({
        success: true,
        ownership: {
            sessionName,
            windowId: '@500',
            paneId: '%500',
            panePid: 10_500,
            ownerMarker: '00000000-0000-4000-8000-000000000500',
        },
    })),
    killSession: vi.fn(async () => true),
    killWindow: vi.fn(async () => true),
    killWindowById: vi.fn(async () => true),
    killPaneById: vi.fn(async () => true),
    releaseOwnedPane: vi.fn(),
    spawnInTmux: vi.fn(),
}));

const openTerminalMocks = vi.hoisted(() => ({
    openTerminalWithCommand: vi.fn(async () => true),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: () => {},
        debugLargeJson: () => {},
        info: () => {},
        warn: () => {},
    },
}));

vi.mock('@/persistence', () => ({
    readSettings: vi.fn(async () => ({ profiles: [], activeProfileId: undefined })),
    validateProfileForAgent: vi.fn(() => true),
    getProfileEnvironmentVariables: vi.fn(() => ({})),
}));

vi.mock('@/utils/tmux', () => ({
    isTmuxAvailable: vi.fn(async () => true),
    getTmuxUtilities: vi.fn(() => ({
        executeTmuxCommand: tmuxMocks.executeTmuxCommand,
        getSessionStatus: tmuxMocks.getSessionStatus,
        getWindowInfo: tmuxMocks.getWindowInfo,
        getPaneInfo: tmuxMocks.getPaneInfo,
        ensureSessionExists: tmuxMocks.ensureSessionExists,
        createSessionWithPane: async (...args: [string, string, string]) => {
            const createSessionWithPane = tmuxMocks.createSessionWithPane as (
                sessionName: string,
                windowName: string,
                ownerMarker: string,
            ) => Promise<{
                success: boolean;
                ownership?: { windowId: string; sessionName: string; paneId: string; panePid: number; ownerMarker?: string };
            }>;
            const result = await createSessionWithPane(...args);
            if (result.success && result.ownership) {
                const ownership = {
                    ...result.ownership,
                    sessionName: args[0],
                    ownerMarker: result.ownership.ownerMarker ?? args[2],
                };
                tmuxMocks.ownedPanes.set(ownership.paneId, ownership);
                return { ...result, ownership };
            }
            return result;
        },
        killSession: tmuxMocks.killSession,
        killWindow: tmuxMocks.killWindow,
        killWindowById: tmuxMocks.killWindowById,
        releaseOwnedPane: async (ownership: {
            windowId: string;
            sessionName: string;
            paneId: string;
            panePid: number;
            ownerMarker: string;
        }) => {
            const releaseOwnedPane = tmuxMocks.releaseOwnedPane as (candidate: typeof ownership) => Promise<'released' | 'missing' | 'mismatch' | 'unknown'>;
            const releaseResult = await releaseOwnedPane(ownership);
            if (releaseResult === 'released') {
                tmuxMocks.ownedPanes.delete(ownership.paneId);
            }
            return releaseResult;
        },
        killPaneById: async (paneId: string) => {
            const killPaneById = tmuxMocks.killPaneById as (candidatePaneId: string) => Promise<boolean>;
            const didKill = await killPaneById(paneId);
            if (didKill) {
                tmuxMocks.ownedPanes.delete(paneId);
            }
            return didKill;
        },
        spawnInOwnedTmuxSession: async (...args: Parameters<typeof tmuxMocks.spawnInTmux>) => {
            const result = await tmuxMocks.spawnInTmux(...args);
            if (!result?.success || !result.pid) {
                return result;
            }
            const options = args[1] as {
                hostOwnership?: { sessionName: string };
                ownershipMarker?: string;
            } | undefined;
            const sessionName = options?.hostOwnership?.sessionName;
            const normalizedResult = {
                ...result,
                windowId: result.windowId ?? `@${result.pid}`,
                paneId: result.paneId ?? `%${result.pid}`,
                ownership: result.ownership ?? {
                    sessionName,
                    windowId: result.windowId ?? `@${result.pid}`,
                    paneId: result.paneId ?? `%${result.pid}`,
                    panePid: result.pid,
                    ownerMarker: options?.ownershipMarker,
                },
            };
            if (sessionName && normalizedResult.ownership.ownerMarker) {
                tmuxMocks.ownedPanes.set(normalizedResult.paneId, {
                    sessionName,
                    windowId: normalizedResult.windowId,
                    paneId: normalizedResult.paneId,
                    panePid: normalizedResult.pid,
                    ownerMarker: normalizedResult.ownership.ownerMarker,
                });
            }
            return normalizedResult;
        },
        spawnInTmux: async (...args: Parameters<typeof tmuxMocks.spawnInTmux>) => {
            const result = await tmuxMocks.spawnInTmux(...args);
            if (!result?.success || !result.pid) {
                return result;
            }
            const options = args[1] as { sessionName?: string; ownershipMarker?: string } | undefined;
            const normalizedResult = {
                ...result,
                windowId: result.windowId ?? `@${result.pid}`,
                paneId: result.paneId ?? `%${result.pid}`,
                ownership: result.ownership ?? {
                    sessionName: options?.sessionName,
                    windowId: result.windowId ?? `@${result.pid}`,
                    paneId: result.paneId ?? `%${result.pid}`,
                    panePid: result.pid,
                    ownerMarker: options?.ownershipMarker,
                },
            };
            const sessionName = options?.sessionName;
            if (sessionName && normalizedResult.ownership.ownerMarker) {
                tmuxMocks.ownedPanes.set(normalizedResult.paneId, {
                    sessionName,
                    windowId: normalizedResult.windowId,
                    paneId: normalizedResult.paneId,
                    panePid: normalizedResult.pid,
                    ownerMarker: normalizedResult.ownership.ownerMarker,
                });
            }
            return normalizedResult;
        },
    })),
}));

vi.mock('@/utils/openTerminal', () => ({
    openTerminalWithCommand: openTerminalMocks.openTerminalWithCommand,
}));

import {
    createSessionManager,
    resolveSpawnAuthEnvironment,
} from './sessionSpawner';
import { buildSafeSpawnSessionLogPayload } from './spawnSessionLog';

beforeEach(() => {
    vi.clearAllMocks();
    tmuxMocks.ownedPanes.clear();
    tmuxMocks.getSessionStatus.mockResolvedValue('missing');
    tmuxMocks.getWindowInfo.mockResolvedValue({ status: 'missing' });
    tmuxMocks.getPaneInfo.mockImplementation(async (paneId: string) => {
        const pane = tmuxMocks.ownedPanes.get(paneId);
        return pane ? { status: 'exists', pane } : { status: 'missing' };
    });
    tmuxMocks.executeTmuxCommand.mockResolvedValue({
        returncode: 0,
        stdout: '',
        stderr: '',
        command: [],
    });
    tmuxMocks.ensureSessionExists.mockResolvedValue(true);
    tmuxMocks.createSessionWithPane.mockImplementation(async (sessionName: string) => ({
        success: true,
        ownership: {
            sessionName,
            windowId: '@500',
            paneId: '%500',
            panePid: 10_500,
            ownerMarker: '00000000-0000-4000-8000-000000000500',
        },
    }));
    tmuxMocks.killSession.mockResolvedValue(true);
    tmuxMocks.killWindow.mockResolvedValue(true);
    tmuxMocks.killWindowById.mockResolvedValue(true);
    tmuxMocks.killPaneById.mockResolvedValue(true);
    tmuxMocks.releaseOwnedPane.mockImplementation(async (ownership: {
        windowId: string;
        sessionName: string;
        paneId: string;
        panePid: number;
        ownerMarker: string;
    }) => {
        const pane = tmuxMocks.ownedPanes.get(ownership.paneId);
        if (!pane) {
            return 'missing';
        }
        return pane.windowId === ownership.windowId
            && pane.sessionName === ownership.sessionName
            && pane.paneId === ownership.paneId
            && pane.panePid === ownership.panePid
            && pane.ownerMarker === ownership.ownerMarker
            ? 'released'
            : 'mismatch';
    });
    openTerminalMocks.openTerminalWithCommand.mockResolvedValue(true);
});

afterEach(() => {
    vi.restoreAllMocks();
});

function createSessionMetadata(hostPid: number, overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: process.cwd(),
        host: 'test-host',
        homeDir: '/Users/test',
        remcliHomeDir: '/Users/test/.remcli',
        remcliLibDir: process.cwd(),
        remcliToolsDir: `${process.cwd()}/tools/unpacked`,
        hostPid,
        ...overrides,
    };
}

function getDaemonRunnerToken(spawnIndex = 0): string {
    const spawnCall = tmuxMocks.spawnInTmux.mock.calls[spawnIndex];
    const environment = spawnCall?.[2] as Record<string, string> | undefined;
    const runnerToken = environment?.REMCLI_DAEMON_RUNNER_TOKEN;
    if (!runnerToken) {
        throw new Error('Expected daemon spawn to provide a runner control token.');
    }
    return runnerToken;
}

function mockTrackedDaemonTmuxOwnership(
    manager: ReturnType<typeof createSessionManager>,
    remcliSessionId: string,
): void {
    const trackedSession = manager.getChildren().find((session) => session.remcliSessionId === remcliSessionId);
    if (trackedSession?.startedBy === 'daemon') {
        trackedSession.tmuxRunner ??= {
            windowId: `@${trackedSession.pid}`,
            sessionName: `tmux-test-${trackedSession.pid}`,
            paneId: `%${trackedSession.pid}`,
            panePid: trackedSession.pid,
            ownerMarker: '00000000-0000-4000-8000-000000000001',
        };
        tmuxMocks.ownedPanes.set(trackedSession.tmuxRunner.paneId, {
            windowId: trackedSession.tmuxRunner.windowId,
            sessionName: trackedSession.tmuxRunner.sessionName,
            paneId: trackedSession.tmuxRunner.paneId,
            panePid: trackedSession.tmuxRunner.panePid,
            ownerMarker: trackedSession.tmuxRunner.ownerMarker,
        });
    }
}

async function bindTrackedCodexThread(
    manager: ReturnType<typeof createSessionManager>,
    binding: {
        agent: 'codex';
        remcliSessionId: string;
        nativeThreadId: string;
    },
) {
    mockTrackedDaemonTmuxOwnership(manager, binding.remcliSessionId);

    return manager.bindNativeCodexThread(binding);
}

function openTrackedCodexRemoteTui(
    manager: ReturnType<typeof createSessionManager>,
    request: {
        agent: 'codex';
        remcliSessionId: string;
        nativeThreadId: string;
        endpoint: string;
        reasoningEffort?: string;
    },
) {
    mockTrackedDaemonTmuxOwnership(manager, request.remcliSessionId);

    return manager.openCodexRemoteTui(request);
}

describe('resolveSpawnAuthEnvironment', () => {
    it('does not replace Codex CODEX_HOME with an auth-only temporary home', () => {
        expect(resolveSpawnAuthEnvironment({
            agent: 'codex',
            token: '{"OPENAI":"token"}',
        })).toEqual({});
    });

    it('keeps Claude token injection behavior unchanged', () => {
        expect(resolveSpawnAuthEnvironment({
            agent: 'claude',
            token: 'claude-token',
        })).toEqual({
            CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
        });
    });

    it('does not add auth env when token is absent', () => {
        expect(resolveSpawnAuthEnvironment({
            agent: 'codex',
        })).toEqual({});
    });
});

describe('buildSafeSpawnSessionLogPayload', () => {
    it('does not include token or environment variable values', () => {
        const payload = buildSafeSpawnSessionLogPayload({
            directory: '/Users/dev/project',
            agent: 'codex',
            token: 'secret-token',
            environmentVariables: {
                ANTHROPIC_AUTH_TOKEN: 'secret-anthropic-token',
                ANTHROPIC_MODEL: 'claude-sonnet',
            },
        });

        expect(payload).toEqual({
            directory: '/Users/dev/project',
            sessionId: undefined,
            resumeSessionId: undefined,
            resumeSessionName: undefined,
            approvedNewDirectoryCreation: undefined,
            agent: 'codex',
            hasToken: true,
            environmentVariableKeys: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL'],
        });
        expect(JSON.stringify(payload)).not.toContain('secret-token');
        expect(JSON.stringify(payload)).not.toContain('secret-anthropic-token');
    });
});

describe('createSessionManager resume deduplication', () => {
    it('does not spawn a Codex resume after shutdown starts during async resume resolution', async () => {
        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'codex',
            resumeSessionId: 'codex-thread-shutdown-race',
        });
        const shutdownDrain = manager.killAllSessions();

        await expect(shutdownDrain).resolves.toBeUndefined();
        await expect(spawning).resolves.toEqual({
            type: 'error',
            errorMessage: 'Daemon is shutting down and cannot start a new session.',
        });
        expect(tmuxMocks.spawnInTmux).not.toHaveBeenCalled();
        expect(manager.getChildren()).toHaveLength(0);
    });

    it('joins concurrent spawns for the same native agent session', async () => {
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session',
            windowId: '@200',
            paneId: '%200',
            pid: process.pid,
        });

        const manager = createSessionManager();
        const options = {
            directory: process.cwd(),
            agent: 'codex' as const,
            resumeSessionId: 'codex-thread-1',
        };

        const first = manager.spawnSession(options);
        const second = manager.spawnSession(options);

        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        });
        expect(openTerminalMocks.openTerminalWithCommand).not.toHaveBeenCalled();

        manager.onRemcliSessionWebhook('remcli-session-1', {
            path: process.cwd(),
            host: 'test-host',
            homeDir: '/Users/test',
            remcliHomeDir: '/Users/test/.remcli',
            remcliLibDir: process.cwd(),
            remcliToolsDir: `${process.cwd()}/tools/unpacked`,
            hostPid: process.pid,
            startedBy: 'daemon',
            flavor: 'codex',
            agentSessionId: 'codex-thread-1',
            codexSessionId: 'codex-thread-1',
        }, getDaemonRunnerToken());

        await expect(first).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-1' });
        await expect(second).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-1' });
    });

    it('drains a cancelled pre-PID Codex resume through its immutable tmux target before shutdown is exit-ready', async () => {
        let releaseTmuxSpawn: (result: {
            success: boolean;
            sessionId?: string;
            windowId?: string;
            paneId?: string;
            pid?: number;
            error?: string;
        }) => void = () => {};
        tmuxMocks.spawnInTmux.mockImplementationOnce(() => new Promise<{
            success: boolean;
            sessionId?: string;
            windowId?: string;
            paneId?: string;
            pid?: number;
            error?: string;
        }>((resolve) => {
            releaseTmuxSpawn = resolve;
        }));
        let releaseTmuxCleanup: (result: 'released' | 'missing' | 'mismatch' | 'unknown') => void = () => {};
        tmuxMocks.releaseOwnedPane.mockImplementationOnce(() => new Promise<'released' | 'missing' | 'mismatch' | 'unknown'>((resolve) => {
            releaseTmuxCleanup = resolve;
        }));

        const manager = createSessionManager();
        const resume = manager.spawnSession({
            directory: process.cwd(),
            agent: 'codex',
            resumeSessionId: 'codex-thread-shutdown-before-pid',
        });

        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        });
        const shutdownDrain = manager.killAllSessions();
        let isExitReady = false;
        void shutdownDrain.then(() => {
            isExitReady = true;
        });

        await expect(resume).resolves.toEqual({
            type: 'error',
            errorMessage: 'Daemon shut down before Codex resume process registration.',
        });
        expect(isExitReady).toBe(false);

        releaseTmuxSpawn({
            success: true,
            sessionId: 'tmux-session-created-after-shutdown',
            windowId: '@301',
            paneId: '%301',
            pid: 10_009,
        });
        await vi.waitFor(() => {
            expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%301' }));
        });

        await Promise.resolve();
        expect(isExitReady).toBe(false);

        releaseTmuxCleanup('released');
        await shutdownDrain;

        expect(isExitReady).toBe(true);
        expect(manager.getChildren()).toHaveLength(0);
    });

    it('drains a cancelled ordinary spawn through its immutable tmux target before shutdown is exit-ready', async () => {
        let releaseTmuxSpawn: (result: {
            success: boolean;
            sessionId?: string;
            windowId?: string;
            paneId?: string;
            pid?: number;
            error?: string;
        }) => void = () => {};
        tmuxMocks.spawnInTmux.mockImplementationOnce(() => new Promise<{
            success: boolean;
            sessionId?: string;
            windowId?: string;
            paneId?: string;
            pid?: number;
            error?: string;
        }>((resolve) => {
            releaseTmuxSpawn = resolve;
        }));

        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'claude',
        });

        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        });
        const shutdownDrain = manager.killAllSessions();
        let isExitReady = false;
        void shutdownDrain.then(() => {
            isExitReady = true;
        });

        await expect(spawning).resolves.toEqual({
            type: 'error',
            errorMessage: 'Daemon shut down before session process registration.',
        });
        expect(isExitReady).toBe(false);

        releaseTmuxSpawn({
            success: true,
            sessionId: 'tmux-ordinary-session-created-after-shutdown',
            windowId: '@302',
            paneId: '%302',
            pid: 10_012,
        });
        await vi.waitFor(() => {
            expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%302' }));
        });
        await shutdownDrain;

        expect(isExitReady).toBe(true);
        expect(openTerminalMocks.openTerminalWithCommand).not.toHaveBeenCalled();
        expect(manager.getChildren()).toHaveLength(0);
    });

    it('rejects shutdown rather than widening cleanup after immutable window cleanup fails', async () => {
        let releaseTmuxSpawn: (result: {
            success: boolean;
            sessionId?: string;
            windowId?: string;
            paneId?: string;
            pid?: number;
            error?: string;
        }) => void = () => {};
        tmuxMocks.spawnInTmux.mockImplementationOnce(() => new Promise<{
            success: boolean;
            sessionId?: string;
            windowId?: string;
            paneId?: string;
            pid?: number;
            error?: string;
        }>((resolve) => {
            releaseTmuxSpawn = resolve;
        }));
        tmuxMocks.releaseOwnedPane.mockResolvedValueOnce('unknown');

        const manager = createSessionManager();
        const resume = manager.spawnSession({
            directory: process.cwd(),
            agent: 'codex',
            resumeSessionId: 'codex-thread-fallback-cleanup',
        });

        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        });
        const shutdownDrain = manager.killAllSessions();
        releaseTmuxSpawn({
            success: true,
            sessionId: 'tmux-session-created-after-shutdown',
            windowId: '@303',
            paneId: '%303',
            pid: 10_010,
        });
        await expect(resume).resolves.toEqual({
            type: 'error',
            errorMessage: 'Daemon shut down before Codex resume process registration.',
        });
        await expect(shutdownDrain).rejects.toThrow('immutable pane target is unknown');

        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%303' }));
    });

    it('refuses shutdown rather than signaling a daemon runner whose immutable target cannot be inspected', async () => {
        const runnerPid = 10_014;
        const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session-with-unknown-target:main',
            windowId: '@304',
            paneId: '%304',
            pid: runnerPid,
        });
        tmuxMocks.releaseOwnedPane.mockResolvedValueOnce('unknown');

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'claude' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));

        const shutdownDrain = manager.killAllSessions();
        await expect(spawning).resolves.toEqual({
            type: 'error',
            errorMessage: 'Daemon shut down before session process registration.',
        });
        await expect(shutdownDrain).rejects.toThrow('immutable pane target is unknown');
        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 'SIGTERM');
        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 'SIGKILL');
    });

    it('starts a fresh Codex wrapper when a pending resume is stopped before its webhook', async () => {
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session-1', windowId: '@201', paneId: '%201', pid: 10_005 })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session-2', pid: 10_006 });

        const manager = createSessionManager();
        const options = {
            directory: process.cwd(),
            agent: 'codex' as const,
            resumeSessionId: 'codex-thread-stopped-before-webhook',
        };
        const first = manager.spawnSession(options);

        await vi.waitFor(() => {
            expect(manager.getChildren()).toHaveLength(1);
        });
        await expect(manager.stopSession('PID-10005')).resolves.toEqual({
            success: true,
            stoppedSessionId: 'PID-10005',
        });

        const resumed = manager.spawnSession(options);
        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2);
        });

        const joinedResume = manager.spawnSession(options);
        let joinedResumeResult: Awaited<typeof joinedResume> | undefined;
        void joinedResume.then((result) => {
            joinedResumeResult = result;
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(joinedResumeResult).toBeUndefined();

        manager.onRemcliSessionWebhook('remcli-session-resumed-after-stop', createSessionMetadata(10_006, {
            startedBy: 'daemon',
            flavor: 'codex',
            agentSessionId: options.resumeSessionId,
            codexSessionId: options.resumeSessionId,
        }), getDaemonRunnerToken(1));

        await expect(first).resolves.toEqual({
            type: 'error',
            errorMessage: expect.stringContaining('stopped before reporting'),
        });
        await expect(resumed).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-resumed-after-stop' });
        await expect(joinedResume).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-resumed-after-stop' });
    });

    it('starts a fresh Codex wrapper when pruning removes a pending resume before its webhook', async () => {
        const activePids = new Set([10_007]);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (signal === 0 && !activePids.has(pid)) {
                throw new Error('process is not running');
            }
            return true;
        });
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session-1', pid: 10_007 })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session-2', pid: 10_008 });

        const manager = createSessionManager();
        const options = {
            directory: process.cwd(),
            agent: 'codex' as const,
            resumeSessionId: 'codex-thread-pruned-before-webhook',
        };
        const first = manager.spawnSession(options);

        await vi.waitFor(() => {
            expect(manager.getChildren()).toHaveLength(1);
        });
        activePids.delete(10_007);
        manager.pruneDeadSessions();
        await vi.waitFor(() => {
            expect(manager.getChildren()).toHaveLength(0);
        });

        const resumed = manager.spawnSession(options);
        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2);
        });

        manager.onRemcliSessionWebhook('remcli-session-resumed-after-prune', createSessionMetadata(10_008, {
            startedBy: 'daemon',
            flavor: 'codex',
            agentSessionId: options.resumeSessionId,
            codexSessionId: options.resumeSessionId,
        }), getDaemonRunnerToken(1));

        await expect(first).resolves.toEqual({
            type: 'error',
            errorMessage: expect.stringContaining('stopped before reporting'),
        });
        await expect(resumed).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-resumed-after-prune' });
    });

    it('binds a late native Codex thread and reuses its active wrapper on resume', async () => {
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session',
            windowId: '@200',
            paneId: '%200',
            pid: process.pid,
        });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'codex' as const,
        });

        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        });
        expect(openTerminalMocks.openTerminalWithCommand).not.toHaveBeenCalled();

        manager.onRemcliSessionWebhook('remcli-session-2', createSessionMetadata(process.pid, {
            startedBy: 'daemon',
            flavor: 'codex',
        }), getDaemonRunnerToken());
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-2' });

        await expect(bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-2',
            nativeThreadId: 'codex-thread-2',
        })).resolves.toEqual({
            type: 'bound',
            wrapper: {
                agent: 'codex',
                remcliSessionId: 'remcli-session-2',
                nativeThreadId: 'codex-thread-2',
            },
        });
        const tmuxSessionName = tmuxMocks.spawnInTmux.mock.calls[0]?.[1]?.sessionName as string;
        tmuxMocks.getWindowInfo.mockResolvedValue({
            status: 'exists',
            window: {
                windowId: '@200',
                sessionName: tmuxSessionName,
                paneId: '%200',
                panePid: process.pid,
            },
        });
        await expect(manager.resolveCodexThreadResume('codex-thread-2')).resolves.toEqual({
            type: 'reuse-active-wrapper',
            wrapper: {
                agent: 'codex',
                remcliSessionId: 'remcli-session-2',
                nativeThreadId: 'codex-thread-2',
            },
        });

        const resumed = await manager.spawnSession({
            directory: process.cwd(),
            agent: 'codex',
            resumeSessionId: 'codex-thread-2',
        });

        expect(resumed).toEqual({ type: 'success', sessionId: 'remcli-session-2' });
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
    });

    it('opens one daemon-owned remote TUI tmux window and releases exactly it on stop', async () => {
        const runnerPid = 10_021;
        const remoteTuiSessionId = `remcli-codex-tui-${process.pid}:codex-remote-tui`;
        const remoteTuiWindowId = '@101';
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', windowId: '@202', paneId: '%202', pid: runnerPid })
            .mockResolvedValueOnce({ success: true, sessionId: remoteTuiSessionId, windowId: remoteTuiWindowId, paneId: '%101', pid: 10_121 });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        const runnerToken = getDaemonRunnerToken();
        expect(manager.onRemcliSessionWebhook(
            'remcli-session-remote-tui',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            runnerToken,
        )).toMatchObject({
            accepted: true,
            daemonOwned: true,
            shouldIssueRunnerCredential: true,
            runnerCredentialOwner: expect.any(String),
        });
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-remote-tui' });

        await expect(bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-remote-tui',
            nativeThreadId: 'codex-thread-remote-tui',
        })).resolves.toMatchObject({ type: 'bound' });

        const request = {
            agent: 'codex' as const,
            remcliSessionId: 'remcli-session-remote-tui',
            nativeThreadId: 'codex-thread-remote-tui',
            endpoint: 'ws://127.0.0.1:45123',
            reasoningEffort: 'high',
            model: 'gpt-5.6-luna',
        };
        await expect(openTrackedCodexRemoteTui(manager, request)).resolves.toMatchObject({
            type: 'opened',
            tmuxWindowId: remoteTuiWindowId,
        });
        await expect(openTrackedCodexRemoteTui(manager, request)).resolves.toMatchObject({
            type: 'already-open',
            tmuxWindowId: remoteTuiWindowId,
        });

        expect(tmuxMocks.createSessionWithPane).toHaveBeenCalledWith(
            expect.stringMatching(/^remcli-codex-tui-/),
            'host',
            expect.any(String),
        );
        expect(openTerminalMocks.openTerminalWithCommand).toHaveBeenCalledTimes(1);
        expect(openTerminalMocks.openTerminalWithCommand).toHaveBeenCalledWith(
            'env -u TMUX tmux attach -t %500',
        );
        expect(tmuxMocks.spawnInTmux.mock.calls[1]?.[0]).toEqual([
            "codex -c 'model_reasoning_effort=\"high\"' --model 'gpt-5.6-luna' resume 'codex-thread-remote-tui' --remote 'ws://127.0.0.1:45123'",
        ]);
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2);
        await expect(manager.stopSession('remcli-session-remote-tui')).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-session-remote-tui',
        });
        await vi.waitFor(() => {
            expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%101' }));
        });
        expect(tmuxMocks.ownedPanes.has('%101')).toBe(false);
        await expect(openTrackedCodexRemoteTui(manager, request)).resolves.toMatchObject({
            type: 'wrapper-not-tracked',
        });
    });

    it('does not kill a respawned managed Codex remote TUI pane with the same window id', async () => {
        const runnerPid = 10_031;
        const remoteTuiWindowId = '@215';
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', windowId: '@214', paneId: '%214', pid: runnerPid })
            .mockResolvedValueOnce({ success: true, sessionId: `remcli-codex-tui-${process.pid}:codex-respawned`, windowId: remoteTuiWindowId, paneId: '%215', pid: 10_215 });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-respawned-tui',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-respawned-tui' });
        await expect(bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-respawned-tui',
            nativeThreadId: 'codex-thread-respawned-tui',
        })).resolves.toMatchObject({ type: 'bound' });

        await expect(openTrackedCodexRemoteTui(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-respawned-tui',
            nativeThreadId: 'codex-thread-respawned-tui',
            endpoint: 'ws://127.0.0.1:45123',
        })).resolves.toMatchObject({ type: 'opened', tmuxWindowId: remoteTuiWindowId });

        tmuxMocks.ownedPanes.set('%215', {
            windowId: remoteTuiWindowId,
            sessionName: `remcli-codex-tui-${process.pid}`,
            paneId: '%215',
            panePid: 10_216,
        });

        await expect(manager.stopSession('remcli-session-respawned-tui')).resolves.toEqual({
            success: false,
        });

        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%215' }));
    });

    it('closes only the owned remote TUI pane and preserves a foreign pane in the same window', async () => {
        const runnerPid = 10_035;
        const remoteTuiWindowId = '@219';
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', windowId: '@220', paneId: '%220', pid: runnerPid })
            .mockResolvedValueOnce({ success: true, sessionId: `remcli-codex-tui-${process.pid}:codex-foreign-pane`, windowId: remoteTuiWindowId, paneId: '%219', pid: 10_219 });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-foreign-pane',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-foreign-pane' });
        await bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-foreign-pane',
            nativeThreadId: 'codex-thread-foreign-pane',
        });
        await expect(openTrackedCodexRemoteTui(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-foreign-pane',
            nativeThreadId: 'codex-thread-foreign-pane',
            endpoint: 'ws://127.0.0.1:45123',
        })).resolves.toMatchObject({ type: 'opened', tmuxWindowId: remoteTuiWindowId });

        tmuxMocks.ownedPanes.set('%foreign', {
            sessionName: `remcli-codex-tui-${process.pid}`,
            windowId: remoteTuiWindowId,
            paneId: '%foreign',
            panePid: 99_999,
        });

        await expect(manager.stopSession('remcli-session-foreign-pane')).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-session-foreign-pane',
        });

        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%219' }));
        expect(tmuxMocks.ownedPanes.has('%foreign')).toBe(true);
    });

    it('refuses a same-named Codex TUI host instead of adopting it', async () => {
        const runnerPid = 10_036;
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session:main',
            windowId: '@221',
            paneId: '%221',
            pid: runnerPid,
        });
        tmuxMocks.createSessionWithPane.mockResolvedValueOnce({
            success: false,
            error: 'duplicate session: remcli-codex-tui',
        } as never);

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-host-takeover',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-host-takeover' });
        await bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-host-takeover',
            nativeThreadId: 'codex-thread-host-takeover',
        });

        await expect(openTrackedCodexRemoteTui(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-host-takeover',
            nativeThreadId: 'codex-thread-host-takeover',
            endpoint: 'ws://127.0.0.1:45123',
        })).resolves.toMatchObject({ type: 'host-unavailable' });

        expect(openTerminalMocks.openTerminalWithCommand).not.toHaveBeenCalled();
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
    });

    it('keeps the Codex TUI host marker stable across response-loss recovery and releases the recovered host on shutdown', async () => {
        const runnerPid = 10_038;
        const remoteTuiWindowId = '@225';
        const recoveredHostMarker = '00000000-0000-4000-8000-000000000501';
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', windowId: '@224', paneId: '%224', pid: runnerPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:remote', windowId: remoteTuiWindowId, paneId: '%225', pid: 10_225 });
        tmuxMocks.createSessionWithPane
            .mockResolvedValueOnce({
                success: false,
                error: 'tmux client response lost',
            } as never)
            .mockResolvedValueOnce({
                success: true,
                ownership: {
                    sessionName: `remcli-codex-tui-${process.pid}`,
                    windowId: '@501',
                    paneId: '%501',
                    panePid: 10_501,
                    ownerMarker: recoveredHostMarker,
                },
            } as never);

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-host-recovery',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-host-recovery' });
        await bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-host-recovery',
            nativeThreadId: 'codex-thread-host-recovery',
        });

        const request = {
            agent: 'codex' as const,
            remcliSessionId: 'remcli-session-host-recovery',
            nativeThreadId: 'codex-thread-host-recovery',
            endpoint: 'ws://127.0.0.1:45123',
        };
        await expect(openTrackedCodexRemoteTui(manager, request)).resolves.toMatchObject({
            type: 'host-unavailable',
        });
        await expect(openTrackedCodexRemoteTui(manager, request)).resolves.toMatchObject({
            type: 'opened',
            tmuxWindowId: remoteTuiWindowId,
        });

        expect(tmuxMocks.createSessionWithPane).toHaveBeenCalledTimes(2);
        const hostCreateCalls = tmuxMocks.createSessionWithPane.mock.calls as unknown as Array<[string, string, string]>;
        expect(hostCreateCalls[1]?.[2]).toBe(hostCreateCalls[0]?.[2]);

        await expect(manager.killAllSessions()).resolves.toBeUndefined();
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(expect.objectContaining({
            paneId: '%501',
            ownerMarker: recoveredHostMarker,
        }));
        expect(tmuxMocks.ownedPanes.has('%501')).toBe(false);
    });

    it('keeps the wrapper tracked when managed remote TUI cleanup cannot be confirmed', async () => {
        const runnerPid = 10_037;
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', windowId: '@222', paneId: '%222', pid: runnerPid })
            .mockResolvedValueOnce({ success: true, sessionId: `remcli-codex-tui-${process.pid}:codex-cleanup-failure`, windowId: '@223', paneId: '%223', pid: 10_223 });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-cleanup-failure',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-cleanup-failure' });
        await bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-cleanup-failure',
            nativeThreadId: 'codex-thread-cleanup-failure',
        });
        await expect(openTrackedCodexRemoteTui(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-cleanup-failure',
            nativeThreadId: 'codex-thread-cleanup-failure',
            endpoint: 'ws://127.0.0.1:45123',
        })).resolves.toMatchObject({ type: 'opened', tmuxWindowId: '@223' });

        tmuxMocks.releaseOwnedPane.mockResolvedValueOnce('unknown');
        await expect(manager.stopSession('remcli-session-cleanup-failure')).resolves.toEqual({ success: false });
        expect(manager.getChildren()).toHaveLength(1);
        expect(manager.getChildren()[0]?.managedCodexRemoteTui).toMatchObject({ paneId: '%223' });
        await expect(openTrackedCodexRemoteTui(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-cleanup-failure',
            nativeThreadId: 'codex-thread-cleanup-failure',
            endpoint: 'ws://127.0.0.1:45123',
        })).resolves.toMatchObject({ type: 'already-open', tmuxWindowId: '@223' });

        await expect(manager.stopSession('remcli-session-cleanup-failure')).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-session-cleanup-failure',
        });
    });

    it('keeps a daemon Codex wrapper tracked when its live PID belongs to a mismatched tmux pane', async () => {
        const runnerPid = 10_032;
        const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', windowId: '@216', paneId: '%217', pid: runnerPid })
            .mockResolvedValueOnce({ success: false, error: 'tmux unavailable' });

        const manager = createSessionManager();
        const initialSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-stale-codex-wrapper',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(initialSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-stale-codex-wrapper' });
        const tmuxSessionName = tmuxMocks.spawnInTmux.mock.calls[0]?.[1]?.sessionName as string;
        tmuxMocks.ownedPanes.set('%217', {
            windowId: '@216',
            sessionName: tmuxSessionName,
            paneId: '%217',
            panePid: runnerPid + 1,
        });
        await expect(manager.bindNativeCodexThread({
            agent: 'codex',
            remcliSessionId: 'remcli-session-stale-codex-wrapper',
            nativeThreadId: 'codex-thread-stale-wrapper',
        })).resolves.toMatchObject({ type: 'wrapper-not-tracked' });
        expect(manager.getChildren()).toHaveLength(1);

        await expect(manager.spawnSession({
            directory: process.cwd(),
            agent: 'codex',
            resumeSessionId: 'codex-thread-stale-wrapper',
        })).resolves.toEqual({
            type: 'error',
            errorMessage: 'Failed to spawn in tmux: tmux unavailable',
        });

        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2);
        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 0);
    });

    it('refuses daemon Codex binding when the immutable tmux target is unknown without retiring it', async () => {
        const runnerPid = 10_033;
        const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session:main',
            windowId: '@217',
            paneId: '%219',
            pid: runnerPid,
        });
        tmuxMocks.getPaneInfo.mockResolvedValue({ status: 'unknown' });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-unknown-codex-wrapper',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-unknown-codex-wrapper' });

        await expect(manager.bindNativeCodexThread({
            agent: 'codex',
            remcliSessionId: 'remcli-session-unknown-codex-wrapper',
            nativeThreadId: 'codex-thread-unknown-wrapper',
        })).resolves.toMatchObject({ type: 'wrapper-not-tracked' });

        expect(manager.getChildren()).toHaveLength(1);
        expect(manager.getChildren()[0]?.nativeCodexThreadId).toBeUndefined();
        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 0);
    });

    it('does not open a remote TUI for a daemon wrapper whose live PID belongs to a mismatched tmux pane', async () => {
        const runnerPid = 10_034;
        const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session:main',
            windowId: '@218',
            paneId: '%220',
            pid: runnerPid,
        });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-stale-open-wrapper',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-stale-open-wrapper' });
        await expect(bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-stale-open-wrapper',
            nativeThreadId: 'codex-thread-stale-open-wrapper',
        })).resolves.toMatchObject({ type: 'bound' });
        const tmuxSessionName = tmuxMocks.spawnInTmux.mock.calls[0]?.[1]?.sessionName as string;
        tmuxMocks.ownedPanes.set('%220', {
            windowId: '@218',
            sessionName: tmuxSessionName,
            paneId: '%220',
            panePid: runnerPid + 1,
        });

        await expect(manager.openCodexRemoteTui({
            agent: 'codex',
            remcliSessionId: 'remcli-session-stale-open-wrapper',
            nativeThreadId: 'codex-thread-stale-open-wrapper',
            endpoint: 'ws://127.0.0.1:45123',
        })).resolves.toMatchObject({ type: 'wrapper-not-tracked' });

        expect(manager.getChildren()).toHaveLength(1);
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        expect(openTerminalMocks.openTerminalWithCommand).not.toHaveBeenCalled();
        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 0);
    });

    it('coalesces concurrent requests into one immutable managed Codex remote TUI window', async () => {
        const runnerPid = 10_030;
        const remoteTuiWindowId = '@212';
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', windowId: '@211', paneId: '%211', pid: runnerPid })
            .mockResolvedValueOnce({ success: true, sessionId: `remcli-codex-tui-${process.pid}:codex-concurrent`, windowId: remoteTuiWindowId, paneId: '%212', pid: 10_212 });
        tmuxMocks.getSessionStatus.mockResolvedValue('missing');

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-concurrent-tui',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-concurrent-tui' });
        await bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-concurrent-tui',
            nativeThreadId: 'codex-thread-concurrent-tui',
        });

        const request = {
            agent: 'codex' as const,
            remcliSessionId: 'remcli-session-concurrent-tui',
            nativeThreadId: 'codex-thread-concurrent-tui',
            endpoint: 'ws://127.0.0.1:45123',
        };
        const [firstOpen, secondOpen] = await Promise.all([
            openTrackedCodexRemoteTui(manager, request),
            openTrackedCodexRemoteTui(manager, request),
        ]);

        expect(firstOpen).toMatchObject({ type: 'opened', tmuxWindowId: remoteTuiWindowId });
        expect(secondOpen).toMatchObject({ type: 'opened', tmuxWindowId: remoteTuiWindowId });
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2);
        expect(openTerminalMocks.openTerminalWithCommand).toHaveBeenCalledTimes(1);
    });

    it('recreates the daemon Codex TUI host and window after the managed host is interrupted', async () => {
        const runnerPid = 10_022;
        const firstWindowId = '@102';
        const replacementWindowId = '@103';
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', windowId: '@203', paneId: '%203', pid: runnerPid })
            .mockResolvedValueOnce({ success: true, sessionId: `remcli-codex-tui-${process.pid}:codex-host-lost`, windowId: firstWindowId, paneId: '%102', pid: 10_122 })
            .mockResolvedValueOnce({ success: true, sessionId: `remcli-codex-tui-${process.pid}:codex-host-recreated`, windowId: replacementWindowId, paneId: '%103', pid: 10_123 });
        tmuxMocks.createSessionWithPane
            .mockResolvedValueOnce({
                success: true,
                ownership: {
                    sessionName: `remcli-codex-tui-${process.pid}`,
                    windowId: '@500',
                    paneId: '%500',
                    panePid: 10_500,
                    ownerMarker: '00000000-0000-4000-8000-000000000500',
                },
            })
            .mockResolvedValueOnce({
                success: true,
                ownership: {
                    sessionName: `remcli-codex-tui-${process.pid}`,
                    windowId: '@501',
                    paneId: '%501',
                    panePid: 10_501,
                    ownerMarker: '00000000-0000-4000-8000-000000000501',
                },
            });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-host-interrupted',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-host-interrupted' });
        await bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-host-interrupted',
            nativeThreadId: 'codex-thread-host-interrupted',
        });

        const request = {
            agent: 'codex' as const,
            remcliSessionId: 'remcli-session-host-interrupted',
            nativeThreadId: 'codex-thread-host-interrupted',
            endpoint: 'ws://127.0.0.1:45123',
        };
        await expect(openTrackedCodexRemoteTui(manager, request)).resolves.toMatchObject({
            type: 'opened',
            tmuxWindowId: firstWindowId,
        });
        tmuxMocks.ownedPanes.delete('%500');
        tmuxMocks.ownedPanes.delete('%102');
        await expect(openTrackedCodexRemoteTui(manager, request)).resolves.toMatchObject({
            type: 'opened',
            tmuxWindowId: replacementWindowId,
        });

        expect(tmuxMocks.createSessionWithPane).toHaveBeenCalledTimes(2);
        expect(openTerminalMocks.openTerminalWithCommand).toHaveBeenCalledTimes(2);
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(3);
    });

    it('recreates the managed Codex TUI window when its host remains but the exact window is gone', async () => {
        const runnerPid = 10_023;
        const firstWindowId = '@104';
        const replacementWindowId = '@105';
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', windowId: '@206', paneId: '%206', pid: runnerPid })
            .mockResolvedValueOnce({ success: true, sessionId: `remcli-codex-tui-${process.pid}:codex-window-lost`, windowId: firstWindowId, paneId: '%104', pid: 10_123 })
            .mockResolvedValueOnce({ success: true, sessionId: `remcli-codex-tui-${process.pid}:codex-window-recreated`, windowId: replacementWindowId, paneId: '%105', pid: 10_124 });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-window-interrupted',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-window-interrupted' });
        await bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-window-interrupted',
            nativeThreadId: 'codex-thread-window-interrupted',
        });

        const request = {
            agent: 'codex' as const,
            remcliSessionId: 'remcli-session-window-interrupted',
            nativeThreadId: 'codex-thread-window-interrupted',
            endpoint: 'ws://127.0.0.1:45123',
        };
        await expect(openTrackedCodexRemoteTui(manager, request)).resolves.toMatchObject({
            type: 'opened',
            tmuxWindowId: firstWindowId,
        });
        tmuxMocks.ownedPanes.delete('%104');
        await expect(openTrackedCodexRemoteTui(manager, request)).resolves.toMatchObject({
            type: 'opened',
            tmuxWindowId: replacementWindowId,
        });

        expect(tmuxMocks.createSessionWithPane).toHaveBeenCalledTimes(1);
        expect(openTerminalMocks.openTerminalWithCommand).toHaveBeenCalledTimes(1);
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(3);
    });

    it('rejects an invalid daemon runner token before it can bind or open a remote TUI', async () => {
        const runnerPid = 10_023;
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', pid: runnerPid });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));

        expect(manager.onRemcliSessionWebhook(
            'forged-remcli-session',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            'forged-runner-token',
        )).toEqual({
            accepted: false,
            daemonOwned: false,
            error: 'runner-capability-mismatch',
        });
        await expect(bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'forged-remcli-session',
            nativeThreadId: 'forged-thread',
        })).resolves.toMatchObject({ type: 'wrapper-not-tracked' });

        const runnerToken = getDaemonRunnerToken();
        manager.onRemcliSessionWebhook(
            'remcli-session-secure',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            runnerToken,
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-secure' });
    });

    it('binds a daemon runner token to its first Remcli session and rejects another session id', async () => {
        const runnerPid = 10_024;
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', pid: runnerPid });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        const runnerToken = getDaemonRunnerToken();
        const firstWebhook = manager.onRemcliSessionWebhook(
            'remcli-session-first-bound',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            runnerToken,
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-first-bound' });

        expect(firstWebhook).toMatchObject({
            accepted: true,
            daemonOwned: true,
            shouldIssueRunnerCredential: true,
            runnerCredentialOwner: expect.any(String),
        });
        expect(manager.onRemcliSessionWebhook(
            'remcli-session-first-bound',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            runnerToken,
        )).toEqual({
            accepted: true,
            daemonOwned: true,
            shouldIssueRunnerCredential: true,
            runnerCredentialOwner: expect.any(String),
        });
        expect(manager.onRemcliSessionWebhook(
            'remcli-session-credential-oracle',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            runnerToken,
        )).toEqual({
            accepted: false,
            daemonOwned: false,
            error: 'runner-capability-already-bound',
        });
    });

    it('rejects a second daemon runner that claims the first runner Remcli session', async () => {
        const firstRunnerPid = 10_028;
        const secondRunnerPid = 10_029;
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-first:main', pid: firstRunnerPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-second:main', pid: secondRunnerPid });

        const manager = createSessionManager();
        const firstSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        const secondSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(2));

        const firstSession = manager.onRemcliSessionWebhook(
            'remcli-owned-by-first-runner',
            createSessionMetadata(firstRunnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(0),
        );
        const claimedBySecondRunner = manager.onRemcliSessionWebhook(
            'remcli-owned-by-first-runner',
            createSessionMetadata(secondRunnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(1),
        );
        const secondSession = manager.onRemcliSessionWebhook(
            'remcli-owned-by-second-runner',
            createSessionMetadata(secondRunnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(1),
        );

        expect(firstSession).toMatchObject({
            accepted: true,
            daemonOwned: true,
            shouldIssueRunnerCredential: true,
            runnerCredentialOwner: expect.any(String),
        });
        expect(claimedBySecondRunner).toEqual({
            accepted: false,
            daemonOwned: false,
            error: 'runner-session-already-owned',
        });
        expect(secondSession).toMatchObject({
            accepted: true,
            daemonOwned: true,
            shouldIssueRunnerCredential: true,
            runnerCredentialOwner: expect.any(String),
        });
        await expect(firstSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-owned-by-first-runner' });
        await expect(secondSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-owned-by-second-runner' });
    });

    it('does not open a managed tmux TUI for a terminal-started Codex session', async () => {
        const manager = createSessionManager();
        expect(manager.onRemcliSessionWebhook('remcli-terminal-tui', createSessionMetadata(process.pid, {
            startedBy: 'terminal',
            flavor: 'codex',
            agentSessionId: 'codex-thread-terminal-tui',
            codexSessionId: 'codex-thread-terminal-tui',
        }))).toEqual({ accepted: true, daemonOwned: false });
        await expect(bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-terminal-tui',
            nativeThreadId: 'codex-thread-terminal-tui',
        })).resolves.toMatchObject({ type: 'bound' });

        await expect(openTrackedCodexRemoteTui(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-terminal-tui',
            nativeThreadId: 'codex-thread-terminal-tui',
            endpoint: 'ws://127.0.0.1:45123',
        })).resolves.toMatchObject({ type: 'wrapper-not-daemon-owned' });
        expect(openTerminalMocks.openTerminalWithCommand).not.toHaveBeenCalled();
        expect(tmuxMocks.spawnInTmux).not.toHaveBeenCalled();
    });

    it('does not report stop success until a late-created remote TUI pane is tracked and released', async () => {
        const runnerPid = 10_024;
        let resolveRemoteTuiSpawn: (result: { success: boolean; sessionId?: string; windowId?: string; paneId?: string; pid?: number }) => void = () => {};
        const remoteTuiWindowId = '@106';
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', windowId: '@207', paneId: '%207', pid: runnerPid })
            .mockImplementationOnce(() => new Promise((resolve) => {
                resolveRemoteTuiSpawn = resolve;
            }));

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-late-tui',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-late-tui' });
        await bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-late-tui',
            nativeThreadId: 'codex-thread-late-tui',
        });

        const opening = openTrackedCodexRemoteTui(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-late-tui',
            nativeThreadId: 'codex-thread-late-tui',
            endpoint: 'ws://127.0.0.1:45123',
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));
        const stopping = manager.stopSession('remcli-session-late-tui');
        let hasStopped = false;
        void stopping.then(() => {
            hasStopped = true;
        });
        await Promise.resolve();
        expect(hasStopped).toBe(false);

        resolveRemoteTuiSpawn({ success: true, sessionId: `remcli-codex-tui-${process.pid}:codex-late`, windowId: remoteTuiWindowId, paneId: '%106', pid: 10_124 });

        await expect(opening).resolves.toMatchObject({ type: 'wrapper-not-tracked' });
        await expect(stopping).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-session-late-tui',
        });
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%106' }));
    });

    it('rejects a non-loopback remote endpoint before creating a Terminal host or tmux window', async () => {
        const runnerPid = 10_025;
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', pid: runnerPid });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-invalid-endpoint',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-invalid-endpoint' });
        await bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-invalid-endpoint',
            nativeThreadId: 'codex-thread-invalid-endpoint',
        });

        await expect(openTrackedCodexRemoteTui(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-invalid-endpoint',
            nativeThreadId: 'codex-thread-invalid-endpoint',
            endpoint: 'ws://example.test:45123',
        })).resolves.toMatchObject({ type: 'host-unavailable' });

        expect(openTerminalMocks.openTerminalWithCommand).not.toHaveBeenCalled();
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
    });

    it('kills managed remote TUI windows and the owned host on daemon shutdown', async () => {
        const runnerPid = 10_026;
        const remoteTuiWindowId = '@107';
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session:main', pid: runnerPid })
            .mockResolvedValueOnce({ success: true, sessionId: `remcli-codex-tui-${process.pid}:codex-shutdown`, windowId: remoteTuiWindowId, paneId: '%107', pid: 10_126 });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-tui-shutdown',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-tui-shutdown' });
        await bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-tui-shutdown',
            nativeThreadId: 'codex-thread-tui-shutdown',
        });
        await expect(openTrackedCodexRemoteTui(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-tui-shutdown',
            nativeThreadId: 'codex-thread-tui-shutdown',
            endpoint: 'ws://127.0.0.1:45123',
        })).resolves.toMatchObject({ type: 'opened', tmuxWindowId: remoteTuiWindowId });

        await expect(manager.killAllSessions()).resolves.toBeUndefined();
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%107' }));
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%500' }));
    });

    it('refuses duplicate resume spawn while the first process is still waiting for webhook', async () => {
        vi.useFakeTimers();
        try {
            tmuxMocks.spawnInTmux.mockResolvedValueOnce({
                success: true,
                sessionId: 'tmux-session',
                pid: process.pid,
            });

            const manager = createSessionManager();
            const options = {
                directory: process.cwd(),
                agent: 'codex' as const,
                resumeSessionId: 'codex-thread-slow',
            };

            const first = manager.spawnSession(options);
            await vi.waitFor(() => {
                expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
            });

            await vi.advanceTimersByTimeAsync(15_000);
            await expect(first).resolves.toEqual({
                type: 'error',
                errorMessage: expect.stringContaining('Session webhook timeout'),
            });

            const second = await manager.spawnSession(options);

            expect(second).toEqual({
                type: 'error',
                errorMessage: expect.stringContaining('already starting'),
            });
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('refreshes a terminal-started tracked session when its webhook arrives again', () => {
        const manager = createSessionManager();

        manager.onRemcliSessionWebhook('remcli-terminal-session', createSessionMetadata(process.pid, {
            startedBy: 'terminal',
            flavor: 'codex',
        }));
        manager.onRemcliSessionWebhook('remcli-terminal-session', createSessionMetadata(process.pid, {
            startedBy: 'terminal',
            flavor: 'codex',
            agentSessionId: 'codex-terminal-thread',
            codexSessionId: 'codex-terminal-thread',
        }));

        expect(manager.getChildren()).toHaveLength(1);
        expect(manager.getChildren()[0]).toMatchObject({
            remcliSessionId: 'remcli-terminal-session',
            remcliSessionMetadataFromLocalWebhook: {
                agentSessionId: 'codex-terminal-thread',
                codexSessionId: 'codex-terminal-thread',
                startedBy: 'terminal',
            },
        });
    });

    it('allows a stopped Codex wrapper to resume its native thread in a fresh process', async () => {
        const activePids = new Set([10_001]);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (signal === 0 && !activePids.has(pid)) {
                throw new Error('process is not running');
            }
            return true;
        });
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session-1', windowId: '@204', paneId: '%204', pid: 10_001 })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session-2', pid: 10_002 });

        const manager = createSessionManager();
        const initialSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        });
        manager.onRemcliSessionWebhook('remcli-session-stopped', createSessionMetadata(10_001, {
            startedBy: 'daemon',
            flavor: 'codex',
        }), getDaemonRunnerToken());
        await expect(initialSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-stopped' });
        await bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-stopped',
            nativeThreadId: 'codex-thread-stopped',
        });

        await expect(manager.stopSession('remcli-session-stopped')).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-session-stopped',
        });
        await expect(manager.resolveCodexThreadResume('codex-thread-stopped')).resolves.toEqual({
            type: 'spawn-new-wrapper',
            nativeThreadId: 'codex-thread-stopped',
        });

        activePids.add(10_002);
        const resumed = manager.spawnSession({
            directory: process.cwd(),
            agent: 'codex',
            resumeSessionId: 'codex-thread-stopped',
        });
        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2);
        });
        manager.onRemcliSessionWebhook('remcli-session-resumed', createSessionMetadata(10_002, {
            startedBy: 'daemon',
            flavor: 'codex',
            agentSessionId: 'codex-thread-stopped',
            codexSessionId: 'codex-thread-stopped',
        }), getDaemonRunnerToken(1));

        await expect(resumed).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-resumed' });
    });

    it('allows a dead Codex wrapper to resume its native thread after pruning', async () => {
        const activePids = new Set([10_003]);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (signal === 0 && !activePids.has(pid)) {
                throw new Error('process is not running');
            }
            return true;
        });
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session-1', pid: 10_003 })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-session-2', pid: 10_004 });

        const manager = createSessionManager();
        const initialSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        });
        manager.onRemcliSessionWebhook('remcli-session-dead', createSessionMetadata(10_003, {
            startedBy: 'daemon',
            flavor: 'codex',
        }), getDaemonRunnerToken());
        await expect(initialSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-dead' });
        await bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-session-dead',
            nativeThreadId: 'codex-thread-dead',
        });

        activePids.delete(10_003);
        manager.pruneDeadSessions();
        await vi.waitFor(() => {
            expect(manager.getChildren()).toHaveLength(0);
        });
        await expect(manager.resolveCodexThreadResume('codex-thread-dead')).resolves.toEqual({
            type: 'spawn-new-wrapper',
            nativeThreadId: 'codex-thread-dead',
        });

        activePids.add(10_004);
        const resumed = manager.spawnSession({
            directory: process.cwd(),
            agent: 'codex',
            resumeSessionId: 'codex-thread-dead',
        });
        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2);
        });
        manager.onRemcliSessionWebhook('remcli-session-dead-resumed', createSessionMetadata(10_004, {
            startedBy: 'daemon',
            flavor: 'codex',
            agentSessionId: 'codex-thread-dead',
            codexSessionId: 'codex-thread-dead',
        }), getDaemonRunnerToken(1));

        await expect(resumed).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-dead-resumed' });
    });

    it('calls onSessionStopped once when heartbeat pruning removes a dead runner', async () => {
        const runnerPid = 10_005;
        const activePids = new Set([runnerPid]);
        const onSessionStopped = vi.fn();
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (signal === 0 && !activePids.has(pid)) {
                throw new Error('process is not running');
            }
            return true;
        });
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({ success: true, sessionId: 'tmux-session', pid: runnerPid });

        const manager = createSessionManager({
            onSessionStopped,
        });
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        const rootRunner = manager.getChildren()[0]?.tmuxRunner;
        expect(rootRunner).toBeDefined();
        manager.onRemcliSessionWebhook(
            'remcli-session-pruned-runner',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-pruned-runner' });

        activePids.delete(runnerPid);
        manager.pruneDeadSessions();
        manager.pruneDeadSessions();

        await vi.waitFor(() => {
            expect(onSessionStopped).toHaveBeenCalledOnce();
        });
        expect(onSessionStopped).toHaveBeenCalledWith('remcli-session-pruned-runner');
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(rootRunner);
        expect(tmuxMocks.ownedPanes.has(rootRunner!.paneId)).toBe(false);
    });

    it('publishes stop after pruning a dead daemon runner whose root pane is already missing', async () => {
        const runnerPid = 10_040;
        const activePids = new Set([runnerPid]);
        const onSessionStopped = vi.fn();
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (signal === 0 && !activePids.has(pid)) {
                throw new Error('process is not running');
            }
            return true;
        });
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session-root-missing:main',
            windowId: '@240',
            paneId: '%240',
            pid: runnerPid,
        });

        const manager = createSessionManager({ onSessionStopped });
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        const rootRunner = manager.getChildren()[0]?.tmuxRunner;
        expect(rootRunner).toBeDefined();
        manager.onRemcliSessionWebhook(
            'remcli-session-pruned-root-missing',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-pruned-root-missing' });

        tmuxMocks.ownedPanes.delete(rootRunner!.paneId);
        activePids.delete(runnerPid);
        manager.pruneDeadSessions();

        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(0));
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(rootRunner);
        expect(onSessionStopped).toHaveBeenCalledOnce();
        expect(onSessionStopped).toHaveBeenCalledWith('remcli-session-pruned-root-missing');
    });

    it.each(['unknown', 'mismatch'] as const)(
        'keeps a dead daemon runner tracked when atomic root cleanup is %s',
        async (releaseResult) => {
            const runnerPid = releaseResult === 'unknown' ? 10_041 : 10_042;
            const activePids = new Set([runnerPid]);
            const onSessionStopped = vi.fn();
            vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
                if (signal === 0 && !activePids.has(pid)) {
                    throw new Error('process is not running');
                }
                return true;
            });
            tmuxMocks.spawnInTmux.mockResolvedValueOnce({
                success: true,
                sessionId: `tmux-session-root-${releaseResult}:main`,
                windowId: releaseResult === 'unknown' ? '@241' : '@242',
                paneId: releaseResult === 'unknown' ? '%241' : '%242',
                pid: runnerPid,
            });
            tmuxMocks.releaseOwnedPane.mockResolvedValueOnce(releaseResult);

            const manager = createSessionManager({ onSessionStopped });
            const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
            await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
            const rootRunner = manager.getChildren()[0]?.tmuxRunner;
            expect(rootRunner).toBeDefined();
            manager.onRemcliSessionWebhook(
                `remcli-session-pruned-root-${releaseResult}`,
                createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
                getDaemonRunnerToken(),
            );
            await expect(spawning).resolves.toEqual({
                type: 'success',
                sessionId: `remcli-session-pruned-root-${releaseResult}`,
            });

            activePids.delete(runnerPid);
            manager.pruneDeadSessions();

            await vi.waitFor(() => expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(rootRunner));
            expect(manager.getChildren()).toHaveLength(1);
            expect(onSessionStopped).not.toHaveBeenCalled();
        },
    );

    it('retries dead daemon runner pruning after an unknown root cleanup result', async () => {
        const runnerPid = 10_043;
        const activePids = new Set([runnerPid]);
        const onSessionStopped = vi.fn();
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (signal === 0 && !activePids.has(pid)) {
                throw new Error('process is not running');
            }
            return true;
        });
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session-root-retry:main',
            windowId: '@243',
            paneId: '%243',
            pid: runnerPid,
        });
        tmuxMocks.releaseOwnedPane.mockResolvedValueOnce('unknown');

        const manager = createSessionManager({ onSessionStopped });
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        const rootRunner = manager.getChildren()[0]?.tmuxRunner;
        expect(rootRunner).toBeDefined();
        manager.onRemcliSessionWebhook(
            'remcli-session-pruned-root-retry',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-pruned-root-retry' });

        activePids.delete(runnerPid);
        manager.pruneDeadSessions();
        await vi.waitFor(() => expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(rootRunner));
        expect(manager.getChildren()).toHaveLength(1);
        expect(onSessionStopped).not.toHaveBeenCalled();

        manager.pruneDeadSessions();

        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(0));
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(2);
        expect(onSessionStopped).toHaveBeenCalledOnce();
        expect(onSessionStopped).toHaveBeenCalledWith('remcli-session-pruned-root-retry');
    });

    it('keeps terminal-started sessions on PID-only pruning', async () => {
        const terminalPid = 10_044;
        const activePids = new Set([terminalPid]);
        const onSessionStopped = vi.fn();
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (signal === 0 && !activePids.has(pid)) {
                throw new Error('process is not running');
            }
            return true;
        });

        const manager = createSessionManager({ onSessionStopped });
        manager.onRemcliSessionWebhook(
            'remcli-terminal-pruned',
            createSessionMetadata(terminalPid, { startedBy: 'terminal', flavor: 'codex' }),
        );

        activePids.delete(terminalPid);
        manager.pruneDeadSessions();

        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(0));
        expect(tmuxMocks.releaseOwnedPane).not.toHaveBeenCalled();
        expect(onSessionStopped).toHaveBeenCalledOnce();
        expect(onSessionStopped).toHaveBeenCalledWith('remcli-terminal-pruned');
    });

    it('clears terminal-started sessions on daemon shutdown without signalling or publishing them inactive', async () => {
        const terminalPid = 10_047;
        const onSessionStopped = vi.fn();
        const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
        const manager = createSessionManager({ onSessionStopped });
        manager.onRemcliSessionWebhook(
            'remcli-terminal-shutdown',
            createSessionMetadata(terminalPid, { startedBy: 'terminal', flavor: 'codex' }),
        );

        await expect(manager.killAllSessions()).resolves.toBeUndefined();

        expect(manager.getChildren()).toHaveLength(0);
        expect(processKill).not.toHaveBeenCalled();
        expect(tmuxMocks.releaseOwnedPane).not.toHaveBeenCalled();
        expect(onSessionStopped).not.toHaveBeenCalled();
    });

    it('calls onSessionStopped once when a daemon runner is stopped', async () => {
        const runnerPid = 10_016;
        const onSessionStopped = vi.fn();
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({ success: true, sessionId: 'tmux-stop-runner:main', windowId: '@205', paneId: '%205', pid: runnerPid });

        const manager = createSessionManager({
            onSessionStopped,
        });
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        manager.onRemcliSessionWebhook(
            'remcli-session-stopped-runner',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-stopped-runner' });

        await expect(manager.stopSession('remcli-session-stopped-runner')).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-session-stopped-runner',
        });
        await expect(manager.stopSession('remcli-session-stopped-runner')).resolves.toEqual({ success: false });

        expect(onSessionStopped).toHaveBeenCalledOnce();
        expect(onSessionStopped).toHaveBeenCalledWith('remcli-session-stopped-runner');
    });

    it('refuses to stop a session with a reused PID when its immutable tmux pane no longer matches', async () => {
        const runnerPid = 10_018;
        const publishInactive = vi.fn();
        const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session-reused-pid:main',
            windowId: '@213',
            paneId: '%213',
            pid: runnerPid,
        });

        const manager = createSessionManager({ onSessionStopped: publishInactive });
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        const tmuxSessionName = tmuxMocks.spawnInTmux.mock.calls[0]?.[1]?.sessionName as string;
        manager.onRemcliSessionWebhook(
            'remcli-session-reused-pid',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-reused-pid' });
        tmuxMocks.ownedPanes.set('%213', {
            windowId: '@213',
            sessionName: tmuxSessionName,
            paneId: '%213',
            panePid: runnerPid + 1,
        });

        await expect(manager.stopSession('remcli-session-reused-pid')).resolves.toEqual({
            success: false,
        });

        expect(tmuxMocks.releaseOwnedPane).not.toHaveBeenCalledWith(expect.objectContaining({ paneId: '%213' }));
        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 'SIGTERM');
        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 'SIGKILL');
        expect(publishInactive).not.toHaveBeenCalled();
    });

    it('does not kill a respawned tmux pane during daemon shutdown', async () => {
        const runnerPid = 10_019;
        const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session-respawned-pane:main',
            windowId: '@214',
            paneId: '%214',
            pid: runnerPid,
        });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'claude' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        const tmuxSessionName = tmuxMocks.spawnInTmux.mock.calls[0]?.[1]?.sessionName as string;
        tmuxMocks.ownedPanes.set('%214', {
            windowId: '@214',
            sessionName: tmuxSessionName,
            paneId: '%214',
            panePid: runnerPid + 1,
        });

        const shutdownDrain = manager.killAllSessions();
        await expect(spawning).resolves.toEqual({
            type: 'error',
            errorMessage: 'Daemon shut down before session process registration.',
        });
        await expect(shutdownDrain).rejects.toThrow('ownership no longer matches the original runner');

        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%214' }));
        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 'SIGTERM');
        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 'SIGKILL');
    });

    it('does not signal a PID reused after its daemon tmux runner was pruned', async () => {
        const runnerPid = 10_015;
        let processState: 'original' | 'dead' | 'reused' = 'original';
        const processKill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (pid === runnerPid && signal === 0) {
                if (processState === 'dead') {
                    throw new Error('process is not running');
                }
                return true;
            }
            return true;
        });
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session-stale-runner:main',
            pid: runnerPid,
        });
        tmuxMocks.killWindow.mockResolvedValueOnce(false);
        tmuxMocks.getSessionStatus
            .mockResolvedValueOnce('exists')
            .mockResolvedValueOnce('missing');

        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'claude',
        });

        await vi.waitFor(() => {
            expect(manager.getChildren()).toHaveLength(1);
        });
        processState = 'dead';
        manager.pruneDeadSessions();
        processState = 'reused';

        await expect(spawning).resolves.toEqual({
            type: 'error',
            errorMessage: `Session process ${runnerPid} stopped before reporting its Remcli session.`,
        });
        await expect(manager.killAllSessions()).resolves.toBeUndefined();

        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 'SIGTERM');
        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 'SIGKILL');
    });

    it('does not signal an alive reused PID after tmux reports its daemon session missing', async () => {
        const reusedPid = 10_017;
        const processKill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (pid === reusedPid && signal === 0) {
                return true;
            }
            return true;
        });
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session-with-reused-pid:main',
            pid: reusedPid,
        });
        tmuxMocks.ownedPanes.delete(`%${reusedPid}`);

        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'claude',
        });

        await vi.waitFor(() => {
            expect(manager.getChildren()).toHaveLength(1);
        });
        const shutdownDrain = manager.killAllSessions();

        await expect(spawning).resolves.toEqual({
            type: 'error',
            errorMessage: 'Daemon shut down before session process registration.',
        });
        await expect(shutdownDrain).resolves.toBeUndefined();

        expect(processKill).not.toHaveBeenCalledWith(reusedPid, 'SIGTERM');
        expect(processKill).not.toHaveBeenCalledWith(reusedPid, 'SIGKILL');
    });

    it('rejects shutdown when immutable tmux target remains unknown', async () => {
        const runnerPid = 10_016;
        const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session-with-unknown-status:main',
            windowId: '@309',
            paneId: '%309',
            pid: runnerPid,
        });
        tmuxMocks.releaseOwnedPane.mockResolvedValueOnce('unknown');

        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'claude',
        });

        await vi.waitFor(() => {
            expect(manager.getChildren()).toHaveLength(1);
        });
        const shutdownDrain = manager.killAllSessions();

        await expect(spawning).resolves.toEqual({
            type: 'error',
            errorMessage: 'Daemon shut down before session process registration.',
        });
        await expect(shutdownDrain).rejects.toThrow('immutable pane target is unknown');

        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 'SIGTERM');
        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 'SIGKILL');
    });

    it.each(['unknown', 'mismatch'] as const)(
        'preserves a webhook-tracked runner after shutdown cannot clean a deferred terminal attach root pane (%s)',
        async (releaseResult) => {
            const runnerPid = releaseResult === 'unknown' ? 10_045 : 10_046;
            const remcliSessionId = `remcli-session-shutdown-retry-${releaseResult}`;
            const onSessionStopped = vi.fn();
            let resolveTerminalAttach: (result: boolean) => void = () => {};
            openTerminalMocks.openTerminalWithCommand.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
                resolveTerminalAttach = resolve;
            }));
            tmuxMocks.spawnInTmux.mockResolvedValueOnce({
                success: true,
                sessionId: `tmux-session-shutdown-retry-${releaseResult}:main`,
                windowId: releaseResult === 'unknown' ? '@245' : '@246',
                paneId: releaseResult === 'unknown' ? '%245' : '%246',
                pid: runnerPid,
            });
            tmuxMocks.releaseOwnedPane
                .mockResolvedValueOnce(releaseResult)
                .mockResolvedValueOnce('released');

            const manager = createSessionManager({ onSessionStopped });
            const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'claude' });
            await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
            const rootRunner = manager.getChildren()[0]?.tmuxRunner;
            expect(rootRunner).toBeDefined();

            manager.onRemcliSessionWebhook(
                remcliSessionId,
                createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'claude' }),
                getDaemonRunnerToken(),
            );

            const failedShutdown = manager.killAllSessions();
            await vi.waitFor(() => expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(rootRunner));
            resolveTerminalAttach(true);

            await expect(spawning).resolves.toEqual({
                type: 'error',
                errorMessage: 'Daemon shut down before session process registration.',
            });
            await expect(failedShutdown).rejects.toThrow(
                releaseResult === 'mismatch'
                    ? 'ownership no longer matches the original runner'
                    : 'immutable pane target is unknown',
            );

            expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(1);
            expect(manager.getChildren()).toHaveLength(1);
            expect(onSessionStopped).not.toHaveBeenCalled();

            await expect(manager.killAllSessions()).resolves.toBeUndefined();

            expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(2);
            expect(manager.getChildren()).toHaveLength(0);
            expect(onSessionStopped).toHaveBeenCalledOnce();
            expect(onSessionStopped).toHaveBeenCalledWith(remcliSessionId);
        },
    );

    it('keeps opening a tmux terminal attach for non-Codex agents', async () => {
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session',
            pid: process.pid,
        });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'claude',
        });

        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        });

        expect(openTerminalMocks.openTerminalWithCommand).toHaveBeenCalledWith(
            expect.stringMatching(/^env -u TMUX tmux attach -t remcli-claude-[0-9a-f-]+$/)
        );

        manager.onRemcliSessionWebhook('remcli-session-claude', {
            path: process.cwd(),
            host: 'test-host',
            homeDir: '/Users/test',
            remcliHomeDir: '/Users/test/.remcli',
            remcliLibDir: process.cwd(),
            remcliToolsDir: `${process.cwd()}/tools/unpacked`,
            hostPid: process.pid,
            startedBy: 'daemon',
            flavor: 'claude',
            agentSessionId: 'claude-session-1',
            claudeSessionId: 'claude-session-1',
        }, getDaemonRunnerToken());

        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-claude' });
    });
});
