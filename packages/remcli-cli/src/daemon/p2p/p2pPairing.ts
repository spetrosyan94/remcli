/**
 * Persistent P2P pairing storage
 *
 * Keeps the shared secret and the last bound P2P port across daemon restarts,
 * so phones paired via QR code stay connected after `remcli daemon` restarts.
 * Stored at ~/.remcli/p2p-pairing.json with 0600 permissions (atomic writes).
 * `remcli daemon rekey` deletes this file to force a fresh secret.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { generateSharedSecret, encodeSharedSecret, decodeSharedSecret } from './p2pAuth';

const PAIRING_FILE_NAME = 'p2p-pairing.json';
const PAIRING_FILE_MODE = 0o600;
const SHARED_SECRET_BYTES = 32;

const PairingFileSchema = z.object({
    secret: z.string().base64(),
    port: z.number().int().min(0).max(65535),
    createdAt: z.string()
});

export interface PersistedPairing {
    secret: Uint8Array;
    port: number;
    createdAt: string;
}

export function getPairingFilePath(): string {
    return join(configuration.remcliHomeDir, PAIRING_FILE_NAME);
}

/**
 * Atomic write (tmp + rename) with 0600 permissions
 */
function writePairingFile(pairing: PersistedPairing): void {
    const filePath = getPairingFilePath();
    const tmpPath = filePath + '.tmp';
    const content = JSON.stringify({
        secret: encodeSharedSecret(pairing.secret),
        port: pairing.port,
        createdAt: pairing.createdAt
    }, null, 2);
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: PAIRING_FILE_MODE });
    renameSync(tmpPath, filePath);
    chmodSync(filePath, PAIRING_FILE_MODE);
}

/**
 * Load the persisted pairing, or create a fresh one when the file is missing.
 * A corrupted file is regenerated with a warning (phones must rescan the QR).
 */
export function loadOrCreatePairing(): PersistedPairing {
    const filePath = getPairingFilePath();
    if (existsSync(filePath)) {
        try {
            const parsed = PairingFileSchema.parse(JSON.parse(readFileSync(filePath, 'utf-8')));
            const secret = decodeSharedSecret(parsed.secret);
            if (secret.length !== SHARED_SECRET_BYTES) {
                throw new Error(`Unexpected shared secret length: ${secret.length}`);
            }
            logger.debug(`[P2P PAIRING] Loaded persisted pairing (createdAt: ${parsed.createdAt}, port: ${parsed.port})`);
            return { secret, port: parsed.port, createdAt: parsed.createdAt };
        } catch (error) {
            logger.debug('[P2P PAIRING] Pairing file corrupted, regenerating:', error);
            console.log('  Warning: pairing file was corrupted — a new secret was generated. Phones must rescan the QR code.');
        }
    }

    const pairing: PersistedPairing = {
        secret: generateSharedSecret(),
        port: 0,
        createdAt: new Date().toISOString()
    };
    writePairingFile(pairing);
    logger.debug('[P2P PAIRING] New pairing generated and persisted');
    return pairing;
}

/**
 * Persist the actually bound P2P port so the next daemon start reuses it
 */
export function updatePairingPort(pairing: PersistedPairing, port: number): void {
    writePairingFile({ ...pairing, port });
    logger.debug(`[P2P PAIRING] Pairing file updated with port ${port}`);
}

/**
 * Delete the pairing file (used by `remcli daemon rekey`).
 * Returns true when a file existed and was removed.
 */
export function clearPairing(): boolean {
    const filePath = getPairingFilePath();
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
}
