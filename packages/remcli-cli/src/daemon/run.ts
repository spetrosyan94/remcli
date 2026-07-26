import os from 'os';

import { MachineMetadata } from '@/api/types';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import {
  DAEMON_STATE_SCHEMA_VERSION,
  writeDaemonState,
  readDaemonState,
  type DaemonLocallyPersistedState,
  type DaemonStateReason,
  acquireDaemonLock,
  releaseDaemonLock,
  updateSettings,
} from '@/persistence';
import { randomUUID } from 'node:crypto';

import {
  getLiveLegacyDaemonMigrationBlocker,
  isDaemonRunningCurrentlyInstalledRemcliVersion,
  isVerifiedDaemonLive,
  LEGACY_DAEMON_MIGRATION_MESSAGE,
  stopDaemon,
  waitForVerifiedDaemonToStop,
} from './controlClient';
import { findAllRemcliProcesses } from './doctor';
import { startDaemonControlServer } from './controlServer';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { projectPath } from '@/projectPath';
import { isTmuxAvailable } from '@/utils/tmux';
import { P2PStore } from './p2p/p2pStore';
import { startP2PServer, P2PServer } from './p2p/p2pServer';
import { P2PRunnerCredentialStore } from './p2p/p2pRunnerCredentials';
import { publishSessionActivity } from './p2p/p2pSessionLifecycle';
import { createStoppedSessionLifecycleHandler } from './sessionLifecycle';
import { deriveBearerToken } from './p2p/p2pAuth';
import { loadOrCreatePairing, replacePairing, updatePairingPort } from './p2p/p2pPairing';
import { getLanIPAddress } from './p2p/networkUtils';
import { buildP2PConnectionInfo, buildP2PQRUrl, displayP2PQRCode, displayP2PConnectionStatus } from './p2p/p2pQRCode';
import { startCloudflaredTunnel, isCloudflaredAvailable } from './p2p/tunnel';
import { freeWhisper } from './whisper/whisperService';
import { initTtsProvider, stopTts } from './tts/ttsService';
import { createSessionManager } from './sessionSpawner';
import { ConciergeDeps } from './concierge/types';
import { bootstrapMachineSocket } from './machineSocket';
import { startHeartbeatLoop } from './heartbeat';
import { startCodexAppServerHost, type CodexAppServerHostHandle } from '@/codex/codexAppServerHost';
import { CodexCapabilitiesService } from '@/codex/codexCapabilities';
import { CursorCapabilitiesService } from '@/cursor/cursorCapabilities';
import { PairingRekeyCoordinator } from './p2p/pairingRekey';
import { redactDiagnosticData } from '@/utils/redaction';
import { spawnRemcliCLI } from '@/utils/spawnRemcliCLI';
import QRCode from 'qrcode';

// Prepare initial metadata
export const initialMachineMetadata: MachineMetadata = {
  host: os.hostname(),
  platform: os.platform(),
  remcliCliVersion: packageJson.version,
  homeDir: os.homedir(),
  remcliHomeDir: configuration.remcliHomeDir,
  remcliLibDir: projectPath()
};

/**
 * Resolve path to the web client build directory (remcli-web, Vite).
 * Checks (in order): REMCLI_WEB_DIR env, monorepo remcli-web/dist (dev),
 * bundled web-dist/ inside the published package, monorepo from cwd.
 */
function resolveWebAppDir(): string | undefined {
    // 1. Explicit env var
    if (process.env.REMCLI_WEB_DIR) {
        const dir = resolve(process.env.REMCLI_WEB_DIR);
        if (existsSync(join(dir, 'index.html'))) return dir;
        logger.debug(`[DAEMON RUN] REMCLI_WEB_DIR=${dir} does not contain index.html`);
    }

    // 2. Monorepo dev: fresh Vite build next to the CLI package (projectPath() = packages/remcli-cli/)
    const fromProject = resolve(projectPath(), '../remcli-web/dist');
    if (existsSync(join(fromProject, 'index.html'))) return fromProject;

    // 3. Published package: web client bundled at build time by scripts/copy-web-dist.cjs
    const bundled = join(projectPath(), 'web-dist');
    if (existsSync(join(bundled, 'index.html'))) return bundled;

    // 4. From cwd (running from monorepo root)
    const fromCwd = resolve(process.cwd(), 'packages/remcli-web/dist');
    if (existsSync(join(fromCwd, 'index.html'))) return fromCwd;

    return undefined;
}

