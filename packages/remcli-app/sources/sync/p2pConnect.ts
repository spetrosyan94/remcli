/**
 * P2P direct connection support
 *
 * Parses P2P QR code payload, derives bearer token from shared secret
 * using HMAC-SHA256 (matching the CLI daemon's derivation), and configures
 * the app to connect directly to the daemon's local P2P server.
 */

import * as Crypto from 'expo-crypto';
import { decodeBase64 } from '@/encryption/base64';
import { setP2PConfig, clearP2PConfig, P2PConfig } from './serverConfig';

// ─── Types ───────────────────────────────────────────────────────

export interface P2PQRPayload {
    mode: 'p2p';
    host: string;
    port: number;
    key: string;      // base64-encoded shared secret
    v: number;        // protocol version
}

// ─── QR Parsing ──────────────────────────────────────────────────

/**
 * Try to parse a scanned QR code as P2P connection info.
 * Returns null if the data is not a valid P2P QR payload.
 */
export function parseP2PQRCode(data: string): P2PQRPayload | null {
    try {
        const parsed = JSON.parse(data);
        if (
            parsed &&
            parsed.mode === 'p2p' &&
            typeof parsed.host === 'string' &&
            typeof parsed.port === 'number' &&
            typeof parsed.key === 'string' &&
            typeof parsed.v === 'number'
        ) {
            return parsed as P2PQRPayload;
        }
    } catch {
        // Not JSON — not a P2P QR code
    }
    return null;
}

// ─── Token Derivation ────────────────────────────────────────────

const P2P_AUTH_CONTEXT = 'p2p-auth';

/**
 * Derive bearer token from shared secret using HMAC-SHA256.
 * Must produce the same output as the CLI daemon's `deriveBearerToken()`.
 *
 * Uses Web Crypto API (via expo-crypto digest) for cross-platform support.
 */
export async function deriveBearerToken(sharedSecret: Uint8Array): Promise<string> {
    // HMAC-SHA256 manual implementation using expo-crypto SHA256 digest
    // This mirrors Node.js createHmac('sha256', key).update(data).digest('hex')
    const blockSize = 64; // SHA256 block size in bytes

    // Prepare key — if longer than block size, hash it first
    let key = new Uint8Array(sharedSecret);
    if (key.length > blockSize) {
        const keyHash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, new Uint8Array(key));
        key = new Uint8Array(keyHash);
    }

    // Pad key to block size
    const paddedKey = new Uint8Array(blockSize);
    paddedKey.set(key);

    // Create inner and outer padded keys
    const innerKey = new Uint8Array(blockSize);
    const outerKey = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) {
        innerKey[i] = paddedKey[i] ^ 0x36;
        outerKey[i] = paddedKey[i] ^ 0x5c;
    }

    // Data to HMAC
    const data = new TextEncoder().encode(P2P_AUTH_CONTEXT);

    // Inner hash: SHA256(innerKey || data)
    const innerData = new Uint8Array(blockSize + data.length);
    innerData.set(innerKey);
    innerData.set(data, blockSize);
    const innerHash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, innerData);

    // Outer hash: SHA256(outerKey || innerHash)
    const outerData = new Uint8Array(blockSize + 32); // 32 bytes for SHA256
    outerData.set(outerKey);
    outerData.set(new Uint8Array(innerHash), blockSize);
    const finalHash = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, outerData);

    // Convert to hex string
    return Array.from(new Uint8Array(finalHash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// ─── Connection Setup ────────────────────────────────────────────

/**
 * Process a P2P QR code payload: decode the shared secret, derive the bearer
 * token, build the server URL, and persist the P2P config so the app connects
 * to the daemon's local P2P server.
 *
 * Returns the bearer token and master secret for auth login.
 */
export async function connectP2P(payload: P2PQRPayload): Promise<{
    token: string;
    secret: Uint8Array;
    endpoint: string;
}> {
    // Decode shared secret from base64
    const sharedSecret = decodeBase64(payload.key);

    // Derive bearer token (same algorithm as CLI daemon)
    const token = await deriveBearerToken(sharedSecret);

    // Build endpoint URL
    let endpoint: string;
    if (payload.port === 0) {
        // Tunnel mode — host IS the full URL
        endpoint = payload.host;
    } else {
        endpoint = `http://${payload.host}:${payload.port}`;
    }

    // Persist P2P config
    const p2pConfig: P2PConfig = {
        host: payload.host,
        port: payload.port,
        key: payload.key,
    };
    setP2PConfig(p2pConfig);

    return { token, secret: sharedSecret, endpoint };
}

/**
 * Disconnect from P2P — clears stored P2P config
 */
export function disconnectP2P(): void {
    clearP2PConfig();
}
