import { readCredentials, updateSettings, Credentials } from "@/persistence";
import { randomUUID } from 'node:crypto';
import { logger } from './logger';

/**
 * Ensure authentication and machine setup.
 *
 * In P2P mode credentials are established by the daemon (shared secret from QR code).
 * This function reads the existing credentials and ensures a machine ID exists.
 * If no credentials are found, it instructs the user to start the daemon.
 */
export async function authAndSetupMachineIfNeeded(): Promise<{
    credentials: Credentials;
    machineId: string;
}> {
    logger.debug('[AUTH] Starting auth and machine setup...');

    const credentials = await readCredentials();

    if (!credentials) {
        throw new Error(
            'No credentials found. Start the daemon first with: remcli daemon start\n' +
            'Then scan the QR code from the mobile app to authenticate.'
        );
    }

    logger.debug('[AUTH] Using existing credentials');

    // Make sure we have a machine ID
    const settings = await updateSettings(async s => {
        if (!s.machineId) {
            return {
                ...s,
                machineId: randomUUID()
            };
        }
        return s;
    });

    logger.debug(`[AUTH] Machine ID: ${settings.machineId}`);

    return { credentials, machineId: settings.machineId! };
}
