import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import { decodeBase64, encodeBase64 } from '@/lib/protocol/encoding';
import {
    createCipher,
    createEncryption,
    decryptLegacy,
    decryptWithDataKey,
    deriveKey,
    encryptLegacy,
    encryptWithDataKey,
    hmacSha512,
    seedBoxKeyPair
} from '@/lib/protocol/encryption';

// ─── Daemon-side reference implementations (packages/remcli-cli/src/api/encryption.ts) ─

function daemonEncryptWithDataKey(data: unknown, dataKey: Uint8Array): Uint8Array {
    const nonce = new Uint8Array(randomBytes(12));
    const cipher = createCipheriv('aes-256-gcm', dataKey, nonce);
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const bundle = new Uint8Array(12 + encrypted.length + 16 + 1);
    bundle.set([0], 0);
    bundle.set(nonce, 1);
    bundle.set(new Uint8Array(encrypted), 13);
    bundle.set(new Uint8Array(authTag), 13 + encrypted.length);
    return bundle;
}

function daemonDecryptWithDataKey(bundle: Uint8Array, dataKey: Uint8Array): unknown | null {
    if (bundle[0] !== 0) return null;
    const nonce = bundle.slice(1, 13);
    const authTag = bundle.slice(bundle.length - 16);
    const ciphertext = bundle.slice(13, bundle.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', dataKey, nonce);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(new TextDecoder().decode(decrypted));
}

function daemonPublicKeyFromSeed(seed: Uint8Array): Uint8Array {
    // libsodium crypto_box_seed_keypair emulation from the daemon
    const hashedSeed = new Uint8Array(createHash('sha512').update(seed).digest());
    const secretKey = hashedSeed.slice(0, 32);
    return new Uint8Array(nacl.box.keyPair.fromSecretKey(secretKey).publicKey);
}

function daemonEncryptForPublicKey(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
    const ephemeralKeyPair = nacl.box.keyPair();
    const nonce = new Uint8Array(randomBytes(nacl.box.nonceLength));
    const encrypted = nacl.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);
    const result = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
    result.set(ephemeralKeyPair.publicKey, 0);
    result.set(nonce, ephemeralKeyPair.publicKey.length);
    result.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
    return result;
}

// ─── HMAC / key derivation ───────────────────────────────────────

describe('hmacSha512', () => {
    it('matches node:crypto for short, block-size and long keys', () => {
        const data = new TextEncoder().encode('some data to authenticate');
        for (const keyLength of [1, 32, 64, 128, 129, 300]) {
            const key = new Uint8Array(randomBytes(keyLength));
            const expected = new Uint8Array(createHmac('sha512', key).update(data).digest());
            expect(hmacSha512(key, data)).toEqual(expected);
        }
    });
});

describe('deriveKey', () => {
    it('derives the deterministic key-tree path (node:crypto reference)', () => {
        const master = new Uint8Array(randomBytes(32));

        // Reference: sources/encryption/deriveKey.ts computed with node:crypto
        const root = new Uint8Array(
            createHmac('sha512', new TextEncoder().encode('Remcli Encrypt Master Seed')).update(master).digest()
        );
        let chainCode = root.slice(32);
        const childData = Buffer.concat([Buffer.from([0]), Buffer.from('content')]);
        const child = new Uint8Array(createHmac('sha512', chainCode).update(childData).digest());
        const expected = child.slice(0, 32);

        expect(deriveKey(master, 'Remcli Encrypt', ['content'])).toEqual(expected);
    });
});

describe('seedBoxKeyPair', () => {
    it('matches the daemon libsodium seed keypair emulation', () => {
        const seed = new Uint8Array(randomBytes(32));
        expect(seedBoxKeyPair(seed).publicKey).toEqual(daemonPublicKeyFromSeed(seed));
    });
});

// ─── Legacy scheme (XSalsa20-Poly1305 secretbox) ─────────────────

describe('legacy secretbox scheme', () => {
    it('round-trips arbitrary JSON payloads', () => {
        const secret = new Uint8Array(randomBytes(32));
        const payload = { role: 'user', content: { type: 'text', text: 'привет, мир! 🚀' }, nested: [1, 2, { a: null }] };
        const encrypted = encryptLegacy(payload, secret);
        expect(decryptLegacy(encrypted, secret)).toEqual(payload);
    });

    it('bundle layout is nonce(24) + box, decryptable by the daemon reference impl', () => {
        const secret = new Uint8Array(randomBytes(32));
        const payload = { hello: 'world' };
        const bundle = encryptLegacy(payload, secret);

        // Daemon-side decryptLegacy (packages/remcli-cli/src/api/encryption.ts)
        const nonce = bundle.slice(0, nacl.secretbox.nonceLength);
        const box = bundle.slice(nacl.secretbox.nonceLength);
        const opened = nacl.secretbox.open(box, nonce, secret);
        expect(opened).not.toBeNull();
        expect(JSON.parse(new TextDecoder().decode(opened!))).toEqual(payload);
    });

    it('returns null on wrong key', () => {
        const encrypted = encryptLegacy({ x: 1 }, new Uint8Array(randomBytes(32)));
        expect(decryptLegacy(encrypted, new Uint8Array(randomBytes(32)))).toBeNull();
    });
});

