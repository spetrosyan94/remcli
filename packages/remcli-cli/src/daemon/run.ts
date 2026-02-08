import fs from 'fs/promises';
import os from 'os';
import * as tmp from 'tmp';

import { TrackedSession } from './types';
import { MachineMetadata, Metadata } from '@/api/types';
import { SpawnSessionOptions, SpawnSessionResult, registerCommonHandlers } from '@/modules/common/registerCommonHandlers';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { spawnRemcliCLI } from '@/utils/spawnRemcliCLI';
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readSettings, validateProfileForAgent, getProfileEnvironmentVariables } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledRemcliVersion, stopDaemon } from './controlClient';
import { findAllRemcliProcesses } from './doctor';
import { startDaemonControlServer } from './controlServer';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { projectPath } from '@/projectPath';
import { getTmuxUtilities, isTmuxAvailable } from '@/utils/tmux';
import { expandEnvironmentVariables } from '@/utils/expandEnvVars';
import { P2PStore } from './p2p/p2pStore';
import { startP2PServer, P2PServer } from './p2p/p2pServer';
import { generateSharedSecret, encodeSharedSecret, deriveBearerToken } from './p2p/p2pAuth';
import { getLanIPAddress } from './p2p/networkUtils';
import { buildP2PConnectionInfo, buildP2PQRUrl, displayP2PQRCode, displayP2PConnectionStatus } from './p2p/p2pQRCode';
import { startNgrokTunnel } from './p2p/tunnel';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { openTerminalWithCommand } from '@/utils/openTerminal';

// Track whether we've already opened a terminal for the tmux session
let terminalOpenedForTmux = false;

// Prepare initial metadata
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname(),
  platform: os.platform(),
  remcliCliVersion: packageJson.version,
  homeDir: os.homedir(),
  remcliHomeDir: configuration.remcliHomeDir,
  remcliLibDir: projectPath()
};

