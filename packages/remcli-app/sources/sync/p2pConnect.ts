/**
 * P2P direct connection support
 *
 * Parses P2P QR code payload, derives bearer token from shared secret
 * using HMAC-SHA256 (matching the CLI daemon's derivation), and configures
 * the app to connect directly to the daemon's local P2P server.
 */

import { decodeBase64 } from '@/encryption/base64';
import { hmac_sha512 } from '@/encryption/hmac_sha512';
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
 * Derive bearer token from shared secret using HMAC-SHA512.
 * Must produce the same output as the CLI daemon's `deriveBearerToken()`.
 *
 * Uses hmac_sha512 which has platform-specific implementations:
 * - Native: expo-crypto (secure native crypto)
 * - Web: libsodium WASM (works on HTTP, no secure context needed)
 */
export async function deriveBearerToken(sharedSecret: Uint8Array): Promise<string> {
    const data = new TextEncoder().encode(P2P_AUTH_CONTEXT);
    const hash = await hmac_sha512(sharedSecret, data);
    return Array.from(hash)
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
        // Tunnel mode — host contains full URL with protocol (e.g. "https://abc.ngrok.io")
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
