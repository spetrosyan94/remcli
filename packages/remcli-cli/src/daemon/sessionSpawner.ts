/**
 * Session manager for the daemon.
 *
 * Owns the map of tracked child sessions (keyed by PID) and the set of tmux
 * session names created by this daemon. Exposes pure functions (created via a
 * factory with explicit dependencies) for spawning, stopping, tracking and
 * cleaning up sessions. The daemon coordinator (run.ts) wires these into the
 * control server, the P2P machine socket and the heartbeat loop.
 */

import fs from 'fs/promises';
import { join } from 'path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import {
    CodexThreadResumeResult,
    CodexRemoteTuiOpenRequest,
    CodexRemoteTuiOpenResult,
    CursorInteractiveTuiOpenRequest,
    CursorInteractiveTuiOpenResult,
    CursorRunnerPreflightRequest,
    CursorRunnerPreflightResult,
    DaemonRunnerLifecycleResult,
    DaemonSessionWebhookResult,
    NativeCodexThreadBinding,
    NativeCodexThreadBindingResult,
    NativeCodexThreadWrapper,
    NativeCursorSessionBinding,
    NativeCursorSessionBindingResult,
    NativeCursorSessionWrapper,
    StopSessionResult,
    TrackedSession,
    TmuxPaneOwnership,
} from './types';
import { Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { readSettings, validateProfileForAgent, getProfileEnvironmentVariables } from '@/persistence';
import { projectPath } from '@/projectPath';
import { buildSafeSpawnSessionLogPayload } from './spawnSessionLog';
import { getTmuxUtilities, isTmuxAvailable } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { openTerminalWithCommand } from '@/utils/openTerminal';
import { buildCodexRemoteTuiCommand } from '@/codex/codexAppServerHost';
import { isCursorRunnerIdentity } from '@/cursor/cursorCapabilities';
import { buildCursorInteractiveTuiCommand } from '@/cursor/cursorCli';
import { isCursorLaunchControls } from '@/cursor/cursorLaunchControls';

const DAEMON_SHUTDOWN_CANCELLATION_MESSAGE = 'Daemon shut down before session process registration.';
const CODEX_RESUME_SHUTDOWN_CANCELLATION_MESSAGE = 'Daemon shut down before Codex resume process registration.';
const DAEMON_SHUTTING_DOWN_SPAWN_ERROR_MESSAGE = 'Daemon is shutting down and cannot start a new session.';
const CURSOR_RESUME_OWNERSHIP_UNCONFIRMED_ERROR = 'Could not confirm ownership of the Cursor session tmux pane. Resume was not started.';
const RUNNER_CONTROL_TOKEN_BYTES = 32;
const GRACEFUL_DAEMON_RUNNER_SHUTDOWN_TIMEOUT_MS = 10_000;
const CURSOR_LEGACY_PERMISSION_ENV_KEY = 'REMCLI_CURSOR_PERMISSION_MODE';
const CURSOR_DAEMON_SELECTION_ENV_KEYS = [
    'REMCLI_CURSOR_MODEL',
    'REMCLI_CURSOR_CATALOG_VERSION',
    'REMCLI_CURSOR_PERMISSION_MODE',
    'REMCLI_CURSOR_EXECUTION_MODE',
    'REMCLI_CURSOR_FORCE',
    'REMCLI_CURSOR_AUTO_REVIEW',
    'REMCLI_CURSOR_SANDBOX',
    'REMCLI_CURSOR_APPROVE_MCPS',
    'REMCLI_CURSOR_EXECUTABLE',
    'REMCLI_CURSOR_CLI_FINGERPRINT',
] as const;

interface SessionSpawnAwaiter {
    session: TrackedSession;
    complete: (session: TrackedSession) => void;
    fail: (errorMessage: string) => void;
}

interface PendingSpawnTask {
    nativeThreadId?: string;
    resumeKey?: string;
    promise: Promise<SpawnSessionResult>;
    taskCompletion: Promise<Error | undefined>;
    cancel: (errorMessage: string) => void;
    completeTask: (error?: Error) => void;
    getCancellationResult: () => SpawnSessionResult | undefined;
    resolve: (result: SpawnSessionResult) => void;
}

interface DaemonTmuxRunner {
    ownership: TmuxPaneOwnership;
    tmuxSessionId?: string;
}

interface DaemonRunnerStoppingFence {
    completion: Promise<void>;
    complete: () => void;
}

type OwnedPaneStatus = 'exists' | 'missing' | 'mismatch' | 'unknown';
type TrackedSessionStatus = OwnedPaneStatus;

interface BoundNativeCursorSessionLookup {
    type: 'found' | 'not-found' | 'unavailable';
    session?: TrackedSession;
}

interface NativeCursorSessionMapping {
    pid: number;
    session: TrackedSession;
}

interface NativeCodexThreadMapping {
    pid: number;
    session: TrackedSession;
}

interface PendingCodexThreadResume {
    session: TrackedSession;
    task: PendingSpawnTask;
}

interface PendingSpawnTaskRegistration {
    session: TrackedSession;
    task: PendingSpawnTask;
}

interface RunnerSessionMapping {
    pid: number;
    session: TrackedSession;
}

/** Trusted only after the daemon has credential-bound the native Cursor ID. */
interface CursorSessionLineage {
    parentRemcliSessionId: string;
    directory: string;
}

/** Immutable native Cursor launch selection retained only inside the daemon. */
interface CursorInteractiveTuiLaunch {
    model: string;
    runner: NonNullable<SpawnSessionOptions['cursorRunner']>;
    launchControls: NonNullable<SpawnSessionOptions['cursorLaunchControls']>;
}

interface CursorInteractiveTuiOpening {
    remcliSessionId: string;
    promise: Promise<CursorInteractiveTuiOpenResult>;
}

function createPendingSpawnTask(nativeThreadId?: string): PendingSpawnTask {
    let cancellationResult: SpawnSessionResult | undefined;
    let resolvePromise: (result: SpawnSessionResult) => void = () => {};
    let resolveTaskCompletion: (error: Error | undefined) => void = () => {};
    let hasSettled = false;
    let hasCompletedTask = false;
    const promise = new Promise<SpawnSessionResult>((resolve) => {
        resolvePromise = resolve;
    });
    const taskCompletion = new Promise<Error | undefined>((resolve) => {
        resolveTaskCompletion = resolve;
    });

    return {
        nativeThreadId,
        promise,
        taskCompletion,
        cancel: (errorMessage) => {
            if (hasSettled) {
                return;
            }
            cancellationResult = { type: 'error', errorMessage };
            hasSettled = true;
            resolvePromise(cancellationResult);
        },
        completeTask: (error) => {
            if (hasCompletedTask) {
                return;
            }
            hasCompletedTask = true;
            resolveTaskCompletion(error);
        },
        getCancellationResult: () => cancellationResult,
        resolve: (result) => {
            if (hasSettled) {
                return;
            }
            hasSettled = true;
            resolvePromise(result);
        },
    };
}

function createDaemonRunnerStoppingFence(): DaemonRunnerStoppingFence {
    let complete: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
        complete = resolve;
    });
    return { completion, complete };
}

export interface SessionManager {
    /** Snapshot of currently tracked sessions. */
    getChildren: () => TrackedSession[];
    /** Bind a native Codex thread to its already-created Remcli wrapper session. */
    bindNativeCodexThread: (binding: NativeCodexThreadBinding) => Promise<NativeCodexThreadBindingResult>;
    /** Bind a native Cursor session to its already-created Remcli wrapper session. */
    bindNativeCursorSession: (binding: NativeCursorSessionBinding) => Promise<NativeCursorSessionBindingResult>;
    /** Validate a daemon-owned Cursor or Codex runner before it creates P2P metadata. */
    preflightCursorRunner: (
        request: CursorRunnerPreflightRequest,
    ) => Promise<CursorRunnerPreflightResult>;
    /** Prevent a graceful daemon-owned runner from being resumed while it exits. */
    markDaemonRunnerStopping: (sessionId: string) => DaemonRunnerLifecycleResult;
    /** Release a graceful daemon-owned runner after it flushed its final P2P lifecycle event. */
    completeDaemonRunnerStopping: (sessionId: string) => Promise<DaemonRunnerLifecycleResult>;
    /** Open one daemon-owned tmux window for a bound Codex remote TUI. */
    openCodexRemoteTui: (request: CodexRemoteTuiOpenRequest) => Promise<CodexRemoteTuiOpenResult>;
    /** Prepare one daemon-owned tmux window for a bound native Cursor TUI. */
    openCursorInteractiveTui: (request: CursorInteractiveTuiOpenRequest) => Promise<CursorInteractiveTuiOpenResult>;
    /** Resolve whether a Codex thread already has an active wrapper session. */
    resolveCodexThreadResume: (nativeThreadId: string) => Promise<CodexThreadResumeResult>;
    /** Spawn a new session in tmux and wait for its webhook. */
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    /** Stop a daemon-owned session by its immutable tmux target. */
    stopSession: (sessionId: string) => Promise<StopSessionResult>;
    /** Handle a webhook from a session reporting itself to the daemon. */
    onRemcliSessionWebhook: (
        sessionId: string,
        metadata: Metadata,
        runnerToken?: string
    ) => DaemonSessionWebhookResult;
    /** Remove sessions whose process is no longer alive (used by heartbeat). */
    pruneDeadSessions: () => void;
    /** Kill all tracked sessions and tmux sessions created by this daemon (used on shutdown). */
    killAllSessions: () => Promise<void>;
}

export interface SessionManagerOptions {
    onSessionStopped?: (sessionId: string) => void;
    /**
     * Isolated compiled CLI entrypoint for subprocess integration tests. Normal
     * daemon sessions always use this package's current `dist/index.mjs`.
     */
    runnerEntrypointPath?: string;
}

// Get environment variables for a profile, filtered for agent compatibility
async function getProfileEnvironmentVariablesForAgent(
    profileId: string,
    agentType: 'claude' | 'codex' | 'cursor' | 'gemini'
): Promise<Record<string, string>> {
    try {
        const settings = await readSettings();
        const profile = settings.profiles.find(p => p.id === profileId);

        if (!profile) {
            logger.debug(`[DAEMON RUN] Profile ${profileId} not found`);
            return {};
        }

        // Check if profile is compatible with the agent
        if (!validateProfileForAgent(profile, agentType)) {
            logger.debug(`[DAEMON RUN] Profile ${profileId} not compatible with agent ${agentType}`);
            return {};
        }

        // Get environment variables from profile (new schema)
        const envVars = getProfileEnvironmentVariables(profile);

        logger.debug(`[DAEMON RUN] Loaded ${Object.keys(envVars).length} environment variables from profile ${profileId} for agent ${agentType}`);
        return envVars;
    } catch (error) {
        logger.debug('[DAEMON RUN] Failed to get profile environment variables:', error);
        return {};
    }
}

