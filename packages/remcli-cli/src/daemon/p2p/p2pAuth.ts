/**
 * P2P authentication using the revocable pairing auth secret.
 * No accounts or user IDs — pairing material establishes remote trust.
 * QR code scan proves physical proximity and establishes trust
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { encodeBase64, decodeBase64 } from '@/api/encryption';

const P2P_AUTH_CONTEXT = 'p2p-auth';
export const PAIRING_SECRET_SIZE = 32;
const PAIRING_V1_KEY_SIZE = PAIRING_SECRET_SIZE;
const PAIRING_V2_KEY_SIZE = PAIRING_SECRET_SIZE * 2;

export interface PairingSecrets {
    authSecret: Uint8Array;
    contentSecret: Uint8Array;
}

/**
 * Generate one new random 32-byte pairing secret.
 */
export function generateSharedSecret(): Uint8Array {
    return new Uint8Array(randomBytes(PAIRING_SECRET_SIZE));
}

/**
 * Encode v2 QR key material. The first half rotates to revoke paired user
 * clients; the second half stays stable so active encrypted session transport
 * does not break during a rekey.
 */
export function encodePairingKey(secrets: PairingSecrets): string {
    if (secrets.authSecret.length !== PAIRING_SECRET_SIZE || secrets.contentSecret.length !== PAIRING_SECRET_SIZE) {
        throw new Error('Pairing secrets must be 32 bytes');
    }
    const key = new Uint8Array(PAIRING_V2_KEY_SIZE);
    key.set(secrets.authSecret, 0);
    key.set(secrets.contentSecret, PAIRING_SECRET_SIZE);
    return encodeBase64(key);
}

/**
 * Decode both legacy v1 QR payloads and v2 split pairing payloads. v1 maps the
 * single secret to both roles so existing devices continue to connect.
 */
export function decodePairingKey(encoded: string): PairingSecrets {
    const key = decodeBase64(encoded);
    if (key.length === PAIRING_V1_KEY_SIZE) {
        return { authSecret: key, contentSecret: key };
    }
    if (key.length === PAIRING_V2_KEY_SIZE) {
        return {
            authSecret: key.slice(0, PAIRING_SECRET_SIZE),
            contentSecret: key.slice(PAIRING_SECRET_SIZE),
        };
    }
    throw new Error(`Unexpected pairing key length: ${key.length}`);
}

/**
 * Derive a bearer token from the shared secret using HMAC-SHA512
 * Both daemon and app compute the same token from the same secret.
 * SHA-512 is used because libsodium-wrappers (web) only exposes crypto_hash (SHA-512),
 * and Web Crypto API (SHA-256) requires HTTPS which isn't available on LAN HTTP.
 */
export function deriveBearerToken(authSecret: Uint8Array): string {
    const hmac = createHmac('sha512', authSecret);
    hmac.update(P2P_AUTH_CONTEXT);
    return hmac.digest('hex');
}

/**
 * Verify a bearer token against the shared secret
 * Uses timing-safe comparison to prevent timing attacks
 */
export function verifyBearerToken(token: string, authSecret: Uint8Array): boolean {
    const expected = deriveBearerToken(authSecret);
    if (token.length !== expected.length) return false;

    try {
        return timingSafeEqual(
            Buffer.from(token, 'utf-8'),
            Buffer.from(expected, 'utf-8')
        );
    } catch {
        return false;
    }
}

/**
 * Encode one 32-byte pairing secret as base64 for pairing storage or QR material.
 */
export function encodeSharedSecret(secret: Uint8Array): string {
    return encodeBase64(secret);
}

/**
 * Decode one 32-byte pairing secret from pairing storage or QR material.
 */
export function decodeSharedSecret(encoded: string): Uint8Array {
    const secret = decodeBase64(encoded);
    if (secret.length !== PAIRING_SECRET_SIZE) {
        throw new Error(`Unexpected shared secret length: ${secret.length}`);
    }
    return secret;
}
