import { createHmac, randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    buildEndpoint,
    clearStoredConnection,
    connectP2P,
    deriveBearerToken,
    getStoredConnection,
    parseConnectData,
    parseConnectUrl,
    parseManualInput,
    restoreCredentials,
    storeConnection
} from '@/lib/protocol/connection';

// In-memory localStorage stub for the node test environment
function installLocalStorage(): void {
    const backing = new Map<string, string>();
    const stub = {
        getItem: (key: string) => backing.get(key) ?? null,
        setItem: (key: string, value: string) => { backing.set(key, value); },
        removeItem: (key: string) => { backing.delete(key); },
        clear: () => { backing.clear(); },
        key: (index: number) => [...backing.keys()][index] ?? null,
        get length() { return backing.size; }
    };
    (globalThis as { localStorage?: unknown }).localStorage = stub;
}

describe('deriveBearerToken', () => {
    it('matches the daemon HMAC-SHA512 derivation (node:crypto reference)', () => {
        for (let i = 0; i < 5; i++) {
            const secret = new Uint8Array(randomBytes(32));
            const expected = createHmac('sha512', secret).update('p2p-auth').digest('hex');
            expect(deriveBearerToken(secret)).toBe(expected);
        }
    });

    it('produces a known vector', () => {
        const secret = new Uint8Array(32); // all zeros
        const expected = createHmac('sha512', secret).update('p2p-auth').digest('hex');
        const actual = deriveBearerToken(secret);
        expect(actual).toBe(expected);
        expect(actual).toHaveLength(128); // 64 bytes hex
    });
});

describe('parseConnectData / parseConnectUrl', () => {
    const key = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

    it('parses the full JSON QR payload', () => {
        const payload = JSON.stringify({ mode: 'p2p', host: '192.168.1.5', port: 8005, key, v: 1 });
        expect(parseConnectData(payload)).toEqual({ mode: 'p2p', host: '192.168.1.5', port: 8005, key, v: 1 });
    });

    it('parses the compact URL with base64({k,v}) hash fragment', () => {
        const hash = Buffer.from(JSON.stringify({ k: key, v: 1 })).toString('base64');
        const url = `http://192.168.1.5:8005/terminal/connect#${hash}`;
        expect(parseConnectData(url)).toEqual({ mode: 'p2p', host: '192.168.1.5', port: 8005, key, v: 1 });
        expect(parseConnectUrl(url)).toEqual({ mode: 'p2p', host: '192.168.1.5', port: 8005, key, v: 1 });
    });

    it('parses the tunnel URL (https, port=0, host=origin)', () => {
        const hash = Buffer.from(JSON.stringify({ k: key, v: 1 })).toString('base64');
        const url = `https://abc.trycloudflare.com/terminal/connect#${hash}`;
        expect(parseConnectData(url)).toEqual({
            mode: 'p2p',
            host: 'https://abc.trycloudflare.com',
            port: 0,
            key,
            v: 1
        });
    });

    it('rejects invalid inputs', () => {
        expect(parseConnectData('not a url')).toBeNull();
        expect(parseConnectData('{"mode":"p2p"}')).toBeNull();
        expect(parseConnectData('http://192.168.1.5:8005/terminal/connect')).toBeNull(); // no hash
        const badHash = Buffer.from(JSON.stringify({ nope: true })).toString('base64');
        expect(parseConnectData(`http://192.168.1.5:8005/terminal/connect#${badHash}`)).toBeNull();
    });
});

describe('parseManualInput', () => {
    const key = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');

    it('builds a payload from host:port + key', () => {
        expect(parseManualInput('192.168.1.5:8005', key)).toEqual({
            mode: 'p2p', host: '192.168.1.5', port: 8005, key, v: 1
        });
        expect(parseManualInput('http://192.168.1.5:8005', key)).toEqual({
            mode: 'p2p', host: '192.168.1.5', port: 8005, key, v: 1
        });
    });

    it('treats https URLs as tunnel mode (port=0)', () => {
        expect(parseManualInput('https://abc.trycloudflare.com', key)).toEqual({
            mode: 'p2p', host: 'https://abc.trycloudflare.com', port: 0, key, v: 1
        });
    });

    it('rejects an empty or non-base64 key', () => {
        expect(parseManualInput('192.168.1.5:8005', '')).toBeNull();
        expect(parseManualInput('192.168.1.5:8005', '!!!not-base64!!!')).toBeNull();
    });
});

describe('buildEndpoint', () => {
    it('builds LAN and tunnel endpoints', () => {
        expect(buildEndpoint({ host: '192.168.1.5', port: 8005, key: 'x' })).toBe('http://192.168.1.5:8005');
        expect(buildEndpoint({ host: 'https://abc.trycloudflare.com', port: 0, key: 'x' })).toBe('https://abc.trycloudflare.com');
    });
});

describe('connection persistence (localStorage)', () => {
    beforeEach(() => {
        installLocalStorage();
        clearStoredConnection();
    });

    it('stores, restores and clears the connection', () => {
        const key = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');
        expect(getStoredConnection()).toBeNull();
        expect(restoreCredentials()).toBeNull();

        storeConnection({ host: '10.0.0.2', port: 9001, key });
        expect(getStoredConnection()).toEqual({ host: '10.0.0.2', port: 9001, key });

        const restored = restoreCredentials();
        expect(restored).not.toBeNull();
        expect(restored!.endpoint).toBe('http://10.0.0.2:9001');
        expect(restored!.token).toBe(deriveBearerToken(new Uint8Array(32).fill(3)));

        clearStoredConnection();
        expect(getStoredConnection()).toBeNull();
    });

    it('connectP2P derives credentials and persists the config', () => {
        const secret = new Uint8Array(randomBytes(32));
        const key = Buffer.from(secret).toString('base64');
        const credentials = connectP2P({ mode: 'p2p', host: '192.168.1.7', port: 8123, key, v: 1 });

        expect(credentials.endpoint).toBe('http://192.168.1.7:8123');
        expect(credentials.secret).toEqual(secret);
        expect(credentials.token).toBe(createHmac('sha512', secret).update('p2p-auth').digest('hex'));
        expect(getStoredConnection()).toEqual({ host: '192.168.1.7', port: 8123, key });
    });
});
