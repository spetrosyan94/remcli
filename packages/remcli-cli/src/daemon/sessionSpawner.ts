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
    DaemonSessionWebhookResult,
    NativeCodexThreadBinding,
    NativeCodexThreadBindingResult,
    NativeCodexThreadWrapper,
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

const DAEMON_SHUTDOWN_CANCELLATION_MESSAGE = 'Daemon shut down before session process registration.';
const CODEX_RESUME_SHUTDOWN_CANCELLATION_MESSAGE = 'Daemon shut down before Codex resume process registration.';
const DAEMON_SHUTTING_DOWN_SPAWN_ERROR_MESSAGE = 'Daemon is shutting down and cannot start a new session.';
const RUNNER_CONTROL_TOKEN_BYTES = 32;

interface SessionSpawnAwaiter {
    complete: (session: TrackedSession) => void;
    fail: (errorMessage: string) => void;
}

interface PendingSpawnTask {
    nativeThreadId?: string;
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

type OwnedPaneStatus = 'exists' | 'missing' | 'mismatch' | 'unknown';
type TrackedSessionStatus = OwnedPaneStatus;

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

export interface SessionManager {
    /** Snapshot of currently tracked sessions. */
    getChildren: () => TrackedSession[];
    /** Bind a native Codex thread to its already-created Remcli wrapper session. */
    bindNativeCodexThread: (binding: NativeCodexThreadBinding) => Promise<NativeCodexThreadBindingResult>;
    /** Open one daemon-owned tmux window for a bound Codex remote TUI. */
    openCodexRemoteTui: (request: CodexRemoteTuiOpenRequest) => Promise<CodexRemoteTuiOpenResult>;
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

    return { CLAUDE_CODE_OAUTH_TOKEN: options.token };
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

export function createSessionManager(options: SessionManagerOptions = {}): SessionManager {
    // State - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();
    const resumeSpawnPromises = new Map<string, Promise<SpawnSessionResult>>();
    const codexThreadResumeSpawnPromises = new Map<string, PendingSpawnTask>();
    const nativeCodexThreadIdToPid = new Map<string, number>();
    const runnerSessionIdToPid = new Map<string, number>();
    const codexRemoteTuiOpenPromises = new Map<string, Promise<CodexRemoteTuiOpenResult>>();
    const orphanedCodexRemoteTuiPanes = new Map<string, TmuxPaneOwnership>();
    const stoppingSessionPids = new Map<number, number>();
    let codexRemoteTuiHostPromise: Promise<{ ok: true } | { ok: false; error: string }> | null = null;

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, SessionSpawnAwaiter>();
    const pidToPendingCodexThreadResume = new Map<number, PendingSpawnTask>();
    const inFlightSpawnTasks = new Set<PendingSpawnTask>();

    // Track tmux session names created by this daemon for cleanup
    const daemonTmuxRunners = new Map<string, DaemonTmuxRunner>();
    const codexRemoteTuiHostSessionName = `remcli-codex-tui-${randomUUID()}`;
    const codexRemoteTuiHostWindowName = 'host';
    const codexRemoteTuiHostOwnerMarker = randomUUID();
    let codexRemoteTuiHostAnchor: TmuxPaneOwnership | undefined;
    let hasOpenedCodexRemoteTuiHostTerminal = false;
    let isShuttingDown = false;
    let shutdownDrain: Promise<void> | null = null;

    const getChildren = () => Array.from(pidToTrackedSession.values());

    const acquireStoppingSessionGuard = (pid: number): (() => void) => {
        stoppingSessionPids.set(pid, (stoppingSessionPids.get(pid) ?? 0) + 1);

        let hasReleased = false;
        return () => {
            if (hasReleased) {
                return;
            }
            hasReleased = true;

            const guardCount = stoppingSessionPids.get(pid);
            if (!guardCount || guardCount === 1) {
                stoppingSessionPids.delete(pid);
                return;
            }
            stoppingSessionPids.set(pid, guardCount - 1);
        };
    };

    const withStoppingSessionGuard = async <T>(pid: number, action: () => Promise<T>): Promise<T> => {
        const releaseGuard = acquireStoppingSessionGuard(pid);
        try {
            return await action();
        } finally {
            releaseGuard();
        }
    };

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
            logger.warn(`[DAEMON RUN] Could not confirm cleanup of managed Codex remote TUI pane ${ownership.paneId}; preserving tracking for retry.`);
            return false;
        }

