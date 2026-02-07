/**
 * P2P authentication using shared secret
 * No accounts, no user IDs — the shared secret IS the identity
 * QR code scan proves physical proximity and establishes trust
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { encodeBase64, decodeBase64 } from '@/api/encryption';

const P2P_AUTH_CONTEXT = 'p2p-auth';
const SHARED_SECRET_SIZE = 32;

/**
 * Generate a new random shared secret (32 bytes)
 */
export function generateSharedSecret(): Uint8Array {
    return new Uint8Array(randomBytes(SHARED_SECRET_SIZE));
}

/**
 * Derive a bearer token from the shared secret using HMAC-SHA256
 * Both daemon and app compute the same token from the same secret
 */
export function deriveBearerToken(sharedSecret: Uint8Array): string {
    const hmac = createHmac('sha256', sharedSecret);
    hmac.update(P2P_AUTH_CONTEXT);
    return hmac.digest('hex');
}

/**
 * Verify a bearer token against the shared secret
 * Uses timing-safe comparison to prevent timing attacks
 */
export function verifyBearerToken(token: string, sharedSecret: Uint8Array): boolean {
    const expected = deriveBearerToken(sharedSecret);
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
 * Encode shared secret for QR code (base64)
 */
export function encodeSharedSecret(secret: Uint8Array): string {
    return encodeBase64(secret);
}

/**
 * Decode shared secret from QR code (base64)
 */
export function decodeSharedSecret(encoded: string): Uint8Array {
    return decodeBase64(encoded);
}
