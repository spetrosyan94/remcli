/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, readDaemonState } from '@/persistence';
import type { Metadata } from '@/api/types';
import { projectPath } from '@/projectPath';
import { readFileSync } from 'fs';
import { join } from 'path';
import { configuration } from '@/configuration';
import {
  type CodexRemoteTuiOpenRequest,
  type CodexRemoteTuiOpenResult,
  type NativeCodexThreadBinding,
  type NativeCodexThreadBindingResult,
  type TrackedSession,
} from './types';
import { getSessionRunnerCredential, rememberSessionRunnerCredential } from './p2p/p2pRunnerCredentials';

/**
 * Consistent envelope for all daemon HTTP responses.
 * Either the request succeeded with a typed payload, or it failed with a reason.
 */
export type DaemonResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

interface SpawnDaemonSessionBody {
  success?: boolean;
  sessionId?: string;
  errorMessage?: string;
  type?: string;
  directory?: string;
}

interface SessionStartedResponse {
  status: 'ok';
  runnerCredential?: string;
}

const MISSING_SESSION_RUNNER_CREDENTIAL_ERROR = 'Missing session runner credential';

async function daemonPost<T = unknown>(path: string, body?: unknown): Promise<DaemonResponse<T>> {
  const state = await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = 'No daemon running, no state file found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }

  try {
    process.kill(state.pid, 0);
  } catch (error) {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }

  try {
    const timeout = process.env.REMCLI_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.REMCLI_DAEMON_HTTP_TIMEOUT) : 10_000;
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: AbortSignal.timeout(timeout)
    });

    if (!response.ok) {
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return { ok: false, error: errorMessage };
    }

    return { ok: true, data: await response.json() as T };
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }
}

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata
): Promise<{ error?: string }> {
  const runnerToken = process.env.REMCLI_DAEMON_RUNNER_TOKEN;
  const result = await daemonPost<SessionStartedResponse>('/session-started', {
    sessionId,
    metadata,
    ...(runnerToken ? { runnerToken } : {}),
  });
  if (result.ok && typeof result.data.runnerCredential === 'string') {
    rememberSessionRunnerCredential(sessionId, result.data.runnerCredential);
  }
  return result.ok ? {} : { error: result.error };
}

export async function bindDaemonCodexThread(
  binding: NativeCodexThreadBinding
): Promise<DaemonResponse<NativeCodexThreadBindingResult>> {
  const runnerCredential = getSessionRunnerCredential(binding.remcliSessionId);
  if (!runnerCredential) {
    return { ok: false, error: MISSING_SESSION_RUNNER_CREDENTIAL_ERROR };
  }

  return daemonPost<NativeCodexThreadBindingResult>('/codex-thread-bound', {
    ...binding,
    runnerCredential,
  });
}

export async function openDaemonCodexRemoteTui(
  request: CodexRemoteTuiOpenRequest
): Promise<DaemonResponse<CodexRemoteTuiOpenResult>> {
  const runnerCredential = getSessionRunnerCredential(request.remcliSessionId);
  if (!runnerCredential) {
    return { ok: false, error: MISSING_SESSION_RUNNER_CREDENTIAL_ERROR };
  }

  return daemonPost<CodexRemoteTuiOpenResult>('/codex-remote-tui-open', {
    ...request,
    runnerCredential,
  });
}

export async function listDaemonSessions(): Promise<TrackedSession[]> {
  const result = await daemonPost<{ children?: TrackedSession[] }>('/list');
  return result.ok ? (result.data.children ?? []) : [];
}

export async function stopDaemonSession(sessionId: string): Promise<boolean> {
  const result = await daemonPost<{ success?: boolean }>('/stop-session', { sessionId });
  return result.ok ? (result.data.success ?? false) : false;
}

export async function spawnDaemonSession(directory: string, sessionId?: string): Promise<SpawnDaemonSessionBody & { error?: string }> {
  const result = await daemonPost<SpawnDaemonSessionBody>('/spawn-session', { directory, sessionId });
  return result.ok ? result.data : { error: result.error };
}

export async function stopDaemonHttp(): Promise<void> {
  await daemonPost('/stop');
}

/**
 * The version check is still quite naive.
 * For instance we are not handling the case where we upgraded remcli,
 * the daemon is still running, and it recieves a new message to spawn a new session.
 * This is a tough case - we need to somehow figure out to restart ourselves,
 * yet still handle the original request.
 * 
 * Options:
 * 1. Periodically check during the health checks whether our version is the same as CLIs version. If not - restart.
 * 2. Wait for a command from the machine session, or any other signal to
 * check for version & restart.
 *   a. Handle the request first
 *   b. Let the request fail, restart and rely on the client retrying the request
 * 
 * I like option 1 a little better.
 * Maybe we can ... wait for it ... have another daemon to make sure 
 * our daemon is always alive and running the latest version.
 * 
 * That seems like an overkill and yet another process to manage - lets not do this :D
 * 
 * TODO: This function should return a state object with
 * clear state - if it is running / or errored out or something else.
 * Not just a boolean.
 * 
 * We can destructure the response on the caller for richer output.
 * For instance when running `remcli daemon status` we can show more information.
 */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state) {
    return false;
  }

  // Check if the daemon is running
  try {
    process.kill(state.pid, 0);
    return true;
  } catch {
    logger.debug('[DAEMON RUN] Daemon PID not running, cleaning up state');
    await cleanupDaemonState();
    return false;
  }
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 * 
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledRemcliVersion(): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const runningDaemon = await checkIfDaemonRunningAndCleanupStaleState();
  if (!runningDaemon) {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }

  const state = await readDaemonState();
  if (!state) {
    logger.debug('[DAEMON CONTROL] No daemon state found, returning false');
    return false;
  }
  
  try {
    // Read package.json on demand from disk - so we are guaranteed to get the latest version
    const packageJsonPath = join(projectPath(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const currentCliVersion = packageJson.version;
    
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}`);
    return currentCliVersion === state.startedWithCliVersion;
    
    // PREVIOUS IMPLEMENTATION - Keeping this commented in case we need it
    // we will get a new path or not when remcli is upgraded globally.
    // If reading package.json doesn't work correctly after npm upgrades, 
    // we can revert to spawning a process (but should add timeout and cleanup!)
    /*
    const { spawnRemcliCLI } = await import('@/utils/spawnRemcliCLI');
    const remcliProcess = spawnRemcliCLI(['--version'], { stdio: 'pipe' });
    let version: string | null = null;
    remcliProcess.stdout?.on('data', (data) => {
      version = data.toString().trim();
    });
    await new Promise(resolve => remcliProcess.stdout?.on('close', resolve));
    logger.debug(`[DAEMON CONTROL] Current CLI version: ${version}, Daemon started with version: ${state.startedWithCliVersion}`);
    return version === state.startedWithCliVersion;
    */
  } catch (error) {
    logger.debug('[DAEMON CONTROL] Error checking daemon version', error);
    return false;
  }
}

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearDaemonState();
    logger.debug('[DAEMON RUN] Daemon state file removed');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

export async function stopDaemon() {
  try {
    const state = await readDaemonState();
    if (!state) {
      logger.debug('No daemon state found');
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp();

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, 2000);
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }

    // Force kill
    try {
      process.kill(state.pid, 'SIGKILL');
      logger.debug('Force killed daemon');
    } catch (error) {
      logger.debug('Daemon already dead');
    }
  } catch (error) {
    logger.debug('Error stopping daemon', error);
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      return; // Process is dead
    }
  }
  throw new Error('Process did not die within timeout');
}
