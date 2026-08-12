/**
 * Persistent P2P pairing storage
 *
 * Keeps v2 auth/content pairing secrets and the last bound P2P port across daemon restarts,
 * so phones paired via QR code stay connected after `remcli daemon` restarts.
 * Stored at ~/.remcli/p2p-pairing.json with 0600 permissions (atomic writes).
 * Host-approved rekey atomically rotates only its revocable auth secret.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import {
    generateSharedSecret,
    encodeSharedSecret,
    decodeSharedSecret,
    PAIRING_SECRET_SIZE,
} from './p2pAuth';

const PAIRING_FILE_NAME = 'p2p-pairing.json';
const PAIRING_FILE_MODE = 0o600;
const LegacyPairingFileSchema = z.object({
    secret: z.string().base64(),
    port: z.number().int().min(0).max(65535),
    createdAt: z.string()
});

const PairingFileSchema = z.object({
    v: z.literal(2),
    authSecret: z.string().base64(),
    contentSecret: z.string().base64(),
    port: z.number().int().min(0).max(65535),
    createdAt: z.string(),
});

export interface PersistedPairing {
    authSecret: Uint8Array;
    contentSecret: Uint8Array;
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
        v: 2,
        authSecret: encodeSharedSecret(pairing.authSecret),
        contentSecret: encodeSharedSecret(pairing.contentSecret),
        port: pairing.port,
        createdAt: pairing.createdAt
    }, null, 2);
    writeFileSync(tmpPath, content, { encoding: 'utf-8', mode: PAIRING_FILE_MODE });
    renameSync(tmpPath, filePath);
    chmodSync(filePath, PAIRING_FILE_MODE);
}

function isValidSecret(secret: Uint8Array): boolean {
    return secret.length === PAIRING_SECRET_SIZE;
}

function parsePairingFile(): PersistedPairing | null {
    const filePath = getPairingFilePath();
    if (!existsSync(filePath)) {
        return null;
    }

    try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
        const v2 = PairingFileSchema.safeParse(raw);
        if (v2.success) {
            const authSecret = decodeSharedSecret(v2.data.authSecret);
            const contentSecret = decodeSharedSecret(v2.data.contentSecret);
            if (!isValidSecret(authSecret) || !isValidSecret(contentSecret)) {
                throw new Error('Unexpected v2 pairing secret length');
            }
            return {
                authSecret,
                contentSecret,
                port: v2.data.port,
                createdAt: v2.data.createdAt,
            };
        }

        const legacy = LegacyPairingFileSchema.parse(raw);
        const secret = decodeSharedSecret(legacy.secret);
        if (!isValidSecret(secret)) {
            throw new Error('Unexpected legacy pairing secret length');
        }
        const migrated: PersistedPairing = {
            authSecret: secret,
            contentSecret: secret,
            port: legacy.port,
            createdAt: legacy.createdAt,
        };
        writePairingFile(migrated);
        logger.debug('[P2P PAIRING] Migrated legacy pairing file to v2');
        return migrated;
    } catch (error) {
        logger.debug('[P2P PAIRING] Failed to load pairing file:', error);
        return null;
    }
}

/** Read an existing pairing without generating a new secret. */
export function loadPairing(): PersistedPairing | null {
    return parsePairingFile();
}

/**
 * Load the persisted pairing, or create a fresh one when the file is missing.
 * A corrupted file is regenerated with a warning (phones must rescan the QR).
 */
export function loadOrCreatePairing(): PersistedPairing {
    const loaded = parsePairingFile();
    if (loaded) {
        logger.debug(`[P2P PAIRING] Loaded persisted pairing (createdAt: ${loaded.createdAt}, port: ${loaded.port})`);
        return loaded;
    }
    if (existsSync(getPairingFilePath())) {
        console.log('  Warning: pairing file was corrupted — a new secret was generated. Phones must rescan the QR code.');
    }

    const pairing: PersistedPairing = {
        authSecret: generateSharedSecret(),
        contentSecret: generateSharedSecret(),
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
export function updatePairingPort(pairing: PersistedPairing, port: number): PersistedPairing {
    const updated = { ...pairing, port };
    writePairingFile(updated);
    logger.debug(`[P2P PAIRING] Pairing file updated with port ${port}`);
    return updated;
}

/**
 * Replace the pairing atomically while keeping the currently bound port.
 * The caller must commit the in-memory P2P server only after this write
 * succeeds, otherwise an old secret could become valid again after restart.
 */
export function replacePairing(pairing: PersistedPairing): PersistedPairing {
    if (!isValidSecret(pairing.authSecret) || !isValidSecret(pairing.contentSecret)) {
        throw new Error('Unexpected pairing secret length');
    }

    const nextPairing: PersistedPairing = {
        authSecret: pairing.authSecret,
        contentSecret: pairing.contentSecret,
        port: pairing.port,
        createdAt: new Date().toISOString(),
    };
    writePairingFile(nextPairing);
    logger.debug(`[P2P PAIRING] Pairing secret rotated on port ${nextPairing.port}`);
    return nextPairing;
}

/** Delete pairing material for explicit local reset flows. */
export function clearPairing(): boolean {
    const filePath = getPairingFilePath();
    if (!existsSync(filePath)) return false;
    unlinkSync(filePath);
    return true;
}
