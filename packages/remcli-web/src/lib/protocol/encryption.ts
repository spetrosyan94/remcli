/**
 * End-to-end encryption — 1:1 port of remcli-app sources/encryption/ + sources/sync/encryption/.
 *
 * Two wire schemes (must match packages/remcli-cli/src/api/encryption.ts exactly):
 * - Legacy:  XSalsa20-Poly1305 secretbox (tweetnacl). Bundle: nonce(24) + box(JSON).
 * - DataKey: AES-256-GCM (WebCrypto). Bundle: version(1, =0) + nonce(12) + ciphertext + tag(16).
 *
 * Key material:
 * - masterSecret = 32-byte shared secret from the QR code.
 * - contentKeyPair = crypto_box_seed_keypair(deriveKey(masterSecret, 'Remcli Encrypt', ['content'])).
 *   Session/machine dataEncryptionKey blobs are curve25519 boxes addressed to that key pair.
 *
 * libsodium seed keypair emulation (tweetnacl does not do this by default):
 *   secretKey = SHA-512(seed)[0..32), publicKey = scalarmult_base(secretKey).
 */

import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from '@/lib/protocol/encoding';

// ─── HMAC-SHA512 (pure, over nacl.hash) ──────────────────────────
// WebCrypto (crypto.subtle) is unavailable on plain-HTTP LAN origins,
// so HMAC is built on tweetnacl's SHA-512 — same as the RN web build
// (sources/encryption/hmac_sha512.web.ts). Output matches node:crypto.

export function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
    const blockSize = 128; // SHA-512 block size in bytes
    const opad = 0x5c;
    const ipad = 0x36;

    let actualKey = key;
    if (key.length > blockSize) {
        actualKey = nacl.hash(key);
    }

    const paddedKey = new Uint8Array(blockSize);
    paddedKey.set(actualKey);

    const innerKey = new Uint8Array(blockSize);
    const outerKey = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) {
        innerKey[i] = paddedKey[i] ^ ipad;
        outerKey[i] = paddedKey[i] ^ opad;
    }

    const innerData = new Uint8Array(blockSize + data.length);
    innerData.set(innerKey);
    innerData.set(data, blockSize);
    const innerHash = nacl.hash(innerData);

    const outerData = new Uint8Array(blockSize + 64);
    outerData.set(outerKey);
    outerData.set(innerHash, blockSize);
    return nacl.hash(outerData);
}

// ─── Key tree derivation (port of sources/encryption/deriveKey.ts) ─

export function deriveKey(master: Uint8Array, usage: string, path: string[]): Uint8Array {
    const root = hmacSha512(new TextEncoder().encode(usage + ' Master Seed'), master);
    let key = root.slice(0, 32);
    let chainCode = root.slice(32);
    for (const index of path) {
        const data = new Uint8Array([0x0, ...new TextEncoder().encode(index)]);
        const derived = hmacSha512(chainCode, data);
        key = derived.slice(0, 32);
        chainCode = derived.slice(32);
    }
    return key;
}

// ─── libsodium-compatible seed keypair ───────────────────────────

export interface BoxKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export function seedBoxKeyPair(seed: Uint8Array): BoxKeyPair {
    const hashedSeed = nacl.hash(seed);
    const secretKey = hashedSeed.slice(0, 32);
    const pair = nacl.box.keyPair.fromSecretKey(secretKey);
    return { publicKey: pair.publicKey, secretKey: pair.secretKey };
}

// ─── Curve25519 box (ephemeral key bundle) ───────────────────────
// Bundle format: ephemeral public key (32) + nonce (24) + box ciphertext.

export function encryptBox(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeralKeyPair = nacl.box.keyPair();
    const nonce = nacl.randomBytes(nacl.box.nonceLength);
    const encrypted = nacl.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);

    const result = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
    result.set(ephemeralKeyPair.publicKey, 0);
    result.set(nonce, ephemeralKeyPair.publicKey.length);
    result.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
    return result;
}

export function decryptBox(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
    const publicKeyLength = nacl.box.publicKeyLength;
    const nonceLength = nacl.box.nonceLength;
    if (encryptedBundle.length < publicKeyLength + nonceLength) {
        return null;
    }
    const ephemeralPublicKey = encryptedBundle.slice(0, publicKeyLength);
    const nonce = encryptedBundle.slice(publicKeyLength, publicKeyLength + nonceLength);
    const encrypted = encryptedBundle.slice(publicKeyLength + nonceLength);
    try {
        return nacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
    } catch {
        return null;
    }
}

// ─── Legacy scheme: XSalsa20-Poly1305 secretbox ──────────────────
// Bundle format: nonce (24) + secretbox(JSON bytes).

export function encryptLegacy(data: unknown, secret: Uint8Array): Uint8Array {
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const encrypted = nacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, secret);
    const result = new Uint8Array(nonce.length + encrypted.length);
    result.set(nonce);
    result.set(encrypted, nonce.length);
    return result;
}