// Get environment variables for a profile, filtered for agent compatibility
async function getProfileEnvironmentVariablesForAgent(
  profileId: string,
  agentType: 'claude' | 'codex' | 'gemini'
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

/**
 * Resolve path to the web app build directory.
 * Checks (in order): REMCLI_WEB_DIR env, monorepo relative to dist/, monorepo from cwd.
 */
function resolveWebAppDir(): string | undefined {
    // 1. Explicit env var
    if (process.env.REMCLI_WEB_DIR) {
        const dir = resolve(process.env.REMCLI_WEB_DIR);
        if (existsSync(join(dir, 'index.html'))) return dir;
        logger.debug(`[DAEMON RUN] REMCLI_WEB_DIR=${dir} does not contain index.html`);
    }

    // 2. Relative to CLI package root (projectPath() = packages/remcli-cli/)
    const fromProject = resolve(projectPath(), '../remcli-app/dist');
    if (existsSync(join(fromProject, 'index.html'))) return fromProject;

    // 3. From cwd (running from monorepo root)
    const fromCwd = resolve(process.cwd(), 'packages/remcli-app/dist');
    if (existsSync(join(fromCwd, 'index.html'))) return fromCwd;

    return undefined;
}

export async function startDaemon(): Promise<void> {
  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let requestShutdown: (source: 'remcli-app' | 'remcli-cli' | 'os-signal' | 'exception', errorMessage?: string) => void;
  let resolvesWhenShutdownRequested = new Promise<({ source: 'remcli-app' | 'remcli-cli' | 'os-signal' | 'exception', errorMessage?: string })>((resolve) => {
    requestShutdown = (source, errorMessage) => {
      logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage})`);

      // Fallback - in case startup malfunctions - we will force exit the process with code 1
      setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100))

        process.exit(1);
      }, 1_000);

      // Start graceful shutdown
      resolve({ source, errorMessage });
    };
  });

  // Setup signal handlers
  process.on('SIGINT', () => {
    logger.debug('[DAEMON RUN] Received SIGINT');
    requestShutdown('os-signal');
  });

  process.on('SIGTERM', () => {
    logger.debug('[DAEMON RUN] Received SIGTERM');
    requestShutdown('os-signal');
  });

  process.on('uncaughtException', (error) => {
    logger.debug('[DAEMON RUN] FATAL: Uncaught exception', error);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.debug('[DAEMON RUN] FATAL: Unhandled promise rejection', reason);
    logger.debug(`[DAEMON RUN] Rejected promise:`, promise);
    const error = reason instanceof Error ? reason : new Error(`Unhandled promise rejection: ${reason}`);
    logger.debug(`[DAEMON RUN] Stack trace: ${error.stack}`);
    requestShutdown('exception', error.message);
  });

  process.on('exit', (code) => {
    logger.debug(`[DAEMON RUN] Process exiting with code: ${code}`);
  });

  process.on('beforeExit', (code) => {
    logger.debug(`[DAEMON RUN] Process about to exit with code: ${code}`);
  });

  logger.debug('[DAEMON RUN] Starting daemon process...');
  logger.debugLargeJson('[DAEMON RUN] Environment', getEnvironmentInfo());

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledRemcliVersion();
  if (!runningDaemonVersionMatches) {
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    await stopDaemon();
  } else {
    logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
    console.log('Daemon already running with matching version');
    process.exit(0);
  }

  // Acquire exclusive lock (proves daemon is running)
  const daemonLockHandle = await acquireDaemonLock(5, 200);
  if (!daemonLockHandle) {
    logger.debug('[DAEMON RUN] Daemon lock file already held, another daemon is running');
    process.exit(0);
  }

  // At this point we should be safe to startup the daemon:
  // 1. Not have a stale daemon state
  // 2. Should not have another daemon process running

  // Kill orphaned sessions from previous daemon (they have stale P2P credentials)
  try {
    const allProcesses = await findAllRemcliProcesses();
    const orphanedSessions = allProcesses.filter(p =>
      (p.type === 'daemon-spawned-session' || p.type === 'dev-daemon-spawned') &&
      p.pid !== process.pid
    );
    for (const orphan of orphanedSessions) {
      try {
        process.kill(orphan.pid, 'SIGTERM');
        logger.debug(`[DAEMON RUN] Killed orphaned session PID ${orphan.pid}`);
      } catch {
        // Process may have already exited
      }
    }
    if (orphanedSessions.length > 0) {
      logger.debug(`[DAEMON RUN] Cleaned up ${orphanedSessions.length} orphaned session(s)`);
    }
  } catch (error) {
    logger.debug('[DAEMON RUN] Orphan cleanup failed, continuing startup:', error);
  }

  // Verify tmux is available (required for session spawning)
  const tmuxAvailable = await isTmuxAvailable();
  if (!tmuxAvailable) {
    console.error('Error: tmux is required for remcli daemon. Install it with: brew install tmux');
    logger.debug('[DAEMON RUN] tmux not found, aborting daemon startup');
    await releaseDaemonLock(daemonLockHandle);
    process.exit(1);
  }
  logger.debug('[DAEMON RUN] tmux is available');

  try {
    // Start caffeinate
    const caffeinateStarted = startCaffeinate();
    if (caffeinateStarted) {
      logger.debug('[DAEMON RUN] Sleep prevention enabled');
    }

    // Generate P2P shared secret for this daemon session
    const sharedSecret = generateSharedSecret();
    const bearerToken = deriveBearerToken(sharedSecret);
    logger.debug('[DAEMON RUN] P2P shared secret generated');

    // Setup state - key by PID
    const pidToTrackedSession = new Map<number, TrackedSession>();

    // Session spawning awaiter system
    const pidToAwaiter = new Map<number, (session: TrackedSession) => void>();

    // Helper functions
    const getCurrentChildren = () => Array.from(pidToTrackedSession.values());

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

      const { directory, sessionId, machineId, approvedNewDirectoryCreation = true } = options;
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

        // Get tmux session name from profile or use default
        const tmuxSessionName: string = extraEnv.TMUX_SESSION_NAME ?? 'remcli';

        // Spawn in tmux session
        const sessionDesc = tmuxSessionName || 'current/most recent session';
          logger.debug(`[DAEMON RUN] Attempting to spawn session in tmux: ${sessionDesc}`);

          const tmux = getTmuxUtilities(tmuxSessionName);

          // Construct command for the CLI
          const cliPath = join(projectPath(), 'dist', 'index.mjs');
          // Determine agent command - support claude, codex, and gemini
          const agent = options.agent === 'gemini' ? 'gemini' : (options.agent === 'codex' ? 'codex' : 'claude');
          const fullCommand = `node --no-warnings --no-deprecation ${cliPath} ${agent} --remcli-starting-mode remote --started-by daemon`;

          // Spawn in tmux with environment variables
          // IMPORTANT: Pass complete environment (process.env + extraEnv) because:
          // 1. tmux sessions need daemon's expanded auth variables (e.g., ANTHROPIC_AUTH_TOKEN)
          // 2. Regular spawn uses env: { ...process.env, ...extraEnv }
          // 3. tmux needs explicit environment via -e flags to ensure all variables are available
          const windowName = `remcli-${Date.now()}-${agent}`;
          const tmuxEnv: Record<string, string> = {};

          // Add all daemon environment variables (filtering out undefined)
          for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
              tmuxEnv[key] = value;
            }
          }

          // Add extra environment variables (these should already be filtered)
          Object.assign(tmuxEnv, extraEnv);

          const tmuxResult = await tmux.spawnInTmux([fullCommand], {
            sessionName: tmuxSessionName,
            windowName: windowName,
            cwd: directory
          }, tmuxEnv);  // Pass complete environment for tmux session

          if (tmuxResult.success) {
            logger.debug(`[DAEMON RUN] Successfully spawned in tmux session: ${tmuxResult.sessionId}, PID: ${tmuxResult.pid}`);

            // Validate we got a PID from tmux
            if (!tmuxResult.pid) {
              throw new Error('Tmux window created but no PID returned');
            }

            // Create a tracked session for tmux windows - now we have the real PID!
            const trackedSession: TrackedSession = {
              startedBy: 'daemon',
              pid: tmuxResult.pid, // Real PID from tmux -P flag
              tmuxSessionId: tmuxResult.sessionId,
              directoryCreated,
              message: directoryCreated
                ? `The path '${directory}' did not exist. We created a new folder and spawned a new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
                : `Spawned new session in tmux session '${tmuxSessionName}'. Use 'tmux attach -t ${tmuxSessionName}' to view the session.`
            };

            // Add to tracking map so webhook can find it later
            pidToTrackedSession.set(tmuxResult.pid, trackedSession);

            // Auto-open terminal with tmux attach if no client is attached yet
            if (!terminalOpenedForTmux) {
              try {
                const tmux = getTmuxUtilities(tmuxSessionName);
                const clientsResult = await tmux.executeTmuxCommand(['list-clients', '-t', tmuxSessionName]);
                const hasClients = clientsResult && clientsResult.returncode === 0 && clientsResult.stdout.trim().length > 0;

                if (!hasClients) {
                  terminalOpenedForTmux = true;
                  openTerminalWithCommand(`tmux attach -t ${tmuxSessionName}`);
                  logger.debug(`[DAEMON RUN] Opened terminal with tmux attach -t ${tmuxSessionName}`);
                } else {
                  logger.debug(`[DAEMON RUN] tmux session already has attached clients, skipping terminal open`);
                }
              } catch (error) {
                logger.debug(`[DAEMON RUN] Failed to check/open terminal for tmux:`, error);
              }
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
    const stopSession = (sessionId: string): boolean => {
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
          return true;
        }
      }

      logger.debug(`[DAEMON RUN] Session ${sessionId} not found`);
      return false;
    };

    // Handle child process exit
    const onChildExited = (pid: number) => {
      logger.debug(`[DAEMON RUN] Removing exited process PID ${pid} from tracking`);
      pidToTrackedSession.delete(pid);
    };

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: getCurrentChildren,
      stopSession,
      spawnSession,
      requestShutdown: () => requestShutdown('remcli-cli'),
      onRemcliSessionWebhook
    });

    // Write initial daemon state (no lock needed for state file)
    const fileState: DaemonLocallyPersistedState = {
      pid: process.pid,
      httpPort: controlPort,
      startTime: new Date().toLocaleString(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath
    };
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state written');

    // ─── P2P Server ──────────────────────────────────────────────
    // Load P2P store from disk
    const p2pStore = new P2PStore();
    // Start with a fresh store — each daemon session generates a new shared secret,
    // so old sessions/machines encrypted with the previous key are unusable.
    logger.debug('[DAEMON RUN] P2P store initialized (fresh — new shared secret)');

    // Determine LAN IP address
    const lanIP = getLanIPAddress() || '0.0.0.0';
    logger.debug(`[DAEMON RUN] LAN IP: ${lanIP}`);

    // Resolve web app build directory for static serving
    const webAppDir = resolveWebAppDir();
    if (webAppDir) {
        logger.debug(`[DAEMON RUN] Web app build found: ${webAppDir}`);
    } else {
        logger.debug('[DAEMON RUN] No web app build found — QR will still work but browser cannot load the app from daemon');
        console.log('  Warning: Web app build not found. Run "npm run build:web" first for QR→browser flow.');
    }

    // Start P2P server
    let p2pServer: P2PServer;
    try {
        p2pServer = await startP2PServer({
            port: 0,  // Random available port
            host: '0.0.0.0',
            sharedSecret,
            store: p2pStore,
            getChildren: getCurrentChildren,
            stopSession,
            spawnSession,
            requestShutdown: () => requestShutdown('remcli-app'),
            onRemcliSessionWebhook,
            webAppDir
        });
        logger.debug(`[DAEMON RUN] P2P server started on port ${p2pServer.port}`);
    } catch (error) {
        logger.debug('[DAEMON RUN] Failed to start P2P server:', error);
        throw error;
    }

    // Update daemon state with P2P info
    fileState.p2pPort = p2pServer.port;
    fileState.p2pHost = lanIP;
    fileState.p2pSharedSecret = encodeSharedSecret(sharedSecret);
    writeDaemonState(fileState);
    logger.debug('[DAEMON RUN] Daemon state updated with P2P info');

    // Register machine in P2P store
    const machineId = `machine-${process.pid}-${Date.now()}`;
    p2pStore.getOrCreateMachine(
        machineId,
        JSON.stringify(initialMachineMetadata),
        JSON.stringify({ status: 'running', pid: process.pid, httpPort: controlPort, startedAt: Date.now() }),
        null
    );
    logger.debug(`[DAEMON RUN] Machine registered in P2P store: ${machineId}`);

    // ─── Self-connect as machine client for RPC handling ────────────
    // In P2P mode, the daemon IS the server. To handle RPC calls from the
    // mobile app (e.g., spawn-remcli-session), the daemon connects to its
    // own P2P server as a machine-scoped Socket.IO client and registers
    // RPC handlers via the existing forwarding mechanism.
    const machineSocket: ClientSocket = ioClient(`http://127.0.0.1:${p2pServer.port}`, {
        transports: ['websocket'],
        auth: {
            token: bearerToken,
            clientType: 'machine-scoped',
            machineId
        },
        path: '/v1/updates',
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
    });

    const machineRpcManager = new RpcHandlerManager({
        scopePrefix: machineId,
        encryptionKey: sharedSecret,
        encryptionVariant: 'legacy',
        logger: (msg, data) => logger.debug(msg, data)
    });

    // Register common handlers (bash, readFile, listDirectory, etc.)
    registerCommonHandlers(machineRpcManager, process.cwd());

    // Register daemon-specific RPC handlers
    machineRpcManager.registerHandler('spawn-remcli-session', async (params: any) => {
        const { directory, sessionId: sid, machineId: targetMachineId, approvedNewDirectoryCreation, agent, token, environmentVariables } = params || {};
        logger.debugLargeJson('[DAEMON RUN] RPC spawn-remcli-session', params);

        if (!directory) {
            throw new Error('Directory is required');
        }

        const result = await spawnSession({
            directory,
            sessionId: sid,
            machineId: targetMachineId,
            approvedNewDirectoryCreation,
            agent,
            token,
            environmentVariables
        });

        switch (result.type) {
            case 'success':
                logger.debug(`[DAEMON RUN] RPC spawned session ${result.sessionId}`);
                return { type: 'success', sessionId: result.sessionId };
            case 'requestToApproveDirectoryCreation':
                logger.debug(`[DAEMON RUN] RPC requesting directory approval: ${result.directory}`);
                return { type: 'requestToApproveDirectoryCreation', directory: result.directory };
            case 'error':
                throw new Error(result.errorMessage);
        }
    });

    machineRpcManager.registerHandler('stop-session', (params: any) => {
        const { sessionId: targetSessionId } = params || {};
        if (!targetSessionId) {
            throw new Error('Session ID is required');
        }

        const success = stopSession(targetSessionId);
        if (!success) {
            throw new Error('Session not found or failed to stop');
        }

        logger.debug(`[DAEMON RUN] RPC stopped session ${targetSessionId}`);
        return { message: 'Session stopped' };
    });

    machineRpcManager.registerHandler('stop-daemon', () => {
        logger.debug('[DAEMON RUN] RPC stop-daemon received');
        setTimeout(() => requestShutdown('remcli-app'), 100);
        return { message: 'Daemon stop request acknowledged' };
    });

    machineSocket.on('connect', () => {
        logger.debug('[DAEMON RUN] Machine RPC socket connected to own P2P server');
        machineRpcManager.onSocketConnect(machineSocket);
    });

    machineSocket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: string) => void) => {
        logger.debug(`[DAEMON RUN] Machine RPC request: ${data.method}`);
        callback(await machineRpcManager.handleRequest(data));
    });

    machineSocket.on('disconnect', () => {
        logger.debug('[DAEMON RUN] Machine RPC socket disconnected');
        machineRpcManager.onSocketDisconnect();
    });

    machineSocket.on('connect_error', (error: Error) => {
        logger.debug(`[DAEMON RUN] Machine RPC socket error: ${error.message}`);
    });

    logger.debug('[DAEMON RUN] Machine RPC socket connecting to own P2P server');

    // Optionally start ngrok tunnel for remote access
    const useTunnel = process.argv.includes('--tunnel') || process.env.REMCLI_TUNNEL === 'true';
    let tunnelStop: (() => void) | null = null;
    let tunnelUrl: string | undefined;

    if (useTunnel) {
        console.log('  Starting ngrok tunnel for remote access...');
        const tunnel = await startNgrokTunnel(p2pServer.port);
        if (tunnel) {
            tunnelUrl = tunnel.url;
            tunnelStop = tunnel.stop;
            fileState.tunnelUrl = tunnelUrl;
            writeDaemonState(fileState);
            logger.debug(`[DAEMON RUN] Tunnel started: ${tunnelUrl}`);

            // Show QR with tunnel URL (accessible from anywhere)
            // Keep full URL with protocol in host field — app needs it to connect
            const tunnelConnectionInfo = buildP2PConnectionInfo(tunnelUrl.replace(/\/$/, ''), 0, sharedSecret);
            const tunnelQRUrl = buildP2PQRUrl(tunnelConnectionInfo, tunnelUrl);
            displayP2PQRCode(tunnelQRUrl);
            displayP2PConnectionStatus(lanIP, p2pServer.port, tunnelUrl);
        } else {
            console.log('  Failed to start tunnel, using LAN only');
            const connectionInfo = buildP2PConnectionInfo(lanIP, p2pServer.port, sharedSecret);
            const qrUrl = buildP2PQRUrl(connectionInfo);
            displayP2PQRCode(qrUrl);
            displayP2PConnectionStatus(lanIP, p2pServer.port);
        }
    } else {
        // LAN only - show QR with LAN IP
        const connectionInfo = buildP2PConnectionInfo(lanIP, p2pServer.port, sharedSecret);
        const qrUrl = buildP2PQRUrl(connectionInfo);
        displayP2PQRCode(qrUrl);
        displayP2PConnectionStatus(lanIP, p2pServer.port);
    }

    // Every 60 seconds:
    // 1. Prune stale sessions
    // 2. Check if daemon needs update
    // 3. If outdated, restart with latest version
    // 4. Write heartbeat
    const heartbeatIntervalMs = parseInt(process.env.REMCLI_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false
    const restartOnStaleVersionAndHeartbeat = setInterval(async () => {
      if (heartbeatRunning) {
        return;
      }
      heartbeatRunning = true;

      if (process.env.DEBUG) {
        logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
      }

      // Prune stale sessions
      for (const [pid, _] of pidToTrackedSession.entries()) {
        try {
          // Check if process is still alive (signal 0 doesn't kill, just checks)
          process.kill(pid, 0);
        } catch (error) {
          // Process is dead, remove from tracking
          logger.debug(`[DAEMON RUN] Removing stale session with PID ${pid} (process no longer exists)`);
          pidToTrackedSession.delete(pid);
        }
      }

      // Check if daemon needs update
      // If version on disk is different from the one in package.json - we need to restart
      // BIG if - does this get updated from underneath us on npm upgrade?
      const projectVersion = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;
      if (projectVersion !== configuration.currentCliVersion) {
        logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version, clearing heartbeat interval');

        clearInterval(restartOnStaleVersionAndHeartbeat);

        // Spawn new daemon through the CLI
        // We do not need to clean ourselves up - we will be killed by
        // the CLI start command.
        // 1. It will first check if daemon is running (yes in this case)
        // 2. If the version is stale (it will read daemon.state.json file and check startedWithCliVersion) & compare it to its own version
        // 3. Next it will start a new daemon with the latest version with daemon-sync :D
        // Done!
        try {
          spawnRemcliCLI(['daemon', 'start'], {
            detached: true,
            stdio: 'ignore'
          });
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
        }

        // So we can just hang forever
        logger.debug('[DAEMON RUN] Hanging for a bit - waiting for CLI to kill us because we are running outdated version of the code');
        await new Promise(resolve => setTimeout(resolve, 10_000));
        process.exit(0);
      }

      // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
      // Race condition is possible, but thats okay for the time being :D
      const daemonState = await readDaemonState();
      if (daemonState && daemonState.pid !== process.pid) {
        logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.')
        requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.')
      }

      // Heartbeat
      try {
        const updatedState: DaemonLocallyPersistedState = {
          pid: process.pid,
          httpPort: controlPort,
          startTime: fileState.startTime,
          startedWithCliVersion: packageJson.version,
          lastHeartbeat: new Date().toLocaleString(),
          daemonLogPath: fileState.daemonLogPath,
          p2pPort: p2pServer.port,
          p2pHost: lanIP,
          p2pSharedSecret: encodeSharedSecret(sharedSecret),
          tunnelUrl
        };
        writeDaemonState(updatedState);
        if (process.env.DEBUG) {
          logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
        }
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
      }

      heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    // Setup signal handlers
    const cleanupAndShutdown = async (source: 'remcli-app' | 'remcli-cli' | 'os-signal' | 'exception', errorMessage?: string) => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);

      // Clear health check interval
      if (restartOnStaleVersionAndHeartbeat) {
        clearInterval(restartOnStaleVersionAndHeartbeat);
        logger.debug('[DAEMON RUN] Health check interval cleared');
      }

      // Disconnect machine RPC socket
      try {
        machineSocket.close();
        logger.debug('[DAEMON RUN] Machine RPC socket closed');
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to close machine RPC socket:', error);
      }

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

      // Kill tmux session created by daemon (windows already closing since processes are killed)
      try {
        const { execSync } = await import('child_process');
        execSync('tmux has-session -t remcli 2>/dev/null && tmux kill-session -t remcli', { stdio: 'ignore' });
        logger.debug('[DAEMON RUN] Killed tmux session "remcli"');
      } catch {
        // tmux session may not exist
      }

      // Stop ngrok tunnel if running
      if (tunnelStop) {
        try {
          tunnelStop();
          logger.debug('[DAEMON RUN] Tunnel stopped');
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to stop tunnel:', error);
        }
      }

      // Stop P2P server
      try {
        await p2pServer.stop();
        logger.debug('[DAEMON RUN] P2P server stopped');
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to stop P2P server:', error);
      }

      await stopControlServer();
      await cleanupDaemonState();
      await stopCaffeinate();
      await releaseDaemonLock(daemonLockHandle);

      logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
      process.exit(0);
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // Wait for shutdown request
    const shutdownRequest = await resolvesWhenShutdownRequested;
    await cleanupAndShutdown(shutdownRequest.source, shutdownRequest.errorMessage);
  } catch (error) {
    const errorMessage = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    logger.debug(`[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1: ${errorMessage}`);
    process.exit(1);
  }
}
