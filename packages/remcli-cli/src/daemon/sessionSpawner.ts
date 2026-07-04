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
import { execSync } from 'child_process';
import { join } from 'path';
import * as tmp from 'tmp';

import { StopSessionResult, TrackedSession } from './types';
import { Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { readSettings, validateProfileForAgent, getProfileEnvironmentVariables } from '@/persistence';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { openTerminalWithCommand } from '@/utils/openTerminal';

export interface SessionManager {
    /** Snapshot of currently tracked sessions. */
    getChildren: () => TrackedSession[];
    /** Spawn a new session in tmux and wait for its webhook. */
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    /** Stop a session by sessionId or `PID-<pid>` fallback. */
    stopSession: (sessionId: string) => StopSessionResult;
    /** Handle a webhook from a session reporting itself to the daemon. */
    onRemcliSessionWebhook: (sessionId: string, metadata: Metadata) => void;
    /** Remove sessions whose process is no longer alive (used by heartbeat). */
    pruneDeadSessions: () => void;
    /** Kill all tracked sessions and tmux sessions created by this daemon (used on shutdown). */
    killAllSessions: () => void;
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

export function createSessionManager(): SessionManager {
    // State - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Track tmux session names created by this daemon for cleanup
    const daemonTmuxSessions = new Set<string>();

    const getChildren = () => Array.from(pidToTrackedSession.values());

    // Handle webhook from remcli session reporting itself
    const onRemcliSessionWebhook = (sessionId: string, sessionMetadata: Metadata) => {
        logger.debugLargeJson(`[DAEMON RUN] Session reported`, sessionMetadata);

        const pid = sessionMetadata.hostPid;
        if (!pid) {
            logger.debug(`[DAEMON RUN] Session webhook missing hostPid for sessionId: ${sessionId}`);
            return;
        }

        logger.debug(`[DAEMON RUN] Session webhook: ${sessionId}, PID: ${pid}, started by: ${sessionMetadata.startedBy || 'unknown'}`);
        logger.debug(`[DAEMON RUN] Current tracked sessions before webhook: ${Array.from(pidToTrackedSession.keys()).join(', ')}`);

        // Check if we already have this PID (daemon-spawned)
        const existingSession = pidToTrackedSession.get(pid);

        if (existingSession && existingSession.startedBy === 'daemon') {
            // Update daemon-spawned session with reported data
            existingSession.remcliSessionId = sessionId;
            existingSession.remcliSessionMetadataFromLocalWebhook = sessionMetadata;
            logger.debug(`[DAEMON RUN] Updated daemon-spawned session ${sessionId} with metadata`);

            // Resolve any awaiter for this PID
            const awaiter = pidToAwaiter.get(pid);
            if (awaiter) {
                pidToAwaiter.delete(pid);
                awaiter(existingSession);
                logger.debug(`[DAEMON RUN] Resolved session awaiter for PID ${pid}`);
            }
        } else if (!existingSession) {
            // New session started externally
            const trackedSession: TrackedSession = {
                startedBy: 'remcli directly - likely by user from terminal',
                remcliSessionId: sessionId,
                remcliSessionMetadataFromLocalWebhook: sessionMetadata,
                pid
            };
            pidToTrackedSession.set(pid, trackedSession);
            logger.debug(`[DAEMON RUN] Registered externally-started session ${sessionId}`);
        }
    };

    // Spawn a new session (sessionId reserved for future --resume functionality)
    const spawnSession = async (options: SpawnSessionOptions): Promise<SpawnSessionResult> => {
        logger.debugLargeJson('[DAEMON RUN] Spawning session', options);

        const { directory, approvedNewDirectoryCreation = true } = options;
        let directoryCreated = false;

        try {
            await fs.access(directory);
            logger.debug(`[DAEMON RUN] Directory exists: ${directory}`);
        } catch (error) {
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

            // Build environment variables with explicit precedence layers:
            // Layer 1 (base): Authentication tokens - protected, cannot be overridden
            // Layer 2 (middle): Profile environment variables - GUI profile OR CLI local profile
            // Layer 3 (top): Auth tokens again to ensure they're never overridden

            // Layer 1: Resolve authentication token if provided
            const authEnv: Record<string, string> = {};
            if (options.token) {
                if (options.agent === 'codex') {

                    // Create a temporary directory for Codex
                    const codexHomeDir = tmp.dirSync();

                    // Write the token to the temporary directory
                    fs.writeFile(join(codexHomeDir.name, 'auth.json'), options.token);

                    // Set the environment variable for Codex
                    authEnv.CODEX_HOME = codexHomeDir.name;
                } else { // Assuming claude
                    authEnv.CLAUDE_CODE_OAUTH_TOKEN = options.token;
                }
            }

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
                    if (settings.activeProfileId) {
                        logger.debug(`[DAEMON RUN] No GUI profile provided, loading CLI local active profile: ${settings.activeProfileId}`);

                        // Get profile environment variables filtered for agent compatibility
                        profileEnv = await getProfileEnvironmentVariablesForAgent(
                            settings.activeProfileId,
                            options.agent || 'claude'
                        );

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
            if (!tmuxAvailable) {
                return {
                    type: 'error',
                    errorMessage: 'tmux is required for session spawning. Install it with: brew install tmux'
                };
            }

            // Each remote session gets its own tmux session → its own Terminal.app tab
            const agent = options.agent === 'gemini' ? 'gemini' : options.agent === 'cursor' ? 'cursor' : (options.agent === 'codex' ? 'codex' : 'claude');
            const tmuxSessionName = `remcli-${Date.now()}-${agent}`;
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

            const tmuxResult = await tmux.spawnInTmux([fullCommand], {
                sessionName: tmuxSessionName,
                windowName: windowName,
                cwd: directory
            }, tmuxEnv);

            if (tmuxResult.success) {
                logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

                if (!tmuxResult.pid) {
                    throw new Error('Tmux window created but no PID returned');
                }

                // Track tmux session name for cleanup
                daemonTmuxSessions.add(tmuxSessionName);

                const trackedSession: TrackedSession = {
                    startedBy: 'daemon',
                    pid: tmuxResult.pid,
                    tmuxSessionId: tmuxResult.sessionId,
                    directoryCreated,
                    message: directoryCreated
                        ? `The path '${directory}' did not exist. Created folder and spawned session in tmux '${tmuxSessionName}'.`
                        : `Spawned new session in tmux '${tmuxSessionName}'.`
                };

                pidToTrackedSession.set(tmuxResult.pid, trackedSession);

                // Always open a new Terminal.app tab for this session
                try {
                    openTerminalWithCommand(`tmux attach -t ${tmuxSessionName}`);
                    logger.debug(`[DAEMON RUN] Opened terminal tab for tmux session ${tmuxSessionName}`);
                } catch (error) {
                    logger.debug(`[DAEMON RUN] Failed to open terminal for tmux:`, error);
                }

                // Wait for webhook to populate session with remcliSessionId (exact same as regular flow)
                logger.debug(`[DAEMON RUN] Waiting for session webhook for PID ${tmuxResult.pid} (tmux)`);

                return new Promise((resolve) => {
                    // Set timeout for webhook (same as regular flow)
                    const timeout = setTimeout(() => {
                        pidToAwaiter.delete(tmuxResult.pid!);
                        logger.debug(`[DAEMON RUN] Session webhook timeout for PID ${tmuxResult.pid} (tmux)`);
                        resolve({
                            type: 'error',
                            errorMessage: `Session webhook timeout for PID ${tmuxResult.pid} (tmux)`
                        });
                    }, 15_000); // Same timeout as regular sessions

                    // Register awaiter for tmux session (exact same as regular flow)
                    pidToAwaiter.set(tmuxResult.pid!, (completedSession) => {
                        clearTimeout(timeout);
                        logger.debug(`[DAEMON RUN] Session ${completedSession.remcliSessionId} fully spawned with webhook (tmux)`);
                        resolve({
                            type: 'success',
                            sessionId: completedSession.remcliSessionId!
                        });
                    });
                });
            } else {
                return {
                    type: 'error',
                    errorMessage: `Failed to spawn in tmux: ${tmuxResult.error}`
                };
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.debug('[DAEMON RUN] Failed to spawn session:', error);
            return {
                type: 'error',
                errorMessage: `Failed to spawn session: ${errorMessage}`
            };
        }
    };

    // Stop a session by sessionId or PID fallback
    const stopSession = (sessionId: string): StopSessionResult => {
        logger.debug(`[DAEMON RUN] Attempting to stop session ${sessionId}`);

        // Try to find by sessionId first
        for (const [pid, session] of pidToTrackedSession.entries()) {
            if (session.remcliSessionId === sessionId ||
                (sessionId.startsWith('PID-') && pid === parseInt(sessionId.replace('PID-', '')))) {

                if (session.startedBy === 'daemon' && session.childProcess) {
                    try {
                        session.childProcess.kill('SIGTERM');
                        logger.debug(`[DAEMON RUN] Sent SIGTERM to daemon-spawned session ${sessionId}`);
                    } catch (error) {
                        logger.debug(`[DAEMON RUN] Failed to kill session ${sessionId}:`, error);
                    }
                } else {
                    // For externally started sessions, try to kill by PID
                    try {
                        process.kill(pid, 'SIGTERM');
                        logger.debug(`[DAEMON RUN] Sent SIGTERM to external session PID ${pid}`);
                    } catch (error) {
                        logger.debug(`[DAEMON RUN] Failed to kill external session PID ${pid}:`, error);
                    }
                }

                pidToTrackedSession.delete(pid);
                logger.debug(`[DAEMON RUN] Removed session ${sessionId} from tracking`);
                return {
                    success: true,
                    stoppedSessionId: session.remcliSessionId ?? sessionId
                };
            }
        }

        logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
        return { success: false };
    };

    // Remove sessions whose process is no longer alive
    const pruneDeadSessions = () => {
        for (const [pid] of pidToTrackedSession.entries()) {
            try {
                // Check if process is still alive (signal 0 doesn't kill, just checks)
                process.kill(pid, 0);
            } catch (error) {
                // Process is dead, remove from tracking
                logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
                pidToTrackedSession.delete(pid);
            }
        }
    };

    // Kill all tracked sessions and tmux sessions created by this daemon
    const killAllSessions = () => {
        // Kill all tracked child sessions
        for (const [pid, session] of pidToTrackedSession) {
            try {
                process.kill(pid, 'SIGTERM');
                logger.debug(`[DAEMON RUN] Killed tracked session PID ${pid} (${session.remcliSessionId || 'no session id'})`);
            } catch {
                // Process may have already exited
            }
        }
        pidToTrackedSession.clear();

        // Kill all tmux sessions created by this daemon
        try {
            for (const sessionName of daemonTmuxSessions) {
                try {
                    execSync(`tmux kill-session -t ${sessionName}`, { stdio: 'ignore' });
                    logger.debug(`[DAEMON RUN] Killed tmux session "${sessionName}"`);
                } catch {
                    // Session may have already exited
                }
            }
            daemonTmuxSessions.clear();
        } catch {
            // tmux may not be available
        }
    };

    return {
        getChildren,
        spawnSession,
        stopSession,
        onRemcliSessionWebhook,
        pruneDeadSessions,
        killAllSessions
    };
}
