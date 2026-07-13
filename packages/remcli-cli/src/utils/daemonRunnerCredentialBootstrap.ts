import type { Metadata } from '@/api/types';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import {
    forgetSessionRunnerCredential,
    getSessionRunnerCredential,
} from '@/daemon/p2p/p2pRunnerCredentials';
import { logger } from '@/ui/logger';
import { delay } from '@/utils/time';

const DAEMON_RUNNER_CREDENTIAL_HANDOFF_ATTEMPTS = 3;
const DAEMON_RUNNER_CREDENTIAL_HANDOFF_RETRY_DELAY_MS = 100;

export interface DaemonRunnerCredentialBootstrapOptions {
    agentName: string;
    sessionId: string;
    metadata: Metadata;
}

/**
 * Acquires the daemon-issued credential required to acknowledge mobile prompts.
 * A session consumer must not be created before this succeeds.
 */
export async function acquireDaemonRunnerCredential(
    options: DaemonRunnerCredentialBootstrapOptions,
): Promise<boolean> {
    const { agentName, sessionId, metadata } = options;
    forgetSessionRunnerCredential(sessionId);

    let lastError = 'Daemon did not return a session runner credential';
    for (let attempt = 1; attempt <= DAEMON_RUNNER_CREDENTIAL_HANDOFF_ATTEMPTS; attempt += 1) {
        try {
            const result = await notifyDaemonSessionStarted(sessionId, metadata);
            if (!result.error && getSessionRunnerCredential(sessionId)) {
                return true;
            }
            lastError = result.error ?? lastError;
        } catch (error) {
            lastError = error instanceof Error ? error.message : 'Unknown handoff error';
        }

        if (attempt < DAEMON_RUNNER_CREDENTIAL_HANDOFF_ATTEMPTS) {
            logger.warn(
                `[${agentName}] Daemon runner credential handoff attempt ${attempt}/${DAEMON_RUNNER_CREDENTIAL_HANDOFF_ATTEMPTS} failed: ${lastError}. Retrying.`,
            );
            await delay(DAEMON_RUNNER_CREDENTIAL_HANDOFF_RETRY_DELAY_MS);
        }
    }

    logger.warn(
        `[${agentName}] Daemon runner credential handoff failed after ${DAEMON_RUNNER_CREDENTIAL_HANDOFF_ATTEMPTS} attempts: ${lastError}`,
    );
    return false;
}

/**
 * Creates a daemon-owned consumer only after its ACK credential is available.
 */
export async function createDaemonRunnerSessionConsumer<TSession>(
    options: DaemonRunnerCredentialBootstrapOptions & {
        createSessionConsumer: () => TSession;
    },
): Promise<TSession | null> {
    const hasCredential = await acquireDaemonRunnerCredential(options);
    return hasCredential ? options.createSessionConsumer() : null;
}

/**
 * Keeps terminal-started sessions best-effort: a missing daemon must not block them.
 */
export async function reportTerminalSessionStarted(options: DaemonRunnerCredentialBootstrapOptions): Promise<void> {
    const { agentName, sessionId, metadata } = options;

    try {
        logger.debug(`[START] Reporting ${agentName} session ${sessionId} to daemon`);
        const result = await notifyDaemonSessionStarted(sessionId, metadata);
        if (result.error) {
            logger.debug(`[START] Failed to report ${agentName} session to daemon (may not be running):`, result.error);
        } else {
            logger.debug(`[START] Reported ${agentName} session ${sessionId} to daemon`);
        }
    } catch (error) {
        logger.debug(`[START] Failed to report ${agentName} session to daemon (may not be running):`, error);
    }
}
