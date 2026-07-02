import os from 'os';

import { MachineMetadata } from '@/api/types';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { startCaffeinate, stopCaffeinate } from '@/utils/caffeinate';
import packageJson from '../../package.json';
import { getEnvironmentInfo } from '@/ui/doctor';
import { writeDaemonState, DaemonLocallyPersistedState, acquireDaemonLock, releaseDaemonLock } from '@/persistence';

import { cleanupDaemonState, isDaemonRunningCurrentlyInstalledRemcliVersion, stopDaemon } from './controlClient';
import { findAllRemcliProcesses } from './doctor';
import { startDaemonControlServer } from './controlServer';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { projectPath } from '@/projectPath';
import { isTmuxAvailable } from '@/utils/tmux';
import { P2PStore } from './p2p/p2pStore';
import { startP2PServer, P2PServer } from './p2p/p2pServer';
import { generateSharedSecret, encodeSharedSecret, deriveBearerToken } from './p2p/p2pAuth';
import { getLanIPAddress } from './p2p/networkUtils';
import { buildP2PConnectionInfo, buildP2PQRUrl, displayP2PQRCode, displayP2PConnectionStatus } from './p2p/p2pQRCode';
import { startCloudflaredTunnel, isCloudflaredAvailable } from './p2p/tunnel';
import { freeWhisper } from './whisper/whisperService';
import { initTtsProvider, stopTts } from './tts/ttsService';
import { createSessionManager } from './sessionSpawner';
import { bootstrapMachineSocket } from './machineSocket';
import { startHeartbeatLoop } from './heartbeat';

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

    // Session manager owns tracked child sessions and tmux session cleanup
    const sessionManager = createSessionManager();

    // Start control server
    const { port: controlPort, stop: stopControlServer } = await startDaemonControlServer({
      getChildren: sessionManager.getChildren,
      stopSession: sessionManager.stopSession,
      spawnSession: sessionManager.spawnSession,
      requestShutdown: () => requestShutdown('remcli-cli'),
      onRemcliSessionWebhook: sessionManager.onRemcliSessionWebhook
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
            webAppDir
        });
        logger.debug(`[DAEMON RUN] P2P server started on port ${p2pServer.port}`);
    } catch (error) {
        logger.debug('[DAEMON RUN] Failed to start P2P server:', error);
        throw error;
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
    const machineSocketHandle = bootstrapMachineSocket({
        p2pPort: p2pServer.port,
        machineId,
        bearerToken,
        sharedSecret,
        spawnSession: sessionManager.spawnSession,
        stopSession: sessionManager.stopSession,
        requestShutdown: () => requestShutdown('remcli-app')
    });

    // Optionally start cloudflared tunnel for remote access
    const useTunnel = process.argv.includes('--tunnel') || process.env.REMCLI_TUNNEL === 'true';
    let tunnelStop: (() => void) | null = null;
    let tunnelUrl: string | undefined;

    if (useTunnel) {
        console.log('  Starting cloudflared tunnel for remote access...');
        const tunnel = await startCloudflaredTunnel(p2pServer.port);
        if (tunnel) {
            tunnelUrl = tunnel.url;
            tunnelStop = tunnel.stop;
            fileState.tunnelUrl = tunnelUrl;
            writeDaemonState(fileState);
            logger.debug(`[DAEMON RUN] Tunnel started: ${tunnelUrl}`);

            // Show QR with tunnel URL (accessible from anywhere)
            const tunnelConnectionInfo = buildP2PConnectionInfo(tunnelUrl.replace(/\/$/, ''), 0, sharedSecret);
            const tunnelQRUrl = buildP2PQRUrl(tunnelConnectionInfo, tunnelUrl);
            await displayP2PQRCode(tunnelQRUrl);
            displayP2PConnectionStatus(lanIP, p2pServer.port, tunnelUrl);
        } else {
            console.log('  Failed to start tunnel, using LAN only');
            const connectionInfo = buildP2PConnectionInfo(lanIP, p2pServer.port, sharedSecret);
            const qrUrl = buildP2PQRUrl(connectionInfo);
            await displayP2PQRCode(qrUrl);
            displayP2PConnectionStatus(lanIP, p2pServer.port);
        }
    } else {
        // LAN only - show QR with LAN IP
        const connectionInfo = buildP2PConnectionInfo(lanIP, p2pServer.port, sharedSecret);
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

    // Heartbeat loop: prunes stale sessions, self-updates on version change, writes heartbeat
    const restartOnStaleVersionAndHeartbeat = startHeartbeatLoop({
        controlPort,
        p2pPort: p2pServer.port,
        lanIP,
        sharedSecret,
        startTime: fileState.startTime,
        daemonLogPath: fileState.daemonLogPath,
        tunnelUrl,
        pruneDeadSessions: sessionManager.pruneDeadSessions,
        requestShutdown: (source, errorMessage) => requestShutdown(source, errorMessage)
    });

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
        machineSocketHandle.close();
        logger.debug('[DAEMON RUN] Machine RPC socket closed');
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to close machine RPC socket:', error);
      }

      // Kill all tracked child sessions and tmux sessions created by this daemon
      sessionManager.killAllSessions();

      // Stop cloudflared tunnel if running
      if (tunnelStop) {
        try {
          tunnelStop();
          logger.debug('[DAEMON RUN] Tunnel stopped');
        } catch (error) {
          logger.debug('[DAEMON RUN] Failed to stop tunnel:', error);
        }
      }

      // Free Whisper native resources
      try {
        await freeWhisper();
        logger.debug('[DAEMON RUN] Whisper native resources freed');
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to free Whisper resources:', error);
      }

      // Stop TTS provider
      try {
        await stopTts();
        logger.debug('[DAEMON RUN] TTS provider stopped');
      } catch (error) {
        logger.debug('[DAEMON RUN] Failed to stop TTS provider:', error);
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