export interface DaemonShutdownDependencies {
    machineSocketHandle: ReturnType<typeof bootstrapMachineSocket> | null;
    killAllSessions: () => Promise<void>;
    codexAppServerHost: CodexAppServerHostHandle | null;
    tunnelStop: (() => void) | null;
    freeWhisper: () => Promise<void>;
    stopTts: () => Promise<void>;
    flushP2PStore: () => void;
    stopP2PServer: () => Promise<void>;
    stopControlServer: () => Promise<void>;
    persistStoppedState: () => Promise<void>;
    stopCaffeinate: () => Promise<void>;
    releaseDaemonLock: () => Promise<void>;
    restartAfterRelease?: () => boolean | void;
}

type ExitProcess = (code: number) => void;
type ShutdownSource = 'remcli-web' | 'remcli-cli' | 'os-signal' | 'exception';

function shutdownSourceToStateReason(source: ShutdownSource): DaemonStateReason {
    switch (source) {
        case 'remcli-web':
            return 'remcli-web-request';
        case 'remcli-cli':
            return 'remcli-cli-request';
        case 'os-signal':
            return 'os-signal';
        case 'exception':
            return 'exception';
    }

    return 'exception';
}

export interface DaemonShutdownRequest {
    source: ShutdownSource;
    errorMessage?: string;
    restartAfterShutdown?: boolean;
}

export type DaemonShutdownResult = 'completed' | 'retry';

export interface DaemonShutdownLifecycleDependencies {
    waitForShutdownRequest: () => Promise<DaemonShutdownRequest>;
    cleanupAndShutdown: (request: DaemonShutdownRequest) => Promise<DaemonShutdownResult>;
}

export interface DaemonShutdownRequestChannel {
    enqueueShutdownRequest: (request: DaemonShutdownRequest) => void;
    waitForShutdownRequest: () => Promise<DaemonShutdownRequest>;
}

export interface DaemonRestartIntent {
    recordShutdownRequest: (restartAfterShutdown: boolean) => void;
    shouldRestart: () => boolean;
}

/**
 * An explicit stop must win over a pending auto-update, even if it reaches the
 * daemon while cleanup is already draining resources for that update.
 */
export function createDaemonRestartIntent(): DaemonRestartIntent {
    let isRestartRequested = false;
    let isRestartCancelled = false;

    return {
        recordShutdownRequest: (restartAfterShutdown) => {
            if (restartAfterShutdown) {
                if (!isRestartCancelled) {
                    isRestartRequested = true;
                }
                return;
            }

            isRestartRequested = false;
            isRestartCancelled = true;
        },
        shouldRestart: () => isRestartRequested && !isRestartCancelled,
    };
}

export function createDaemonReplacementArgs(useTunnel: boolean): string[] {
    return useTunnel ? ['daemon', 'start', '--tunnel'] : ['daemon', 'start'];
}

export function createDaemonReplacementStarter(
    restartIntent: DaemonRestartIntent,
    useTunnel: boolean,
    spawnReplacement: typeof spawnRemcliCLI = spawnRemcliCLI,
): () => boolean {
    return () => {
        if (!restartIntent.shouldRestart()) {
            return false;
        }

        const replacement = spawnReplacement(createDaemonReplacementArgs(useTunnel), {
            detached: true,
            stdio: 'ignore',
            env: process.env,
        });
        replacement.unref();
        return true;
    };
}

export function createDaemonShutdownRequestChannel(): DaemonShutdownRequestChannel {
    const pendingShutdownRequests: DaemonShutdownRequest[] = [];
    let resolveNextShutdownRequest: ((request: DaemonShutdownRequest) => void) | null = null;

    return {
        enqueueShutdownRequest: (request) => {
            if (resolveNextShutdownRequest) {
                const resolveShutdownRequest = resolveNextShutdownRequest;
                resolveNextShutdownRequest = null;
                resolveShutdownRequest(request);
                return;
            }

            pendingShutdownRequests.push(request);
        },
        waitForShutdownRequest: () => {
            const pendingShutdownRequest = pendingShutdownRequests.shift();
            if (pendingShutdownRequest) {
                return Promise.resolve(pendingShutdownRequest);
            }

            return new Promise<DaemonShutdownRequest>((resolve) => {
                resolveNextShutdownRequest = resolve;
            });
        },
    };
}

