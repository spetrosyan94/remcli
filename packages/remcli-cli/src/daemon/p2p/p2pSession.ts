/**
 * P2P session setup for CLI session processes
 *
 * When a CLI session starts (runClaude, runCodex, runGemini), it needs to connect
 * to the local P2P server instead of the cloud. This module reads the daemon state
 * to get P2P connection info and creates appropriate credentials.
 */

import { readDaemonState, readSettings, updateSettings, Credentials } from '@/persistence';
import { deriveBearerToken, decodeSharedSecret } from './p2pAuth';
import { configuration } from '@/configuration';
import { getRandomBytes } from '@/api/encryption';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';

/**
 * Setup P2P connection for a CLI session process.
 * Reads daemon state, derives bearer token, and configures the server URL.
 *
 * Returns credentials compatible with ApiClient.create().
 */
export async function setupP2PForSession(): Promise<{
    credentials: Credentials;
    machineId: string;
}> {
    logger.debug('[P2P-SESSION] Setting up P2P connection for session...');

    // Read daemon state to get P2P info
    const daemonState = await readDaemonState();
    if (!daemonState) {
        throw new Error(
            'Daemon is not running. Start the daemon first with: remcli daemon start'
        );
    }

    if (!daemonState.p2pPort || !daemonState.p2pSharedSecret) {
        throw new Error(
            'Daemon is running but P2P server info is missing. ' +
            'Try restarting the daemon: remcli daemon stop && remcli daemon start'
        );
    }

    // Derive bearer token from shared secret
    const sharedSecret = decodeSharedSecret(daemonState.p2pSharedSecret);
    const bearerToken = deriveBearerToken(sharedSecret);

    // Configure the global server URL to point to local P2P server
    const p2pUrl = `http://127.0.0.1:${daemonState.p2pPort}`;
    configuration.p2pServerUrl = p2pUrl;

    logger.debug(`[P2P-SESSION] P2P URL: ${p2pUrl}`);

    // Create P2P credentials using dataKey encryption with a derived key
    // The encryption key is generated per-session and sent to the P2P store
    const sessionEncryptionKey = getRandomBytes(32);

    const credentials: Credentials = {
        token: bearerToken,
        encryption: {
            type: 'dataKey',
            publicKey: sessionEncryptionKey, // Used as public key for encrypting data keys
            machineKey: getRandomBytes(32)   // Machine-scoped key
        }
    };

    // Ensure machine ID exists in settings
    const settings = await updateSettings(async (s) => {
        if (!s.machineId) {
            return {
                ...s,
                machineId: randomUUID()
            };
        }
        return s;
    });

    logger.debug(`[P2P-SESSION] Machine ID: ${settings.machineId}`);
    logger.debug('[P2P-SESSION] P2P session setup complete');

    return { credentials, machineId: settings.machineId! };
}

/**
 * Get the effective server URL for API calls.
 * Returns P2P URL if configured, otherwise falls back to cloud server URL.
 */
export function getEffectiveServerUrl(): string {
    return configuration.p2pServerUrl || configuration.serverUrl;
}