        session.managedCodexRemoteTui = undefined;
        return true;
    };

    const releaseDaemonTmuxRunner = async (session: TrackedSession): Promise<boolean> => {
        if (session.startedBy !== 'daemon') {
            return true;
        }

        const ownership = session.tmuxRunner;
        if (!ownership) {
            logger.warn(`[DAEMON RUN] Could not confirm cleanup of daemon session ${session.remcliSessionId ?? session.pid}: immutable tmux runner ownership is missing.`);
            return false;
        }

        const releaseResult = await getTmuxUtilities(ownership.sessionName).releaseOwnedPane(ownership);
        if (releaseResult === 'released' || releaseResult === 'missing') {
            return true;
        }

        const reason = releaseResult === 'mismatch'
            ? 'ownership no longer matches the original runner'
            : 'immutable tmux runner target is unknown';
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

    const retireDaemonTmuxRunner = (session: TrackedSession): void => {
        const ownership = session.tmuxRunner;
        if (ownership) {
            daemonTmuxRunners.delete(ownership.sessionName);
        }
    };

    const removeTrackedSession = (pid: number, shouldPublishStopped = true): void => {
        const trackedSession = pidToTrackedSession.get(pid);
        const stoppedSessionId = trackedSession?.remcliSessionId;
        const pendingCodexThreadResume = pidToPendingCodexThreadResume.get(pid);
        const errorMessage = `Session process ${pid} stopped before reporting its Remcli session.`;

        pidToPendingCodexThreadResume.delete(pid);
        if (
            pendingCodexThreadResume?.nativeThreadId
            && codexThreadResumeSpawnPromises.get(pendingCodexThreadResume.nativeThreadId) === pendingCodexThreadResume
        ) {
            codexThreadResumeSpawnPromises.delete(pendingCodexThreadResume.nativeThreadId);
        }
        pendingCodexThreadResume?.cancel(errorMessage);

        if (trackedSession?.nativeCodexThreadId && nativeCodexThreadIdToPid.get(trackedSession.nativeCodexThreadId) === pid) {
            nativeCodexThreadIdToPid.delete(trackedSession.nativeCodexThreadId);
        }
        if (
            trackedSession?.runnerControlTokenSessionId
            && runnerSessionIdToPid.get(trackedSession.runnerControlTokenSessionId) === pid
        ) {
            runnerSessionIdToPid.delete(trackedSession.runnerControlTokenSessionId);
        }
        pidToAwaiter.get(pid)?.fail(errorMessage);
        pidToTrackedSession.delete(pid);
        stoppingSessionPids.delete(pid);
        if (trackedSession) {
            retireDaemonTmuxRunner(trackedSession);
        }

        if (shouldPublishStopped && stoppedSessionId) {
            try {
                options.onSessionStopped?.(stoppedSessionId);
            } catch (error) {
                logger.warn(`[DAEMON RUN] Failed to publish stopped session ${stoppedSessionId}:`, error);
            }
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

    const releaseAndRemoveTrackedSession = async (
        pid: number,
        shouldAwaitRemoteTuiOpening = true,
    ): Promise<boolean> => {
        const trackedSession = pidToTrackedSession.get(pid);
        if (!trackedSession) {
            return true;
        }
        return withStoppingSessionGuard(pid, async () => {
            if (
                shouldAwaitRemoteTuiOpening
                && trackedSession.remcliSessionId
                && !await waitForCodexRemoteTuiOpening(trackedSession.remcliSessionId)
            ) {
                return false;
            }
            if (!await releaseManagedCodexRemoteTuiWindow(trackedSession)) {
                return false;
            }
            if (!await releaseDaemonTmuxRunner(trackedSession)) {
                return false;
            }
            removeTrackedSession(pid);
            return true;
        });
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

    const toNativeCodexThreadWrapper = (remcliSessionId: string, nativeThreadId: string): NativeCodexThreadWrapper => ({
        agent: 'codex',
        nativeThreadId,
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
        for (const [pid, session] of pidToTrackedSession.entries()) {
            if (session.expectedAgent !== 'codex' || session.expectedResumeSessionId !== nativeThreadId) {
                continue;
            }
            const status = await getTrackedSessionStatus(pid, session);
            if (status === 'missing') {
                if (!await releaseAndRemoveTrackedSession(pid)) {
                    return { session, status: 'unknown' };
                }
                continue;
            }
            return { session, status: status === 'exists' ? 'exists' : 'unknown' };
        }
        return null;
    };

    const resolveCodexThreadResume = async (nativeThreadId: string): Promise<CodexThreadResumeResult> => {
        const pid = nativeCodexThreadIdToPid.get(nativeThreadId);
        if (pid !== undefined) {
            const session = pidToTrackedSession.get(pid);
            if (!session || session.nativeCodexThreadId !== nativeThreadId) {
                nativeCodexThreadIdToPid.delete(nativeThreadId);
                if (session) {
                    await releaseAndRemoveTrackedSession(pid);
                }
            } else {
                const status = await getTrackedSessionStatus(pid, session);
                if (status === 'missing') {
                    nativeCodexThreadIdToPid.delete(nativeThreadId);
                    if (!await releaseAndRemoveTrackedSession(pid)) {
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
        const existingPid = nativeCodexThreadIdToPid.get(binding.nativeThreadId);
        if (existingPid !== undefined) {
            const existingSession = pidToTrackedSession.get(existingPid);
            if (!existingSession || existingSession.nativeCodexThreadId !== binding.nativeThreadId) {
                nativeCodexThreadIdToPid.delete(binding.nativeThreadId);
                if (existingSession) {
                    await releaseAndRemoveTrackedSession(existingPid);
                }
            } else {
                const status = await getTrackedSessionStatus(existingPid, existingSession);
                if (status === 'missing') {
                    nativeCodexThreadIdToPid.delete(binding.nativeThreadId);
                    await releaseAndRemoveTrackedSession(existingPid);
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
            const status = await getTrackedSessionStatus(pid, session);
            if (status === 'missing') {
                await releaseAndRemoveTrackedSession(pid);
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
            nativeCodexThreadIdToPid.delete(trackedSession.nativeCodexThreadId);
        }
        trackedSession.nativeCodexThreadId = binding.nativeThreadId;
        nativeCodexThreadIdToPid.set(binding.nativeThreadId, trackedPid);

        return {
            type: 'bound',
            wrapper: toNativeCodexThreadWrapper(binding.remcliSessionId, binding.nativeThreadId),
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

    async function getManagedCodexRemoteTuiWindowStatus(
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
                await releaseAndRemoveTrackedSession(pid, false);
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
        if (stoppingSessionPids.has(trackedPid)) {
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
            const existingWindowStatus = await getManagedCodexRemoteTuiWindowStatus(existingOwnership);
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
            [buildCodexRemoteTuiCommand(request.endpoint, request.nativeThreadId)],
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
        if (isShuttingDown || stoppingSessionPids.has(trackedPid)) {
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

    const findTrackedResumeSession = (agent: 'claude' | 'codex' | 'cursor' | 'gemini', resumeSessionId: string): TrackedSession | null => {
        for (const [pid, session] of pidToTrackedSession.entries()) {
            const reportedAgent = session.remcliSessionMetadataFromLocalWebhook?.flavor;
            const trackedAgent = reportedAgent ?? session.expectedAgent;
            if (trackedAgent !== agent) continue;
            const trackedResumeSessionId = session.remcliSessionMetadataFromLocalWebhook
                ? getNativeSessionId(session.remcliSessionMetadataFromLocalWebhook, agent)
                : session.expectedResumeSessionId;
            if (trackedResumeSessionId === resumeSessionId) {
                try {
                    process.kill(pid, 0);
                } catch {
                    void releaseAndRemoveTrackedSession(pid);
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
        logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

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
                const ownerPid = runnerSessionIdToPid.get(sessionId);
                if (ownerPid !== undefined && ownerPid !== pid) {
                    logger.warn(`[DAEMON RUN] Rejected daemon session webhook for PID ${pid}: Remcli session is already owned by another runner`);
                    return { accepted: false, daemonOwned: false, error: 'runner-session-already-owned' };
                }
                if (!existingSession.runnerControlToken) {
                    logger.warn(`[DAEMON RUN] Rejected daemon session webhook for PID ${pid}: runner capability is missing`);
                    return { accepted: false, daemonOwned: false, error: 'runner-capability-mismatch' };
                }
                existingSession.runnerControlTokenSessionId = sessionId;
                runnerSessionIdToPid.set(sessionId, pid);
            } else if (runnerToken) {
                logger.warn(`[DAEMON RUN] Rejected external session webhook for PID ${pid}: unexpected runner capability`);
                return { accepted: false, daemonOwned: false, error: 'unexpected-runner-capability' };
            }

            existingSession.remcliSessionId = sessionId;
            existingSession.remcliSessionMetadataFromLocalWebhook = sessionMetadata;
            logger.debug(`[DAEMON RUN] Updated tracked session ${sessionId} with metadata`);

            // Resolve any awaiter for this PID
            pidToPendingCodexThreadResume.delete(pid);
            const awaiter = pidToAwaiter.get(pid);
            if (awaiter) {
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
        pidToTrackedSession.set(pid, trackedSession);
        logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
        return { accepted: true, daemonOwned: false };
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSessionWithoutResumeDedup = async (
        options: SpawnSessionOptions,
        pendingSpawnTask?: PendingSpawnTask
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
            const potentialAuthVars = ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_HOME', 'AZURE_OPENAI_API_KEY', 'TOGETHER_API_KEY'];
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
            const tmuxSessionName = `remcli-${agent}-${randomUUID()}`;
            const windowName = 'main';

            logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${tmuxSessionName}`);

            const tmux = getTmuxUtilities(tmuxSessionName);

            // Construct command for the CLI
            const cliPath = join(projectPath(), 'dist', 'index.mjs');
            const resumeArg = options.resumeSessionId ? ` --resume ${options.resumeSessionId}` : '';
            const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${agent} --remcli-starting-mode remote --started-by daemon${resumeArg}`;

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

            // Pass session name for resumed sessions (used by runClaude to set P2P metadata)
            if (options.resumeSessionName) {
                tmuxEnv.REMCLI_SESSION_NAME = options.resumeSessionName;
            }

            const runnerControlToken = createRunnerControlToken();
            const tmuxOwnershipMarker = randomUUID();
            tmuxEnv.REMCLI_DAEMON_RUNNER_TOKEN = runnerControlToken;

            const tmuxSpawnCancellationResult = getCancellationResult();
            if (tmuxSpawnCancellationResult) {
                return tmuxSpawnCancellationResult;
            }
            const tmuxResult = await tmux.spawnInTmux([fullCommand], {
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
                    runnerControlToken,
                    directoryCreated,
                    message: directoryCreated
                        ? `The path '${directory}' did not exist. Created folder and spawned session in tmux '${tmuxSessionName}'.`
                        : `Spawned new session in tmux '${tmuxSessionName}'.`
                };

                pidToTrackedSession.set(tmuxResult.ownership.panePid, trackedSession);
                if (pendingSpawnTask?.nativeThreadId) {
                    pidToPendingCodexThreadResume.set(tmuxResult.ownership.panePid, pendingSpawnTask);
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
                    removeTrackedSession(tmuxResult.ownership.panePid);
                    return beforeAwaiterCancellationResult;
                }

                // Wait for webhook to populate session with remcliSessionId (exact same as regular flow)
                logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.ownership.panePid} (tmux)`);

                return new Promise((resolve) => {
                    // Set timeout for webhook (same as regular flow)
                    const timeout = setTimeout(() => {
                        const awaiter = pidToAwaiter.get(tmuxResult.ownership.panePid);
                        if (!awaiter) {
                            return;
                        }
                        logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxResult.ownership.panePid} (tmux)`);
                        awaiter.fail(`Session webhook timeout for PID ${tmuxResult.ownership.panePid} (tmux)`);
                    }, 15_000); // Same timeout as regular sessions

                    // Register awaiter for tmux session (exact same as regular flow)
                    pidToAwaiter.set(tmuxResult.ownership.panePid, {
                        complete: (completedSession) => {
                            clearTimeout(timeout);
                            pidToAwaiter.delete(tmuxResult.ownership.panePid);
                            logger.debug(`[DAEMON RUN] Session ${completedSession.remcliSessionId} fully spawned with webhook (tmux)`);
                            resolve({
                                type: 'success',
                                sessionId: completedSession.remcliSessionId!
                            });
                        },
                        fail: (errorMessage) => {
                            clearTimeout(timeout);
                            pidToAwaiter.delete(tmuxResult.ownership.panePid);
                            resolve({ type: 'error', errorMessage });
                        },
                    });
                });
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

    const startSpawnTask = (options: SpawnSessionOptions, nativeThreadId?: string): PendingSpawnTask => {
        const pendingSpawnTask = createPendingSpawnTask(nativeThreadId);
        inFlightSpawnTasks.add(pendingSpawnTask);

        void spawnSessionWithoutResumeDedup(options, pendingSpawnTask).then(
            (result) => pendingSpawnTask.resolve(result),
            (error) => {
                const errorMessage = error instanceof Error ? error.message : String(error);
                pendingSpawnTask.resolve({ type: 'error', errorMessage });
                pendingSpawnTask.completeTask(error instanceof Error ? error : new Error(errorMessage));
            }
        ).finally(() => {
            pendingSpawnTask.completeTask();
            inFlightSpawnTasks.delete(pendingSpawnTask);
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

        const existing = findTrackedResumeSession(agent, options.resumeSessionId);
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

        const spawnPromise = startSpawnTask(options).promise
            .finally(() => {
                resumeSpawnPromises.delete(resumeKey);
            });
        resumeSpawnPromises.set(resumeKey, spawnPromise);
        return spawnPromise;
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = async (sessionId: string): Promise<StopSessionResult> => {
        logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

        // Try to find by sessionId first
        for (const [pid, session] of pidToTrackedSession.entries()) {
            if (session.remcliSessionId === sessionId ||
                (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

                if (session.startedBy !== 'daemon' || !session.tmuxRunner) {
                    logger.warn(`[DAEMON RUN] Refused to signal unverified session ${sessionId}; only daemon-owned immutable tmux targets are stoppable.`);
                    return { success: false };
                }
                const tmuxRunner = session.tmuxRunner;

                return withStoppingSessionGuard(pid, async () => {
                    if (
                        session.remcliSessionId
                        && !await waitForCodexRemoteTuiOpening(session.remcliSessionId)
                    ) {
                        logger.warn(`[DAEMON RUN] Could not stop session ${sessionId} because its in-flight managed remote TUI opener did not settle.`);
                        return { success: false };
                    }

                    if (!await releaseManagedCodexRemoteTuiWindow(session)) {
                        logger.warn(`[DAEMON RUN] Could not stop session ${sessionId} because its managed remote TUI cleanup was not confirmed.`);
                        return { success: false };
                    }

                    const paneStatus = await getOwnedPaneStatus(tmuxRunner);
                    if (paneStatus === 'unknown') {
                        logger.warn(`[DAEMON RUN] Could not verify immutable tmux target for session ${sessionId}; keeping it tracked.`);
                        return { success: false };
                    }
                    if (paneStatus === 'mismatch') {
                        logger.warn(`[DAEMON RUN] Refused to stop stale tmux pane for session ${sessionId}; ownership no longer matches the original runner.`);
                        return { success: false };
                    }
                    if (paneStatus === 'exists' && !await releaseOwnedPane(tmuxRunner)) {
                        logger.warn(`[DAEMON RUN] Failed to stop verified tmux pane for session ${sessionId}; keeping it tracked.`);
                        return { success: false };
                    }

                    removeTrackedSession(pid);
                    logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
                    return {
                        success: true,
                        stoppedSessionId: session.remcliSessionId ?? sessionId
                    };
                });
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

        logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
        return { success: false };
    };

    // Remove sessions whose process is no longer alive
    const pruneDeadSessions = () => {
        for (const [pid, session] of pidToTrackedSession.entries()) {
            if (!isProcessAlive(pid)) {
                logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
                void releaseAndRemoveTrackedSession(pid).then((didRemove) => {
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
                if (pidToTrackedSession.get(pid) !== session || paneStatus === 'unknown') {
                    return;
                }
                if (paneStatus === 'missing') {
                    logger.debug(`[DAEMON RUN] Removing stale daemon session ${session.remcliSessionId ?? pid}: immutable tmux target is gone.`);
                    void releaseAndRemoveTrackedSession(pid).then((didRemove) => {
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

    // Kill all tracked sessions and tmux sessions created by this daemon
    const killAllSessions = (): Promise<void> => {
        if (shutdownDrain) {
            return shutdownDrain;
        }

        isShuttingDown = true;
        const pendingSpawnTasks = Array.from(inFlightSpawnTasks);
        const daemonTmuxRunnerSnapshot = Array.from(daemonTmuxRunners.values());
        const trackedSessionSnapshot = Array.from(pidToTrackedSession.entries());
        for (const [pid] of trackedSessionSnapshot) {
            acquireStoppingSessionGuard(pid);
        }

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
                Array.from(codexRemoteTuiOpenPromises.values()),
            );
            for (const result of remoteTuiOpenResults) {
                if (result.status === 'rejected') {
                    cleanupErrors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
                }
            }

            const cleanupResults = await Promise.allSettled([
                ...trackedSessionSnapshot.map(async ([, session]) => {
                    if (!await releaseManagedCodexRemoteTuiWindow(session)) {
                        throw new Error(`Could not confirm cleanup of managed Codex remote TUI for session ${session.remcliSessionId ?? session.pid}.`);
                    }
                }),
                ...Array.from(orphanedCodexRemoteTuiPanes.keys()).map(async (sessionId) => {
                    if (!await releaseOrphanedCodexRemoteTuiPane(sessionId)) {
                        throw new Error(`Could not confirm cleanup of orphaned Codex remote TUI for session ${sessionId}.`);
                    }
                }),
                ...daemonTmuxRunnerSnapshot.map((runner) => cleanupDaemonTmuxRunner(runner)),
            ]);
            for (const result of cleanupResults) {
                if (result.status === 'rejected') {
                    cleanupErrors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
                }
            }

            const codexTuiHostCleanup = await Promise.allSettled([cleanupCodexRemoteTuiHost()]);
            for (const result of codexTuiHostCleanup) {
                if (result.status === 'rejected') {
                    cleanupErrors.push(result.reason instanceof Error ? result.reason : new Error(String(result.reason)));
                }
            }

            const spawnCleanupErrors = await Promise.all(pendingSpawnTasks.map((pendingSpawnTask) => pendingSpawnTask.taskCompletion));
            cleanupErrors.push(...spawnCleanupErrors.filter((error): error is Error => error !== undefined));

            if (cleanupErrors.length > 0) {
                throw new Error(`Daemon session cleanup could not be confirmed: ${cleanupErrors.map((error) => error.message).join('; ')}`);
            }

            for (const [pid, trackedSession] of trackedSessionSnapshot) {
                if (pidToTrackedSession.get(pid) === trackedSession) {
                    removeTrackedSession(pid, trackedSession.startedBy === 'daemon');
                }
            }
            nativeCodexThreadIdToPid.clear();
            pidToAwaiter.clear();
            pidToPendingCodexThreadResume.clear();
            codexThreadResumeSpawnPromises.clear();
            codexRemoteTuiOpenPromises.clear();
            orphanedCodexRemoteTuiPanes.clear();
            daemonTmuxRunners.clear();
        })().catch((error: unknown) => {
            shutdownDrain = null;
            throw error;
        });

        return shutdownDrain;
    };

    return {
        getChildren,
        bindNativeCodexThread,
        openCodexRemoteTui,
        resolveCodexThreadResume,
        spawnSession,
        stopSession,
        onRemcliSessionWebhook,
        pruneDeadSessions,
        killAllSessions
    };
}
