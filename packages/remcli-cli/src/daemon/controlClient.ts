/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import {
  readDaemonState,
  readLegacyDaemonStateDiagnostic,
  type DaemonLifecycleState,
  type DaemonLocallyPersistedState,
  type LegacyDaemonStateDiagnostic,
} from '@/persistence';
import type { Metadata, SessionExecutionConsumeResponse } from '@/api/types';
import { projectPath } from '@/projectPath';
import { readFileSync } from 'fs';
import { join } from 'path';
import { configuration } from '@/configuration';
import {
    type CodexRemoteTuiOpenRequest,
    type CodexRemoteTuiOpenResult,
    type CursorHeadlessWriterLeaseAcquireRequest,
    type CursorHeadlessWriterLeaseAcquireResult,
    type CursorNativeWriterLeaseReleaseRequest,
    type CursorNativeWriterLeaseReleaseResult,
    type CursorRunnerBootstrapFailureRequest,
    type CursorRunnerBootstrapFailureResult,
    type CursorRunnerPreflightRequest,
    type CursorRunnerPreflightResponse,
    type DaemonRunnerLifecycleResult,
    type DaemonTerminalLaunchResult,
    type NativeCodexThreadBinding,
    type NativeCodexThreadBindingResult,
    type NativeCursorSessionBinding,
    type NativeCursorSessionBindingResult,
    type TrackedSession,
} from './types';
import { getSessionRunnerCredential, rememberSessionRunnerCredential } from './p2p/p2pRunnerCredentials';
import type { PairingRekeyApprovalResult } from './p2p/pairingRekey';
import { findAllRemcliProcesses } from './doctor';

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
  terminal?: DaemonTerminalLaunchResult;
  errorMessage?: string;
  type?: string;
  directory?: string;
}

interface SessionStartedResponse {
  status: 'ok';
  runnerCredential?: string;
}

const MISSING_SESSION_RUNNER_CREDENTIAL_ERROR = 'Missing session runner credential';
const MISSING_DAEMON_RUNNER_CAPABILITY_ERROR = 'Missing daemon runner capability';
const READY_DAEMON_STATES = ['running'] as const;
const STOPPABLE_DAEMON_STATES = ['starting', 'running', 'stopping'] as const;
type DaemonInstanceProbe = 'matching' | 'absent' | 'replaced' | 'unreachable';
type UnverifiedDaemonDiscoveryStatus = 'absent' | 'present' | 'unresolved';
export type DaemonOwnershipStatus = 'absent' | 'matching' | 'unresolved';
export const LEGACY_DAEMON_MIGRATION_MESSAGE = [
  'An older Remcli daemon is still running and cannot be verified safely by this release.',
  'Stop it from its original terminal (Ctrl+C) or with the previous Remcli release, then retry.',
].join(' ');

function hasDaemonLifecycleState(
  state: DaemonLocallyPersistedState,
  allowedStates: readonly DaemonLifecycleState[],
): boolean {
  return allowedStates.includes(state.state);
}

async function hasMatchingDaemonIdentity(
  state: DaemonLocallyPersistedState,
): Promise<boolean> {
  return await probeDaemonInstance(state) === 'matching';
}

async function probeDaemonInstance(
  state: DaemonLocallyPersistedState,
): Promise<DaemonInstanceProbe> {
  if (!state.httpPort) {
    return 'unreachable';
  }

  try {
    process.kill(state.pid, 0);
  } catch (error) {
    return isProcessMissingError(error) ? 'absent' : 'unreachable';
  }

  try {
    const timeout = process.env.REMCLI_DAEMON_HTTP_TIMEOUT ? parseInt(process.env.REMCLI_DAEMON_HTTP_TIMEOUT) : 10_000;
    const response = await fetch(`http://127.0.0.1:${state.httpPort}/identity`, {
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      return 'unreachable';
    }

    const body = await response.json() as { instanceId?: unknown };
    return body.instanceId === state.instanceId ? 'matching' : 'replaced';
  } catch {
    return 'unreachable';
  }
}

function isProcessMissingError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'ESRCH';
}

async function getUnverifiedDaemonDiscoveryStatus(): Promise<UnverifiedDaemonDiscoveryStatus> {
  try {
    const remcliProcesses = await findAllRemcliProcesses();
    return remcliProcesses.some((candidate) =>
      candidate.pid !== process.pid
      && (candidate.type === 'daemon' || candidate.type === 'dev-daemon'),
    ) ? 'present' : 'absent';
  } catch {
    return 'unresolved';
  }
}

/**
 * Classifies whether starting a replacement daemon is safe. A live process that
 * cannot be bound to the persisted instance identity must fail closed.
 */
export async function getDaemonOwnershipStatus(): Promise<DaemonOwnershipStatus> {
  const state = await readDaemonState();
  if (!state) {
    return await getUnverifiedDaemonDiscoveryStatus() === 'absent' ? 'absent' : 'unresolved';
  }

  const probe = await probeDaemonInstance(state);
  if (probe === 'matching') {
    return 'matching';
  }

  if (probe !== 'absent') {
    return 'unresolved';
  }

  return await getUnverifiedDaemonDiscoveryStatus() === 'absent' ? 'absent' : 'unresolved';
}