export function resolveSpawnAuthEnvironment(options: Pick<SpawnSessionOptions, 'agent' | 'token'>): Record<string, string> {
    if (!options.token) {
        return {};
    }

    if (options.agent === 'codex') {
        // Codex must behave like `codex` launched from the user's terminal:
        // same CODEX_HOME, config.toml, plugins, MCP auth state and sessions.
        // Do not replace CODEX_HOME with a temporary auth-only directory here.
        logger.debug('[DAEMON RUN] Ignoring Codex token override to preserve local Codex CLI environment');
        return {};
    }

    if (options.agent === 'cursor') {
        // Cursor accepts its API key only through the environment. Never put a
        // provider credential in a native process argument where it is visible.
        return { CURSOR_API_KEY: options.token };
    }

    return { CLAUDE_CODE_OAUTH_TOKEN: options.token };
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function createRunnerControlToken(): string {
    return randomBytes(RUNNER_CONTROL_TOKEN_BYTES).toString('base64url');
}

function hasMatchingRunnerControlToken(expectedToken: string | undefined, receivedToken: string | undefined): boolean {
    if (!expectedToken || !receivedToken) {
        return false;
    }

    const expected = Buffer.from(expectedToken);
    const received = Buffer.from(receivedToken);
    return expected.length === received.length && timingSafeEqual(expected, received);
}

function isValidCodexRemoteTuiEndpoint(endpoint: string): boolean {
    try {
        const url = new URL(endpoint);
        return url.protocol === 'ws:'
            && url.hostname === '127.0.0.1'
            && url.port.length > 0
            && !url.username
            && !url.password
            && (!url.pathname || url.pathname === '/')
            && !url.search
            && !url.hash;
    } catch {
        return false;
    }
}

function buildCodexRemoteTuiWindowName(nativeThreadId: string): string {
    const suffix = createHash('sha256').update(nativeThreadId).digest('hex').slice(0, 16);
    return `codex-${suffix}-${randomUUID()}`;
}

function buildCursorInteractiveTuiWindowName(nativeSessionId: string): string {
    const suffix = createHash('sha256').update(nativeSessionId).digest('hex').slice(0, 16);
    return `cursor-${suffix}-${randomUUID()}`;
}

function buildCursorInteractiveTuiOpeningKey(request: CursorInteractiveTuiOpenRequest): string {
    return JSON.stringify([request.remcliSessionId, request.nativeSessionId]);
}

export function createSessionManager(options: SessionManagerOptions = {}): SessionManager {
    const runnerEntrypointPath = options.runnerEntrypointPath;
    // PID indexes only the currently active session in a process slot. A session
    // displaced by PID reuse remains separately tracked until its immutable
    // cleanup is confirmed.
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const displacedTrackedSessionPids = new Map<TrackedSession, number>();
    const resumeSpawnPromises = new Map<string, Promise<SpawnSessionResult>>();
    const codexThreadResumeSpawnPromises = new Map<string, PendingSpawnTask>();
    const nativeCodexThreadIdToTrackedSession = new Map<string, NativeCodexThreadMapping>();
    const nativeCursorSessionIdToTrackedSession = new Map<string, NativeCursorSessionMapping>();
    const nativeCursorSessionBindingPromises = new Map<string, Promise<NativeCursorSessionBindingResult>>();
    const cursorSessionLineageByNativeSessionId = new Map<string, CursorSessionLineage>();
    const runnerSessionIdToTrackedSession = new Map<string, RunnerSessionMapping>();
    const codexRemoteTuiOpenPromises = new Map<string, Promise<CodexRemoteTuiOpenResult>>();
    const cursorInteractiveTuiOpenPromises = new Map<string, CursorInteractiveTuiOpening>();
    const orphanedCodexRemoteTuiPanes = new Map<string, TmuxPaneOwnership>();
    const orphanedCursorInteractiveTuiPanes = new Map<string, TmuxPaneOwnership>();
    const cursorInteractiveTuiLaunches = new WeakMap<TrackedSession, CursorInteractiveTuiLaunch>();
    const sessionCleanupPromises = new Map<TrackedSession, Promise<boolean>>();
    const sessionCleanupFailureReasons = new Map<TrackedSession, string>();
    const daemonRunnerStoppingFences = new WeakMap<TrackedSession, DaemonRunnerStoppingFence>();
    let codexRemoteTuiHostPromise: Promise<{ ok: true } | { ok: false; error: string }> | null = null;
    let cursorInteractiveTuiHostPromise: Promise<{ ok: true } | { ok: false; error: string }> | null = null;

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, SessionSpawnAwaiter>();
    const pidToPendingCodexThreadResume = new Map<number, PendingCodexThreadResume>();
    const pidToPendingSpawnTask = new Map<number, PendingSpawnTaskRegistration>();
    const inFlightSpawnTasks = new Set<PendingSpawnTask>();
    const stoppedSessionIds = new Set<string>();

    // Track tmux session names created by this daemon for cleanup
    const daemonTmuxRunners = new Map<string, DaemonTmuxRunner>();
    const codexRemoteTuiHostSessionName = `remcli-codex-tui-${randomUUID()}`;
    const codexRemoteTuiHostWindowName = 'host';
    const codexRemoteTuiHostOwnerMarker = randomUUID();
    let codexRemoteTuiHostAnchor: TmuxPaneOwnership | undefined;
    let hasOpenedCodexRemoteTuiHostTerminal = false;
    const cursorInteractiveTuiHostSessionName = `remcli-cursor-tui-${randomUUID()}`;
    const cursorInteractiveTuiHostWindowName = 'host';
    const cursorInteractiveTuiHostOwnerMarker = randomUUID();
    let cursorInteractiveTuiHostAnchor: TmuxPaneOwnership | undefined;
    let hasOpenedCursorInteractiveTuiHostTerminal = false;
    let isShuttingDown = false;
    let shutdownDrain: Promise<void> | null = null;

    const getTrackedSessionEntries = (): Array<[number, TrackedSession]> => [
        ...pidToTrackedSession.entries(),
        ...Array.from(displacedTrackedSessionPids.entries(), ([session, pid]) => [pid, session] as [number, TrackedSession]),
    ];

    const getChildren = () => getTrackedSessionEntries().map(([, session]) => session);

    const retireDaemonTmuxRunner = (session: TrackedSession): void => {
        const ownership = session.tmuxRunner;
        if (ownership) {
            daemonTmuxRunners.delete(ownership.sessionName);
        }
    };

    const getSessionStoppedBeforeReportingError = (pid: number): string => (
        `Session process ${pid} stopped before reporting its Remcli session.`
    );

    const publishSessionStopped = (session: TrackedSession): void => {
        const sessionId = session.remcliSessionId;
        if (!sessionId || stoppedSessionIds.has(sessionId)) {
            return;
        }

        stoppedSessionIds.add(sessionId);
        try {
            options.onSessionStopped?.(sessionId);
        } catch (error) {
            logger.warn(`[DAEMON RUN] Failed to publish stopped session ${sessionId}:`, error);
        }
    };

    const detachNativeCodexThreadMapping = (session: TrackedSession): void => {
        const nativeThreadId = session.nativeCodexThreadId;
        if (!nativeThreadId) {
            return;
        }

        const mapping = nativeCodexThreadIdToTrackedSession.get(nativeThreadId);
        if (mapping?.session === session) {
            nativeCodexThreadIdToTrackedSession.delete(nativeThreadId);
        }
    };

    const detachNativeCursorSessionMapping = (session: TrackedSession): void => {
        const nativeSessionId = session.nativeCursorSessionId;
        if (!nativeSessionId) {
            return;
        }

        const mapping = nativeCursorSessionIdToTrackedSession.get(nativeSessionId);
        if (mapping?.session === session) {
            nativeCursorSessionIdToTrackedSession.delete(nativeSessionId);
        }
    };

    const detachRunnerSessionMapping = (session: TrackedSession): void => {
        const remcliSessionId = session.runnerControlTokenSessionId;
        if (!remcliSessionId) {
            return;
        }

        const mapping = runnerSessionIdToTrackedSession.get(remcliSessionId);
        if (mapping?.session === session) {
            runnerSessionIdToTrackedSession.delete(remcliSessionId);
        }
    };

    const settleTrackedSessionSpawn = (pid: number, session: TrackedSession): void => {
        const errorMessage = getSessionStoppedBeforeReportingError(pid);
        const pendingCodexThreadResume = pidToPendingCodexThreadResume.get(pid);
        if (pendingCodexThreadResume?.session === session) {
            pidToPendingCodexThreadResume.delete(pid);
            if (
                pendingCodexThreadResume.task.nativeThreadId
                && codexThreadResumeSpawnPromises.get(pendingCodexThreadResume.task.nativeThreadId) === pendingCodexThreadResume.task
            ) {
                codexThreadResumeSpawnPromises.delete(pendingCodexThreadResume.task.nativeThreadId);
            }
            pendingCodexThreadResume.task.cancel(errorMessage);
        }

        const pendingSpawnTask = pidToPendingSpawnTask.get(pid);
        if (pendingSpawnTask?.session === session) {
            pidToPendingSpawnTask.delete(pid);
            if (
                pendingSpawnTask.task.resumeKey
                && resumeSpawnPromises.get(pendingSpawnTask.task.resumeKey) === pendingSpawnTask.task.promise
            ) {
                resumeSpawnPromises.delete(pendingSpawnTask.task.resumeKey);
            }
            pendingSpawnTask.task.cancel(errorMessage);
        }

        const awaiter = pidToAwaiter.get(pid);
        if (awaiter?.session === session) {
            awaiter.fail(errorMessage);
        }
    };

    const clearTrackedSessionRuntimeState = (pid: number, session: TrackedSession): void => {
        settleTrackedSessionSpawn(pid, session);

        detachNativeCodexThreadMapping(session);
        detachNativeCursorSessionMapping(session);
        detachRunnerSessionMapping(session);
    };

    const displaceTrackedSessionRuntimeState = (pid: number, session: TrackedSession): void => {
        // A later PID owner cannot complete A's spawn. Its waiters must settle,
        // but A's native and runner ownership remains intact for cleanup retry.
        settleTrackedSessionSpawn(pid, session);
    };

    const isDisplacedTrackedSession = (pid: number, session: TrackedSession): boolean => (
        displacedTrackedSessionPids.get(session) === pid
    );

    const isTrackedSessionIdentity = (pid: number, session: TrackedSession): boolean => (
        pidToTrackedSession.get(pid) === session || isDisplacedTrackedSession(pid, session)
    );

    const replaceTrackedSession = (pid: number, session: TrackedSession): void => {
        const replacedSession = pidToTrackedSession.get(pid);
        if (replacedSession && replacedSession !== session) {
            displaceTrackedSessionRuntimeState(pid, replacedSession);
            pidToTrackedSession.delete(pid);
            displacedTrackedSessionPids.set(replacedSession, pid);
        }

        pidToTrackedSession.set(pid, session);

        if (replacedSession && replacedSession !== session) {
            scheduleDisplacedTrackedSessionCleanup(pid, replacedSession);
        }
    };

    const isCurrentTrackedSession = (pid: number, session: TrackedSession): boolean => (
        pidToTrackedSession.get(pid) === session
    );

    const isStoppingSession = (session: TrackedSession): boolean => (
        sessionCleanupPromises.has(session)
    );

    const isGracefullyStoppingDaemonRunner = (session: TrackedSession): boolean => (
        daemonRunnerStoppingFences.has(session)
    );

    const waitForGracefulDaemonRunnerCompletion = async (session: TrackedSession): Promise<boolean> => {
        const fence = daemonRunnerStoppingFences.get(session);
        if (!fence) {
            return true;
        }

        let timeout: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                fence.completion,
                new Promise<void>((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('Timed out waiting for graceful daemon runner completion.')), GRACEFUL_DAEMON_RUNNER_SHUTDOWN_TIMEOUT_MS);
                }),
            ]);
            return true;
        } catch {
            return false;
        } finally {
            if (timeout) {
                clearTimeout(timeout);
            }
        }
    };

    const isReadyTrackedSession = (pid: number, session: TrackedSession): boolean => (
        isCurrentTrackedSession(pid, session)
        && !isStoppingSession(session)
        && !isGracefullyStoppingDaemonRunner(session)
    );

    const isExactTrackedSession = (pid: number, session: TrackedSession): boolean => (
        pidToTrackedSession.get(pid) === session
    );

    const createSessionSpawnAwaiter = (
        pid: number,
        session: TrackedSession,
    ): Promise<SpawnSessionResult> => new Promise((resolve) => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const settle = (result: SpawnSessionResult): void => {
            if (timeout) {
                clearTimeout(timeout);
            }
            if (pidToAwaiter.get(pid)?.session === session) {
                pidToAwaiter.delete(pid);
            }
            resolve(result);
        };
        const awaiter: SessionSpawnAwaiter = {
            session,
            complete: (completedSession) => {
                logger.debug(`[DAEMON RUN] Session ${completedSession.remcliSessionId} fully spawned with webhook (tmux)`);
                settle({
                    type: 'success',
                    sessionId: completedSession.remcliSessionId!,
                });
            },
            fail: (errorMessage) => {
                settle({ type: 'error', errorMessage });
            },
        };
        timeout = setTimeout(() => {
            if (pidToAwaiter.get(pid)?.session !== session) {
                return;
            }
            logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${pid} (tmux)`);
            awaiter.fail(`Session webhook timeout for PID ${pid} (tmux)`);
        }, 15_000);

        pidToAwaiter.set(pid, awaiter);
    });

    const getOwnedPaneStatus = async (ownership: TmuxPaneOwnership): Promise<OwnedPaneStatus> => {
        try {
            const paneLookup = await getTmuxUtilities(ownership.sessionName).getPaneInfo(ownership.paneId);
            if (paneLookup.status === 'unknown') {
                return 'unknown';
            }
            if (paneLookup.status === 'missing') {
                return 'missing';
            }

            return paneLookup.pane.sessionName === ownership.sessionName
                && paneLookup.pane.windowId === ownership.windowId
                && paneLookup.pane.paneId === ownership.paneId
                && paneLookup.pane.panePid === ownership.panePid
                && paneLookup.pane.ownerMarker === ownership.ownerMarker
                ? 'exists'
                : 'mismatch';
        } catch (error) {
            logger.debug(`[DAEMON RUN] Failed to inspect tmux pane ${ownership.paneId}:`, error);
            return 'unknown';
        }
    };

    const releaseOwnedPane = async (ownership: TmuxPaneOwnership): Promise<boolean> => {
        const tmux = getTmuxUtilities(ownership.sessionName);
        const releaseResult = await tmux.releaseOwnedPane(ownership);
        return releaseResult === 'released' || releaseResult === 'missing';
    };

    const releaseManagedCodexRemoteTuiWindow = async (session: TrackedSession): Promise<boolean> => {
        const ownership = session.managedCodexRemoteTui;
        if (!ownership) {
            return true;
        }

        const didRelease = await releaseOwnedPane(ownership);
        if (!didRelease) {
            sessionCleanupFailureReasons.set(
                session,
                `Could not confirm cleanup of managed Codex remote TUI for session ${session.remcliSessionId ?? session.pid}.`,
            );
            logger.warn(`[DAEMON RUN] Could not confirm cleanup of managed Codex remote TUI pane ${ownership.paneId}; preserving tracking for retry.`);
            return false;
        }

        session.managedCodexRemoteTui = undefined;
        return true;
    };

    const releaseManagedCursorInteractiveTuiWindow = async (session: TrackedSession): Promise<boolean> => {
        const ownership = session.managedCursorInteractiveTui;
        if (!ownership) {
            return true;
        }

        const didRelease = await releaseOwnedPane(ownership);
        if (!didRelease) {
            sessionCleanupFailureReasons.set(
                session,
                `Could not confirm cleanup of managed Cursor interactive TUI for session ${session.remcliSessionId ?? session.pid}.`,
            );
            logger.warn(`[DAEMON RUN] Could not confirm cleanup of managed Cursor interactive TUI pane ${ownership.paneId}; preserving tracking for retry.`);
            return false;
        }

        session.managedCursorInteractiveTui = undefined;
        return true;
    };

    const releaseDaemonTmuxRunner = async (session: TrackedSession): Promise<boolean> => {
        if (session.startedBy !== 'daemon') {
            return true;
        }

        const ownership = session.tmuxRunner;
        if (!ownership) {
            sessionCleanupFailureReasons.set(
                session,
                `Cannot safely clean up daemon tmux runner ${session.remcliSessionId ?? session.pid}: immutable pane ownership is missing.`,
            );
            logger.warn(`[DAEMON RUN] Could not confirm cleanup of daemon session ${session.remcliSessionId ?? session.pid}: immutable tmux runner ownership is missing.`);
            return false;
        }

        const releaseResult = await getTmuxUtilities(ownership.sessionName).releaseOwnedPane(ownership);
        if (releaseResult === 'released' || releaseResult === 'missing') {
            return true;
        }

        if (
            releaseResult === 'unknown'
            && isGracefullyStoppingDaemonRunner(session)
            && await getTmuxUtilities(ownership.sessionName).getSessionStatus(ownership.sessionName) === 'missing'
        ) {
            // The pane lookup was inconclusive, but tmux confirmed the uniquely
            // daemon-created session itself no longer exists, so nothing can be released.
            return true;
        }

        const reason = releaseResult === 'mismatch'
            ? 'ownership no longer matches the original runner'
            : 'immutable pane target is unknown';
        sessionCleanupFailureReasons.set(
            session,
            `Cannot safely clean up daemon tmux runner ${ownership.sessionName}: ${reason}.`,
        );
        logger.warn(`[DAEMON RUN] Could not confirm cleanup of daemon session ${session.remcliSessionId ?? session.pid}: ${reason}.`);
        return false;
    };

    const releaseOrphanedCodexRemoteTuiPane = async (sessionId: string): Promise<boolean> => {
        const ownership = orphanedCodexRemoteTuiPanes.get(sessionId);
        if (!ownership) {
            return true;
        }

        if (!await releaseOwnedPane(ownership)) {
            logger.warn(`[DAEMON RUN] Could not confirm cleanup of orphaned Codex remote TUI pane ${ownership.paneId}; preserving ownership for retry.`);
            return false;
        }

        orphanedCodexRemoteTuiPanes.delete(sessionId);
        return true;
    };

    const releaseOrphanedCursorInteractiveTuiPane = async (sessionId: string): Promise<boolean> => {
        const ownership = orphanedCursorInteractiveTuiPanes.get(sessionId);
        if (!ownership) {
            return true;
        }

        if (!await releaseOwnedPane(ownership)) {
            logger.warn(`[DAEMON RUN] Could not confirm cleanup of orphaned Cursor interactive TUI pane ${ownership.paneId}; preserving ownership for retry.`);
            return false;
        }

        orphanedCursorInteractiveTuiPanes.delete(sessionId);
        return true;
    };

    const retireTrackedSession = (
        pid: number,
        expectedSession: TrackedSession,
        shouldPublishStopped = true,
    ): void => {
        clearTrackedSessionRuntimeState(pid, expectedSession);

        if (pidToTrackedSession.get(pid) === expectedSession) {
            pidToTrackedSession.delete(pid);
        }
        displacedTrackedSessionPids.delete(expectedSession);
        daemonRunnerStoppingFences.get(expectedSession)?.complete();
        daemonRunnerStoppingFences.delete(expectedSession);

        retireDaemonTmuxRunner(expectedSession);

        if (shouldPublishStopped) {
            publishSessionStopped(expectedSession);
        }
    };

    const waitForCodexRemoteTuiOpening = async (sessionId: string): Promise<boolean> => {
        const opening = codexRemoteTuiOpenPromises.get(sessionId);
        if (!opening) {
            return true;
        }

        try {
            await opening;
            return true;
        } catch (error) {
            logger.warn(`[DAEMON RUN] Codex remote TUI opening failed while stopping ${sessionId}:`, error);
            return false;
        }
    };

    const waitForCursorInteractiveTuiOpening = async (sessionId: string): Promise<boolean> => {
        const openings = Array.from(cursorInteractiveTuiOpenPromises.values())
            .filter((opening) => opening.remcliSessionId === sessionId)
            .map((opening) => opening.promise);
        if (openings.length === 0) {
            return true;
        }

        try {
            await Promise.all(openings);
            return true;
        } catch (error) {
            logger.warn(`[DAEMON RUN] Cursor interactive TUI opening failed while stopping ${sessionId}:`, error);
            return false;
        }
    };

    const releaseAndRemoveTrackedSession = async (
        pid: number,
        trackedSession: TrackedSession,
        shouldAwaitRemoteTuiOpening = true,
        shouldPublishStopped = true,
        allowGracefulDaemonRunnerCleanup = false,
    ): Promise<boolean> => {
        if (isGracefullyStoppingDaemonRunner(trackedSession) && !allowGracefulDaemonRunnerCleanup) {
            return false;
        }
        const inFlightCleanup = sessionCleanupPromises.get(trackedSession);
        if (inFlightCleanup) {
            return inFlightCleanup;
        }

        sessionCleanupFailureReasons.delete(trackedSession);
        const cleanupPromise = (async (): Promise<boolean> => {
            if (!isTrackedSessionIdentity(pid, trackedSession)) {
                return true;
            }
            if (
                shouldAwaitRemoteTuiOpening
                && trackedSession.remcliSessionId
                && !await waitForCodexRemoteTuiOpening(trackedSession.remcliSessionId)
            ) {
                sessionCleanupFailureReasons.set(
                    trackedSession,
                    `Could not wait for managed Codex remote TUI cleanup for session ${trackedSession.remcliSessionId}.`,
                );
                return false;
            }
            if (
                shouldAwaitRemoteTuiOpening
                && trackedSession.remcliSessionId
                && !await waitForCursorInteractiveTuiOpening(trackedSession.remcliSessionId)
            ) {
                sessionCleanupFailureReasons.set(
                    trackedSession,
                    `Could not wait for managed Cursor interactive TUI cleanup for session ${trackedSession.remcliSessionId}.`,
                );
                return false;
            }
            if (!await releaseManagedCodexRemoteTuiWindow(trackedSession)) {
                return false;
            }
            if (!await releaseManagedCursorInteractiveTuiWindow(trackedSession)) {
                return false;
            }
            if (!await releaseDaemonTmuxRunner(trackedSession)) {
                return false;
            }
            retireTrackedSession(
                pid,
                trackedSession,
                shouldPublishStopped && (!isShuttingDown || trackedSession.startedBy === 'daemon'),
            );
            return true;
        })();
        sessionCleanupPromises.set(trackedSession, cleanupPromise);
        void cleanupPromise.then(
            (didRemove) => {
                if (sessionCleanupPromises.get(trackedSession) === cleanupPromise) {
                    sessionCleanupPromises.delete(trackedSession);
                }
                if (didRemove) {
                    sessionCleanupFailureReasons.delete(trackedSession);
                }
            },
            () => {
                if (sessionCleanupPromises.get(trackedSession) === cleanupPromise) {
                    sessionCleanupPromises.delete(trackedSession);
                }
            },
        );
        return cleanupPromise;
    };

    const scheduleDisplacedTrackedSessionCleanup = (pid: number, session: TrackedSession): void => {
        void releaseAndRemoveTrackedSession(pid, session).then(
            (didRemove) => {
                if (!didRemove) {
                    logger.warn(`[DAEMON RUN] Keeping displaced session ${session.remcliSessionId ?? pid} tracked because immutable cleanup was not confirmed.`);
                }
            },
            (error) => {
                logger.warn(`[DAEMON RUN] Failed to clean up displaced session ${session.remcliSessionId ?? pid}:`, error);
            },
        );
    };

    const isProcessAlive = (pid: number): boolean => {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return (error as NodeJS.ErrnoException).code === 'EPERM';
        }
    };

    const getDaemonTmuxRunnerStatus = async (
        session: TrackedSession
    ): Promise<TrackedSessionStatus> => {
        if (!session.tmuxRunner) {
            return 'unknown';
        }

        const paneStatus = await getOwnedPaneStatus(session.tmuxRunner);
        return paneStatus;
    };

    const getTrackedSessionStatus = async (
        pid: number,
        session: TrackedSession
    ): Promise<TrackedSessionStatus> => {
        if (session.startedBy !== 'daemon') {
            return isProcessAlive(pid) ? 'exists' : 'missing';
        }

        return getDaemonTmuxRunnerStatus(session);
    };

    const cleanupDaemonTmuxRunner = async (runner: DaemonTmuxRunner): Promise<void> => {
        const tmux = getTmuxUtilities(runner.ownership.sessionName);
        const releaseResult = await tmux.releaseOwnedPane(runner.ownership);
        if (releaseResult === 'released' || releaseResult === 'missing') {
            return;
        }
        const reason = releaseResult === 'mismatch'
            ? 'ownership no longer matches the original runner'
            : 'immutable pane target is unknown';
        throw new Error(`Cannot safely clean up daemon tmux runner ${runner.ownership.sessionName}: ${reason}.`);
    };

    const getTrackedAgent = (session: TrackedSession): 'claude' | 'codex' | 'cursor' | 'gemini' | undefined => {
        const reportedAgent = session.remcliSessionMetadataFromLocalWebhook?.flavor;
        if (reportedAgent === 'claude' || reportedAgent === 'codex' || reportedAgent === 'cursor' || reportedAgent === 'gemini') {
            return reportedAgent;
        }
        return session.expectedAgent;
    };

    const getTrackedSessionDirectory = (session: TrackedSession): string | undefined => (
        session.remcliSessionMetadataFromLocalWebhook?.path ?? session.expectedDirectory
    );

    const recordCursorSessionLineage = (nativeSessionId: string, session: TrackedSession): void => {
        if (session.startedBy !== 'daemon' || !session.remcliSessionId) {
            return;
        }

        const directory = getTrackedSessionDirectory(session);
        if (!directory) {
            return;
        }

        cursorSessionLineageByNativeSessionId.set(nativeSessionId, {
            parentRemcliSessionId: session.remcliSessionId,
            directory,
        });
    };

    const toNativeCodexThreadWrapper = (remcliSessionId: string, nativeThreadId: string): NativeCodexThreadWrapper => ({
        agent: 'codex',
        nativeThreadId,
        remcliSessionId,
    });

    const toNativeCursorSessionWrapper = (
        remcliSessionId: string,
        nativeSessionId: string,
    ): NativeCursorSessionWrapper => ({
        agent: 'cursor',
        nativeSessionId,
        remcliSessionId,
    });

    const agentOf = (options: Pick<SpawnSessionOptions, 'agent'>): 'claude' | 'codex' | 'cursor' | 'gemini' => (
        options.agent === 'gemini' ? 'gemini'
            : options.agent === 'cursor' ? 'cursor'
                : options.agent === 'codex' ? 'codex'
                    : 'claude'
    );

    const getNativeSessionId = (metadata: Metadata | undefined, agent: 'claude' | 'codex' | 'cursor' | 'gemini'): string | undefined => {
        if (!metadata) return undefined;
        if (agent === 'codex') return undefined;
        switch (agent) {
            case 'cursor':
                return metadata.cursorSessionId ?? metadata.agentSessionId;
            case 'gemini':
                return metadata.geminiSessionId ?? metadata.agentSessionId;
            case 'claude':
                return metadata.claudeSessionId ?? metadata.agentSessionId;
        }
    };

    const resumeKeyOf = (agent: 'claude' | 'codex' | 'cursor' | 'gemini', resumeSessionId: string | undefined): string | null => (
        resumeSessionId ? `${agent}:${resumeSessionId}` : null
    );

    const findTrackedCodexResume = async (nativeThreadId: string): Promise<{
        session: TrackedSession;
        status: 'exists' | 'unknown';
    } | null> => {
        for (const [pid, session] of getTrackedSessionEntries()) {
            if (session.expectedAgent !== 'codex' || session.expectedResumeSessionId !== nativeThreadId) {
                continue;
            }

            if (!isReadyTrackedSession(pid, session)) {
                return { session, status: 'unknown' };
            }
            const status = await getTrackedSessionStatus(pid, session);
            if (!isReadyTrackedSession(pid, session)) {
                return { session, status: 'unknown' };
            }
            if (status === 'missing') {
                if (!await releaseAndRemoveTrackedSession(pid, session)) {
                    return { session, status: 'unknown' };
                }
                continue;
            }
            return { session, status: status === 'exists' ? 'exists' : 'unknown' };
        }
        return null;
    };

    const resolveCodexThreadResume = async (nativeThreadId: string): Promise<CodexThreadResumeResult> => {
        const mapping = nativeCodexThreadIdToTrackedSession.get(nativeThreadId);
        if (mapping) {
            const { pid, session } = mapping;
            if (
                !isTrackedSessionIdentity(pid, session)
                || session.nativeCodexThreadId !== nativeThreadId
            ) {
                // A PID can be reused after the original Codex wrapper exits.
                // The native map is valid only for the captured session object,
                // never for a later session sharing its PID.
                if (nativeCodexThreadIdToTrackedSession.get(nativeThreadId) === mapping) {
                    nativeCodexThreadIdToTrackedSession.delete(nativeThreadId);
                }
            } else if (!isReadyTrackedSession(pid, session)) {
                return { type: 'wrapper-starting', nativeThreadId };
            } else {
                const status = await getTrackedSessionStatus(pid, session);
                if (!isReadyTrackedSession(pid, session)) {
                    return { type: 'wrapper-starting', nativeThreadId };
                }
                if (status === 'missing') {
                    if (!await releaseAndRemoveTrackedSession(pid, session)) {
                        return { type: 'wrapper-starting', nativeThreadId };
                    }
                } else if (status === 'exists' && session.remcliSessionId) {
                    return {
                        type: 'reuse-active-wrapper',
                        wrapper: toNativeCodexThreadWrapper(session.remcliSessionId, nativeThreadId),
                    };
                } else {
                    return { type: 'wrapper-starting', nativeThreadId };
                }
            }
        }

        const pendingSession = await findTrackedCodexResume(nativeThreadId);
        if (pendingSession) {
            return { type: 'wrapper-starting', nativeThreadId };
        }

        return { type: 'spawn-new-wrapper', nativeThreadId };
    };

    const bindNativeCodexThread = async (
        binding: NativeCodexThreadBinding
    ): Promise<NativeCodexThreadBindingResult> => {
        const existingMapping = nativeCodexThreadIdToTrackedSession.get(binding.nativeThreadId);
        if (existingMapping) {
            const { pid: existingPid, session: existingSession } = existingMapping;
            if (
                !isTrackedSessionIdentity(existingPid, existingSession)
                || existingSession.nativeCodexThreadId !== binding.nativeThreadId
            ) {
                if (nativeCodexThreadIdToTrackedSession.get(binding.nativeThreadId) === existingMapping) {
                    nativeCodexThreadIdToTrackedSession.delete(binding.nativeThreadId);
                }
            } else if (!isReadyTrackedSession(existingPid, existingSession)) {
                return { type: 'wrapper-not-tracked', binding };
            } else {
                const status = await getTrackedSessionStatus(existingPid, existingSession);
                if (!isReadyTrackedSession(existingPid, existingSession)) {
                    return { type: 'wrapper-not-tracked', binding };
                }
                if (status === 'missing') {
                    await releaseAndRemoveTrackedSession(existingPid, existingSession);
                    return { type: 'wrapper-not-tracked', binding };
                } else if (status !== 'exists') {
                    return { type: 'wrapper-not-tracked', binding };
                } else if (!existingSession.remcliSessionId) {
                    return { type: 'wrapper-not-tracked', binding };
                } else if (existingSession.remcliSessionId === binding.remcliSessionId) {
                    return {
                        type: 'already-bound',
                        wrapper: toNativeCodexThreadWrapper(binding.remcliSessionId, binding.nativeThreadId),
                    };
                } else {
                    return {
                        type: 'reuse-active-wrapper',
                        wrapper: toNativeCodexThreadWrapper(existingSession.remcliSessionId, binding.nativeThreadId),
                    };
                }
            }
        }

        let trackedSession: TrackedSession | undefined;
        let trackedPid: number | undefined;
        for (const [pid, session] of pidToTrackedSession.entries()) {
            if (session.remcliSessionId !== binding.remcliSessionId) {
                continue;
            }

            if (!isReadyTrackedSession(pid, session)) {
                return { type: 'wrapper-not-tracked', binding };
            }
            const status = await getTrackedSessionStatus(pid, session);
            if (!isReadyTrackedSession(pid, session)) {
                return { type: 'wrapper-not-tracked', binding };
            }
            if (status === 'missing') {
                await releaseAndRemoveTrackedSession(pid, session);
                break;
            }
            if (status !== 'exists') {
                return { type: 'wrapper-not-tracked', binding };
            }
            trackedSession = session;
            trackedPid = pid;
            break;
        }

        if (!trackedSession || trackedPid === undefined) {
            return { type: 'wrapper-not-tracked', binding };
        }

        const trackedAgent = getTrackedAgent(trackedSession);
        if (trackedAgent && trackedAgent !== 'codex') {
            return { type: 'agent-mismatch', binding, trackedAgent };
        }

        if (trackedSession.nativeCodexThreadId && trackedSession.nativeCodexThreadId !== binding.nativeThreadId) {
            const previousMapping = nativeCodexThreadIdToTrackedSession.get(trackedSession.nativeCodexThreadId);
            if (previousMapping?.pid === trackedPid && previousMapping.session === trackedSession) {
                nativeCodexThreadIdToTrackedSession.delete(trackedSession.nativeCodexThreadId);
            }
        }
        trackedSession.nativeCodexThreadId = binding.nativeThreadId;
        nativeCodexThreadIdToTrackedSession.set(binding.nativeThreadId, {
            pid: trackedPid,
            session: trackedSession,
        });

        return {
            type: 'bound',
            wrapper: toNativeCodexThreadWrapper(binding.remcliSessionId, binding.nativeThreadId),
        };
    };

    const bindNativeCursorSessionInternal = async (
        binding: NativeCursorSessionBinding,
    ): Promise<NativeCursorSessionBindingResult> => {
        const existingMapping = nativeCursorSessionIdToTrackedSession.get(binding.nativeSessionId);
        if (existingMapping) {
            const { pid: existingPid, session: existingSession } = existingMapping;
            if (
                !isTrackedSessionIdentity(existingPid, existingSession)
                || existingSession.nativeCursorSessionId !== binding.nativeSessionId
            ) {
                // A PID can be reused after the original Cursor wrapper exits.
                // The mapping proves only the captured session object, never a
                // later session that happens to have the same PID.
                nativeCursorSessionIdToTrackedSession.delete(binding.nativeSessionId);
            } else {
                if (!isReadyTrackedSession(existingPid, existingSession)) {
                    return { type: 'wrapper-not-tracked', binding };
                }
                const status = await getTrackedSessionStatus(existingPid, existingSession);
                if (!isReadyTrackedSession(existingPid, existingSession)) {
                    return { type: 'wrapper-not-tracked', binding };
                }
                if (status === 'missing') {
                    await releaseAndRemoveTrackedSession(existingPid, existingSession);
                    return { type: 'wrapper-not-tracked', binding };
                }
                if (status !== 'exists' || !existingSession.remcliSessionId) {
                    return { type: 'wrapper-not-tracked', binding };
                }
                if (existingSession.remcliSessionId === binding.remcliSessionId) {
                    recordCursorSessionLineage(binding.nativeSessionId, existingSession);
                    return {
                        type: 'already-bound',
                        wrapper: toNativeCursorSessionWrapper(binding.remcliSessionId, binding.nativeSessionId),
                    };
                }
                return {
                    type: 'reuse-active-wrapper',
                    wrapper: toNativeCursorSessionWrapper(existingSession.remcliSessionId, binding.nativeSessionId),
                };
            }
        }

        let trackedSession: TrackedSession | undefined;
        let trackedPid: number | undefined;
        for (const [pid, session] of pidToTrackedSession.entries()) {
            if (session.remcliSessionId !== binding.remcliSessionId) {
                continue;
            }
            if (!isReadyTrackedSession(pid, session)) {
                return { type: 'wrapper-not-tracked', binding };
            }
            const status = await getTrackedSessionStatus(pid, session);
            if (!isReadyTrackedSession(pid, session)) {
                return { type: 'wrapper-not-tracked', binding };
            }
            if (status === 'missing') {
                await releaseAndRemoveTrackedSession(pid, session);
                break;
            }
            if (status !== 'exists') {
                return { type: 'wrapper-not-tracked', binding };
            }
            trackedSession = session;
            trackedPid = pid;
            break;
        }

        if (!trackedSession || trackedPid === undefined) {
            return { type: 'wrapper-not-tracked', binding };
        }

        const trackedAgent = getTrackedAgent(trackedSession);
        if (trackedAgent && trackedAgent !== 'cursor') {
            return { type: 'agent-mismatch', binding, trackedAgent };
        }

        if (
            trackedSession.nativeCursorSessionId
            && trackedSession.nativeCursorSessionId !== binding.nativeSessionId
            && nativeCursorSessionIdToTrackedSession.get(trackedSession.nativeCursorSessionId)?.pid === trackedPid
            && nativeCursorSessionIdToTrackedSession.get(trackedSession.nativeCursorSessionId)?.session === trackedSession
        ) {
            nativeCursorSessionIdToTrackedSession.delete(trackedSession.nativeCursorSessionId);
        }
        trackedSession.nativeCursorSessionId = binding.nativeSessionId;
        nativeCursorSessionIdToTrackedSession.set(binding.nativeSessionId, {
            pid: trackedPid,
            session: trackedSession,
        });
        recordCursorSessionLineage(binding.nativeSessionId, trackedSession);

        return {
            type: 'bound',
            wrapper: toNativeCursorSessionWrapper(binding.remcliSessionId, binding.nativeSessionId),
        };
    };

    const bindNativeCursorSession = async (
        binding: NativeCursorSessionBinding,
    ): Promise<NativeCursorSessionBindingResult> => {
        const inFlightBinding = nativeCursorSessionBindingPromises.get(binding.nativeSessionId);
        if (inFlightBinding) {
            await inFlightBinding;
            return bindNativeCursorSession(binding);
        }

        const bindingPromise = bindNativeCursorSessionInternal(binding);
        nativeCursorSessionBindingPromises.set(binding.nativeSessionId, bindingPromise);
        try {
            return await bindingPromise;
        } finally {
            if (nativeCursorSessionBindingPromises.get(binding.nativeSessionId) === bindingPromise) {
                nativeCursorSessionBindingPromises.delete(binding.nativeSessionId);
            }
        }
    };

    const findBoundNativeCursorSession = async (
        nativeSessionId: string,
    ): Promise<BoundNativeCursorSessionLookup> => {
        const inFlightBinding = nativeCursorSessionBindingPromises.get(nativeSessionId);
        if (inFlightBinding) {
            await inFlightBinding;
        }

        const mapping = nativeCursorSessionIdToTrackedSession.get(nativeSessionId);
        if (!mapping) {
            return { type: 'not-found' };
        }
        const { pid, session } = mapping;
        if (
            !isTrackedSessionIdentity(pid, session)
            || session.nativeCursorSessionId !== nativeSessionId
        ) {
            nativeCursorSessionIdToTrackedSession.delete(nativeSessionId);
            return { type: 'not-found' };
        }
        if (!isReadyTrackedSession(pid, session)) {
            return { type: 'unavailable' };
        }

        const status = await getTrackedSessionStatus(pid, session);
        if (!isReadyTrackedSession(pid, session)) {
            return { type: 'unavailable' };
        }
        if (status === 'missing') {
            return await releaseAndRemoveTrackedSession(pid, session)
                ? { type: 'not-found' }
                : { type: 'unavailable' };
        }
        if (status !== 'exists') {
            return { type: 'unavailable' };
        }

        return { type: 'found', session };
    };

    const findTrackedCursorResumeSession = async (
        resumeSessionId: string,
    ): Promise<BoundNativeCursorSessionLookup> => {
        for (const [pid, session] of pidToTrackedSession.entries()) {
            const reportedNativeSessionId = getNativeSessionId(
                session.remcliSessionMetadataFromLocalWebhook,
                'cursor',
            );
            if (
                getTrackedAgent(session) !== 'cursor'
                || (reportedNativeSessionId ?? session.expectedResumeSessionId) !== resumeSessionId
            ) {
                continue;
            }

            if (
                !isReadyTrackedSession(pid, session)
                || session.startedBy !== 'daemon'
                || !session.tmuxRunner
                || !session.remcliSessionId
                || (
                    session.nativeCursorSessionId
                    && session.nativeCursorSessionId !== resumeSessionId
                )
            ) {
                return { type: 'unavailable' };
            }

            // Cursor can report its wrapper before native system/init and before
            // the native binding map is populated. That pre-init resume can only
            // reuse the wrapper after the immutable daemon-owned pane has been
            // checked, never from PID liveness.
            const status = await getDaemonTmuxRunnerStatus(session);
            if (!isReadyTrackedSession(pid, session) || status !== 'exists') {
                return { type: 'unavailable' };
            }

            return { type: 'found', session };
        }

        return { type: 'not-found' };
    };

    const findDaemonOwnedTrackedSession = (sessionId: string): { pid: number; session: TrackedSession } | null => {
        for (const [pid, session] of pidToTrackedSession.entries()) {
            if (
                session.remcliSessionId === sessionId
                && isCurrentTrackedSession(pid, session)
                && session.startedBy === 'daemon'
                && session.tmuxRunner
            ) {
                return { pid, session };
            }
        }
        return null;
    };

    const markDaemonRunnerStopping = (sessionId: string): DaemonRunnerLifecycleResult => {
        const tracked = findDaemonOwnedTrackedSession(sessionId);
        if (!tracked) {
            return { accepted: false };
        }

        if (!daemonRunnerStoppingFences.has(tracked.session)) {
            daemonRunnerStoppingFences.set(tracked.session, createDaemonRunnerStoppingFence());
        }
        return { accepted: true };
    };

    const completeDaemonRunnerStopping = async (sessionId: string): Promise<DaemonRunnerLifecycleResult> => {
        const tracked = findDaemonOwnedTrackedSession(sessionId);
        if (!tracked) {
            return { accepted: false };
        }

        if (!daemonRunnerStoppingFences.has(tracked.session)) {
            daemonRunnerStoppingFences.set(tracked.session, createDaemonRunnerStoppingFence());
        }
        return {
            accepted: await releaseAndRemoveTrackedSession(tracked.pid, tracked.session, true, true, true),
        };
    };

    const preflightCursorRunner = async (
        request: CursorRunnerPreflightRequest,
    ): Promise<CursorRunnerPreflightResult> => {
        if (request.agent !== 'cursor' && request.agent !== 'codex') {
            return { type: 'rejected' };
        }

        const session = pidToTrackedSession.get(request.pid);
        if (
            !session
            || !isReadyTrackedSession(request.pid, session)
            || session.startedBy !== 'daemon'
            || !session.tmuxRunner
            || session.expectedAgent !== request.agent
            || session.expectedResumeSessionId !== request.nativeResumeSessionId
            || !hasMatchingRunnerControlToken(session.runnerControlToken, request.runnerToken)
        ) {
            return { type: 'rejected' };
        }

        const status = await getDaemonTmuxRunnerStatus(session);
        if (!isReadyTrackedSession(request.pid, session) || status !== 'exists') {
            return { type: 'rejected' };
        }

        const lineage = request.agent === 'cursor' ? session.cursorResumeLineage : undefined;
        if (
            !request.nativeResumeSessionId
            || !lineage
            || lineage.nativeResumeSessionId !== request.nativeResumeSessionId
        ) {
            return { type: 'verified' };
        }

        return {
            type: 'verified',
            parentRemcliSessionId: lineage.parentRemcliSessionId,
        };
    };

    const ensureCodexRemoteTuiHostInternal = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
        const tmux = getTmuxUtilities(codexRemoteTuiHostSessionName);
        if (codexRemoteTuiHostAnchor) {
            const hostStatus = await getOwnedPaneStatus(codexRemoteTuiHostAnchor);
            if (hostStatus === 'missing') {
                codexRemoteTuiHostAnchor = undefined;
                hasOpenedCodexRemoteTuiHostTerminal = false;
            } else if (hostStatus !== 'exists') {
                return { ok: false, error: 'Could not confirm the immutable Codex TUI tmux host ownership.' };
            }
        }

        if (!codexRemoteTuiHostAnchor) {
            hasOpenedCodexRemoteTuiHostTerminal = false;
            const createdHost = await tmux.createSessionWithPane(
                codexRemoteTuiHostSessionName,
                codexRemoteTuiHostWindowName,
                codexRemoteTuiHostOwnerMarker,
            );
            if (!createdHost.success) {
                return {
                    ok: false,
                    error: createdHost.error,
                };
            }
            codexRemoteTuiHostAnchor = createdHost.ownership;
        }

        const hostAnchor = codexRemoteTuiHostAnchor;
        if (!hostAnchor || await getOwnedPaneStatus(hostAnchor) !== 'exists') {
            return { ok: false, error: 'Could not confirm the immutable Codex TUI tmux host ownership.' };
        }

        if (!hasOpenedCodexRemoteTuiHostTerminal) {
            const terminalContext = await openTerminalWithCommand(
                `env -u TMUX tmux attach -t ${hostAnchor.paneId}`,
            );
            if (!terminalContext) {
                return { ok: false, error: 'Could not open the Codex TUI terminal host.' };
            }
            hasOpenedCodexRemoteTuiHostTerminal = true;
        }

        return { ok: true };
    };

    const ensureCodexRemoteTuiHost = (): Promise<{ ok: true } | { ok: false; error: string }> => {
        if (codexRemoteTuiHostPromise) {
            return codexRemoteTuiHostPromise;
        }

        const hostPromise = ensureCodexRemoteTuiHostInternal();
        codexRemoteTuiHostPromise = hostPromise;
        void hostPromise.then(
            () => {
                if (codexRemoteTuiHostPromise === hostPromise) {
                    codexRemoteTuiHostPromise = null;
                }
            },
            () => {
                if (codexRemoteTuiHostPromise === hostPromise) {
                    codexRemoteTuiHostPromise = null;
                }
            },
        );
        return hostPromise;
    };

    const ensureCursorInteractiveTuiHostInternal = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
        const tmux = getTmuxUtilities(cursorInteractiveTuiHostSessionName);
        if (cursorInteractiveTuiHostAnchor) {
            const hostStatus = await getOwnedPaneStatus(cursorInteractiveTuiHostAnchor);
            if (hostStatus === 'missing') {
                cursorInteractiveTuiHostAnchor = undefined;
                hasOpenedCursorInteractiveTuiHostTerminal = false;
            } else if (hostStatus !== 'exists') {
                return { ok: false, error: 'Could not confirm the immutable Cursor TUI tmux host ownership.' };
            }
        }

        if (!cursorInteractiveTuiHostAnchor) {
            hasOpenedCursorInteractiveTuiHostTerminal = false;
            const createdHost = await tmux.createSessionWithPane(
                cursorInteractiveTuiHostSessionName,
                cursorInteractiveTuiHostWindowName,
                cursorInteractiveTuiHostOwnerMarker,
            );
            if (!createdHost.success) {
                return { ok: false, error: createdHost.error };
            }
            cursorInteractiveTuiHostAnchor = createdHost.ownership;
        }

        const hostAnchor = cursorInteractiveTuiHostAnchor;
        if (!hostAnchor || await getOwnedPaneStatus(hostAnchor) !== 'exists') {
            return { ok: false, error: 'Could not confirm the immutable Cursor TUI tmux host ownership.' };
        }

        if (!hasOpenedCursorInteractiveTuiHostTerminal) {
            const terminalContext = await openTerminalWithCommand(
                `env -u TMUX tmux attach -t ${hostAnchor.paneId}`,
            );
            if (!terminalContext) {
                return { ok: false, error: 'Could not open the Cursor TUI terminal host.' };
            }
            hasOpenedCursorInteractiveTuiHostTerminal = true;
        }

        return { ok: true };
    };

    const ensureCursorInteractiveTuiHost = (): Promise<{ ok: true } | { ok: false; error: string }> => {
        if (cursorInteractiveTuiHostPromise) {
            return cursorInteractiveTuiHostPromise;
        }

        const hostPromise = ensureCursorInteractiveTuiHostInternal();
        cursorInteractiveTuiHostPromise = hostPromise;
        void hostPromise.then(
            () => {
                if (cursorInteractiveTuiHostPromise === hostPromise) {
                    cursorInteractiveTuiHostPromise = null;
                }
            },
            () => {
                if (cursorInteractiveTuiHostPromise === hostPromise) {
                    cursorInteractiveTuiHostPromise = null;
                }
            },
        );
        return hostPromise;
    };

    async function getManagedTuiWindowStatus(
        ownership: TmuxPaneOwnership
    ): Promise<'exists' | 'missing' | 'unknown'> {
        const paneStatus = await getOwnedPaneStatus(ownership);
        return paneStatus === 'exists'
            ? 'exists'
            : paneStatus === 'missing'
                ? 'missing'
                : 'unknown';
    }

    const openCodexRemoteTuiInternal = async (
        request: CodexRemoteTuiOpenRequest
    ): Promise<CodexRemoteTuiOpenResult> => {
        let trackedSession: TrackedSession | undefined;
        let trackedPid: number | undefined;
        for (const [pid, session] of pidToTrackedSession.entries()) {
            if (session.remcliSessionId !== request.remcliSessionId) {
                continue;
            }
            const status = await getTrackedSessionStatus(pid, session);
            if (status === 'missing') {
                await releaseAndRemoveTrackedSession(pid, session, false);
                break;
            }
            if (status !== 'exists') {
                return { type: 'wrapper-not-tracked', request };
            }
            trackedSession = session;
            trackedPid = pid;
            break;
        }

        if (!trackedSession || trackedPid === undefined) {
            return { type: 'wrapper-not-tracked', request };
        }

        const trackedAgent = getTrackedAgent(trackedSession);
        if (trackedAgent && trackedAgent !== 'codex') {
            return { type: 'agent-mismatch', request, trackedAgent };
        }
        if (trackedSession.startedBy !== 'daemon') {
            return { type: 'wrapper-not-daemon-owned', request };
        }
        if (isStoppingSession(trackedSession)) {
            return { type: 'wrapper-not-tracked', request };
        }
        if (trackedSession.nativeCodexThreadId !== request.nativeThreadId) {
            return {
                type: 'native-thread-mismatch',
                request,
                trackedNativeThreadId: trackedSession.nativeCodexThreadId,
            };
        }
        if (!isValidCodexRemoteTuiEndpoint(request.endpoint)) {
            return { type: 'host-unavailable', request, error: 'Codex remote endpoint is invalid.' };
        }
        if (isShuttingDown) {
            return { type: 'host-unavailable', request, error: 'Daemon is shutting down.' };
        }

        const wrapper = toNativeCodexThreadWrapper(
            request.remcliSessionId,
            request.nativeThreadId,
        );
        const existingOwnership = trackedSession.managedCodexRemoteTui;
        if (existingOwnership) {
            const existingWindowStatus = await getManagedTuiWindowStatus(existingOwnership);
            if (existingWindowStatus === 'exists') {
                return { type: 'already-open', wrapper, tmuxWindowId: existingOwnership.windowId };
            }
            if (existingWindowStatus === 'unknown') {
                return {
                    type: 'host-unavailable',
                    request,
                    error: 'Could not confirm the managed Codex remote TUI tmux window state.',
                };
            }

            trackedSession.managedCodexRemoteTui = undefined;
        }

        const host = await ensureCodexRemoteTuiHost();
        if (!host.ok) {
            return { type: 'host-unavailable', request, error: host.error };
        }

        const tmux = getTmuxUtilities(codexRemoteTuiHostSessionName);
        const hostAnchor = codexRemoteTuiHostAnchor;
        if (!hostAnchor) {
            return {
                type: 'host-unavailable',
                request,
                error: 'The immutable Codex TUI tmux host is unavailable.',
            };
        }
        const tmuxResult = await tmux.spawnInOwnedTmuxSession(
            [buildCodexRemoteTuiCommand(
                request.endpoint,
                request.nativeThreadId,
                request.reasoningEffort,
                request.model,
            )],
            {
                hostOwnership: hostAnchor,
                windowName: buildCodexRemoteTuiWindowName(request.nativeThreadId),
                ownershipMarker: randomUUID(),
                cwd: trackedSession.remcliSessionMetadataFromLocalWebhook?.path ?? process.cwd(),
            },
        );
        if (!tmuxResult.success) {
            return {
                type: 'host-unavailable',
                request,
                error: tmuxResult.error,
            };
        }

        const createdOwnership: TmuxPaneOwnership = tmuxResult.ownership;

        const currentSession = pidToTrackedSession.get(trackedPid);
        if (currentSession !== trackedSession || currentSession.remcliSessionId !== request.remcliSessionId) {
            orphanedCodexRemoteTuiPanes.set(request.remcliSessionId, createdOwnership);
            logger.warn(`[DAEMON RUN] Preserved late-created Codex remote TUI pane ${createdOwnership.paneId} for retry after its wrapper was removed.`);
            return { type: 'wrapper-not-tracked', request };
        }

        trackedSession.managedCodexRemoteTui = createdOwnership;
        if (isShuttingDown || isStoppingSession(trackedSession)) {
            return { type: 'wrapper-not-tracked', request };
        }

        logger.debug(`[DAEMON RUN] Opened managed Codex remote TUI tmux window ${createdOwnership.windowId}`);
        return { type: 'opened', wrapper, tmuxWindowId: createdOwnership.windowId };
    };

    const openCodexRemoteTui = (request: CodexRemoteTuiOpenRequest): Promise<CodexRemoteTuiOpenResult> => {
        const existingPromise = codexRemoteTuiOpenPromises.get(request.remcliSessionId);
        if (existingPromise) {
            return existingPromise;
        }

        const openingPromise = openCodexRemoteTuiInternal(request);
        codexRemoteTuiOpenPromises.set(request.remcliSessionId, openingPromise);
        void openingPromise.finally(() => {
            if (codexRemoteTuiOpenPromises.get(request.remcliSessionId) === openingPromise) {
                codexRemoteTuiOpenPromises.delete(request.remcliSessionId);
            }
        });
        return openingPromise;
    };

    const openCursorInteractiveTuiInternal = async (
        request: CursorInteractiveTuiOpenRequest,
    ): Promise<CursorInteractiveTuiOpenResult> => {
        let trackedSession: TrackedSession | undefined;
        let trackedPid: number | undefined;
        for (const [pid, session] of pidToTrackedSession.entries()) {
            if (session.remcliSessionId !== request.remcliSessionId) {
                continue;
            }
            const status = await getTrackedSessionStatus(pid, session);
            if (status === 'missing') {
                await releaseAndRemoveTrackedSession(pid, session, false);
                break;
            }
            if (status !== 'exists') {
                return { type: 'wrapper-not-tracked', request };
            }
            trackedSession = session;
            trackedPid = pid;
            break;
        }

        if (!trackedSession || trackedPid === undefined) {
            return { type: 'wrapper-not-tracked', request };
        }

        const trackedAgent = getTrackedAgent(trackedSession);
        if (trackedAgent && trackedAgent !== 'cursor') {
            return { type: 'agent-mismatch', request, trackedAgent };
        }
        if (trackedSession.startedBy !== 'daemon' || isStoppingSession(trackedSession)) {
            return { type: 'wrapper-not-tracked', request };
        }
        if (trackedSession.nativeCursorSessionId !== request.nativeSessionId) {
            return {
                type: 'native-session-mismatch',
                request,
                trackedNativeSessionId: trackedSession.nativeCursorSessionId,
            };
        }
        if (isShuttingDown) {
            return { type: 'launch-unavailable', request, error: 'Daemon is shutting down.' };
        }

        const launch = cursorInteractiveTuiLaunches.get(trackedSession);
        if (
            !launch
            || !isCursorRunnerIdentity(launch.runner)
            || !isCursorLaunchControls(launch.launchControls)
            || typeof launch.model !== 'string'
            || launch.model.trim() === ''
        ) {
            return {
                type: 'launch-unavailable',
                request,
                error: 'The daemon-validated Cursor launch selection is unavailable.',
            };
        }

        const wrapper = toNativeCursorSessionWrapper(
            request.remcliSessionId,
            request.nativeSessionId,
        );
        const existingOwnership = trackedSession.managedCursorInteractiveTui;
        if (existingOwnership) {
            const existingWindowStatus = await getManagedTuiWindowStatus(existingOwnership);
            if (existingWindowStatus === 'exists') {
                return { type: 'already-open', wrapper, tmuxWindowId: existingOwnership.windowId };
            }
            if (existingWindowStatus === 'unknown') {
                return {
                    type: 'launch-unavailable',
                    request,
                    error: 'Could not confirm the managed Cursor interactive TUI tmux window state.',
                };
            }

            trackedSession.managedCursorInteractiveTui = undefined;
        }

        const host = await ensureCursorInteractiveTuiHost();
        if (!host.ok) {
            return { type: 'launch-unavailable', request, error: host.error };
        }

        const hostAnchor = cursorInteractiveTuiHostAnchor;
        if (!hostAnchor) {
            return {
                type: 'launch-unavailable',
                request,
                error: 'The immutable Cursor TUI tmux host is unavailable.',
            };
        }

        let command: string;
        try {
            command = buildCursorInteractiveTuiCommand({
                executable: launch.runner.executable,
                resumeSessionId: request.nativeSessionId,
                model: launch.model,
                launchControls: launch.launchControls,
            });
        } catch {
            return {
                type: 'launch-unavailable',
                request,
                error: 'The daemon-validated Cursor launch selection is invalid.',
            };
        }

        const tmuxResult = await getTmuxUtilities(cursorInteractiveTuiHostSessionName).spawnInOwnedTmuxSession(
            [command],
            {
                hostOwnership: hostAnchor,
                windowName: buildCursorInteractiveTuiWindowName(request.nativeSessionId),
                ownershipMarker: randomUUID(),
                cwd: trackedSession.remcliSessionMetadataFromLocalWebhook?.path
                    ?? trackedSession.expectedDirectory
                    ?? process.cwd(),
            },
        );
        if (!tmuxResult.success) {
            return { type: 'launch-unavailable', request, error: tmuxResult.error };
        }

        const createdOwnership: TmuxPaneOwnership = tmuxResult.ownership;
        const currentSession = pidToTrackedSession.get(trackedPid);
        if (currentSession !== trackedSession || currentSession.remcliSessionId !== request.remcliSessionId) {
            orphanedCursorInteractiveTuiPanes.set(request.remcliSessionId, createdOwnership);
            logger.warn(`[DAEMON RUN] Preserved late-created Cursor interactive TUI pane ${createdOwnership.paneId} for retry after its wrapper was removed.`);
            return { type: 'wrapper-not-tracked', request };
        }

        trackedSession.managedCursorInteractiveTui = createdOwnership;
        if (isShuttingDown || isStoppingSession(trackedSession)) {
            return { type: 'wrapper-not-tracked', request };
        }

        logger.debug(`[DAEMON RUN] Opened managed Cursor interactive TUI tmux window ${createdOwnership.windowId}`);
        return { type: 'opened', wrapper, tmuxWindowId: createdOwnership.windowId };
    };

    const openCursorInteractiveTui = (
        request: CursorInteractiveTuiOpenRequest,
    ): Promise<CursorInteractiveTuiOpenResult> => {
        const openingKey = buildCursorInteractiveTuiOpeningKey(request);
        const existingOpening = cursorInteractiveTuiOpenPromises.get(openingKey);
        if (existingOpening) {
            return existingOpening.promise;
        }

        const openingPromise = openCursorInteractiveTuiInternal(request);
        cursorInteractiveTuiOpenPromises.set(openingKey, {
            remcliSessionId: request.remcliSessionId,
            promise: openingPromise,
        });
        void openingPromise.then(
            () => {
                if (cursorInteractiveTuiOpenPromises.get(openingKey)?.promise === openingPromise) {
                    cursorInteractiveTuiOpenPromises.delete(openingKey);
                }
            },
            () => {
                if (cursorInteractiveTuiOpenPromises.get(openingKey)?.promise === openingPromise) {
                    cursorInteractiveTuiOpenPromises.delete(openingKey);
                }
            },
        );
        return openingPromise;
    };

    const findTrackedResumeSession = (agent: 'claude' | 'codex' | 'gemini', resumeSessionId: string): TrackedSession | null => {
        for (const [pid, session] of pidToTrackedSession.entries()) {
            const reportedAgent = session.remcliSessionMetadataFromLocalWebhook?.flavor;
            const trackedAgent = reportedAgent ?? session.expectedAgent;
            if (trackedAgent !== agent) continue;
            const reportedNativeSessionId = session.remcliSessionMetadataFromLocalWebhook
                ? getNativeSessionId(session.remcliSessionMetadataFromLocalWebhook, agent)
                : undefined;
            const trackedResumeSessionId = reportedNativeSessionId ?? session.expectedResumeSessionId;
            if (trackedResumeSessionId === resumeSessionId) {
                if (!isReadyTrackedSession(pid, session)) {
                    continue;
                }
                try {
                    process.kill(pid, 0);
                } catch {
                    void releaseAndRemoveTrackedSession(pid, session);
                    continue;
                }
                return session;
            }
        }
        return null;
    };

    // Handle webhook from remcli session reporting itself
    const onRemcliSessionWebhook = (
        sessionId: string,
        sessionMetadata: Metadata,
        runnerToken?: string,
    ): DaemonSessionWebhookResult => {
        const diagnosticSessionMetadata = { ...sessionMetadata };
        delete diagnosticSessionMetadata.resumedFromRemcliSessionId;
        logger.debugLargeJson(`[DAEMON RUN] Session reported`, diagnosticSessionMetadata);

        const pid = sessionMetadata.hostPid;
        if (!pid) {
            logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
            return { accepted: false, daemonOwned: false, error: 'missing-runner-pid' };
        }

        logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
        logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

        // Check if we already have this PID (daemon-spawned)
        const existingSession = pidToTrackedSession.get(pid);

        if (existingSession) {
            if (existingSession.startedBy === 'daemon') {
                if (!hasMatchingRunnerControlToken(existingSession.runnerControlToken, runnerToken)) {
                    logger.warn(`[DAEMON RUN] Rejected daemon session webhook for PID ${pid}: runner capability mismatch`);
                    return { accepted: false, daemonOwned: false, error: 'runner-capability-mismatch' };
                }

                const boundSessionId = existingSession.runnerControlTokenSessionId;
                if (boundSessionId && boundSessionId !== sessionId) {
                    logger.warn(`[DAEMON RUN] Rejected daemon session webhook for PID ${pid}: runner capability already bound`);
                    return { accepted: false, daemonOwned: false, error: 'runner-capability-already-bound' };
                }
                const ownerMapping = runnerSessionIdToTrackedSession.get(sessionId);
                if (
                    ownerMapping
                    && (ownerMapping.pid !== pid || ownerMapping.session !== existingSession)
                ) {
                    logger.warn(`[DAEMON RUN] Rejected daemon session webhook for PID ${pid}: Remcli session is already owned by another runner`);
                    return { accepted: false, daemonOwned: false, error: 'runner-session-already-owned' };
                }
                if (!existingSession.runnerControlToken) {
                    logger.warn(`[DAEMON RUN] Rejected daemon session webhook for PID ${pid}: runner capability is missing`);
                    return { accepted: false, daemonOwned: false, error: 'runner-capability-mismatch' };
                }
                existingSession.runnerControlTokenSessionId = sessionId;
                runnerSessionIdToTrackedSession.set(sessionId, {
                    pid,
                    session: existingSession,
                });
            } else if (runnerToken) {
                logger.warn(`[DAEMON RUN] Rejected external session webhook for PID ${pid}: unexpected runner capability`);
                return { accepted: false, daemonOwned: false, error: 'unexpected-runner-capability' };
            }

            existingSession.remcliSessionId = sessionId;
            existingSession.remcliSessionMetadataFromLocalWebhook = sessionMetadata;
            logger.debug(`[DAEMON RUN] Updated tracked session ${sessionId} with metadata`);

            // Resolve any awaiter for this PID
            if (pidToPendingCodexThreadResume.get(pid)?.session === existingSession) {
                pidToPendingCodexThreadResume.delete(pid);
            }
            const awaiter = pidToAwaiter.get(pid);
            if (awaiter?.session === existingSession) {
                awaiter.complete(existingSession);
                logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
            }
            if (existingSession.startedBy === 'daemon') {
                return {
                    accepted: true,
                    daemonOwned: true,
                    shouldIssueRunnerCredential: true,
                    runnerCredentialOwner: existingSession.runnerControlToken,
                };
            }

            return { accepted: true, daemonOwned: false };
        }

        if (runnerToken) {
            logger.warn(`[DAEMON RUN] Rejected unknown session webhook for PID ${pid}: runner capability was not issued by this daemon`);
            return { accepted: false, daemonOwned: false, error: 'unknown-runner-capability' };
        }

        const trackedSession: TrackedSession = {
            startedBy: 'remcli directly - likely by user from terminal',
            remcliSessionId: sessionId,
            remcliSessionMetadataFromLocalWebhook: sessionMetadata,
            pid,
        };
        replaceTrackedSession(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
        return { accepted: true, daemonOwned: false };
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSessionWithoutResumeDedup = async (
        options: SpawnSessionOptions,
        pendingSpawnTask?: PendingSpawnTask,
        cursorSessionLineage?: CursorSessionLineage,
    ): Promise<SpawnSessionResult> => {
        logger.debugLargeJson('[DAEMON RUN] Spawning session', buildSafeSpawnSessionLogPayload(options));
        let cancelledTmuxCleanupError: Error | undefined;

        const getCancellationResult = (): SpawnSessionResult | undefined => (
            pendingSpawnTask?.getCancellationResult()
        );
        const initialCancellationResult = getCancellationResult();
        if (initialCancellationResult) {
            return initialCancellationResult;
        }

        const { directory, approvedNewDirectoryCreation = true } = options;
        let directoryCreated = false;

        try {
            await fs.access(directory);
            const cancellationResult = getCancellationResult();
            if (cancellationResult) {
                return cancellationResult;
            }
            logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
        } catch (error) {
            const cancellationResult = getCancellationResult();
            if (cancellationResult) {
                return cancellationResult;
            }
            logger.debug(`[DAEMON RUN] Directory doesn't exist, creating: ${directory}`);

            // Check if directory creation is approved
            if (!approvedNewDirectoryCreation) {
                logger.debug(`[DAEMON RUN] Directory creation not approved for: ${directory}`);
                return {
                    type: 'requestToApproveDirectoryCreation',
                    directory
                };
            }

            try {
                await fs.mkdir(directory, { recursive: true });
                const cancellationResult = getCancellationResult();
                if (cancellationResult) {
                    return cancellationResult;
                }
                logger.debug(`[DAEMON RUN] Successfully created directory: ${directory}`);
                directoryCreated = true;
            } catch (mkdirError: any) {
                let errorMessage = `Unable to create directory at '${directory}'. `;

                // Provide more helpful error messages based on the error code
                if (mkdirError.code === 'EACCES') {
                    errorMessage += `Permission denied. You don't have write access to create a folder at this location. Try using a different path or check your permissions.`;
                } else if (mkdirError.code === 'ENOTDIR') {
                    errorMessage += `A file already exists at this path or in the parent path. Cannot create a directory here. Please choose a different location.`;
                } else if (mkdirError.code === 'ENOSPC') {
                    errorMessage += `No space left on device. Your disk is full. Please free up some space and try again.`;
                } else if (mkdirError.code === 'EROFS') {
                    errorMessage += `The file system is read-only. Cannot create directories here. Please choose a writable location.`;
                } else {
                    errorMessage += `System error: ${mkdirError.message || mkdirError}. Please verify the path is valid and you have the necessary permissions.`;
                }

                logger.debug(`[DAEMON RUN] Directory creation failed: ${errorMessage}`);
                return {
                    type: 'error',
                    errorMessage
                };
            }
        }

        try {
            const cancellationResult = getCancellationResult();
            if (cancellationResult) {
                return cancellationResult;
            }

            // Build environment variables with explicit precedence layers:
            // Layer 1 (base): Authentication tokens - protected, cannot be overridden
            // Layer 2 (middle): Profile environment variables - GUI profile OR CLI local profile
            // Layer 3 (top): Auth tokens again to ensure they're never overridden

            // Layer 1: Resolve authentication token if provided
            const authEnv = resolveSpawnAuthEnvironment(options);

            // Layer 2: Profile environment variables
            // Priority: GUI-provided profile > CLI local active profile > none
            let profileEnv: Record<string, string> = {};

            if (options.environmentVariables && Object.keys(options.environmentVariables).length > 0) {
                // GUI provided profile environment variables - highest priority for profile settings
                profileEnv = options.environmentVariables;
                logger.info(`[DAEMON RUN] Using GUI-provided profile environment variables (${Object.keys(profileEnv).length} vars)`);
                logger.debug(`[DAEMON RUN] GUI profile env var keys: ${Object.keys(profileEnv).join(', ')}`);
            } else {
                // Fallback to CLI local active profile
                try {
                    const settings = await readSettings();
                    const settingsCancellationResult = getCancellationResult();
                    if (settingsCancellationResult) {
                        return settingsCancellationResult;
                    }
                    if (settings.activeProfileId) {
                        logger.debug(`[DAEMON RUN] No GUI profile provided, loading CLI local active profile: ${settings.activeProfileId}`);

                        // Get profile environment variables filtered for agent compatibility
                        profileEnv = await getProfileEnvironmentVariablesForAgent(
                            settings.activeProfileId,
                            options.agent || 'claude'
                        );
                        const profileCancellationResult = getCancellationResult();
                        if (profileCancellationResult) {
                            return profileCancellationResult;
                        }

                        logger.debug(`[DAEMON RUN] Loaded ${Object.keys(profileEnv).length} environment variables from CLI local profile for agent ${options.agent || 'claude'}`);
                        logger.debug(`[DAEMON RUN] CLI profile env var keys: ${Object.keys(profileEnv).join(', ')}`);
                    } else {
                        logger.debug('[DAEMON RUN] No CLI local active profile set');
                    }
                } catch (error) {
                    logger.debug('[DAEMON RUN] Failed to load CLI local profile environment variables:', error);
                    // Continue without profile env vars - this is not a fatal error
                }
            }

            const beforeTmuxAvailabilityCancellationResult = getCancellationResult();
            if (beforeTmuxAvailabilityCancellationResult) {
                return beforeTmuxAvailabilityCancellationResult;
            }

            // Final merge: Profile vars first, then auth (auth takes precedence to protect authentication)
            let extraEnv = { ...profileEnv, ...authEnv };
            logger.debug(`[DAEMON RUN] Final environment variable keys (before expansion) (${Object.keys(extraEnv).length}): ${Object.keys(extraEnv).join(', ')}`);

            // Expand ${VAR} references from daemon's process.env
            // This ensures variable substitution works in both tmux and non-tmux modes
            // Example: ANTHROPIC_AUTH_TOKEN="${Z_AI_AUTH_TOKEN}" → ANTHROPIC_AUTH_TOKEN="sk-real-key"
            extraEnv = expandEnvironmentVariables(extraEnv, process.env);
            logger.debug(`[DAEMON RUN] After variable expansion: ${Object.keys(extraEnv).join(', ')}`);

            // Fail-fast validation: Check that any auth variables present are fully expanded
            // Only validate variables that are actually set (different agents need different auth)
            const potentialAuthVars = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CURSOR_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME', 'AZURE_OPENAI_API_KEY', 'TOGETHER_API_KEY'];
            const unexpandedAuthVars = potentialAuthVars.filter(varName => {
                const value = extraEnv[varName];
                // Only fail if variable IS SET and contains unexpanded ${VAR} references
                return value && typeof value === 'string' && value.includes('${');
            });

            if (unexpandedAuthVars.length > 0) {
                // Extract the specific missing variable names from unexpanded references
                const missingVarDetails = unexpandedAuthVars.map(authVar => {
                    const value = extraEnv[authVar];
                    const unresolvedMatch = value?.match(/\$\{([A-Z_][A-Z0-9_]*)(:-[^}]*)?\}/);
                    const missingVar = unresolvedMatch ? unresolvedMatch[1] : 'unknown';
                    return `${authVar} references \${${missingVar}} which is not defined`;
                });

                const errorMessage = `Authentication will fail - environment variables not found in daemon: ${missingVarDetails.join('; ')}. ` +
                    `Ensure these variables are set in the daemon's environment (not just your shell) before starting sessions.`;
                logger.warn(`[DAEMON RUN] ${errorMessage}`);
                return {
                    type: 'error',
                    errorMessage
                };
            }

            // tmux is required for daemon-spawned sessions (provides TTY for Ink UI)
            const tmuxAvailable = await isTmuxAvailable();
            const tmuxAvailabilityCancellationResult = getCancellationResult();
            if (tmuxAvailabilityCancellationResult) {
                return tmuxAvailabilityCancellationResult;
            }
            if (!tmuxAvailable) {
                return {
                    type: 'error',
                    errorMessage: 'tmux is required for session spawning. Install it with: brew install tmux'
                };
            }

            // Each remote session gets its own tmux session → its own Terminal.app tab
            const agent = options.agent === 'gemini' ? 'gemini' : options.agent === 'cursor' ? 'cursor' : (options.agent === 'codex' ? 'codex' : 'claude');
            const hasValidatedCursorSelection = Boolean(
                options.cursorExecution
                && options.cursorLaunchControls
                && options.cursorRunner
                && isCursorLaunchControls(options.cursorLaunchControls)
                && isCursorRunnerIdentity(options.cursorRunner),
            );
            if (agent === 'cursor' && !hasValidatedCursorSelection) {
                return {
                    type: 'error',
                    errorMessage: 'Cursor requires a daemon-validated model, launch controls, and CLI identity.',
                };
            }
            const tmuxSessionName = `remcli-${agent}-${randomUUID()}`;
            const windowName = 'main';

            logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${tmuxSessionName}`);

            const tmux = getTmuxUtilities(tmuxSessionName);

            // Construct command for the CLI
            const cliPath = runnerEntrypointPath ?? join(projectPath(), 'dist', 'index.mjs');
            const resumeArg = options.resumeSessionId ? ` --resume ${shellQuote(options.resumeSessionId)}` : '';
            const fullCommand = `node --no-warnings --no-deprecation ${shellQuote(cliPath)} ${shellQuote(agent)} --remcli-starting-mode remote --started-by daemon${resumeArg}`;
            const childCommand = agent === 'cursor'
                ? `/usr/bin/env -u ${CURSOR_LEGACY_PERMISSION_ENV_KEY} ${fullCommand}`
                : fullCommand;

            // Spawn in tmux with environment variables
            const tmuxEnv: Record<string, string> = {};

            // Add all daemon environment variables (filtering out undefined)
            for (const [key, value] of Object.entries(process.env)) {
                if (value !== undefined) {
                    tmuxEnv[key] = value;
                }
            }

            // Add extra environment variables (these should already be filtered)
            Object.assign(tmuxEnv, extraEnv);

            // A daemon runner must never inherit a stale or profile-provided
            // Cursor selection. The machine RPC injects a freshly validated,
            // opaque executable identity below.
            if (agent === 'cursor') {
                for (const key of CURSOR_DAEMON_SELECTION_ENV_KEYS) {
                    delete tmuxEnv[key];
                }
            }

            // Pass session name for resumed sessions (used by runClaude to set P2P metadata)
            if (options.resumeSessionName) {
                tmuxEnv.REMCLI_SESSION_NAME = options.resumeSessionName;
            }

            if (agent === 'codex' && options.codexExecution) {
                tmuxEnv.REMCLI_CODEX_MODEL = options.codexExecution.model;
                if (options.codexExecution.reasoningEffort) {
                    tmuxEnv.REMCLI_CODEX_REASONING_EFFORT = options.codexExecution.reasoningEffort;
                }
                tmuxEnv.REMCLI_CODEX_CATALOG_VERSION = options.codexExecution.catalogVersion;
                if (options.permissionMode) {
                    tmuxEnv.REMCLI_CODEX_PERMISSION_MODE = options.permissionMode;
                }
            }

            if (agent === 'cursor'
                && options.cursorExecution
                && options.cursorLaunchControls
                && options.cursorRunner) {
                tmuxEnv.REMCLI_CURSOR_MODEL = options.cursorExecution.model;
                tmuxEnv.REMCLI_CURSOR_CATALOG_VERSION = options.cursorExecution.catalogVersion;
                tmuxEnv.REMCLI_CURSOR_EXECUTION_MODE = options.cursorLaunchControls.executionMode;
                tmuxEnv.REMCLI_CURSOR_FORCE = String(options.cursorLaunchControls.force);
                tmuxEnv.REMCLI_CURSOR_AUTO_REVIEW = String(options.cursorLaunchControls.autoReview);
                tmuxEnv.REMCLI_CURSOR_SANDBOX = options.cursorLaunchControls.sandbox;
                tmuxEnv.REMCLI_CURSOR_APPROVE_MCPS = String(options.cursorLaunchControls.approveMcps);
                tmuxEnv.REMCLI_CURSOR_EXECUTABLE = options.cursorRunner.executable;
                tmuxEnv.REMCLI_CURSOR_CLI_FINGERPRINT = options.cursorRunner.cliFingerprint;
            }

            const runnerControlToken = createRunnerControlToken();
            const tmuxOwnershipMarker = randomUUID();
            tmuxEnv.REMCLI_DAEMON_RUNNER_TOKEN = runnerControlToken;

            const tmuxSpawnCancellationResult = getCancellationResult();
            if (tmuxSpawnCancellationResult) {
                return tmuxSpawnCancellationResult;
            }
            const tmuxResult = await tmux.spawnInTmux([childCommand], {
                sessionName: tmuxSessionName,
                windowName: windowName,
                ownershipMarker: tmuxOwnershipMarker,
                cwd: directory
            }, tmuxEnv);

            const tmuxResultCancellationResult = getCancellationResult();
            if (tmuxResultCancellationResult) {
                if (tmuxResult.success) {
                    try {
                        await cleanupDaemonTmuxRunner({
                            ownership: tmuxResult.ownership,
                            tmuxSessionId: tmuxResult.sessionId,
                        });
                        logger.debug(`[DAEMON RUN] Cleaned up cancelled tmux session ${tmuxSessionName}`);
                    } catch (error) {
                        cancelledTmuxCleanupError = error instanceof Error
                            ? error
                            : new Error(`Failed to clean up cancelled tmux session ${tmuxSessionName}: ${String(error)}`);
                        throw cancelledTmuxCleanupError;
                    }
                }
                return tmuxResultCancellationResult;
            }

            if (tmuxResult.success) {
                logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.ownership.panePid}`);

                // Track the daemon-owned tmux runner so shutdown can verify process exit.
                const daemonTmuxRunner: DaemonTmuxRunner = {
                    ownership: tmuxResult.ownership,
                    tmuxSessionId: tmuxResult.sessionId,
                };
                daemonTmuxRunners.set(tmuxSessionName, daemonTmuxRunner);

                const trackedSession: TrackedSession = {
                    startedBy: 'daemon',
                    pid: tmuxResult.ownership.panePid,
                    tmuxSessionId: tmuxResult.sessionId,
                    tmuxRunner: daemonTmuxRunner.ownership,
                    expectedAgent: agent,
                    expectedResumeSessionId: options.resumeSessionId,
                    expectedResumeKey: resumeKeyOf(agent, options.resumeSessionId) ?? undefined,
                    expectedDirectory: directory,
                    ...(agent === 'cursor' && cursorSessionLineage && options.resumeSessionId
                        ? {
                            cursorResumeLineage: {
                                nativeResumeSessionId: options.resumeSessionId,
                                parentRemcliSessionId: cursorSessionLineage.parentRemcliSessionId,
                            },
                        }
                        : {}),
                    runnerControlToken,
                    directoryCreated,
                    message: directoryCreated
                        ? `The path '${directory}' did not exist. Created folder and spawned session in tmux '${tmuxSessionName}'.`
                        : `Spawned new session in tmux '${tmuxSessionName}'.`
                };

                replaceTrackedSession(tmuxResult.ownership.panePid, trackedSession);
                if (
                    agent === 'cursor'
                    && options.cursorExecution
                    && options.cursorLaunchControls
                    && options.cursorRunner
                    && isCursorLaunchControls(options.cursorLaunchControls)
                    && isCursorRunnerIdentity(options.cursorRunner)
                ) {
                    cursorInteractiveTuiLaunches.set(trackedSession, {
                        model: options.cursorExecution.model,
                        runner: { ...options.cursorRunner },
                        launchControls: { ...options.cursorLaunchControls },
                    });
                }
                const sessionSpawnAwaiter = createSessionSpawnAwaiter(
                    tmuxResult.ownership.panePid,
                    trackedSession,
                );
                if (pendingSpawnTask) {
                    pidToPendingSpawnTask.set(tmuxResult.ownership.panePid, {
                        session: trackedSession,
                        task: pendingSpawnTask,
                    });
                }
                if (pendingSpawnTask?.nativeThreadId) {
                    pidToPendingCodexThreadResume.set(tmuxResult.ownership.panePid, {
                        session: trackedSession,
                        task: pendingSpawnTask,
                    });
                }

                if (agent === 'codex') {
                    logger.debug('[DAEMON RUN] Codex runner started headless; runCodex opens the real Codex TUI through app-server --remote');
                } else {
                    // Always open a new Terminal.app context for this session.
                    // Unset TMUX so the attach command works even when the daemon
                    // process was started from inside an existing tmux client.
                    try {
                        const terminalLease = await openTerminalWithCommand(`env -u TMUX tmux attach -t ${tmuxSessionName}`);
                        if (terminalLease) {
                            logger.debug(`[DAEMON RUN] Opened terminal context for tmux session ${tmuxSessionName}`);
                        } else {
                            logger.debug(`[DAEMON RUN] Terminal context was not opened for tmux session ${tmuxSessionName}`);
                        }
                    } catch (error) {
                        logger.debug(`[DAEMON RUN] Failed to open terminal for tmux:`, error);
                    }
                }

                if (!isExactTrackedSession(tmuxResult.ownership.panePid, trackedSession)) {
                    return getCancellationResult() ?? {
                        type: 'error',
                        errorMessage: getSessionStoppedBeforeReportingError(tmuxResult.ownership.panePid),
                    };
                }

                const beforeAwaiterCancellationResult = getCancellationResult();
                if (beforeAwaiterCancellationResult) {
                    if (isShuttingDown) {
                        return beforeAwaiterCancellationResult;
                    }

                    try {
                        await cleanupDaemonTmuxRunner(daemonTmuxRunner);
                    } catch (error) {
                        cancelledTmuxCleanupError = error instanceof Error
                            ? error
                            : new Error(`Failed to clean up cancelled tmux session ${tmuxSessionName}: ${String(error)}`);
                        throw cancelledTmuxCleanupError;
                    }
                    retireTrackedSession(tmuxResult.ownership.panePid, trackedSession);
                    return beforeAwaiterCancellationResult;
                }

                // Wait for webhook to populate session with remcliSessionId (exact same as regular flow)
                logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.ownership.panePid} (tmux)`);
                return sessionSpawnAwaiter;
            } else {
                return {
                    type: 'error',
                    errorMessage: `Failed to spawn in tmux: ${tmuxResult.error}`
                };
            }
        } catch (error) {
            if (error === cancelledTmuxCleanupError) {
                throw error;
            }
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.debug('[DAEMON RUN] Failed to spawn session:', error);
            return {
                type: 'error',
                errorMessage: `Failed to spawn session: ${errorMessage}`
            };
        }
    };

    const startSpawnTask = (
        options: SpawnSessionOptions,
        nativeThreadId?: string,
        cursorSessionLineage?: CursorSessionLineage,
        resumeKey?: string,
    ): PendingSpawnTask => {
        const pendingSpawnTask = createPendingSpawnTask(nativeThreadId);
        pendingSpawnTask.resumeKey = resumeKey;
        inFlightSpawnTasks.add(pendingSpawnTask);

        void spawnSessionWithoutResumeDedup(options, pendingSpawnTask, cursorSessionLineage).then(
            (result) => pendingSpawnTask.resolve(result),
            (error) => {
                const errorMessage = error instanceof Error ? error.message : String(error);
                pendingSpawnTask.resolve({ type: 'error', errorMessage });
                pendingSpawnTask.completeTask(error instanceof Error ? error : new Error(errorMessage));
            }
        ).finally(() => {
            pendingSpawnTask.completeTask();
            inFlightSpawnTasks.delete(pendingSpawnTask);
            for (const [pid, pendingSpawnTaskRegistration] of pidToPendingSpawnTask.entries()) {
                if (pendingSpawnTaskRegistration.task === pendingSpawnTask) {
                    pidToPendingSpawnTask.delete(pid);
                }
            }
        });

        return pendingSpawnTask;
    };

    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
        if (isShuttingDown) {
            return {
                type: 'error',
                errorMessage: DAEMON_SHUTTING_DOWN_SPAWN_ERROR_MESSAGE,
            };
        }

        const agent = agentOf(options);

        if (agent === 'codex' && options.resumeSessionId) {
            const resumeResult = await resolveCodexThreadResume(options.resumeSessionId);
            if (isShuttingDown) {
                return {
                    type: 'error',
                    errorMessage: DAEMON_SHUTTING_DOWN_SPAWN_ERROR_MESSAGE,
                };
            }

            if (resumeResult.type === 'reuse-active-wrapper') {
                logger.debug(`[DAEMON RUN] Reusing active Codex wrapper ${resumeResult.wrapper.remcliSessionId} for thread ${options.resumeSessionId}`);
                return { type: 'success', sessionId: resumeResult.wrapper.remcliSessionId };
            }

            const pending = codexThreadResumeSpawnPromises.get(options.resumeSessionId);
            if (pending) {
                logger.debug(`[DAEMON RUN] Joining pending Codex resume spawn for thread ${options.resumeSessionId}`);
                return pending.promise;
            }

            if (resumeResult.type === 'wrapper-starting') {
                const errorMessage = `Codex wrapper for thread ${options.resumeSessionId} is already starting. Wait for it to appear instead of opening it again.`;
                logger.debug(`[DAEMON RUN] Refusing duplicate Codex resume spawn: ${errorMessage}`);
                return { type: 'error', errorMessage };
            }

            const pendingCodexThreadResume = startSpawnTask(options, options.resumeSessionId);
            codexThreadResumeSpawnPromises.set(options.resumeSessionId, pendingCodexThreadResume);

            void pendingCodexThreadResume.promise.finally(() => {
                if (codexThreadResumeSpawnPromises.get(options.resumeSessionId!) === pendingCodexThreadResume) {
                    codexThreadResumeSpawnPromises.delete(options.resumeSessionId!);
                }
            });
            return pendingCodexThreadResume.promise;
        }

        const resumeKey = resumeKeyOf(agent, options.resumeSessionId);

        if (!resumeKey || !options.resumeSessionId) {
            return startSpawnTask(options).promise;
        }

        let cursorResumeSession: BoundNativeCursorSessionLookup | null = null;
        if (agent === 'cursor') {
            const boundCursorSession = await findBoundNativeCursorSession(options.resumeSessionId);
            cursorResumeSession = boundCursorSession.type === 'not-found'
                ? await findTrackedCursorResumeSession(options.resumeSessionId)
                : boundCursorSession;
            if (isShuttingDown) {
                return {
                    type: 'error',
                    errorMessage: DAEMON_SHUTTING_DOWN_SPAWN_ERROR_MESSAGE,
                };
            }
        }
        const cursorSessionLineage = agent === 'cursor'
            ? cursorSessionLineageByNativeSessionId.get(options.resumeSessionId)
            : undefined;
        if (cursorResumeSession?.type === 'unavailable') {
            logger.warn('[DAEMON RUN] Refusing Cursor resume because tmux runner ownership could not be confirmed.');
            return { type: 'error', errorMessage: CURSOR_RESUME_OWNERSHIP_UNCONFIRMED_ERROR };
        }
        const existing = agent === 'cursor'
            ? cursorResumeSession?.type === 'found'
                ? cursorResumeSession.session
                : null
            : findTrackedResumeSession(agent, options.resumeSessionId);
        if (agent === 'cursor' && existing && !isReadyTrackedSession(existing.pid, existing)) {
            logger.warn('[DAEMON RUN] Refusing Cursor resume because its wrapper was removed during ownership lookup.');
            return { type: 'error', errorMessage: CURSOR_RESUME_OWNERSHIP_UNCONFIRMED_ERROR };
        }
        if (agent === 'cursor' && (existing || cursorSessionLineage)) {
            const existingDirectory = existing
                ? getTrackedSessionDirectory(existing)
                : cursorSessionLineage?.directory;
            if (!existingDirectory || existingDirectory !== options.directory) {
                const errorMessage = 'Cursor session belongs to a different working directory. Select its original workspace before resuming.';
                logger.warn(`[DAEMON RUN] Refusing Cursor resume across workspaces for ${options.resumeSessionId}`);
                return { type: 'error', errorMessage };
            }
        }
        if (existing?.remcliSessionId) {
            logger.debug(`[DAEMON RUN] Reusing active ${agent} session ${existing.remcliSessionId} for resume ${options.resumeSessionId}`);
            return { type: 'success', sessionId: existing.remcliSessionId };
        }

        const pending = resumeSpawnPromises.get(resumeKey);
        if (pending) {
            logger.debug(`[DAEMON RUN] Joining pending ${agent} resume spawn for ${options.resumeSessionId}`);
            return pending;
        }

        if (existing) {
            const errorMessage = `${agent} session ${options.resumeSessionId} is already starting. Wait for it to appear instead of opening it again.`;
            logger.debug(`[DAEMON RUN] Refusing duplicate resume spawn: ${errorMessage}`);
            return { type: 'error', errorMessage };
        }

        if (isShuttingDown) {
            return {
                type: 'error',
                errorMessage: DAEMON_SHUTTING_DOWN_SPAWN_ERROR_MESSAGE,
            };
        }

        const spawnPromise = startSpawnTask(options, undefined, cursorSessionLineage, resumeKey).promise
            .finally(() => {
                resumeSpawnPromises.delete(resumeKey);
            });
        resumeSpawnPromises.set(resumeKey, spawnPromise);
        return spawnPromise;
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = async (sessionId: string): Promise<StopSessionResult> => {
        logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

        const requestedPid = sessionId.startsWith('PID-')
            ? Number.parseInt(sessionId.slice('PID-'.length), 10)
            : undefined;

        // A PID fallback addresses only the active PID index. A displaced
        // identity must be addressed by its immutable Remcli session id.
        for (const [pid, session] of getTrackedSessionEntries()) {
            const matchesCurrentPid = requestedPid !== undefined
                && pid === requestedPid
                && isCurrentTrackedSession(pid, session);
            if (session.remcliSessionId === sessionId || matchesCurrentPid) {

                if (session.startedBy !== 'daemon' || !session.tmuxRunner) {
                    logger.warn(`[DAEMON RUN] Refused to signal unverified session ${sessionId}; only daemon-owned immutable tmux targets are stoppable.`);
                    return { success: false };
                }
                const tmuxRunner = session.tmuxRunner;

                if (isGracefullyStoppingDaemonRunner(session)) {
                    logger.debug(`[DAEMON RUN] Session ${sessionId} is already completing a credential-confirmed graceful shutdown.`);
                    return { success: false };
                }

                const inFlightCleanup = sessionCleanupPromises.get(session);
                if (!inFlightCleanup) {
                    const paneStatus = await getOwnedPaneStatus(tmuxRunner);
                    if (paneStatus === 'unknown') {
                        logger.warn(`[DAEMON RUN] Could not verify immutable tmux target for session ${sessionId}; keeping it tracked.`);
                        return { success: false };
                    }
                    if (paneStatus === 'mismatch') {
                        logger.warn(`[DAEMON RUN] Refused to stop stale tmux pane for session ${sessionId}; ownership no longer matches the original runner.`);
                        return { success: false };
                    }
                }

                if (await releaseAndRemoveTrackedSession(pid, session)) {
                    logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
                    return {
                        success: true,
                        stoppedSessionId: session.remcliSessionId ?? sessionId
                    };
                }

                logger.warn(`[DAEMON RUN] Failed to stop verified tmux pane for session ${sessionId}; keeping it tracked.`);
                return { success: false };
            }
        }

        if (orphanedCodexRemoteTuiPanes.has(sessionId)) {
            if (!await releaseOrphanedCodexRemoteTuiPane(sessionId)) {
                return { success: false };
            }
            return {
                success: true,
                stoppedSessionId: sessionId,
            };
        }

        if (orphanedCursorInteractiveTuiPanes.has(sessionId)) {
            if (!await releaseOrphanedCursorInteractiveTuiPane(sessionId)) {
                return { success: false };
            }
            return {
                success: true,
                stoppedSessionId: sessionId,
            };
        }

        logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
        return { success: false };
    };

    // Remove sessions whose process is no longer alive
    const pruneDeadSessions = () => {
        for (const [pid, session] of getTrackedSessionEntries()) {
            if (isStoppingSession(session)) {
                void releaseAndRemoveTrackedSession(pid, session);
                continue;
            }

            if (isDisplacedTrackedSession(pid, session)) {
                scheduleDisplacedTrackedSessionCleanup(pid, session);
                continue;
            }

            if (!isProcessAlive(pid)) {
                logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
                // A dead runner cannot deliver /daemon-runner-stopped. The
                // release path still requires the immutable pane tuple (or a
                // confirmed missing owned tmux session) before retiring it.
                void releaseAndRemoveTrackedSession(pid, session, true, true, true).then((didRemove) => {
                    if (!didRemove) {
                        logger.warn(`[DAEMON RUN] Keeping stale session ${session.remcliSessionId ?? pid} tracked because remote TUI cleanup was not confirmed.`);
                    }
                });
                continue;
            }

            if (session.startedBy !== 'daemon' || !session.tmuxRunner) {
                continue;
            }

            void getOwnedPaneStatus(session.tmuxRunner).then((paneStatus) => {
                if (!isCurrentTrackedSession(pid, session) || paneStatus === 'unknown') {
                    return;
                }
                if (paneStatus === 'missing') {
                    logger.debug(`[DAEMON RUN] Removing stale daemon session ${session.remcliSessionId ?? pid}: immutable tmux target is gone.`);
                    // The runner is no longer attached to its owned pane, so
                    // only immutable tmux evidence can reconcile a graceful
                    // stop that could not send its final control callback.
                    void releaseAndRemoveTrackedSession(pid, session, true, true, true).then((didRemove) => {
                        if (!didRemove) {
                            logger.warn(`[DAEMON RUN] Keeping stale daemon session ${session.remcliSessionId ?? pid} tracked because remote TUI cleanup was not confirmed.`);
                        }
                    });
                } else if (paneStatus === 'mismatch') {
                    logger.warn(`[DAEMON RUN] Keeping daemon session ${session.remcliSessionId ?? pid} tracked because its immutable tmux target no longer matches.`);
                }
            }).catch((error) => {
                logger.debug(`[DAEMON RUN] Failed to inspect daemon tmux target while pruning session ${session.remcliSessionId ?? pid}:`, error);
            });
        }
    };

    const cleanupCodexRemoteTuiHost = async (): Promise<void> => {
        const hostAnchor = codexRemoteTuiHostAnchor;
        if (!hostAnchor) {
            return;
        }

        if (!await releaseOwnedPane(hostAnchor)) {
            throw new Error('Could not confirm cleanup of the immutable Codex TUI tmux host pane.');
        }

        codexRemoteTuiHostAnchor = undefined;
        hasOpenedCodexRemoteTuiHostTerminal = false;
    };

    const cleanupCursorInteractiveTuiHost = async (): Promise<void> => {
        const hostAnchor = cursorInteractiveTuiHostAnchor;
        if (!hostAnchor) {
            return;
        }

        if (!await releaseOwnedPane(hostAnchor)) {
            throw new Error('Could not confirm cleanup of the immutable Cursor TUI tmux host pane.');
        }

        cursorInteractiveTuiHostAnchor = undefined;
        hasOpenedCursorInteractiveTuiHostTerminal = false;
    };

    // Kill all tracked sessions and tmux sessions created by this daemon
    const killAllSessions = (): Promise<void> => {
        if (shutdownDrain) {
            return shutdownDrain;
        }

        isShuttingDown = true;
        const pendingSpawnTasks = Array.from(inFlightSpawnTasks);
        const daemonTmuxRunnerSnapshot = Array.from(daemonTmuxRunners.values());
        const trackedSessionSnapshot = getTrackedSessionEntries();
        const trackedDaemonTmuxRunnerSessionNames = new Set(
            trackedSessionSnapshot.flatMap(([, session]) => (
                session.tmuxRunner ? [session.tmuxRunner.sessionName] : []
            )),
        );
        const orphanedDaemonTmuxRunnerSnapshot = daemonTmuxRunnerSnapshot.filter((runner) => (
            !trackedDaemonTmuxRunnerSessionNames.has(runner.ownership.sessionName)
        ));

        shutdownDrain = (async () => {
            for (const pendingSpawnTask of pendingSpawnTasks) {
                pendingSpawnTask.cancel(
                    pendingSpawnTask.nativeThreadId
                        ? CODEX_RESUME_SHUTDOWN_CANCELLATION_MESSAGE
                        : DAEMON_SHUTDOWN_CANCELLATION_MESSAGE
                );
            }
            for (const awaiter of pidToAwaiter.values()) {
                awaiter.fail(DAEMON_SHUTDOWN_CANCELLATION_MESSAGE);
            }

            const cleanupErrors: Error[] = [];

            const remoteTuiOpenResults = await Promise.allSettled(
                [
                    ...codexRemoteTuiOpenPromises.values(),
                    ...Array.from(cursorInteractiveTuiOpenPromises.values(), (opening) => opening.promise),
                ],
            );
            for (const result of remoteTuiOpenResults) {
                if (result.status === 'rejected') {
                    cleanupErrors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
                }
            }

            const cleanupResults = await Promise.allSettled([
                ...trackedSessionSnapshot.map(async ([pid, session]) => {
                    if (isGracefullyStoppingDaemonRunner(session)) {
                        if (!await waitForGracefulDaemonRunnerCompletion(session)) {
                            throw new Error(`Timed out waiting for graceful cleanup of tracked session ${session.remcliSessionId ?? session.pid}.`);
                        }
                        return;
                    }
                    if (!await releaseAndRemoveTrackedSession(pid, session, true, session.startedBy === 'daemon')) {
                        throw new Error(
                            sessionCleanupFailureReasons.get(session)
                                ?? `Could not confirm cleanup of tracked session ${session.remcliSessionId ?? session.pid}.`,
                        );
                    }
                }),
                ...Array.from(orphanedCodexRemoteTuiPanes.keys()).map(async (sessionId) => {
                    if (!await releaseOrphanedCodexRemoteTuiPane(sessionId)) {
                        throw new Error(`Could not confirm cleanup of orphaned Codex remote TUI for session ${sessionId}.`);
                    }
                }),
                ...Array.from(orphanedCursorInteractiveTuiPanes.keys()).map(async (sessionId) => {
                    if (!await releaseOrphanedCursorInteractiveTuiPane(sessionId)) {
                        throw new Error(`Could not confirm cleanup of orphaned Cursor interactive TUI for session ${sessionId}.`);
                    }
                }),
                ...orphanedDaemonTmuxRunnerSnapshot.map((runner) => cleanupDaemonTmuxRunner(runner)),
            ]);
            for (const result of cleanupResults) {
                if (result.status === 'rejected') {
                    cleanupErrors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
                }
            }

            const tuiHostCleanup = await Promise.allSettled([
                cleanupCodexRemoteTuiHost(),
                cleanupCursorInteractiveTuiHost(),
            ]);
            for (const result of tuiHostCleanup) {
                if (result.status === 'rejected') {
                    cleanupErrors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
                }
            }

            const spawnCleanupErrors = await Promise.all(pendingSpawnTasks.map((pendingSpawnTask) => pendingSpawnTask.taskCompletion));
            cleanupErrors.push(...spawnCleanupErrors.filter((error): error is Error => error !== undefined));

            if (cleanupErrors.length > 0) {
                throw new Error(`Daemon session cleanup could not be confirmed: ${cleanupErrors.map((error) => error.message).join('; ')}`);
            }

            nativeCodexThreadIdToTrackedSession.clear();
            nativeCursorSessionIdToTrackedSession.clear();
            cursorSessionLineageByNativeSessionId.clear();
            pidToAwaiter.clear();
            pidToPendingCodexThreadResume.clear();
            pidToPendingSpawnTask.clear();
            codexThreadResumeSpawnPromises.clear();
            codexRemoteTuiOpenPromises.clear();
            cursorInteractiveTuiOpenPromises.clear();
            orphanedCodexRemoteTuiPanes.clear();
            orphanedCursorInteractiveTuiPanes.clear();
            displacedTrackedSessionPids.clear();
            daemonTmuxRunners.clear();
            sessionCleanupPromises.clear();
            sessionCleanupFailureReasons.clear();
        })().catch((error: unknown) => {
            shutdownDrain = null;
            throw error;
        });

        return shutdownDrain;
    };

    return {
        getChildren,
        bindNativeCodexThread,
        bindNativeCursorSession,
        preflightCursorRunner,
        markDaemonRunnerStopping,
        completeDaemonRunnerStopping,
        openCodexRemoteTui,
        openCursorInteractiveTui,
        resolveCodexThreadResume,
        spawnSession,
        stopSession,
        onRemcliSessionWebhook,
        pruneDeadSessions,
        killAllSessions
    };
}