export async function performDaemonShutdown(
    dependencies: DaemonShutdownDependencies,
    exitProcess: ExitProcess = (code) => process.exit(code),
): Promise<DaemonShutdownResult> {

    try {
        dependencies.machineSocketHandle?.close();
        logger.debug('[DAEMON RUN] Machine RPC socket closed');
    } catch (error) {
        logger.debug('[DAEMON RUN] Failed to close machine RPC socket:', error);
    }

    try {
        await dependencies.killAllSessions();
    } catch (error) {
        logger.warn('[DAEMON RUN] Session cleanup was not confirmed; refusing clean daemon exit', error);
        throw error;
    }

    if (dependencies.codexAppServerHost) {
        try {
            await dependencies.codexAppServerHost.stop();
            logger.debug('[DAEMON RUN] Shared Codex app-server stopped');
        } catch (error) {
            logger.warn(
                '[DAEMON RUN] Failed to stop shared Codex app-server; preserving daemon ownership for retry:',
                redactDiagnosticData(error),
            );
            return 'retry';
        }
    }

    if (dependencies.tunnelStop) {
        try {
            dependencies.tunnelStop();
            logger.debug('[DAEMON RUN] Tunnel stopped');
        } catch (error) {
            logger.debug('[DAEMON RUN] Failed to stop tunnel:', error);
        }
    }

    try {
        await dependencies.freeWhisper();
        logger.debug('[DAEMON RUN] Whisper native resources freed');
    } catch (error) {
        logger.debug('[DAEMON RUN] Failed to free Whisper resources:', error);
    }

    try {
        await dependencies.stopTts();
        logger.debug('[DAEMON RUN] TTS provider stopped');
    } catch (error) {
        logger.debug('[DAEMON RUN] Failed to stop TTS provider:', error);
    }

    try {
        dependencies.flushP2PStore();
        logger.debug('[DAEMON RUN] KV store flushed to disk');
    } catch (error) {
        logger.debug('[DAEMON RUN] Failed to flush KV store to disk:', error);
        throw error;
    }

    try {
        await dependencies.stopP2PServer();
        logger.debug('[DAEMON RUN] P2P server stopped');
    } catch (error) {
        logger.debug('[DAEMON RUN] Failed to stop P2P server:', error);
    }

    await dependencies.stopControlServer();
    await dependencies.persistStoppedState();
    await dependencies.stopCaffeinate();
    await dependencies.releaseDaemonLock();
    if (dependencies.restartAfterRelease) {
        try {
            const replacementStarted = dependencies.restartAfterRelease();
            if (replacementStarted !== false) {
                logger.debug('[DAEMON RUN] Started daemon replacement after releasing the old lock');
            }
        } catch (error) {
            logger.warn('[DAEMON RUN] Failed to start daemon replacement after shutdown:', error);
        }
    }

    logger.debug('[DAEMON RUN] Cleanup completed, exiting process');
    exitProcess(0);
    return 'completed';
}

export async function runDaemonShutdownLifecycle(
    dependencies: DaemonShutdownLifecycleDependencies,
): Promise<void> {
    while (true) {
        const shutdownRequest = await dependencies.waitForShutdownRequest();
        const shutdownResult = await dependencies.cleanupAndShutdown(shutdownRequest);
        if (shutdownResult === 'completed') {
            return;
        }
    }
}

