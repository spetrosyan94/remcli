import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Metadata } from '@/api/types';
import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

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

const loggerMocks = vi.hoisted(() => ({
    debug: vi.fn(),
    debugLargeJson: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: loggerMocks,
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

const CONTROLLED_CURSOR_SELECTION = {
    cursorExecution: {
        model: 'controlled-cursor-model',
        catalogVersion: 'controlled-cursor-catalog',
    },
    cursorLaunchControls: {
        executionMode: 'agent',
        force: false,
        autoReview: false,
        sandbox: 'local-configuration',
        approveMcps: false,
    },
    cursorRunner: {
        executable: 'agent',
        cliFingerprint: '0123456789abcdef',
    },
} satisfies Pick<SpawnSessionOptions, 'cursorExecution' | 'cursorLaunchControls' | 'cursorRunner'>;

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

async function bindTrackedCursorSession(
    manager: ReturnType<typeof createSessionManager>,
    binding: {
        agent: 'cursor';
        remcliSessionId: string;
        nativeSessionId: string;
    },
) {
    mockTrackedDaemonTmuxOwnership(manager, binding.remcliSessionId);

    return manager.bindNativeCursorSession(binding);
}

function openTrackedCodexRemoteTui(
    manager: ReturnType<typeof createSessionManager>,
    request: {
        agent: 'codex';
        remcliSessionId: string;
        nativeThreadId: string;
        endpoint: string;
        reasoningEffort: string | null;
        model?: string;
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

    it('maps an explicit Cursor token only to the native Cursor environment key', () => {
        expect(resolveSpawnAuthEnvironment({
            agent: 'cursor',
            token: 'cursor-token',
        })).toEqual({
            CURSOR_API_KEY: 'cursor-token',
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
    it('uses an injected CLI entrypoint for an isolated subprocess integration runner', async () => {
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-isolated-cli-artifact',
            windowId: '@619',
            paneId: '%619',
            pid: process.pid,
        });
        const runnerEntrypointPath = '/private/remcli-test-artifact/dist/index.mjs';
        const manager = createSessionManager({ runnerEntrypointPath });
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'codex',
        });

        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        const command = tmuxMocks.spawnInTmux.mock.calls[0]?.[0]?.[0];
        expect(command).toContain(`'${runnerEntrypointPath}'`);
        expect(command).not.toContain("packages/remcli-cli/dist/index.mjs");

        manager.onRemcliSessionWebhook('remcli-isolated-cli-artifact', createSessionMetadata(process.pid, {
            startedBy: 'daemon',
            flavor: 'codex',
        }), getDaemonRunnerToken());
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-isolated-cli-artifact' });
    });

    it('passes the daemon-validated Codex execution config to the runner before its first turn', async () => {
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-codex-capability',
            windowId: '@620',
            paneId: '%620',
            pid: process.pid,
        });
        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'codex',
            permissionMode: 'workspace-write',
            codexExecution: {
                model: 'gpt-5.6-luna',
                reasoningEffort: 'ultra',
                catalogVersion: 'catalog-1',
            },
        });

        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        const environment = tmuxMocks.spawnInTmux.mock.calls[0]?.[2] as Record<string, string>;
        expect(environment).toMatchObject({
            REMCLI_CODEX_MODEL: 'gpt-5.6-luna',
            REMCLI_CODEX_REASONING_EFFORT: 'ultra',
            REMCLI_CODEX_CATALOG_VERSION: 'catalog-1',
            REMCLI_CODEX_PERMISSION_MODE: 'workspace-write',
        });

        manager.onRemcliSessionWebhook('remcli-codex-capability', createSessionMetadata(process.pid, {
            startedBy: 'daemon',
            flavor: 'codex',
        }), getDaemonRunnerToken());
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-codex-capability' });
    });

    it('passes the daemon-validated Cursor execution config to the runner before its first turn', async () => {
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-cursor-capability',
            windowId: '@621',
            paneId: '%621',
            pid: process.pid,
        });
        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            cursorExecution: {
                model: 'cursor-grok-4.5-high',
                catalogVersion: 'cursor-catalog-1',
            },
            cursorLaunchControls: {
                executionMode: 'ask',
                force: true,
                autoReview: true,
                sandbox: 'enabled',
                approveMcps: true,
            },
            cursorRunner: {
                executable: 'agent',
                cliFingerprint: '0123456789abcdef',
            },
        });

        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        const environment = tmuxMocks.spawnInTmux.mock.calls[0]?.[2] as Record<string, string>;
        expect(environment).toMatchObject({
            REMCLI_CURSOR_MODEL: 'cursor-grok-4.5-high',
            REMCLI_CURSOR_CATALOG_VERSION: 'cursor-catalog-1',
            REMCLI_CURSOR_EXECUTION_MODE: 'ask',
            REMCLI_CURSOR_FORCE: 'true',
            REMCLI_CURSOR_AUTO_REVIEW: 'true',
            REMCLI_CURSOR_SANDBOX: 'enabled',
            REMCLI_CURSOR_APPROVE_MCPS: 'true',
            REMCLI_CURSOR_EXECUTABLE: 'agent',
            REMCLI_CURSOR_CLI_FINGERPRINT: '0123456789abcdef',
        });

        manager.onRemcliSessionWebhook('remcli-cursor-capability', createSessionMetadata(process.pid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-capability' });
    });

    it('does not inherit the legacy Cursor permission environment into a daemon spawn', async () => {
        const previousLegacyPermissionMode = process.env.REMCLI_CURSOR_PERMISSION_MODE;
        process.env.REMCLI_CURSOR_PERMISSION_MODE = 'legacy-permission-alias';

        try {
            tmuxMocks.spawnInTmux.mockResolvedValueOnce({
                success: true,
                sessionId: 'tmux-cursor-legacy-env',
                windowId: '@622',
                paneId: '%622',
                pid: process.pid,
            });
            const manager = createSessionManager();
            const spawning = manager.spawnSession({
                directory: process.cwd(),
                agent: 'cursor',
                ...CONTROLLED_CURSOR_SELECTION,
            });

            await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
            const environment = tmuxMocks.spawnInTmux.mock.calls[0]?.[2] as Record<string, string>;
            expect(environment).not.toHaveProperty('REMCLI_CURSOR_PERMISSION_MODE');
            const command = tmuxMocks.spawnInTmux.mock.calls[0]?.[0]?.[0] as string;
            expect(command).toMatch(/^\/usr\/bin\/env -u REMCLI_CURSOR_PERMISSION_MODE /);
            expect(command).not.toContain('legacy-permission-alias');

            manager.onRemcliSessionWebhook('remcli-cursor-legacy-env', createSessionMetadata(process.pid, {
                startedBy: 'daemon',
                flavor: 'cursor',
            }), getDaemonRunnerToken());
            await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-legacy-env' });
        } finally {
            if (previousLegacyPermissionMode === undefined) {
                delete process.env.REMCLI_CURSOR_PERMISSION_MODE;
            } else {
                process.env.REMCLI_CURSOR_PERMISSION_MODE = previousLegacyPermissionMode;
            }
        }
    });

    const invalidCursorSpawnCases: Array<[
        string,
        () => Partial<Pick<SpawnSessionOptions, 'cursorExecution' | 'cursorLaunchControls' | 'cursorRunner'>>,
    ]> = [
        ['missing cursor launch controls', () => {
            const { cursorLaunchControls: _cursorLaunchControls, ...selection } = CONTROLLED_CURSOR_SELECTION;
            return selection;
        }],
        ['invalid Cursor sandbox', () => ({
            ...CONTROLLED_CURSOR_SELECTION,
            cursorLaunchControls: {
                ...CONTROLLED_CURSOR_SELECTION.cursorLaunchControls,
                sandbox: 'unsupported-sandbox',
            } as unknown as SpawnSessionOptions['cursorLaunchControls'],
        })],
        ['malformed Cursor runner fingerprint', () => ({
            ...CONTROLLED_CURSOR_SELECTION,
            cursorRunner: {
                ...CONTROLLED_CURSOR_SELECTION.cursorRunner,
                cliFingerprint: 'not-a-fingerprint',
            } as unknown as SpawnSessionOptions['cursorRunner'],
        })],
    ];

    it.each(invalidCursorSpawnCases)('fails closed for Cursor spawn with %s before tmux spawn', async (_caseName, buildOverrides) => {
        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...buildOverrides(),
        });

        await expect(spawning).resolves.toEqual({
            type: 'error',
            errorMessage: 'Cursor requires a daemon-validated model, launch controls, and CLI identity.',
        });
        expect(tmuxMocks.spawnInTmux).not.toHaveBeenCalled();
    });

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

    it('settles a displaced pre-webhook Codex resume before allowing a fresh replacement', async () => {
        const reusedPid = 10_009;
        const options = {
            directory: process.cwd(),
            agent: 'codex' as const,
            resumeSessionId: 'codex-thread-replaced-before-webhook',
        };
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-codex-replaced-a', windowId: '@109', paneId: '%109', pid: reusedPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-codex-replaced-b', windowId: '@110', paneId: '%110', pid: reusedPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-codex-replaced-resume', windowId: '@111', paneId: '%111', pid: reusedPid + 1 });

        const manager = createSessionManager();
        const firstResume = manager.spawnSession(options);
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1));

        const replacementSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));

        await expect(firstResume).resolves.toEqual({
            type: 'error',
            errorMessage: `Session process ${reusedPid} stopped before reporting its Remcli session.`,
        });

        manager.onRemcliSessionWebhook('remcli-codex-replaced-b', createSessionMetadata(reusedPid, {
            startedBy: 'daemon',
            flavor: 'codex',
        }), getDaemonRunnerToken(1));
        await expect(replacementSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-codex-replaced-b' });

        const recoveredResume = manager.spawnSession(options);
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(3));
        manager.onRemcliSessionWebhook('remcli-codex-replaced-resume', createSessionMetadata(reusedPid + 1, {
            startedBy: 'daemon',
            flavor: 'codex',
            agentSessionId: options.resumeSessionId,
            codexSessionId: options.resumeSessionId,
        }), getDaemonRunnerToken(2));

        await expect(recoveredResume).resolves.toEqual({ type: 'success', sessionId: 'remcli-codex-replaced-resume' });
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

    it('keeps a displaced Codex native binding unavailable until immutable cleanup confirms retirement', async () => {
        const reusedPid = 10_041;
        const nativeThreadId = 'codex-thread-reused-pid';
        const onSessionStopped = vi.fn();
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-codex-reused-a', windowId: '@401', paneId: '%401', pid: reusedPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-codex-reused-b', windowId: '@402', paneId: '%402', pid: reusedPid });

        const manager = createSessionManager({ onSessionStopped });
        const firstSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook('remcli-codex-reused-a', createSessionMetadata(reusedPid, {
            startedBy: 'daemon',
            flavor: 'codex',
        }), getDaemonRunnerToken());
        await expect(firstSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-codex-reused-a' });
        await expect(bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-codex-reused-a',
            nativeThreadId,
        })).resolves.toMatchObject({ type: 'bound' });

        let resolveDisplacedRelease: (result: 'released') => void = () => {};
        tmuxMocks.releaseOwnedPane.mockImplementationOnce(() => new Promise<'released'>((resolve) => {
            resolveDisplacedRelease = resolve;
        }));
        const replacementSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));
        manager.onRemcliSessionWebhook('remcli-codex-reused-b', createSessionMetadata(reusedPid, {
            startedBy: 'daemon',
            flavor: 'codex',
        }), getDaemonRunnerToken(1));
        await expect(replacementSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-codex-reused-b' });
        const replacementRunner = manager.getChildren().find((session) => session.remcliSessionId === 'remcli-codex-reused-b')?.tmuxRunner;
        expect(replacementRunner).toBeDefined();

        await expect(manager.resolveCodexThreadResume(nativeThreadId)).resolves.toEqual({
            type: 'wrapper-starting',
            nativeThreadId,
        });
        await expect(manager.bindNativeCodexThread({
            agent: 'codex',
            remcliSessionId: 'remcli-codex-reused-a',
            nativeThreadId,
        })).resolves.toEqual({
            type: 'wrapper-not-tracked',
            binding: {
                agent: 'codex',
                remcliSessionId: 'remcli-codex-reused-a',
                nativeThreadId,
            },
        });
        await expect(manager.bindNativeCodexThread({
            agent: 'codex',
            remcliSessionId: 'remcli-codex-reused-b',
            nativeThreadId: 'codex-thread-reused-b',
        })).resolves.toMatchObject({
            type: 'bound',
            wrapper: { remcliSessionId: 'remcli-codex-reused-b', nativeThreadId: 'codex-thread-reused-b' },
        });

        resolveDisplacedRelease('released');
        await vi.waitFor(() => expect(onSessionStopped).toHaveBeenCalledWith('remcli-codex-reused-a'));
        await expect(manager.resolveCodexThreadResume(nativeThreadId)).resolves.toEqual({
            type: 'spawn-new-wrapper',
            nativeThreadId,
        });

        expect(manager.getChildren()).toContainEqual(expect.objectContaining({
            pid: reusedPid,
            remcliSessionId: 'remcli-codex-reused-b',
        }));
        expect(tmuxMocks.releaseOwnedPane).not.toHaveBeenCalledWith(replacementRunner);
        expect(onSessionStopped).toHaveBeenCalledOnce();
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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
            reasoningEffort: null,
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

    it('reuses a Cursor wrapper after its webhook while native init is still pending', async () => {
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-cursor-resume',
            pid: process.pid,
        });

        const manager = createSessionManager();
        const options = {
            directory: process.cwd(),
            agent: 'cursor' as const,
            resumeSessionId: 'cursor-native-resume',
            ...CONTROLLED_CURSOR_SELECTION,
        };
        const first = manager.spawnSession(options);
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook('remcli-cursor-resume', createSessionMetadata(process.pid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());

        await expect(first).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-resume' });
        await expect(manager.spawnSession(options)).resolves.toEqual({
            type: 'success',
            sessionId: 'remcli-cursor-resume',
        });
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce();
    });

    it('does not spawn a Cursor resume after shutdown completes during async ownership lookup', async () => {
        const runnerPid = 21_040;
        const nativeSessionId = 'cursor-native-shutdown-race';
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-cursor-shutdown-race',
            pid: runnerPid,
        });

        const manager = createSessionManager();
        const initialSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook('remcli-cursor-shutdown-race', createSessionMetadata(runnerPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(initialSpawn).resolves.toEqual({
            type: 'success',
            sessionId: 'remcli-cursor-shutdown-race',
        });
        await expect(manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId,
            remcliSessionId: 'remcli-cursor-shutdown-race',
        })).resolves.toMatchObject({ type: 'bound' });

        let releaseLookup: () => void = () => {};
        tmuxMocks.getPaneInfo.mockClear();
        tmuxMocks.getPaneInfo.mockImplementationOnce(() => new Promise<void>((resolve) => {
            releaseLookup = resolve;
        }));
        tmuxMocks.spawnInTmux.mockClear();

        const resume = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: nativeSessionId,
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.getPaneInfo).toHaveBeenCalledOnce());

        const shutdownDrain = manager.killAllSessions();
        await expect(shutdownDrain).resolves.toBeUndefined();
        expect(manager.getChildren()).toHaveLength(0);

        releaseLookup();

        await expect(resume).resolves.toEqual({
            type: 'error',
            errorMessage: 'Daemon is shutting down and cannot start a new session.',
        });
        expect(tmuxMocks.spawnInTmux).not.toHaveBeenCalled();
        expect(manager.getChildren()).toHaveLength(0);
    });

    it('blocks a Cursor resume while its daemon runner is closing, then starts exactly one new wrapper after confirmed cleanup', async () => {
        const runnerPid = 21_041;
        const nativeSessionId = 'cursor-native-graceful-stop';
        const sessionId = 'remcli-cursor-graceful-stop';
        vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-graceful-stop:main', windowId: '@441', paneId: '%441', pid: runnerPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-graceful-resume:main', windowId: '@442', paneId: '%442', pid: runnerPid + 1 });

        const manager = createSessionManager();
        const initialSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook(sessionId, createSessionMetadata(runnerPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(initialSpawn).resolves.toEqual({ type: 'success', sessionId });
        await expect(manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId,
            remcliSessionId: sessionId,
        })).resolves.toMatchObject({ type: 'bound' });

        expect(manager.markDaemonRunnerStopping(sessionId)).toEqual({ accepted: true });
        manager.pruneDeadSessions();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(tmuxMocks.releaseOwnedPane).not.toHaveBeenCalled();
        expect(manager.getChildren()).toHaveLength(1);

        await expect(manager.stopSession(sessionId)).resolves.toEqual({ success: false });
        expect(tmuxMocks.releaseOwnedPane).not.toHaveBeenCalled();

        await expect(manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: nativeSessionId,
            ...CONTROLLED_CURSOR_SELECTION,
        })).resolves.toEqual({
            type: 'error',
            errorMessage: 'Could not confirm ownership of the Cursor session tmux pane. Resume was not started.',
        });
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce();

        await expect(manager.completeDaemonRunnerStopping(sessionId)).resolves.toEqual({ accepted: true });
        expect(manager.getChildren()).toHaveLength(0);

        const resumed = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: nativeSessionId,
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));
        manager.onRemcliSessionWebhook('remcli-cursor-graceful-resume', createSessionMetadata(runnerPid + 1, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken(1));
        await expect(resumed).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-graceful-resume' });
    });

    it('waits for a credential-confirmed Cursor graceful shutdown during daemon teardown without releasing its pane early', async () => {
        const runnerPid = 21_043;
        const sessionId = 'remcli-cursor-graceful-daemon-shutdown';
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-cursor-graceful-daemon-shutdown:main',
            windowId: '@443',
            paneId: '%443',
            pid: runnerPid,
        });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook(sessionId, createSessionMetadata(runnerPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId });

        expect(manager.markDaemonRunnerStopping(sessionId)).toEqual({ accepted: true });
        const shutdown = manager.killAllSessions();
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(tmuxMocks.releaseOwnedPane).not.toHaveBeenCalled();
        expect(manager.getChildren()).toHaveLength(1);

        await expect(manager.completeDaemonRunnerStopping(sessionId)).resolves.toEqual({ accepted: true });
        await expect(shutdown).resolves.toBeUndefined();
        expect(manager.getChildren()).toHaveLength(0);
    });

    it('reuses a fresh Cursor wrapper only after its authenticated repeat webhook confirms the native session ID', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'remcli-cursor-workspace-'));
        const otherWorkspace = await mkdtemp(join(tmpdir(), 'remcli-cursor-other-workspace-'));

        try {
            tmuxMocks.spawnInTmux.mockResolvedValueOnce({
                success: true,
                sessionId: 'tmux-cursor-fresh',
                pid: process.pid,
            });

            const manager = createSessionManager();
            const spawning = manager.spawnSession({
                directory: workspace,
                agent: 'cursor',
                ...CONTROLLED_CURSOR_SELECTION,
            });
            await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());

            const runnerToken = getDaemonRunnerToken();
            manager.onRemcliSessionWebhook('remcli-cursor-fresh', createSessionMetadata(process.pid, {
                path: workspace,
                startedBy: 'daemon',
                flavor: 'cursor',
            }), runnerToken);
            await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-fresh' });

            const nativeCursorSessionId = 'cursor-native-fresh';
            expect(manager.onRemcliSessionWebhook('remcli-cursor-fresh', createSessionMetadata(process.pid, {
                path: workspace,
                startedBy: 'daemon',
                flavor: 'cursor',
                agentSessionId: nativeCursorSessionId,
                cursorSessionId: nativeCursorSessionId,
            }), 'forged-runner-token')).toMatchObject({
                accepted: false,
                error: 'runner-capability-mismatch',
            });
            expect(manager.getChildren()).toContainEqual(expect.objectContaining({
                remcliSessionId: 'remcli-cursor-fresh',
                remcliSessionMetadataFromLocalWebhook: expect.not.objectContaining({ cursorSessionId: nativeCursorSessionId }),
            }));

            expect(manager.onRemcliSessionWebhook('remcli-cursor-fresh', createSessionMetadata(process.pid, {
                path: workspace,
                startedBy: 'daemon',
                flavor: 'cursor',
                agentSessionId: nativeCursorSessionId,
                cursorSessionId: nativeCursorSessionId,
            }), runnerToken)).toMatchObject({ accepted: true, daemonOwned: true });
            expect(manager.getChildren()).toContainEqual(expect.objectContaining({
                remcliSessionId: 'remcli-cursor-fresh',
                remcliSessionMetadataFromLocalWebhook: expect.objectContaining({ cursorSessionId: nativeCursorSessionId }),
            }));

            await expect(manager.spawnSession({
                directory: workspace,
                agent: 'cursor',
                resumeSessionId: nativeCursorSessionId,
                ...CONTROLLED_CURSOR_SELECTION,
            })).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-fresh' });

            await expect(manager.spawnSession({
                directory: otherWorkspace,
                agent: 'cursor',
                resumeSessionId: nativeCursorSessionId,
                ...CONTROLLED_CURSOR_SELECTION,
            })).resolves.toEqual({
                type: 'error',
                errorMessage: 'Cursor session belongs to a different working directory. Select its original workspace before resuming.',
            });
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce();
        } finally {
            await Promise.all([
                rm(workspace, { recursive: true, force: true }),
                rm(otherWorkspace, { recursive: true, force: true }),
            ]);
        }
    });

    it('refuses to reuse a Cursor native session across working directories', async () => {
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-cursor-workspace',
            pid: process.pid,
        });

        const manager = createSessionManager();
        const first = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: 'cursor-native-workspace',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook('remcli-cursor-workspace', createSessionMetadata(process.pid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(first).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-workspace' });

        await expect(manager.spawnSession({
            directory: tmpdir(),
            agent: 'cursor',
            resumeSessionId: 'cursor-native-workspace',
            ...CONTROLLED_CURSOR_SELECTION,
        })).resolves.toEqual({
            type: 'error',
            errorMessage: 'Cursor session belongs to a different working directory. Select its original workspace before resuming.',
        });
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce();
    });

    it('does not create Cursor lineage from a webhook before the native session is bound', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'remcli-cursor-unbound-lineage-'));

        try {
            tmuxMocks.spawnInTmux
                .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-unbound-parent', pid: 21_020 })
                .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-unbound-resume', pid: 21_021 });

            const manager = createSessionManager();
            const nativeSessionId = 'cursor-native-unbound-lineage';
            const firstSpawn = manager.spawnSession({
                directory: workspace,
                agent: 'cursor',
                ...CONTROLLED_CURSOR_SELECTION,
            });
            await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
            manager.onRemcliSessionWebhook('remcli-cursor-unbound-parent', createSessionMetadata(21_020, {
                path: workspace,
                startedBy: 'daemon',
                flavor: 'cursor',
                agentSessionId: nativeSessionId,
                cursorSessionId: nativeSessionId,
            }), getDaemonRunnerToken());
            await expect(firstSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-unbound-parent' });

            await expect(manager.stopSession('remcli-cursor-unbound-parent')).resolves.toEqual({
                success: true,
                stoppedSessionId: 'remcli-cursor-unbound-parent',
            });

            const resumed = manager.spawnSession({
                directory: workspace,
                agent: 'cursor',
                resumeSessionId: nativeSessionId,
                ...CONTROLLED_CURSOR_SELECTION,
            });
            await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));
            await expect(manager.preflightCursorRunner({
                agent: 'cursor',
                nativeResumeSessionId: nativeSessionId,
                pid: 21_021,
                runnerToken: getDaemonRunnerToken(1),
            })).resolves.toEqual({ type: 'verified' });

            manager.onRemcliSessionWebhook('remcli-cursor-unbound-resume', createSessionMetadata(21_021, {
                path: workspace,
                startedBy: 'daemon',
                flavor: 'cursor',
            }), getDaemonRunnerToken(1));
            await expect(resumed).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-unbound-resume' });
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    it('does not carry Cursor lineage into a restarted daemon', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'remcli-cursor-restarted-daemon-'));

        try {
            tmuxMocks.spawnInTmux
                .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-before-restart', pid: 21_025 })
                .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-after-restart', pid: 21_026 });

            const nativeSessionId = 'cursor-native-restarted-daemon';
            const firstManager = createSessionManager();
            const firstSpawn = firstManager.spawnSession({
                directory: workspace,
                agent: 'cursor',
                ...CONTROLLED_CURSOR_SELECTION,
            });
            await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
            firstManager.onRemcliSessionWebhook('remcli-cursor-before-restart', createSessionMetadata(21_025, {
                path: workspace,
                startedBy: 'daemon',
                flavor: 'cursor',
            }), getDaemonRunnerToken());
            await expect(firstSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-before-restart' });
            await expect(firstManager.bindNativeCursorSession({
                agent: 'cursor',
                nativeSessionId,
                remcliSessionId: 'remcli-cursor-before-restart',
            })).resolves.toMatchObject({ type: 'bound' });
            await expect(firstManager.stopSession('remcli-cursor-before-restart')).resolves.toEqual({
                success: true,
                stoppedSessionId: 'remcli-cursor-before-restart',
            });

            const restartedManager = createSessionManager();
            const resumed = restartedManager.spawnSession({
                directory: workspace,
                agent: 'cursor',
                resumeSessionId: nativeSessionId,
                ...CONTROLLED_CURSOR_SELECTION,
            });
            await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));
            await expect(restartedManager.preflightCursorRunner({
                agent: 'cursor',
                nativeResumeSessionId: nativeSessionId,
                pid: 21_026,
                runnerToken: getDaemonRunnerToken(1),
            })).resolves.toEqual({ type: 'verified' });

            restartedManager.onRemcliSessionWebhook('remcli-cursor-after-restart', createSessionMetadata(21_026, {
                path: workspace,
                startedBy: 'daemon',
                flavor: 'cursor',
            }), getDaemonRunnerToken(1));
            await expect(resumed).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-after-restart' });
        } finally {
            await rm(workspace, { recursive: true, force: true });
        }
    });

    it('carries trusted Cursor lineage after stop only into a same-workspace native resume', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'remcli-cursor-lineage-'));
        const otherWorkspace = await mkdtemp(join(tmpdir(), 'remcli-cursor-lineage-other-'));

        try {
            tmuxMocks.spawnInTmux
                .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-lineage-parent', pid: 21_030 })
                .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-lineage-resume', pid: 21_031 });

            const manager = createSessionManager();
            const nativeSessionId = 'cursor-native-lineage';
            const parentSessionId = 'remcli-cursor-lineage-parent';
            const firstSpawn = manager.spawnSession({
                directory: workspace,
                agent: 'cursor',
                ...CONTROLLED_CURSOR_SELECTION,
            });
            await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
            manager.onRemcliSessionWebhook(parentSessionId, createSessionMetadata(21_030, {
                path: workspace,
                startedBy: 'daemon',
                flavor: 'cursor',
            }), getDaemonRunnerToken());
            await expect(firstSpawn).resolves.toEqual({ type: 'success', sessionId: parentSessionId });
            await expect(manager.bindNativeCursorSession({
                agent: 'cursor',
                nativeSessionId,
                remcliSessionId: parentSessionId,
            })).resolves.toMatchObject({ type: 'bound' });

            await expect(manager.stopSession(parentSessionId)).resolves.toEqual({
                success: true,
                stoppedSessionId: parentSessionId,
            });

            await expect(manager.spawnSession({
                directory: otherWorkspace,
                agent: 'cursor',
                resumeSessionId: nativeSessionId,
                ...CONTROLLED_CURSOR_SELECTION,
            })).resolves.toEqual({
                type: 'error',
                errorMessage: 'Cursor session belongs to a different working directory. Select its original workspace before resuming.',
            });
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce();

            const resumed = manager.spawnSession({
                directory: workspace,
                agent: 'cursor',
                resumeSessionId: nativeSessionId,
                ...CONTROLLED_CURSOR_SELECTION,
            });
            await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));
            const preflightRequest = {
                agent: 'cursor' as const,
                nativeResumeSessionId: nativeSessionId,
                pid: 21_031,
                runnerToken: getDaemonRunnerToken(1),
            };
            await expect(manager.preflightCursorRunner(preflightRequest)).resolves.toEqual({
                type: 'verified',
                parentRemcliSessionId: parentSessionId,
            });
            await expect(manager.preflightCursorRunner({
                ...preflightRequest,
                runnerToken: 'wrong-runner-token',
            })).resolves.toEqual({ type: 'rejected' });
            await expect(manager.preflightCursorRunner({
                ...preflightRequest,
                pid: 99_999,
            })).resolves.toEqual({ type: 'rejected' });
            await expect(manager.preflightCursorRunner({
                ...preflightRequest,
                agent: 'codex',
            })).resolves.toEqual({ type: 'rejected' });
            await expect(manager.preflightCursorRunner({
                ...preflightRequest,
                nativeResumeSessionId: 'cursor-native-wrong-resume',
            })).resolves.toEqual({ type: 'rejected' });

            manager.onRemcliSessionWebhook('remcli-cursor-lineage-resume', createSessionMetadata(21_031, {
                path: workspace,
                startedBy: 'daemon',
                flavor: 'cursor',
            }), getDaemonRunnerToken(1));
            await expect(resumed).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-lineage-resume' });
        } finally {
            await Promise.all([
                rm(workspace, { recursive: true, force: true }),
                rm(otherWorkspace, { recursive: true, force: true }),
            ]);
        }
    });

    it('verifies a fresh tracked Cursor runner only when it does not claim a native resume', async () => {
        const runnerPid = 21_033;
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-cursor-fresh-preflight',
            pid: runnerPid,
        });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        const runnerToken = getDaemonRunnerToken();

        await expect(manager.preflightCursorRunner({
            agent: 'cursor',
            pid: runnerPid,
            runnerToken,
        })).resolves.toEqual({ type: 'verified' });
        await expect(manager.preflightCursorRunner({
            agent: 'cursor',
            nativeResumeSessionId: 'forged-native-resume',
            pid: runnerPid,
            runnerToken,
        })).resolves.toEqual({ type: 'rejected' });

        manager.onRemcliSessionWebhook('remcli-cursor-fresh-preflight', createSessionMetadata(runnerPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), runnerToken);
        await expect(spawning).resolves.toEqual({
            type: 'success',
            sessionId: 'remcli-cursor-fresh-preflight',
        });
    });

    it('verifies a tracked Codex runner before it can create P2P metadata', async () => {
        const runnerPid = 21_034;
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-codex-fresh-preflight',
            pid: runnerPid,
        });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        const runnerToken = getDaemonRunnerToken();

        await expect(manager.preflightCursorRunner({
            agent: 'codex',
            pid: runnerPid,
            runnerToken,
        })).resolves.toEqual({ type: 'verified' });
        const trackedRunner = manager.getChildren().find((session) => session.pid === runnerPid);
        expect(trackedRunner).toBeDefined();
        expect(trackedRunner).not.toHaveProperty('remcliSessionId');

        manager.onRemcliSessionWebhook('remcli-codex-fresh-preflight', createSessionMetadata(runnerPid, {
            startedBy: 'daemon',
            flavor: 'codex',
        }), runnerToken);
        await expect(spawning).resolves.toEqual({
            type: 'success',
            sessionId: 'remcli-codex-fresh-preflight',
        });
    });

    it('redacts a Cursor parent relation from webhook diagnostics without changing tracked metadata', async () => {
        const runnerPid = 21_032;
        const parentRemcliSessionId = 'parent-remcli-session-must-not-be-logged';
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-cursor-diagnostic-redaction',
            pid: runnerPid,
        });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        const runnerToken = getDaemonRunnerToken();
        const sessionMetadata = createSessionMetadata(runnerPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
            resumedFromRemcliSessionId: parentRemcliSessionId,
        });
        loggerMocks.debugLargeJson.mockClear();

        expect(manager.onRemcliSessionWebhook(
            'remcli-cursor-diagnostic-redaction',
            sessionMetadata,
            runnerToken,
        )).toMatchObject({ accepted: true, daemonOwned: true });
        await expect(spawning).resolves.toEqual({
            type: 'success',
            sessionId: 'remcli-cursor-diagnostic-redaction',
        });

        expect(loggerMocks.debugLargeJson).toHaveBeenCalledOnce();
        const diagnosticSessionMetadata = loggerMocks.debugLargeJson.mock.calls[0]?.[1] as Record<string, unknown>;
        expect(diagnosticSessionMetadata).toMatchObject({ hostPid: runnerPid, flavor: 'cursor' });
        expect(diagnosticSessionMetadata).not.toBe(sessionMetadata);
        expect(diagnosticSessionMetadata).not.toHaveProperty('resumedFromRemcliSessionId');
        expect(JSON.stringify(diagnosticSessionMetadata)).not.toContain(parentRemcliSessionId);
        expect(JSON.stringify(diagnosticSessionMetadata)).not.toContain(runnerToken);

        const trackedSession = manager.getChildren().find((session) => (
            session.remcliSessionId === 'remcli-cursor-diagnostic-redaction'
        ));
        expect(trackedSession?.remcliSessionMetadataFromLocalWebhook).toBe(sessionMetadata);
        expect(trackedSession?.remcliSessionMetadataFromLocalWebhook).toMatchObject({
            resumedFromRemcliSessionId: parentRemcliSessionId,
        });
    });

    it('atomically owns one Cursor native session, reuses its wrapper, and releases ownership on cleanup', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'remcli-cursor-binding-workspace-'));
        const otherWorkspace = await mkdtemp(join(tmpdir(), 'remcli-cursor-binding-other-workspace-'));

        try {
            tmuxMocks.spawnInTmux
                .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-owner-a', pid: 21_001 })
                .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-owner-b', pid: 21_002 });

            const manager = createSessionManager();
            const firstSpawn = manager.spawnSession({
                directory: workspace,
                agent: 'cursor',
                ...CONTROLLED_CURSOR_SELECTION,
            });
            await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1));
            const secondSpawn = manager.spawnSession({
                directory: workspace,
                agent: 'cursor',
                ...CONTROLLED_CURSOR_SELECTION,
            });
            await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));

            manager.onRemcliSessionWebhook('remcli-cursor-owner-a', createSessionMetadata(21_001, {
                path: workspace,
                startedBy: 'daemon',
                flavor: 'cursor',
            }), getDaemonRunnerToken(0));
            manager.onRemcliSessionWebhook('remcli-cursor-owner-b', createSessionMetadata(21_002, {
                path: workspace,
                startedBy: 'daemon',
                flavor: 'cursor',
            }), getDaemonRunnerToken(1));
            await expect(firstSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-owner-a' });
            await expect(secondSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-owner-b' });

            const nativeSessionId = 'cursor-native-atomic-owner';
            const firstBinding = manager.bindNativeCursorSession({
                agent: 'cursor',
                nativeSessionId,
                remcliSessionId: 'remcli-cursor-owner-a',
            });
            const concurrentResume = manager.spawnSession({
                directory: workspace,
                agent: 'cursor',
                resumeSessionId: nativeSessionId,
                ...CONTROLLED_CURSOR_SELECTION,
            });
            const competingBinding = manager.bindNativeCursorSession({
                agent: 'cursor',
                nativeSessionId,
                remcliSessionId: 'remcli-cursor-owner-b',
            });

            await expect(firstBinding).resolves.toMatchObject({
                type: 'bound',
                wrapper: { remcliSessionId: 'remcli-cursor-owner-a', nativeSessionId },
            });
            await expect(competingBinding).resolves.toMatchObject({
                type: 'reuse-active-wrapper',
                wrapper: { remcliSessionId: 'remcli-cursor-owner-a', nativeSessionId },
            });
            await expect(concurrentResume).resolves.toEqual({
                type: 'success',
                sessionId: 'remcli-cursor-owner-a',
            });
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2);

            await expect(manager.spawnSession({
                directory: otherWorkspace,
                agent: 'cursor',
                resumeSessionId: nativeSessionId,
                ...CONTROLLED_CURSOR_SELECTION,
            })).resolves.toEqual({
                type: 'error',
                errorMessage: 'Cursor session belongs to a different working directory. Select its original workspace before resuming.',
            });

            await expect(manager.stopSession('remcli-cursor-owner-a')).resolves.toEqual({
                success: true,
                stoppedSessionId: 'remcli-cursor-owner-a',
            });
            await expect(manager.bindNativeCursorSession({
                agent: 'cursor',
                nativeSessionId,
                remcliSessionId: 'remcli-cursor-owner-b',
            })).resolves.toMatchObject({
                type: 'bound',
                wrapper: { remcliSessionId: 'remcli-cursor-owner-b', nativeSessionId },
            });
        } finally {
            await Promise.all([
                rm(workspace, { recursive: true, force: true }),
                rm(otherWorkspace, { recursive: true, force: true }),
            ]);
        }
    });

    it.each(['unknown', 'mismatch'] as const)('keeps a displaced Cursor identity retryable when immutable cleanup reports %s', async (releaseResult) => {
        const reusedPid = 21_009;
        const nativeSessionId = 'cursor-native-reused-pid';
        const onSessionStopped = vi.fn();
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-reused-a', windowId: '@409', paneId: '%409', pid: reusedPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-reused-b', windowId: '@410', paneId: '%410', pid: reusedPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-reused-resume', pid: reusedPid + 1 });

        const manager = createSessionManager({ onSessionStopped });
        const firstSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook('remcli-cursor-reused-a', createSessionMetadata(reusedPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(firstSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-reused-a' });
        await expect(manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId,
            remcliSessionId: 'remcli-cursor-reused-a',
        })).resolves.toMatchObject({ type: 'bound' });

        let resolveFirstPaneRelease: (result: typeof releaseResult) => void = () => {};
        tmuxMocks.releaseOwnedPane.mockImplementationOnce(() => new Promise<typeof releaseResult>((resolve) => {
            resolveFirstPaneRelease = resolve;
        }));
        const stoppingFirst = manager.stopSession('remcli-cursor-reused-a');
        await vi.waitFor(() => expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledOnce());

        const secondSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));
        manager.onRemcliSessionWebhook('remcli-cursor-reused-b', createSessionMetadata(reusedPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken(1));
        await expect(secondSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-reused-b' });
        await expect(manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId: 'cursor-native-reused-b',
            remcliSessionId: 'remcli-cursor-reused-b',
        })).resolves.toMatchObject({
            type: 'bound',
            wrapper: { remcliSessionId: 'remcli-cursor-reused-b', nativeSessionId: 'cursor-native-reused-b' },
        });
        await expect(manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: nativeSessionId,
            ...CONTROLLED_CURSOR_SELECTION,
        })).resolves.toEqual({
            type: 'error',
            errorMessage: 'Could not confirm ownership of the Cursor session tmux pane. Resume was not started.',
        });

        resolveFirstPaneRelease(releaseResult);
        await expect(stoppingFirst).resolves.toEqual({ success: false });
        expect(onSessionStopped).not.toHaveBeenCalled();
        const secondWrapper = manager.getChildren().find((session) => (
            session.pid === reusedPid && session.remcliSessionId === 'remcli-cursor-reused-b'
        ));
        expect(secondWrapper).toMatchObject({
            pid: reusedPid,
            remcliSessionId: 'remcli-cursor-reused-b',
        });
        expect(manager.getChildren()).toContainEqual(expect.objectContaining({
            pid: reusedPid,
            remcliSessionId: 'remcli-cursor-reused-a',
        }));
        expect(tmuxMocks.releaseOwnedPane).not.toHaveBeenCalledWith(secondWrapper?.tmuxRunner);

        await expect(manager.stopSession('remcli-cursor-reused-a')).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-cursor-reused-a',
        });
        expect(onSessionStopped).toHaveBeenCalledOnce();
        expect(onSessionStopped).toHaveBeenCalledWith('remcli-cursor-reused-a');
        expect(manager.getChildren()).toEqual([
            expect.objectContaining({ pid: reusedPid, remcliSessionId: 'remcli-cursor-reused-b' }),
        ]);

        const resumed = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: nativeSessionId,
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(3));
        manager.onRemcliSessionWebhook('remcli-cursor-reused-resume', createSessionMetadata(reusedPid + 1, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken(2));
        await expect(resumed).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-reused-resume' });

        await expect(manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId,
            remcliSessionId: 'remcli-cursor-reused-resume',
        })).resolves.toMatchObject({ type: 'bound' });
        expect(manager.getChildren()).toContainEqual(expect.objectContaining({
            pid: reusedPid,
            remcliSessionId: 'remcli-cursor-reused-b',
        }));
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(2);
    });

    it.each(['released', 'missing'] as const)('retires the stopped Cursor identity without touching its PID replacement when cleanup reports %s', async (releaseResult) => {
        const reusedPid = 21_013;
        const onSessionStopped = vi.fn();
        const firstNativeSessionId = 'cursor-native-stop-race-a';
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-stop-race-a', windowId: '@413', paneId: '%413', pid: reusedPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-stop-race-b', windowId: '@414', paneId: '%414', pid: reusedPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-stop-race-lineage', windowId: '@417', paneId: '%417', pid: reusedPid + 1 });

        const manager = createSessionManager({ onSessionStopped });
        const firstSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook('remcli-cursor-stop-race-a', createSessionMetadata(reusedPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(firstSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-stop-race-a' });
        await expect(manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId: firstNativeSessionId,
            remcliSessionId: 'remcli-cursor-stop-race-a',
        })).resolves.toMatchObject({ type: 'bound' });
        const firstRunner = manager.getChildren()[0]?.tmuxRunner;
        expect(firstRunner).toBeDefined();

        let releaseFirstPane: (result: typeof releaseResult) => void = () => {};
        tmuxMocks.releaseOwnedPane.mockImplementationOnce(() => new Promise<typeof releaseResult>((resolve) => {
            releaseFirstPane = resolve;
        }));

        const stoppingFirst = manager.stopSession('remcli-cursor-stop-race-a');
        await vi.waitFor(() => expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(firstRunner));

        const secondSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));
        manager.onRemcliSessionWebhook('remcli-cursor-stop-race-b', createSessionMetadata(reusedPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken(1));
        await expect(secondSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-stop-race-b' });
        const secondRunner = manager.getChildren()[0]?.tmuxRunner;
        expect(secondRunner).toBeDefined();
        await expect(manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId: 'cursor-native-stop-race-b',
            remcliSessionId: 'remcli-cursor-stop-race-b',
        })).resolves.toMatchObject({
            type: 'bound',
            wrapper: { remcliSessionId: 'remcli-cursor-stop-race-b', nativeSessionId: 'cursor-native-stop-race-b' },
        });

        releaseFirstPane(releaseResult);
        await expect(stoppingFirst).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-cursor-stop-race-a',
        });

        expect(manager.getChildren()).toHaveLength(1);
        expect(manager.getChildren()[0]).toMatchObject({
            pid: reusedPid,
            remcliSessionId: 'remcli-cursor-stop-race-b',
        });
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(1);
        expect(tmuxMocks.releaseOwnedPane).not.toHaveBeenCalledWith(secondRunner);
        expect(onSessionStopped).toHaveBeenCalledOnce();
        expect(onSessionStopped).toHaveBeenCalledWith('remcli-cursor-stop-race-a');

        const lineageResume = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: firstNativeSessionId,
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(3));
        await expect(manager.preflightCursorRunner({
            agent: 'cursor',
            nativeResumeSessionId: firstNativeSessionId,
            pid: reusedPid + 1,
            runnerToken: getDaemonRunnerToken(2),
        })).resolves.toEqual({
            type: 'verified',
            parentRemcliSessionId: 'remcli-cursor-stop-race-a',
        });
        manager.onRemcliSessionWebhook('remcli-cursor-stop-race-lineage', createSessionMetadata(reusedPid + 1, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken(2));
        await expect(lineageResume).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-stop-race-lineage' });

        await expect(manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId: 'cursor-native-stop-race-b',
            remcliSessionId: 'remcli-cursor-stop-race-b',
        })).resolves.toMatchObject({ type: 'already-bound' });
        await expect(manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: 'cursor-native-stop-race-b',
            ...CONTROLLED_CURSOR_SELECTION,
        })).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-stop-race-b' });
        expect(onSessionStopped).toHaveBeenCalledOnce();
        expect(onSessionStopped).toHaveBeenCalledWith('remcli-cursor-stop-race-a');
    });

    it.each(['released', 'missing'] as const)('retires a pruned Cursor identity without touching its PID replacement when cleanup reports %s', async (releaseResult) => {
        const reusedPid = 21_014;
        const onSessionStopped = vi.fn();
        const firstNativeSessionId = 'cursor-native-prune-race-a';
        let isFirstRunnerAlive = true;
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (pid === reusedPid && signal === 0 && !isFirstRunnerAlive) {
                throw new Error('process is not running');
            }
            return true;
        });
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-prune-race-a', windowId: '@415', paneId: '%415', pid: reusedPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-prune-race-b', windowId: '@416', paneId: '%416', pid: reusedPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-prune-race-lineage', windowId: '@418', paneId: '%418', pid: reusedPid + 1 });

        const manager = createSessionManager({ onSessionStopped });
        const firstSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook('remcli-cursor-prune-race-a', createSessionMetadata(reusedPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(firstSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-prune-race-a' });
        await expect(manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId: firstNativeSessionId,
            remcliSessionId: 'remcli-cursor-prune-race-a',
        })).resolves.toMatchObject({ type: 'bound' });
        const firstRunner = manager.getChildren()[0]?.tmuxRunner;
        expect(firstRunner).toBeDefined();

        let releaseFirstPane: (result: typeof releaseResult) => void = () => {};
        tmuxMocks.releaseOwnedPane.mockImplementationOnce(() => new Promise<typeof releaseResult>((resolve) => {
            releaseFirstPane = resolve;
        }));
        isFirstRunnerAlive = false;
        manager.pruneDeadSessions();
        await vi.waitFor(() => expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(firstRunner));

        const secondSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));
        manager.onRemcliSessionWebhook('remcli-cursor-prune-race-b', createSessionMetadata(reusedPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken(1));
        await expect(secondSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-prune-race-b' });
        const secondRunner = manager.getChildren()[0]?.tmuxRunner;
        expect(secondRunner).toBeDefined();

        releaseFirstPane(releaseResult);
        await vi.waitFor(() => {
            expect(onSessionStopped).toHaveBeenCalledOnce();
            expect(onSessionStopped).toHaveBeenCalledWith('remcli-cursor-prune-race-a');
        });
        await vi.waitFor(() => expect(manager.getChildren()).toContainEqual(expect.objectContaining({
            pid: reusedPid,
            remcliSessionId: 'remcli-cursor-prune-race-b',
        })));

        await vi.waitFor(async () => {
            await expect(manager.bindNativeCursorSession({
                agent: 'cursor',
                nativeSessionId: 'cursor-native-prune-race-b',
                remcliSessionId: 'remcli-cursor-prune-race-b',
            })).resolves.toMatchObject({ type: 'bound' });
        });
        await expect(manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: 'cursor-native-prune-race-b',
            ...CONTROLLED_CURSOR_SELECTION,
        })).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-prune-race-b' });
        expect(onSessionStopped).toHaveBeenCalledOnce();
        expect(onSessionStopped).toHaveBeenCalledWith('remcli-cursor-prune-race-a');

        const lineageResume = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: firstNativeSessionId,
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(3));
        await expect(manager.preflightCursorRunner({
            agent: 'cursor',
            nativeResumeSessionId: firstNativeSessionId,
            pid: reusedPid + 1,
            runnerToken: getDaemonRunnerToken(2),
        })).resolves.toEqual({
            type: 'verified',
            parentRemcliSessionId: 'remcli-cursor-prune-race-a',
        });
        manager.onRemcliSessionWebhook('remcli-cursor-prune-race-lineage', createSessionMetadata(reusedPid + 1, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken(2));
        await expect(lineageResume).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-prune-race-lineage' });

        await expect(manager.stopSession('remcli-cursor-prune-race-b')).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-cursor-prune-race-b',
        });
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(2);
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenLastCalledWith(secondRunner);
        expect(onSessionStopped).toHaveBeenCalledTimes(2);
        expect(onSessionStopped).toHaveBeenNthCalledWith(1, 'remcli-cursor-prune-race-a');
        expect(onSessionStopped).toHaveBeenNthCalledWith(2, 'remcli-cursor-prune-race-b');
    });

    it('fails closed instead of reusing a Cursor session by PID when its owned tmux pane is unknown', async () => {
        const runnerPid = 21_010;
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-cursor-unknown-pane',
            pid: runnerPid,
        });

        const manager = createSessionManager();
        const initialSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook('remcli-cursor-unknown-pane', createSessionMetadata(runnerPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(initialSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-unknown-pane' });

        const nativeSessionId = 'cursor-native-unknown-pane';
        await expect(manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId,
            remcliSessionId: 'remcli-cursor-unknown-pane',
        })).resolves.toMatchObject({ type: 'bound' });

        const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
        tmuxMocks.getPaneInfo.mockResolvedValue({ status: 'unknown' });

        await expect(manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: nativeSessionId,
            ...CONTROLLED_CURSOR_SELECTION,
        })).resolves.toEqual({
            type: 'error',
            errorMessage: 'Could not confirm ownership of the Cursor session tmux pane. Resume was not started.',
        });

        expect(processKill).not.toHaveBeenCalledWith(runnerPid, 0);
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce();
        expect(manager.getChildren()).toContainEqual(expect.objectContaining({
            nativeCursorSessionId: nativeSessionId,
        }));
    });

    it('does not bind a Cursor native session when stale ownership lookup resolves after full stop cleanup', async () => {
        const runnerPid = 21_011;
        const nativeSessionId = 'cursor-native-binding-stop-race';
        const remcliSessionId = 'remcli-cursor-binding-stop-race';
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-cursor-binding-stop-race',
            pid: runnerPid,
        });

        const manager = createSessionManager();
        const initialSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook(remcliSessionId, createSessionMetadata(runnerPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(initialSpawn).resolves.toEqual({ type: 'success', sessionId: remcliSessionId });
        await expect(manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId,
            remcliSessionId,
        })).resolves.toMatchObject({ type: 'bound' });

        let resolveBindingPaneLookup: () => void = () => {};
        tmuxMocks.getPaneInfo.mockImplementationOnce(async (paneId: string) => {
            const stalePane = tmuxMocks.ownedPanes.get(paneId);
            await new Promise<void>((resolve) => {
                resolveBindingPaneLookup = resolve;
            });
            return stalePane ? { status: 'exists', pane: stalePane } : { status: 'missing' };
        });

        const binding = manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId,
            remcliSessionId: 'remcli-cursor-competing-wrapper',
        });
        await vi.waitFor(() => expect(tmuxMocks.getPaneInfo).toHaveBeenCalledTimes(2));

        const stopping = manager.stopSession(remcliSessionId);
        await expect(stopping).resolves.toEqual({
            success: true,
            stoppedSessionId: remcliSessionId,
        });

        resolveBindingPaneLookup();
        await expect(binding).resolves.toEqual({
            type: 'wrapper-not-tracked',
            binding: {
                agent: 'cursor',
                nativeSessionId,
                remcliSessionId: 'remcli-cursor-competing-wrapper',
            },
        });
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce();
    });

    it('fails closed instead of reusing a Cursor wrapper while its stop is releasing the pane', async () => {
        const runnerPid = 21_011;
        const nativeSessionId = 'cursor-native-stopping-pane';
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-cursor-stopping-pane',
            pid: runnerPid,
        });

        const manager = createSessionManager();
        const initialSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook('remcli-cursor-stopping-pane', createSessionMetadata(runnerPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(initialSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-stopping-pane' });
        await expect(manager.bindNativeCursorSession({
            agent: 'cursor',
            nativeSessionId,
            remcliSessionId: 'remcli-cursor-stopping-pane',
        })).resolves.toMatchObject({ type: 'bound' });

        let resolvePaneRelease: (result: 'released') => void = () => {};
        tmuxMocks.releaseOwnedPane.mockImplementationOnce(() => new Promise<'released'>((resolve) => {
            resolvePaneRelease = resolve;
        }));

        const stopping = manager.stopSession('remcli-cursor-stopping-pane');
        await vi.waitFor(() => expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledOnce());

        await expect(manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: nativeSessionId,
            ...CONTROLLED_CURSOR_SELECTION,
        })).resolves.toEqual({
            type: 'error',
            errorMessage: 'Could not confirm ownership of the Cursor session tmux pane. Resume was not started.',
        });
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce();

        resolvePaneRelease('released');
        await expect(stopping).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-cursor-stopping-pane',
        });
    });

    it('does not reuse a pre-init Cursor wrapper when stale ownership lookup resolves after full stop cleanup', async () => {
        const runnerPid = 21_012;
        const resumeSessionId = 'cursor-pre-init-stopping-pane';
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-cursor-pre-init-stopping-pane',
            pid: runnerPid,
        });

        const manager = createSessionManager();
        const initialSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId,
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook('remcli-cursor-pre-init-stopping-pane', createSessionMetadata(runnerPid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(initialSpawn).resolves.toEqual({
            type: 'success',
            sessionId: 'remcli-cursor-pre-init-stopping-pane',
        });

        let resolveResumePaneLookup: () => void = () => {};
        tmuxMocks.getPaneInfo.mockImplementationOnce(async (paneId: string) => {
            const stalePane = tmuxMocks.ownedPanes.get(paneId);
            await new Promise<void>((resolve) => {
                resolveResumePaneLookup = resolve;
            });
            return stalePane ? { status: 'exists', pane: stalePane } : { status: 'missing' };
        });

        const resuming = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId,
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.getPaneInfo).toHaveBeenCalledOnce());

        const stopping = manager.stopSession('remcli-cursor-pre-init-stopping-pane');
        await expect(stopping).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-cursor-pre-init-stopping-pane',
        });

        resolveResumePaneLookup();
        await expect(resuming).resolves.toEqual({
            type: 'error',
            errorMessage: 'Could not confirm ownership of the Cursor session tmux pane. Resume was not started.',
        });
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce();
    });

    it('shell-quotes a Cursor resume id before placing it in a tmux command', async () => {
        const unsafeResumeId = "cursor' ; touch /tmp/remcli-injection #";
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-cursor-quote',
            pid: process.pid,
        });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            resumeSessionId: unsafeResumeId,
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());

        const command = tmuxMocks.spawnInTmux.mock.calls[0]?.[0]?.[0] as string;
        expect(command).toContain("--resume 'cursor'\\'' ; touch /tmp/remcli-injection #'");
        expect(command).not.toContain(`--resume ${unsafeResumeId}`);

        manager.onRemcliSessionWebhook('remcli-cursor-quote', createSessionMetadata(process.pid, {
            startedBy: 'daemon',
            flavor: 'cursor',
        }), getDaemonRunnerToken());
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-cursor-quote' });
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
            if (releaseResult === 'unknown') {
                tmuxMocks.getSessionStatus.mockResolvedValueOnce('unknown');
            }

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

    it('retires a dead daemon runner when its pane lookup is unknown but its owned tmux session is gone', async () => {
        const runnerPid = 10_044_1;
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
            sessionId: 'tmux-session-root-unknown-missing:main',
            windowId: '@244',
            paneId: '%244',
            pid: runnerPid,
        });
        tmuxMocks.releaseOwnedPane.mockResolvedValueOnce('unknown');
        tmuxMocks.getSessionStatus.mockResolvedValueOnce('missing');

        const manager = createSessionManager({ onSessionStopped });
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'cursor', ...CONTROLLED_CURSOR_SELECTION });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        const rootRunner = manager.getChildren()[0]?.tmuxRunner;
        expect(rootRunner).toBeDefined();
        manager.onRemcliSessionWebhook(
            'remcli-session-pruned-root-unknown-missing',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'cursor' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-pruned-root-unknown-missing' });

        expect(manager.markDaemonRunnerStopping('remcli-session-pruned-root-unknown-missing')).toEqual({ accepted: true });
        activePids.delete(runnerPid);
        manager.pruneDeadSessions();

        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(0));
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(rootRunner);
        expect(tmuxMocks.getSessionStatus).toHaveBeenCalledWith(rootRunner?.sessionName);
        expect(onSessionStopped).toHaveBeenCalledWith('remcli-session-pruned-root-unknown-missing');
    });

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

    it('does not publish a terminal-started session when shutdown joins its deferred prune cleanup', async () => {
        const terminalPid = 10_069;
        const onSessionStopped = vi.fn();
        const activePids = new Set([terminalPid]);
        vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
            if (pid === terminalPid && signal === 0 && !activePids.has(pid)) {
                throw new Error('process is not running');
            }
            return true;
        });

        const manager = createSessionManager({ onSessionStopped });
        manager.onRemcliSessionWebhook(
            'remcli-terminal-prune-shutdown',
            createSessionMetadata(terminalPid, { startedBy: 'terminal', flavor: 'codex' }),
        );
        const terminalSession = manager.getChildren()[0];
        expect(terminalSession).toBeDefined();
        const managedPane = {
            sessionName: 'tmux-terminal-prune-shutdown',
            windowId: '@470',
            paneId: '%470',
            panePid: terminalPid,
            ownerMarker: '00000000-0000-4000-8000-000000000470',
        };
        terminalSession!.managedCodexRemoteTui = managedPane;
        tmuxMocks.ownedPanes.set(managedPane.paneId, managedPane);

        let resolvePaneRelease: (result: 'released') => void = () => {};
        tmuxMocks.releaseOwnedPane.mockImplementationOnce(() => new Promise<'released'>((resolve) => {
            resolvePaneRelease = resolve;
        }));

        activePids.delete(terminalPid);
        manager.pruneDeadSessions();
        await vi.waitFor(() => expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(managedPane));
        const shutdown = manager.killAllSessions();

        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(1);
        resolvePaneRelease('released');

        await expect(shutdown).resolves.toBeUndefined();
        expect(manager.getChildren()).toHaveLength(0);
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(1);
        expect(onSessionStopped).not.toHaveBeenCalled();
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

    it('coalesces two concurrent stop requests for the same daemon runner', async () => {
        const runnerPid = 10_064;
        const onSessionStopped = vi.fn();
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-concurrent-stops:main',
            windowId: '@464',
            paneId: '%464',
            pid: runnerPid,
        });

        const manager = createSessionManager({ onSessionStopped });
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        const runner = manager.getChildren()[0]?.tmuxRunner;
        expect(runner).toBeDefined();
        manager.onRemcliSessionWebhook(
            'remcli-concurrent-stops',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-concurrent-stops' });

        let resolvePaneRelease: (result: 'released') => void = () => {};
        tmuxMocks.releaseOwnedPane.mockImplementationOnce(() => new Promise<'released'>((resolve) => {
            resolvePaneRelease = resolve;
        }));

        const firstStop = manager.stopSession('remcli-concurrent-stops');
        await vi.waitFor(() => expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(runner));
        const secondStop = manager.stopSession('remcli-concurrent-stops');

        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(1);
        resolvePaneRelease('released');

        await expect(firstStop).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-concurrent-stops',
        });
        await expect(secondStop).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-concurrent-stops',
        });
        expect(manager.getChildren()).toHaveLength(0);
        expect(onSessionStopped).toHaveBeenCalledOnce();
    });

    it('coalesces a concurrent stop request and shutdown cleanup for the same daemon runner', async () => {
        const runnerPid = 10_065;
        const onSessionStopped = vi.fn();
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-stop-shutdown:main',
            windowId: '@465',
            paneId: '%465',
            pid: runnerPid,
        });

        const manager = createSessionManager({ onSessionStopped });
        const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
        const runner = manager.getChildren()[0]?.tmuxRunner;
        expect(runner).toBeDefined();
        manager.onRemcliSessionWebhook(
            'remcli-stop-shutdown',
            createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-stop-shutdown' });

        let resolvePaneRelease: (result: 'released') => void = () => {};
        tmuxMocks.releaseOwnedPane.mockImplementationOnce(() => new Promise<'released'>((resolve) => {
            resolvePaneRelease = resolve;
        }));

        const stopping = manager.stopSession('remcli-stop-shutdown');
        await vi.waitFor(() => expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(runner));
        const shutdown = manager.killAllSessions();

        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(1);
        resolvePaneRelease('released');

        await expect(stopping).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-stop-shutdown',
        });
        await expect(shutdown).resolves.toBeUndefined();
        expect(manager.getChildren()).toHaveLength(0);
        expect(onSessionStopped).toHaveBeenCalledOnce();
    });

    it.each(['unknown', 'mismatch'] as const)(
        'allows retrying cleanup after a daemon runner release is %s',
        async (releaseResult) => {
            const runnerPid = releaseResult === 'unknown' ? 10_066 : 10_067;
            const remcliSessionId = `remcli-retry-${releaseResult}`;
            tmuxMocks.spawnInTmux.mockResolvedValueOnce({
                success: true,
                sessionId: `tmux-retry-${releaseResult}:main`,
                windowId: releaseResult === 'unknown' ? '@466' : '@467',
                paneId: releaseResult === 'unknown' ? '%466' : '%467',
                pid: runnerPid,
            });
            tmuxMocks.releaseOwnedPane
                .mockResolvedValueOnce(releaseResult)
                .mockResolvedValueOnce('released');

            const manager = createSessionManager();
            const spawning = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
            await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
            manager.onRemcliSessionWebhook(
                remcliSessionId,
                createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'codex' }),
                getDaemonRunnerToken(),
            );
            await expect(spawning).resolves.toEqual({ type: 'success', sessionId: remcliSessionId });

            await expect(manager.stopSession(remcliSessionId)).resolves.toEqual({ success: false });
            expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(1);

            await expect(manager.stopSession(remcliSessionId)).resolves.toEqual({
                success: true,
                stoppedSessionId: remcliSessionId,
            });
            expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(2);
            expect(manager.getChildren()).toHaveLength(0);
        },
    );

    it('keeps a PID replacement bindable while cleanup of the displaced daemon runner is in flight', async () => {
        const reusedPid = 10_068;
        const onSessionStopped = vi.fn();
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-displaced-cleanup-a:main', windowId: '@468', paneId: '%468', pid: reusedPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-displaced-cleanup-b:main', windowId: '@469', paneId: '%469', pid: reusedPid });

        const manager = createSessionManager({ onSessionStopped });
        const firstSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook(
            'remcli-displaced-cleanup-a',
            createSessionMetadata(reusedPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(firstSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-displaced-cleanup-a' });
        const displacedRunner = manager.getChildren()[0]?.tmuxRunner;
        expect(displacedRunner).toBeDefined();

        let resolveDisplacedPaneRelease: (result: 'released') => void = () => {};
        tmuxMocks.releaseOwnedPane.mockImplementationOnce(() => new Promise<'released'>((resolve) => {
            resolveDisplacedPaneRelease = resolve;
        }));

        const replacementSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(displacedRunner));
        const replacementRunner = manager.getChildren().find((session) => session.tmuxRunner?.paneId === '%469')?.tmuxRunner;
        expect(replacementRunner).toBeDefined();

        manager.onRemcliSessionWebhook(
            'remcli-displaced-cleanup-b',
            createSessionMetadata(reusedPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(1),
        );
        await expect(replacementSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-displaced-cleanup-b' });
        await expect(bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-displaced-cleanup-b',
            nativeThreadId: 'codex-thread-displaced-cleanup-b',
        })).resolves.toMatchObject({ type: 'bound' });

        const stoppingDisplaced = manager.stopSession('remcli-displaced-cleanup-a');
        expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledTimes(1);
        resolveDisplacedPaneRelease('released');

        await expect(stoppingDisplaced).resolves.toEqual({
            success: true,
            stoppedSessionId: 'remcli-displaced-cleanup-a',
        });
        expect(tmuxMocks.releaseOwnedPane).not.toHaveBeenCalledWith(replacementRunner);
        expect(manager.getChildren()).toContainEqual(expect.objectContaining({
            pid: reusedPid,
            remcliSessionId: 'remcli-displaced-cleanup-b',
            nativeCodexThreadId: 'codex-thread-displaced-cleanup-b',
        }));
        expect(onSessionStopped).toHaveBeenCalledOnce();
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

    it('asynchronously retires the displaced daemon identity once without stopping its PID replacement', async () => {
        const reusedPid = 10_060;
        const onSessionStopped = vi.fn();
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-replaced-a:main', windowId: '@460', paneId: '%460', pid: reusedPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-replaced-b:main', windowId: '@461', paneId: '%461', pid: reusedPid });

        const manager = createSessionManager({ onSessionStopped });
        const firstSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce());
        manager.onRemcliSessionWebhook(
            'remcli-replaced-a',
            createSessionMetadata(reusedPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(),
        );
        await expect(firstSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-replaced-a' });
        await expect(bindTrackedCodexThread(manager, {
            agent: 'codex',
            remcliSessionId: 'remcli-replaced-a',
            nativeThreadId: 'codex-thread-replaced-a',
        })).resolves.toMatchObject({ type: 'bound' });
        const displacedRunner = manager.getChildren()[0]?.tmuxRunner;
        expect(displacedRunner).toBeDefined();

        const replacementSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'codex' });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));
        const replacementRunner = manager.getChildren()[0]?.tmuxRunner;
        expect(replacementRunner).toBeDefined();
        expect(replacementRunner).not.toEqual(displacedRunner);

        await vi.waitFor(() => expect(onSessionStopped).toHaveBeenCalledWith('remcli-replaced-a'));
        await expect(manager.resolveCodexThreadResume('codex-thread-replaced-a')).resolves.toEqual({
            type: 'spawn-new-wrapper',
            nativeThreadId: 'codex-thread-replaced-a',
        });
        expect(tmuxMocks.releaseOwnedPane).not.toHaveBeenCalledWith(replacementRunner);

        manager.onRemcliSessionWebhook(
            'remcli-replaced-b',
            createSessionMetadata(reusedPid, { startedBy: 'daemon', flavor: 'codex' }),
            getDaemonRunnerToken(1),
        );
        await expect(replacementSpawn).resolves.toEqual({ type: 'success', sessionId: 'remcli-replaced-b' });
        expect(manager.getChildren()).toContainEqual(expect.objectContaining({
            pid: reusedPid,
            remcliSessionId: 'remcli-replaced-b',
        }));
        expect(onSessionStopped).toHaveBeenCalledOnce();
    });

    it.each(['cursor', 'gemini'] as const)(
        'keeps the %s webhook received during terminal attach',
        async (agent) => {
            const runnerPid = agent === 'cursor' ? 10_061 : 10_062;
            let resolveTerminalAttach: (result: boolean) => void = () => {};
            openTerminalMocks.openTerminalWithCommand.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
                resolveTerminalAttach = resolve;
            }));
            tmuxMocks.spawnInTmux.mockResolvedValueOnce({
                success: true,
                sessionId: `tmux-${agent}-early-webhook:main`,
                pid: runnerPid,
            });

            const manager = createSessionManager();
            const spawning = agent === 'cursor'
                ? manager.spawnSession({
                    directory: process.cwd(),
                    agent,
                    ...CONTROLLED_CURSOR_SELECTION,
                })
                : manager.spawnSession({ directory: process.cwd(), agent });
            await vi.waitFor(() => expect(openTerminalMocks.openTerminalWithCommand).toHaveBeenCalledOnce());

            manager.onRemcliSessionWebhook(
                `remcli-${agent}-early-webhook`,
                createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: agent }),
                getDaemonRunnerToken(),
            );

            resolveTerminalAttach(true);
            await expect(spawning).resolves.toEqual({
                type: 'success',
                sessionId: `remcli-${agent}-early-webhook`,
            });
        },
    );

    it('settles a Cursor spawn displaced during terminal attach while its PID replacement resolves independently', async () => {
        const reusedPid = 10_063;
        let resolveFirstTerminalAttach: (result: boolean) => void = () => {};
        openTerminalMocks.openTerminalWithCommand
            .mockImplementationOnce(() => new Promise<boolean>((resolve) => {
                resolveFirstTerminalAttach = resolve;
            }))
            .mockResolvedValueOnce(true);
        tmuxMocks.spawnInTmux
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-displaced:main', windowId: '@463', paneId: '%463', pid: reusedPid })
            .mockResolvedValueOnce({ success: true, sessionId: 'tmux-gemini-replacement:main', windowId: '@464', paneId: '%464', pid: reusedPid });

        const manager = createSessionManager();
        const displacedSpawn = manager.spawnSession({
            directory: process.cwd(),
            agent: 'cursor',
            ...CONTROLLED_CURSOR_SELECTION,
        });
        await vi.waitFor(() => expect(openTerminalMocks.openTerminalWithCommand).toHaveBeenCalledOnce());

        const replacementSpawn = manager.spawnSession({ directory: process.cwd(), agent: 'gemini' });
        await vi.waitFor(() => expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2));
        await expect(displacedSpawn).resolves.toEqual({
            type: 'error',
            errorMessage: `Session process ${reusedPid} stopped before reporting its Remcli session.`,
        });

        manager.onRemcliSessionWebhook(
            'remcli-gemini-replacement',
            createSessionMetadata(reusedPid, { startedBy: 'daemon', flavor: 'gemini' }),
            getDaemonRunnerToken(1),
        );
        await expect(replacementSpawn).resolves.toEqual({
            type: 'success',
            sessionId: 'remcli-gemini-replacement',
        });

        resolveFirstTerminalAttach(true);
        await Promise.resolve();
        expect(manager.getChildren()).toEqual([
            expect.objectContaining({
                pid: reusedPid,
                remcliSessionId: 'remcli-gemini-replacement',
            }),
        ]);
    });

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

    describe('Cursor interactive TUI host', () => {
        it('opens one daemon-owned native TUI using the immutable Cursor launch selection', async () => {
            const runnerPid = 22_101;
            const interactivePanePid = 22_102;
            const remcliSessionId = 'remcli-cursor-interactive-tui';
            const nativeSessionId = 'cursor-native-interactive-tui';
            const cursorLaunchControls = {
                executionMode: 'plan' as const,
                force: true,
                autoReview: true,
                sandbox: 'enabled' as const,
                approveMcps: true,
            };
            tmuxMocks.spawnInTmux
                .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-runner:main', windowId: '@801', paneId: '%801', pid: runnerPid })
                .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-interactive:cursor', windowId: '@802', paneId: '%802', pid: interactivePanePid });

            const manager = createSessionManager();
            const spawning = manager.spawnSession({
                directory: process.cwd(),
                agent: 'cursor',
                cursorExecution: {
                    model: 'controlled-cursor-interactive-model',
                    catalogVersion: 'controlled-cursor-catalog',
                },
                cursorLaunchControls,
                cursorRunner: CONTROLLED_CURSOR_SELECTION.cursorRunner,
            });
            await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
            manager.onRemcliSessionWebhook(
                remcliSessionId,
                createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'cursor' }),
                getDaemonRunnerToken(),
            );
            await expect(spawning).resolves.toEqual({ type: 'success', sessionId: remcliSessionId });
            await expect(bindTrackedCursorSession(manager, {
                agent: 'cursor',
                remcliSessionId,
                nativeSessionId,
            })).resolves.toMatchObject({ type: 'bound' });

            openTerminalMocks.openTerminalWithCommand.mockClear();
            const request = { agent: 'cursor' as const, remcliSessionId, nativeSessionId };
            const [firstOpen, secondOpen, forgedOpen] = await Promise.all([
                manager.openCursorInteractiveTui(request),
                manager.openCursorInteractiveTui(request),
                manager.openCursorInteractiveTui({
                    agent: 'cursor',
                    remcliSessionId,
                    nativeSessionId: 'cursor-native-interactive-forged',
                }),
            ]);

            expect(firstOpen).toMatchObject({ type: 'opened', tmuxWindowId: '@802' });
            expect(secondOpen).toMatchObject({ type: 'opened', tmuxWindowId: '@802' });
            expect(forgedOpen).toEqual({
                type: 'native-session-mismatch',
                request: {
                    agent: 'cursor',
                    remcliSessionId,
                    nativeSessionId: 'cursor-native-interactive-forged',
                },
                trackedNativeSessionId: nativeSessionId,
            });
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(2);
            expect(tmuxMocks.spawnInTmux.mock.calls[1]?.[0]).toEqual([
                "'agent' --resume 'cursor-native-interactive-tui' --model 'controlled-cursor-interactive-model' --mode plan --force --auto-review --sandbox enabled --approve-mcps",
            ]);
            expect(openTerminalMocks.openTerminalWithCommand).toHaveBeenCalledTimes(1);
            expect(manager.getChildren()[0]?.managedCursorInteractiveTui).toMatchObject({
                windowId: '@802',
                paneId: '%802',
            });

            const managedInteractiveTui = manager.getChildren()[0]?.managedCursorInteractiveTui;
            expect(managedInteractiveTui).toBeDefined();
            tmuxMocks.ownedPanes.set(managedInteractiveTui!.paneId, {
                ...managedInteractiveTui!,
                ownerMarker: '00000000-0000-4000-8000-000000000802',
            });

            await expect(manager.stopSession(remcliSessionId)).resolves.toEqual({ success: false });
            expect(manager.getChildren()).toHaveLength(1);

            tmuxMocks.ownedPanes.set(managedInteractiveTui!.paneId, managedInteractiveTui!);
            await expect(manager.stopSession(remcliSessionId)).resolves.toEqual({
                success: true,
                stoppedSessionId: remcliSessionId,
            });
            expect(manager.getChildren()).toHaveLength(0);
        });

        it('fails closed when the native Cursor session does not match the daemon binding', async () => {
            const runnerPid = 22_111;
            const remcliSessionId = 'remcli-cursor-interactive-mismatch';
            tmuxMocks.spawnInTmux.mockResolvedValueOnce({
                success: true,
                sessionId: 'tmux-cursor-runner:main',
                windowId: '@811',
                paneId: '%811',
                pid: runnerPid,
            });

            const manager = createSessionManager();
            const spawning = manager.spawnSession({
                directory: process.cwd(),
                agent: 'cursor',
                ...CONTROLLED_CURSOR_SELECTION,
            });
            await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
            manager.onRemcliSessionWebhook(
                remcliSessionId,
                createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'cursor' }),
                getDaemonRunnerToken(),
            );
            await expect(spawning).resolves.toEqual({ type: 'success', sessionId: remcliSessionId });
            await expect(bindTrackedCursorSession(manager, {
                agent: 'cursor',
                remcliSessionId,
                nativeSessionId: 'cursor-native-bound',
            })).resolves.toMatchObject({ type: 'bound' });

            await expect(manager.openCursorInteractiveTui({
                agent: 'cursor',
                remcliSessionId,
                nativeSessionId: 'cursor-native-forged',
            })).resolves.toEqual({
                type: 'native-session-mismatch',
                request: {
                    agent: 'cursor',
                    remcliSessionId,
                    nativeSessionId: 'cursor-native-forged',
                },
                trackedNativeSessionId: 'cursor-native-bound',
            });
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledOnce();
            expect(openTerminalMocks.openTerminalWithCommand).toHaveBeenCalledOnce();
        });

        it('waits for an in-flight Cursor TUI opening before it cleans up the wrapper', async () => {
            const runnerPid = 22_121;
            const interactivePanePid = 22_122;
            const remcliSessionId = 'remcli-cursor-interactive-stop-race';
            const nativeSessionId = 'cursor-native-interactive-stop-race';
            tmuxMocks.spawnInTmux
                .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-runner:main', windowId: '@821', paneId: '%821', pid: runnerPid })
                .mockResolvedValueOnce({ success: true, sessionId: 'tmux-cursor-interactive:cursor', windowId: '@822', paneId: '%822', pid: interactivePanePid });

            const manager = createSessionManager();
            const spawning = manager.spawnSession({
                directory: process.cwd(),
                agent: 'cursor',
                ...CONTROLLED_CURSOR_SELECTION,
            });
            await vi.waitFor(() => expect(manager.getChildren()).toHaveLength(1));
            manager.onRemcliSessionWebhook(
                remcliSessionId,
                createSessionMetadata(runnerPid, { startedBy: 'daemon', flavor: 'cursor' }),
                getDaemonRunnerToken(),
            );
            await expect(spawning).resolves.toEqual({ type: 'success', sessionId: remcliSessionId });
            await expect(bindTrackedCursorSession(manager, {
                agent: 'cursor',
                remcliSessionId,
                nativeSessionId,
            })).resolves.toMatchObject({ type: 'bound' });

            let resolveInteractiveTerminal: (result: boolean) => void = () => {};
            openTerminalMocks.openTerminalWithCommand.mockClear();
            openTerminalMocks.openTerminalWithCommand.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
                resolveInteractiveTerminal = resolve;
            }));

            const request = { agent: 'cursor' as const, remcliSessionId, nativeSessionId };
            const opening = manager.openCursorInteractiveTui(request);
            await vi.waitFor(() => expect(openTerminalMocks.openTerminalWithCommand).toHaveBeenCalledOnce());

            const stopping = manager.stopSession(remcliSessionId);
            resolveInteractiveTerminal(true);

            await expect(opening).resolves.toEqual({ type: 'wrapper-not-tracked', request });
            await expect(stopping).resolves.toEqual({
                success: true,
                stoppedSessionId: remcliSessionId,
            });
            expect(tmuxMocks.releaseOwnedPane).toHaveBeenCalledWith(expect.objectContaining({ paneId: '%822' }));
            expect(manager.getChildren()).toHaveLength(0);
        });
    });
});