// ─── DataKey scheme (AES-256-GCM) ────────────────────────────────

describe('dataKey AES-256-GCM scheme', () => {
    it('round-trips arbitrary JSON payloads', async () => {
        const dataKey = new Uint8Array(randomBytes(32));
        const payload = { t: 'encrypted?', text: 'ünïcodé проверка', n: 42 };
        const bundle = await encryptWithDataKey(payload, dataKey);
        expect(bundle[0]).toBe(0); // version byte
        expect(await decryptWithDataKey(bundle, dataKey)).toEqual(payload);
    });

    it('decrypts bundles produced by the daemon (node:crypto)', async () => {
        const dataKey = new Uint8Array(randomBytes(32));
        const payload = { from: 'daemon', values: [1, 2, 3] };
        const bundle = daemonEncryptWithDataKey(payload, dataKey);
        expect(await decryptWithDataKey(bundle, dataKey)).toEqual(payload);
    });

    it('produces bundles the daemon can decrypt (node:crypto)', async () => {
        const dataKey = new Uint8Array(randomBytes(32));
        const payload = { from: 'web', ok: true };
        const bundle = await encryptWithDataKey(payload, dataKey);
        expect(daemonDecryptWithDataKey(bundle, dataKey)).toEqual(payload);
    });

    it('rejects wrong version byte and truncated bundles', async () => {
        const dataKey = new Uint8Array(randomBytes(32));
        const bundle = await encryptWithDataKey({ a: 1 }, dataKey);
        const wrongVersion = new Uint8Array(bundle);
        wrongVersion[0] = 1;
        expect(await decryptWithDataKey(wrongVersion, dataKey)).toBeNull();
        expect(await decryptWithDataKey(bundle.slice(0, 10), dataKey)).toBeNull();
    });
});

// ─── Cipher + encryption root ────────────────────────────────────

describe('createCipher', () => {
    it('legacy cipher round-trips base64 strings', async () => {
        const master = new Uint8Array(randomBytes(32));
        const cipher = createCipher(master, null);
        const payload = { method: 'permission', id: 'abc', approved: true };
        const encrypted = await cipher.encryptRaw(payload);
        expect(typeof encrypted).toBe('string');
        expect(await cipher.decryptRaw(encrypted)).toEqual(payload);
    });

    it('dataKey cipher round-trips base64 strings', async () => {
        const master = new Uint8Array(randomBytes(32));
        const dataKey = new Uint8Array(randomBytes(32));
        const cipher = createCipher(master, dataKey);
        const payload = { role: 'agent', content: { type: 'output' } };
        expect(await cipher.decryptRaw(await cipher.encryptRaw(payload))).toEqual(payload);
    });

    it('returns null for garbage input', async () => {
        const cipher = createCipher(new Uint8Array(randomBytes(32)), null);
        expect(await cipher.decryptRaw('not base64!!!')).toBeNull();
        expect(await cipher.decryptRaw(encodeBase64(new Uint8Array(randomBytes(64))))).toBeNull();
    });
});

describe('createEncryption.decryptEncryptionKey', () => {
    it('opens a dataEncryptionKey blob created by the daemon for our content key', () => {
        const master = new Uint8Array(randomBytes(32));
        const encryption = createEncryption(master);

        // Daemon side: derive the same content public key and seal a data key to it
        const contentSeed = deriveKey(master, 'Remcli Encrypt', ['content']);
        const contentPublicKey = daemonPublicKeyFromSeed(contentSeed);
        const dataKey = new Uint8Array(randomBytes(32));
        const sealed = daemonEncryptForPublicKey(dataKey, contentPublicKey);
        const blob = new Uint8Array(sealed.length + 1);
        blob[0] = 0; // version byte
        blob.set(sealed, 1);

        const decrypted = encryption.decryptEncryptionKey(encodeBase64(blob));
        expect(decrypted).toEqual(dataKey);
    });

    it('rejects wrong version byte and garbage', () => {
        const encryption = createEncryption(new Uint8Array(randomBytes(32)));
        const garbage = new Uint8Array(randomBytes(80));
        garbage[0] = 1;
        expect(encryption.decryptEncryptionKey(encodeBase64(garbage))).toBeNull();
        expect(encryption.decryptEncryptionKey('%%%')).toBeNull();
    });
});

describe('encoding', () => {
    it('base64 round-trips and matches Buffer output', () => {
        for (const size of [0, 1, 31, 32, 33, 100]) {
            const bytes = new Uint8Array(randomBytes(size));
            const encoded = encodeBase64(bytes);
            expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
            expect(decodeBase64(encoded)).toEqual(bytes);
        }
    });

    it('base64url round-trips', () => {
        const bytes = new Uint8Array(randomBytes(45));
        const encoded = encodeBase64(bytes, 'base64url');
        expect(encoded).not.toMatch(/[+/=]/);
        expect(decodeBase64(encoded, 'base64url')).toEqual(bytes);
    });
});