export async function startDaemon(): Promise<void> {
  const daemonInstanceId = randomUUID();
  let fileState: DaemonLocallyPersistedState | null = null;
  let runtimeStateWritesAllowed = false;
  let daemonStateWriteQueue = Promise.resolve();
  let persistDaemonState: (() => Promise<void>) | null = null;

  // We don't have cleanup function at the time of server construction
  // Control flow is:
  // 1. Create promise that will resolve when shutdown is requested
  // 2. Setup signal handlers to resolve this promise with the source of the shutdown
  // 3. Once our setup is complete - if all goes well - we await this promise
  // 4. When it resolves we can cleanup and exit
  //
  // In case the setup malfunctions - our signal handlers will not properly
  // shut down. We will force exit the process with code 1.
  let startupFailureExitTimer: NodeJS.Timeout | null = null;
  let isCleanupInProgress = false;
  let isShutdownRetryPending = false;
  const restartIntent = createDaemonRestartIntent();
  const shutdownRequestChannel = createDaemonShutdownRequestChannel();
  const requestShutdown = (
    source: ShutdownSource,
    errorMessage?: string,
    restartAfterShutdown = false,
  ): void => {
    logger.debug(`[DAEMON RUN] Requesting shutdown (source: ${source}, errorMessage: ${errorMessage}, restartAfterShutdown: ${restartAfterShutdown})`);

    restartIntent.recordShutdownRequest(restartAfterShutdown);

    // A failed shared app-server stop keeps the daemon alive for an explicit retry.
    if (!isCleanupInProgress && !isShutdownRetryPending && !startupFailureExitTimer) {
      startupFailureExitTimer = setTimeout(async () => {
        logger.debug('[DAEMON RUN] Startup malfunctioned, forcing exit with code 1');

        // Give time for logs to be flushed
        await new Promise(resolve => setTimeout(resolve, 100));

        process.exit(1);
      }, 1_000);
    }

    shutdownRequestChannel.enqueueShutdownRequest({ source, errorMessage, restartAfterShutdown });
  };

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

  if (await getLiveLegacyDaemonMigrationBlocker()) {
    logger.warn('[DAEMON RUN] Refusing to replace a live legacy daemon without instance identity.');
    console.error(LEGACY_DAEMON_MIGRATION_MESSAGE);
    process.exit(1);
  }

  // Check if already running
  // Check if running daemon version matches current CLI version
  const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledRemcliVersion();
  if (!runningDaemonVersionMatches) {
    logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
    if (await isVerifiedDaemonLive()) {
      await stopDaemon();
      if (!await waitForVerifiedDaemonToStop()) {
        console.error('Daemon did not stop in time; refusing to acquire its lock.');
        process.exit(1);
      }
    }
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

    // Pairing v2 separates revocable connection auth from stable content
    // encryption. Rotating a QR therefore does not break active agent runners.
    let pairing = loadOrCreatePairing();
    logger.debug('[DAEMON RUN] P2P pairing loaded (persistent split secrets)');

    const p2pStore = new P2PStore();
    logger.debug('[DAEMON RUN] P2P store initialized (in-memory, persistent pairing secret)');

    const runnerCredentialStore = new P2PRunnerCredentialStore();
    let publishStoppedSessionInactive: ((sessionId: string) => void) | null = null;
    const handleSessionStopped = createStoppedSessionLifecycleHandler({
        p2pStore,
        runnerCredentialStore,
        getInactivePublisher: () => publishStoppedSessionInactive ?? undefined,
        onInactivePublisherUnavailable: (sessionId) => {
            logger.debug(`[DAEMON RUN] Stopped session ${sessionId} before P2P lifecycle publisher was ready`);
        },
    });
    // Session manager owns tracked child sessions and emits every confirmed stop path.
    const sessionManager = createSessionManager({
        onSessionStopped: handleSessionStopped,
        onOwnedChildrenChanged: () => {
            const persist = persistDaemonState;
            if (persist) {
                void persist().catch((error) => {
                    logger.warn('[DAEMON RUN] Failed to queue daemon-owned child diagnostics:', error);
                });
            }
        },
    });

    const persistCurrentDaemonState = async (): Promise<void> => {
      if (!fileState) {
        return;
      }

      const stateOnDisk = await readDaemonState();
      if (!stateOnDisk || stateOnDisk.instanceId !== daemonInstanceId) {
        logger.warn('[DAEMON RUN] Refusing to overwrite a daemon state snapshot owned by another instance.');
        if (runtimeStateWritesAllowed) {
          runtimeStateWritesAllowed = false;
          requestShutdown('exception', 'Daemon state ownership changed.');
        }
        return;
      }

      fileState = {
        ...fileState,
        ownedChildPids: Array.from(new Set([
          ...sessionManager.getConfirmedOwnedChildPids(),
          ...(fileState.codexAppServerPid ? [fileState.codexAppServerPid] : []),
        ])).sort((left, right) => left - right),
      };
      writeDaemonState(fileState);
    };

    persistDaemonState = (): Promise<void> => {
      const write = daemonStateWriteQueue.then(persistCurrentDaemonState);
      daemonStateWriteQueue = write.catch((error) => {
        logger.warn('[DAEMON RUN] Failed to persist daemon lifecycle state:', error);
      });
      return write;
    };

    let p2pServer: P2PServer | null = null;
    let machineSocketHandle: ReturnType<typeof bootstrapMachineSocket> | null = null;
    let codexCapabilities: CodexCapabilitiesService | null = null;
    let cursorCapabilities: CursorCapabilitiesService | null = null;
    let machineId = '';
    let tunnelStop: (() => void) | null = null;
    let tunnelUrl: string | undefined;

    const pairingRekeyCoordinator = new PairingRekeyCoordinator({
      currentSecrets: () => ({
        authSecret: pairing.authSecret,
        contentSecret: pairing.contentSecret,
      }),
      createQrPayload: async (secrets) => {
        if (!p2pServer) {
          throw new Error('P2P server is not ready');
        }
        const info = tunnelUrl
          ? buildP2PConnectionInfo(tunnelUrl.replace(/\/$/, ''), 0, secrets)
          : buildP2PConnectionInfo(getLanIPAddress() || '0.0.0.0', p2pServer.port, secrets);
        const qrUrl = buildP2PQRUrl(info, tunnelUrl);
        return {
          qrUrl,
          qrDataUrl: await QRCode.toDataURL(qrUrl, {
            errorCorrectionLevel: 'L',
            margin: 1,
            width: 320,
          }),
        };
      },
      rotateAuthSecret: async (nextAuthSecret) => {
        if (!p2pServer) {
          throw new Error('P2P server is not ready');
        }
        const nextPairing = replacePairing({
          ...pairing,
          authSecret: nextAuthSecret,
        });
        p2pServer.rotateAuthSecret(nextPairing.authSecret);
        pairing = nextPairing;

        // The daemon's self-machine is intentionally reconnected with the new
        // bearer; session runners retain their stable content secret and lease.
        setTimeout(() => {
          if (!p2pServer || !machineId || !codexCapabilities || !cursorCapabilities) return;
          machineSocketHandle?.close();
          machineSocketHandle = bootstrapMachineSocket({
            p2pPort: p2pServer.port,
            machineId,
            bearerToken: deriveBearerToken(pairing.authSecret),
            contentSecret: pairing.contentSecret,
            pairingRekeyCoordinator,
            codexCapabilities,
            cursorCapabilities,
            spawnSession: sessionManager.spawnSession,
            stopSession: sessionManager.stopSession,
            requestShutdown: () => requestShutdown('remcli-web'),
          });
        }, 0);
      },
    });

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      instanceId: daemonInstanceId,
      getChildren: sessionManager.getChildren,
      stopSession: sessionManager.stopSession,
      spawnSession: sessionManager.spawnSession,
      requestShutdown: () => requestShutdown('remcli-cli'),
      onExplicitStopRequested: () => restartIntent.recordShutdownRequest(false),
      onRemcliSessionWebhook: sessionManager.onRemcliSessionWebhook,
      issueSessionRunnerCredential: (sessionId, owner) => runnerCredentialStore.issue(sessionId, owner),
      verifySessionRunnerCredential: (sessionId, credential) => runnerCredentialStore.verify(sessionId, credential),
      bindNativeCodexThread: sessionManager.bindNativeCodexThread,
      bindNativeCursorSession: sessionManager.bindNativeCursorSession,
      acquireCursorHeadlessWriterLease: sessionManager.acquireCursorHeadlessWriterLease,
      releaseCursorNativeWriterLease: sessionManager.releaseCursorNativeWriterLease,
      preflightCursorRunner: sessionManager.preflightCursorRunner,
      reportCursorRunnerBootstrapFailure: sessionManager.reportCursorRunnerBootstrapFailure,
      markDaemonRunnerStopping: sessionManager.markDaemonRunnerStopping,
      completeDaemonRunnerStopping: sessionManager.completeDaemonRunnerStopping,
      openCodexRemoteTui: sessionManager.openCodexRemoteTui,
      approvePairingRekey: (requestId, approvalCode) => pairingRekeyCoordinator.approve(requestId, approvalCode),
    });

    // Write the first owner-bound lifecycle snapshot after the control server is ready.
    fileState = {
      schemaVersion: DAEMON_STATE_SCHEMA_VERSION,
      instanceId: daemonInstanceId,
      state: 'starting',
      stateReason: 'startup',
      pid: process.pid,
      httpPort: controlPort,
      startedAtMs: Date.now(),
      startedWithCliVersion: packageJson.version,
      daemonLogPath: logger.logFilePath,
      ownedChildPids: [],
    };
    codexCapabilities = new CodexCapabilitiesService({
      getAppServerState: () => ({
        codexAppServerEndpoint: fileState?.codexAppServerEndpoint,
        codexAppServerPid: fileState?.codexAppServerPid,
      }),
    });
    cursorCapabilities = new CursorCapabilitiesService();
    writeDaemonState(fileState);
    runtimeStateWritesAllowed = true;
    logger.debug('[DAEMON RUN] Daemon state written');

    let codexAppServerHost: CodexAppServerHostHandle | null = null;
    try {
        codexAppServerHost = await startCodexAppServerHost();
        fileState.codexAppServerEndpoint = codexAppServerHost.endpoint;
        fileState.codexAppServerPid = codexAppServerHost.processId;
        await persistDaemonState();
        logger.debug(`[DAEMON RUN] Shared Codex app-server ready at ${codexAppServerHost.endpoint}`);
    } catch (error) {
        logger.debug('[DAEMON RUN] Shared Codex app-server unavailable; Codex sessions will report a transport error if used:', error);
        console.log('  Warning: Codex app-server could not start. Codex sessions require the codex CLI app-server.');
    }

    // ─── P2P Server ──────────────────────────────────────────────
    // Determine LAN IP address
    const lanIP = getLanIPAddress() || '0.0.0.0';
    logger.debug(`[DAEMON RUN] LAN IP: ${lanIP}`);

    // Resolve web app build directory for static serving
    const webAppDir = resolveWebAppDir();
    if (webAppDir) {
        logger.debug(`[DAEMON RUN] Web app build found: ${webAppDir}`);
    } else {
        logger.debug('[DAEMON RUN] No web client build found — QR will still work but browser cannot load the app from daemon');
        console.log('  Warning: Web client build not found. Run "npm -w remcli-web run build" (or set REMCLI_WEB_DIR) for QR→browser flow.');
    }

    // Local concierge capabilities — deterministic daemon data the assistant may route into.
    // Reads mutable `fileState` for port/tunnel at call time (populated after P2P server starts).
    const daemonStartMs = Date.now();
    const conciergeDeps: ConciergeDeps = {
        listSessions: () => sessionManager.getChildren().map((s) => ({
            id: s.remcliSessionId ?? `PID-${s.pid}`,
            agent: s.remcliSessionMetadataFromLocalWebhook?.flavor ?? 'unknown',
            directory: s.remcliSessionMetadataFromLocalWebhook?.path ?? 'unknown',
            status: s.remcliSessionMetadataFromLocalWebhook?.lifecycleState ?? 'running',
        })),
        spawnSession: sessionManager.spawnSession,
        getDefaultCursorSelection: async () => {
            const capabilities = cursorCapabilities;
            if (!capabilities) return null;
            return await capabilities.getDefaultSelection();
        },
        getDefaultCodexSelection: async () => {
            const capabilities = codexCapabilities;
            if (!capabilities) return null;
            return await capabilities.getDefaultSelection();
        },
        getDaemonStatus: () => ({
            version: packageJson.version,
            uptimeSec: Math.floor((Date.now() - daemonStartMs) / 1000),
            port: fileState?.p2pPort ?? 0,
            tunnelUrl: fileState?.tunnelUrl ?? null,
        }),
    };

    // Start P2P server — prefer the persisted port so QR codes stay valid across restarts
    // (pairing.port is 0 on first run → random available port)
    let startedP2PServer: P2PServer;
    try {
        startedP2PServer = await startP2PServer({
            port: pairing.port,
            host: '0.0.0.0',
            authSecret: pairing.authSecret,
            store: p2pStore,
            runnerCredentialStore,
            webAppDir,
            conciergeDeps,
            pairingRekeyDeliveryReader: pairingRekeyCoordinator,
        });
    } catch (error) {
        const isPortTaken = pairing.port !== 0 && (error as NodeJS.ErrnoException)?.code === 'EADDRINUSE';
        if (!isPortTaken) {
            logger.debug('[DAEMON RUN] Failed to start P2P server:', error);
            throw error;
        }
        logger.debug(`[DAEMON RUN] Saved P2P port ${pairing.port} is busy, falling back to a random port`);
        console.log(`  Warning: saved P2P port ${pairing.port} is busy — bound a new random port. Phones must rescan the QR code.`);
        startedP2PServer = await startP2PServer({
            port: 0,  // Random available port
            host: '0.0.0.0',
            authSecret: pairing.authSecret,
            store: p2pStore,
            runnerCredentialStore,
            webAppDir,
            conciergeDeps,
            pairingRekeyDeliveryReader: pairingRekeyCoordinator,
        });
    }
    p2pServer = startedP2PServer;
    logger.debug(`[DAEMON RUN] P2P server started on port ${p2pServer.port}`);
    publishStoppedSessionInactive = (sessionId: string) => {
        const result = publishSessionActivity(p2pStore, p2pServer.router, {
            sessionId,
            active: false,
            terminal: true
        });
        if (!result.sessionExists) {
            logger.debug(`[DAEMON RUN] Stopped session ${sessionId} was not found in P2P store`);
        }
    };
    if (p2pServer.port !== pairing.port) {
        pairing = updatePairingPort(pairing, p2pServer.port);
    }

    // Initialize TTS provider (non-fatal — daemon works without TTS)
    try {
        await initTtsProvider();
        logger.debug('[DAEMON RUN] TTS provider initialized');
    } catch (error) {
        logger.debug('[DAEMON RUN] TTS provider initialization failed (non-fatal):', error);
    }

    // Update daemon state with P2P info
    fileState.p2pPort = p2pServer.port;
    fileState.p2pHost = lanIP;
    await persistDaemonState();
    logger.debug('[DAEMON RUN] Daemon state updated with P2P info');

    // Register machine in P2P store
    const settings = await updateSettings((currentSettings) => {
        if (currentSettings.machineId) {
            return currentSettings;
        }

        return {
            ...currentSettings,
            machineId: randomUUID(),
        };
    });
    if (!settings.machineId) {
        throw new Error('Daemon machine identity is unavailable.');
    }
    machineId = settings.machineId;
    p2pStore.getOrCreateMachine(
        machineId,
        JSON.stringify(initialMachineMetadata),
        JSON.stringify({ status: 'running', pid: process.pid, httpPort: controlPort, startedAt: Date.now() }),
        null
    );
    logger.debug(`[DAEMON RUN] Machine registered in P2P store: ${machineId}`);

    // ─── Self-connect as machine client for RPC handling ────────────
    if (!codexCapabilities || !cursorCapabilities) {
        throw new Error('Provider capability services were not initialized.');
    }
    machineSocketHandle = bootstrapMachineSocket({
        p2pPort: p2pServer.port,
        machineId,
        bearerToken: deriveBearerToken(pairing.authSecret),
        contentSecret: pairing.contentSecret,
        pairingRekeyCoordinator,
        codexCapabilities,
        cursorCapabilities,
        spawnSession: sessionManager.spawnSession,
        stopSession: sessionManager.stopSession,
        requestShutdown: () => requestShutdown('remcli-web')
    });

    // Optionally start cloudflared tunnel for remote access
    const useTunnel = process.argv.includes('--tunnel') || process.env.REMCLI_TUNNEL === 'true';
    if (useTunnel) {
        console.log('  Starting cloudflared tunnel for remote access...');
        const tunnel = await startCloudflaredTunnel(p2pServer.port);
        if (tunnel) {
            tunnelUrl = tunnel.url;
            tunnelStop = tunnel.stop;
            fileState.tunnelUrl = tunnelUrl;
            await persistDaemonState();
            logger.debug(`[DAEMON RUN] Tunnel started: ${tunnelUrl}`);

            // Show QR with tunnel URL (accessible from anywhere)
            const tunnelConnectionInfo = buildP2PConnectionInfo(tunnelUrl.replace(/\/$/, ''), 0, pairing);
            const tunnelQRUrl = buildP2PQRUrl(tunnelConnectionInfo, tunnelUrl);
            await displayP2PQRCode(tunnelQRUrl);
            displayP2PConnectionStatus(lanIP, p2pServer.port, tunnelUrl);
        } else {
            console.log('  Failed to start tunnel, using LAN only');
            const connectionInfo = buildP2PConnectionInfo(lanIP, p2pServer.port, pairing);
            const qrUrl = buildP2PQRUrl(connectionInfo);
            await displayP2PQRCode(qrUrl);
            displayP2PConnectionStatus(lanIP, p2pServer.port);
        }
    } else {
        // LAN only - show QR with LAN IP
        const connectionInfo = buildP2PConnectionInfo(lanIP, p2pServer.port, pairing);
        const qrUrl = buildP2PQRUrl(connectionInfo);
        await displayP2PQRCode(qrUrl);
        displayP2PConnectionStatus(lanIP, p2pServer.port);

        if (!isCloudflaredAvailable()) {
            console.log('  ⓘ  cloudflared not installed — LAN only, no voice input on web.');
            console.log('     Install: brew install cloudflared (macOS)');
            console.log('     Then use --tunnel for HTTPS remote access.\n');
        } else {
            console.log('  ⓘ  LAN only mode. Use --tunnel flag for HTTPS remote access.\n');
        }
    }

    fileState.state = 'running';
    fileState.stateReason = 'ready';
    await persistDaemonState();

    // Heartbeat loop: prunes stale sessions and asks this owner to persist only
    // after it has confirmed the same instance still owns the state snapshot.
    const heartbeat = startHeartbeatLoop({
        instanceId: daemonInstanceId,
        pruneDeadSessions: sessionManager.pruneDeadSessions,
        requestShutdown: (source, errorMessage, restartAfterShutdown) => requestShutdown(
          source,
          errorMessage,
          restartAfterShutdown,
        ),
        isStateWriterActive: () => runtimeStateWritesAllowed && fileState?.state === 'running',
        persistHeartbeat: async (state, heartbeatAtMs, codexAppServerIsUsable) => {
          if (
            !fileState
            || fileState.instanceId !== state.instanceId
            || fileState.state !== 'running'
          ) {
            return;
          }

          fileState.lastHeartbeatAtMs = heartbeatAtMs;
          if (!codexAppServerIsUsable) {
            fileState.codexAppServerEndpoint = undefined;
            fileState.codexAppServerPid = undefined;
          }
          const persist = persistDaemonState;
          if (persist) {
            await persist();
          }
        },
    });

    // Setup signal handlers
    const cleanupAndShutdown = async (
      source: ShutdownSource,
      errorMessage?: string,
      restartAfterShutdown = false,
    ): Promise<DaemonShutdownResult> => {
      logger.debug(`[DAEMON RUN] Starting proper cleanup (source: ${source}, errorMessage: ${errorMessage})...`);
      isCleanupInProgress = true;
      isShutdownRetryPending = false;
      if (startupFailureExitTimer) {
        clearTimeout(startupFailureExitTimer);
        startupFailureExitTimer = null;
      }

      runtimeStateWritesAllowed = false;
      heartbeat.stop();
      await heartbeat.waitForIdle();
      if (fileState) {
        fileState.state = 'stopping';
        fileState.stateReason = shutdownSourceToStateReason(source);
        const persist = persistDaemonState;
        if (persist) {
          await persist();
        }
      }

      const shutdownResult = await performDaemonShutdown({
        machineSocketHandle,
        killAllSessions: sessionManager.killAllSessions,
        codexAppServerHost,
        tunnelStop,
        freeWhisper,
        stopTts,
        flushP2PStore: () => p2pStore.flushKvToDisk(),
        stopP2PServer: () => p2pServer.stop(),
        stopControlServer,
        persistStoppedState: async () => {
          if (!fileState) {
            return;
          }
          fileState.state = 'stopped';
          fileState.stateReason = 'clean-shutdown';
          fileState.codexAppServerEndpoint = undefined;
          fileState.codexAppServerPid = undefined;
          fileState.ownedChildPids = [];
          const persist = persistDaemonState;
          if (persist) {
            await persist();
          }
        },
        stopCaffeinate,
        releaseDaemonLock: () => releaseDaemonLock(daemonLockHandle),
        ...(restartIntent.shouldRestart() ? {
          restartAfterRelease: createDaemonReplacementStarter(restartIntent, useTunnel),
        } : {}),
      });

      if (shutdownResult === 'retry') {
        if (fileState) {
          fileState.state = 'stopping';
          fileState.stateReason = 'cleanup-retry';
          const persist = persistDaemonState;
          if (persist) {
            await persist();
          }
        }
        isCleanupInProgress = false;
        isShutdownRetryPending = true;
        logger.warn('[DAEMON RUN] Daemon shutdown is pending shared Codex app-server retry; control endpoint, state, and lock remain active');
      }

      return shutdownResult;
    };

    logger.debug('[DAEMON RUN] Daemon started successfully, waiting for shutdown request');

    // A failed shared Codex app-server stop preserves ownership and waits for
    // the next control/signal request instead of falling through to fatal exit.
    await runDaemonShutdownLifecycle({
      waitForShutdownRequest: shutdownRequestChannel.waitForShutdownRequest,
      cleanupAndShutdown: (shutdownRequest) => cleanupAndShutdown(
        shutdownRequest.source,
        shutdownRequest.errorMessage,
        shutdownRequest.restartAfterShutdown,
      ),
    });
  } catch (error) {
    if (fileState && persistDaemonState) {
      runtimeStateWritesAllowed = false;
      fileState.state = 'failed';
      fileState.stateReason = isCleanupInProgress ? 'cleanup-failed' : 'startup-failed';
      try {
        await persistDaemonState();
      } catch (persistError) {
        logger.warn('[DAEMON RUN] Failed to persist terminal daemon lifecycle state:', persistError);
      }
    }
    logger.debug('[DAEMON RUN][FATAL] Failed somewhere unexpectedly - exiting with code 1:', redactDiagnosticData(error));
    process.exit(1);
  }
}