async function daemonPost<T = unknown>(
  path: string,
  body?: unknown,
  allowedStates: readonly DaemonLifecycleState[] = READY_DAEMON_STATES,
  expectedInstanceId?: string,
): Promise<DaemonResponse<T>> {
  const state = await readDaemonState();
  if (!state?.httpPort || !hasDaemonLifecycleState(state, allowedStates)) {
    const errorMessage = 'No running daemon is available for control';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }

  if (expectedInstanceId && state.instanceId !== expectedInstanceId) {
    const errorMessage = 'Daemon instance changed before control request';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return { ok: false, error: errorMessage };
  }

  if (!await hasMatchingDaemonIdentity(state)) {
    const errorMessage = 'Daemon identity could not be verified';
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

export async function consumeDaemonSessionExecution(
  sessionId: string,
  provider: 'codex' | 'cursor',
): Promise<DaemonResponse<SessionExecutionConsumeResponse>> {
  const runnerCredential = getSessionRunnerCredential(sessionId);
  if (!runnerCredential) {
    return { ok: false, error: MISSING_SESSION_RUNNER_CREDENTIAL_ERROR };
  }

  return daemonPost<SessionExecutionConsumeResponse>('/session-execution-consume', {
    sessionId,
    provider,
    runnerCredential,
  });
}

export async function bindDaemonCursorSession(
  binding: NativeCursorSessionBinding,
): Promise<DaemonResponse<NativeCursorSessionBindingResult>> {
  const runnerCredential = getSessionRunnerCredential(binding.remcliSessionId);
  if (!runnerCredential) {
    return { ok: false, error: MISSING_SESSION_RUNNER_CREDENTIAL_ERROR };
  }

  return daemonPost<NativeCursorSessionBindingResult>('/cursor-session-bound', {
    ...binding,
    runnerCredential,
  });
}

export async function acquireDaemonCursorHeadlessWriterLease(
  request: CursorHeadlessWriterLeaseAcquireRequest,
): Promise<DaemonResponse<CursorHeadlessWriterLeaseAcquireResult>> {
  const runnerCredential = getSessionRunnerCredential(request.remcliSessionId);
  if (!runnerCredential) {
    return { ok: false, error: MISSING_SESSION_RUNNER_CREDENTIAL_ERROR };
  }

  return daemonPost<CursorHeadlessWriterLeaseAcquireResult>('/cursor-headless-writer-acquire', {
    ...request,
    runnerCredential,
  });
}

export async function releaseDaemonCursorNativeWriterLease(
  request: CursorNativeWriterLeaseReleaseRequest,
): Promise<DaemonResponse<CursorNativeWriterLeaseReleaseResult>> {
  const runnerCredential = getSessionRunnerCredential(request.remcliSessionId);
  if (!runnerCredential) {
    return { ok: false, error: MISSING_SESSION_RUNNER_CREDENTIAL_ERROR };
  }

  return daemonPost<CursorNativeWriterLeaseReleaseResult>('/cursor-writer-release', {
    ...request,
    runnerCredential,
  });
}

export async function preflightDaemonCursorRunner(
  request: Omit<CursorRunnerPreflightRequest, 'runnerToken'>,
): Promise<DaemonResponse<CursorRunnerPreflightResponse>> {
  const runnerToken = process.env.REMCLI_DAEMON_RUNNER_TOKEN;
  if (!runnerToken) {
    return { ok: false, error: MISSING_DAEMON_RUNNER_CAPABILITY_ERROR };
  }

  return daemonPost<CursorRunnerPreflightResponse>('/cursor-runner-preflight', {
    ...request,
    runnerToken,
  });
}

export async function reportDaemonCursorRunnerBootstrapFailure(
  request: Omit<CursorRunnerBootstrapFailureRequest, 'runnerToken'>,
): Promise<DaemonResponse<CursorRunnerBootstrapFailureResult>> {
  const runnerToken = process.env.REMCLI_DAEMON_RUNNER_TOKEN;
  if (!runnerToken) {
    return { ok: false, error: MISSING_DAEMON_RUNNER_CAPABILITY_ERROR };
  }

  return daemonPost<CursorRunnerBootstrapFailureResult>('/cursor-runner-bootstrap-failed', {
    ...request,
    runnerToken,
  });
}

async function reportDaemonRunnerLifecycle(
  path: '/daemon-runner-stopping' | '/daemon-runner-stopped',
  sessionId: string,
): Promise<DaemonResponse<DaemonRunnerLifecycleResult>> {
  const runnerCredential = getSessionRunnerCredential(sessionId);
  if (!runnerCredential) {
    return { ok: false, error: MISSING_SESSION_RUNNER_CREDENTIAL_ERROR };
  }

  return daemonPost<DaemonRunnerLifecycleResult>(path, { sessionId, runnerCredential });
}

export async function reportDaemonRunnerStopping(
  sessionId: string,
): Promise<DaemonResponse<DaemonRunnerLifecycleResult>> {
  return reportDaemonRunnerLifecycle('/daemon-runner-stopping', sessionId);
}

export async function reportDaemonRunnerStopped(
  sessionId: string,
): Promise<DaemonResponse<DaemonRunnerLifecycleResult>> {
  return reportDaemonRunnerLifecycle('/daemon-runner-stopped', sessionId);
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

export async function stopDaemonHttp(expectedInstanceId?: string): Promise<DaemonResponse<unknown>> {
  const state = await readDaemonState();
  const instanceId = expectedInstanceId ?? state?.instanceId;
  if (!instanceId) {
    return { ok: false, error: 'No daemon instance is available for stop' };
  }

  return await daemonPost(
    '/stop',
    { instanceId },
    STOPPABLE_DAEMON_STATES,
    instanceId,
  );
}

export async function approveDaemonPairingRekey(
  requestId: string,
  approvalCode: string,
): Promise<DaemonResponse<PairingRekeyApprovalResult>> {
  return daemonPost<PairingRekeyApprovalResult>('/pairing-rekey/approve', { requestId, approvalCode });
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
  if (!state || !hasDaemonLifecycleState(state, READY_DAEMON_STATES)) {
    return false;
  }

  return await hasMatchingDaemonIdentity(state);
}

/**
 * Returns true only when the local control endpoint proves that any lifecycle
 * instance is still alive. This is intentionally broader than the readiness
 * check and is used before destructive pairing changes.
 */
export async function isVerifiedDaemonLive(): Promise<boolean> {
  const state = await readDaemonState();
  if (!state || !hasDaemonLifecycleState(state, STOPPABLE_DAEMON_STATES)) {
    return false;
  }

  return await hasMatchingDaemonIdentity(state);
}

/**
 * Legacy state has no cryptographic/instance identity and can never be used
 * to stop a process. It only prevents a new release from replacing pairing or
 * claiming the daemon lock while an old daemon may still be alive.
 */
export async function getLiveLegacyDaemonMigrationBlocker(): Promise<LegacyDaemonStateDiagnostic | null> {
  const legacyState = await readLegacyDaemonStateDiagnostic();
  if (!legacyState) {
    return null;
  }

  const remcliProcesses = await findAllRemcliProcesses();
  const matchedDaemon = remcliProcesses.find((process) =>
    process.pid === legacyState.pid
    && (process.type === 'daemon' || process.type === 'dev-daemon')
    && /\bdaemon\s+start-sync(?:\s|$)/.test(process.command),
  );

  return matchedDaemon ? legacyState : null;
}

async function waitForDaemonInstanceToStop(
  state: DaemonLocallyPersistedState,
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeDaemonInstance(state);
    if (probe === 'replaced') {
      return false;
    }
    if (probe === 'absent' && await getUnverifiedDaemonDiscoveryStatus() === 'absent') {
      return true;
    }

    // The verified /stop request closes the control server before the process
    // exits. An unreachable identity endpoint is therefore only conclusive at
    // the deadline; PID reuse and replacement still remain fail-closed.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const probe = await probeDaemonInstance(state);
  return probe === 'absent'
    && await getUnverifiedDaemonDiscoveryStatus() === 'absent';
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

/**
 * Request a verified graceful stop and confirm that the exact daemon instance
 * is gone before a caller starts a replacement.
 */
export async function stopDaemon(): Promise<boolean> {
  try {
    const state = await readDaemonState();
    if (!state) {
      if (await getUnverifiedDaemonDiscoveryStatus() !== 'absent') {
        logger.debug('Daemon state is missing while an unverified daemon process is still live');
        return false;
      }
      logger.debug('No daemon state found');
      return true;
    }

    if (!hasDaemonLifecycleState(state, STOPPABLE_DAEMON_STATES)) {
      const probe = await probeDaemonInstance(state);
      if (probe === 'absent' && await getUnverifiedDaemonDiscoveryStatus() === 'absent') {
        logger.debug(`Daemon is already ${state.state}; no stop request will be sent`);
        return true;
      }
      logger.debug(`Daemon is ${state.state} but its recorded process is still unresolved`);
      return false;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    const result = await stopDaemonHttp(state.instanceId);
    if (!result.ok) {
      logger.debug(`Daemon stop was not sent because ownership could not be verified: ${result.error}`);
      return false;
    }

    if (!await waitForDaemonInstanceToStop(state)) {
      logger.debug('Daemon did not exit after verified graceful stop request; refusing PID-only force kill');
      return false;
    }

    logger.debug('Daemon stopped gracefully via HTTP');
    return true;
  } catch (error) {
    logger.debug('Error stopping daemon', error);
    return false;
  }
}