export function decryptLegacy(data: Uint8Array, secret: Uint8Array): unknown | null {
    const nonce = data.slice(0, nacl.secretbox.nonceLength);
    const encrypted = data.slice(nacl.secretbox.nonceLength);
    try {
        const decrypted = nacl.secretbox.open(encrypted, nonce, secret);
        if (!decrypted) {
            return null;
        }
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}

// ─── DataKey scheme: AES-256-GCM (WebCrypto) ─────────────────────
// Bundle format: version byte (0) + nonce (12) + ciphertext + auth tag (16).
// WebCrypto AES-GCM outputs ciphertext||tag, which matches the node format.

const AES_GCM_NONCE_LENGTH = 12;
const AES_GCM_TAG_LENGTH = 16;

function requireSubtle(): SubtleCrypto {
    if (typeof crypto === 'undefined' || !crypto.subtle) {
        throw new Error('WebCrypto is unavailable — AES-256-GCM requires a secure context (HTTPS or localhost)');
    }
    return crypto.subtle;
}

async function importAesKey(dataKey: Uint8Array): Promise<CryptoKey> {
    return requireSubtle().importKey(
        'raw',
        dataKey.slice().buffer as ArrayBuffer,
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
    );
}

export async function encryptWithDataKey(data: unknown, dataKey: Uint8Array): Promise<Uint8Array> {
    const key = await importAesKey(dataKey);
    const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_LENGTH));
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const encrypted = new Uint8Array(await requireSubtle().encrypt(
        { name: 'AES-GCM', iv: nonce, tagLength: AES_GCM_TAG_LENGTH * 8 },
        key,
        plaintext.slice().buffer as ArrayBuffer
    ));

    const bundle = new Uint8Array(1 + AES_GCM_NONCE_LENGTH + encrypted.length);
    bundle[0] = 0;
    bundle.set(nonce, 1);
    bundle.set(encrypted, 1 + AES_GCM_NONCE_LENGTH);
    return bundle;
}

export async function decryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): Promise<unknown | null> {
    if (bundle.length < 1 + AES_GCM_NONCE_LENGTH + AES_GCM_TAG_LENGTH) {
        return null;
    }
    if (bundle[0] !== 0) { // Only version 0
        return null;
    }
    const nonce = bundle.slice(1, 1 + AES_GCM_NONCE_LENGTH);
    const ciphertextWithTag = bundle.slice(1 + AES_GCM_NONCE_LENGTH);
    try {
        const key = await importAesKey(dataKey);
        const decrypted = new Uint8Array(await requireSubtle().decrypt(
            { name: 'AES-GCM', iv: nonce, tagLength: AES_GCM_TAG_LENGTH * 8 },
            key,
            ciphertextWithTag.slice().buffer as ArrayBuffer
        ));
        return JSON.parse(new TextDecoder().decode(decrypted));
    } catch {
        return null;
    }
}

// ─── Cipher: uniform encrypt/decrypt for a session/machine ──────
// dataKey === null → legacy secretbox with the master secret,
// dataKey !== null → AES-256-GCM with the per-entity data key.

export interface Cipher {
    encryptRaw(data: unknown): Promise<string>;
    decryptRaw(encrypted: string): Promise<unknown | null>;
}

export function createCipher(masterSecret: Uint8Array, dataKey: Uint8Array | null): Cipher {
    return {
        async encryptRaw(data: unknown): Promise<string> {
            const bundle = dataKey
                ? await encryptWithDataKey(data, dataKey)
                : encryptLegacy(data, masterSecret);
            return encodeBase64(bundle, 'base64');
        },
        async decryptRaw(encrypted: string): Promise<unknown | null> {
            try {
                const bundle = decodeBase64(encrypted, 'base64');
                return dataKey
                    ? await decryptWithDataKey(bundle, dataKey)
                    : decryptLegacy(bundle, masterSecret);
            } catch {
                return null;
            }
        }
    };
}

// ─── Encryption root (port of sources/sync/encryption/encryption.ts) ─

export interface Encryption {
    /** Master-secret legacy cipher (account-level payloads). */
    legacy: Cipher;
    /** Decrypt a per-session/machine dataEncryptionKey blob (base64). */
    decryptEncryptionKey(encrypted: string): Uint8Array | null;
    /** Build the cipher for an entity given its (already decrypted) data key. */
    openCipher(dataKey: Uint8Array | null): Cipher;
}

export function createEncryption(masterSecret: Uint8Array): Encryption {
    // Derive the content key pair used to open session/machine data keys
    const contentDataKeySeed = deriveKey(masterSecret, 'Remcli Encrypt', ['content']);
    const contentKeyPair = seedBoxKeyPair(contentDataKeySeed);

    return {
        legacy: createCipher(masterSecret, null),
        decryptEncryptionKey(encrypted: string): Uint8Array | null {
            try {
                const encryptedKey = decodeBase64(encrypted, 'base64');
                if (encryptedKey.length < 1 || encryptedKey[0] !== 0) {
                    return null;
                }
                return decryptBox(encryptedKey.slice(1), contentKeyPair.secretKey);
            } catch {
                return null;
            }
        },
        openCipher(dataKey: Uint8Array | null): Cipher {
            return createCipher(masterSecret, dataKey);
        }
    };
}
