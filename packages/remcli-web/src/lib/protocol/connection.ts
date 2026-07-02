/**
 * P2P daemon connection: connect-URL / QR payload parsing, bearer token
 * derivation and localStorage persistence.
 *
 * Port of remcli-app sources/sync/p2pConnect.ts + serverConfig.ts.
 *
 * IMPORTANT: the daemon derives the bearer token with HMAC-SHA512 (not SHA-256) —
 * see packages/remcli-cli/src/daemon/p2p/p2pAuth.ts. SHA-512 is used because the
 * web client must work on plain-HTTP LAN origins where WebCrypto is unavailable.
 */

import { decodeBase64 } from '@/lib/protocol/encoding';
import { hmacSha512 } from '@/lib/protocol/encryption';

// ─── Types ───────────────────────────────────────────────────────

export interface P2PQRPayload {
    mode: 'p2p';
    host: string;
    port: number;
    key: string;      // base64-encoded shared secret
    v: number;        // protocol version
}

export interface P2PConnectionConfig {
    host: string;
    port: number;
    key: string;      // base64-encoded shared secret
}

// ─── Parsing ─────────────────────────────────────────────────────

/**
 * Try to parse scanned/pasted connect data as P2P connection info.
 *
 * Supports two formats:
 * 1. Full JSON: {"mode":"p2p","host":"...","port":12345,"key":"...","v":1}
 * 2. Compact URL: http(s)://host:port/terminal/connect#<base64({k,v})>
 *    Host/port extracted from URL, key/version from base64-encoded hash fragment.
 */
export function parseConnectData(data: string): P2PQRPayload | null {
    // Try full JSON format first
    try {
        const parsed: unknown = JSON.parse(data);
        if (
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as P2PQRPayload).mode === 'p2p' &&
            typeof (parsed as P2PQRPayload).host === 'string' &&
            typeof (parsed as P2PQRPayload).port === 'number' &&
            typeof (parsed as P2PQRPayload).key === 'string' &&
            typeof (parsed as P2PQRPayload).v === 'number'
        ) {
            return parsed as P2PQRPayload;
        }
    } catch {
        // Not JSON — try URL format below
    }

    return parseConnectUrl(data);
}

/**
 * Parse compact connect URL: extract host/port from the URL, key/version from
 * the hash fragment. URL format: http://192.168.1.x:PORT/terminal/connect#<base64({k,v})>
 *
 * Also usable with `window.location.href` when the web app is served by the
 * daemon itself and opened via the QR link.
 */
export function parseConnectUrl(data: string): P2PQRPayload | null {
    try {
        const url = new URL(data);
        if (!url.hash || url.hash.length <= 1) return null;

        const base64 = url.hash.substring(1);
        const decoded = atob(base64);
        const compact = JSON.parse(decoded) as { k?: string; v?: number };

        if (typeof compact.k !== 'string' || typeof compact.v !== 'number') return null;

        if (url.protocol === 'https:') {
            // Tunnel mode — host carries the full origin, port=0 signals it
            return { mode: 'p2p', host: url.origin, port: 0, key: compact.k, v: compact.v };
        }

        const host = url.hostname;
        const port = url.port ? parseInt(url.port, 10) : 80;
        return { mode: 'p2p', host, port, key: compact.k, v: compact.v };
    } catch {
        return null;
    }
}

/**
 * Build a payload from manual input: server URL (http://host:port or
 * https://tunnel-host) + base64 shared secret key.
 */
export function parseManualInput(serverUrl: string, key: string): P2PQRPayload | null {
    const trimmedKey = key.trim();
    if (!trimmedKey) return null;
    try {
        decodeBase64(trimmedKey); // validate base64
    } catch {
        return null;
    }
    try {
        const withProtocol = /^https?:\/\//i.test(serverUrl.trim())
            ? serverUrl.trim()
            : `http://${serverUrl.trim()}`;
        const url = new URL(withProtocol);
        if (url.protocol === 'https:') {
            // Tunnel mode — host contains full URL with protocol, port=0
            return { mode: 'p2p', host: url.origin, port: 0, key: trimmedKey, v: 1 };
        }
        const port = url.port ? parseInt(url.port, 10) : 80;
        return { mode: 'p2p', host: url.hostname, port, key: trimmedKey, v: 1 };
    } catch {
        return null;
    }
}

// ─── Token Derivation ────────────────────────────────────────────

const P2P_AUTH_CONTEXT = 'p2p-auth';

/**
 * Derive bearer token from shared secret using HMAC-SHA512 (hex string).
 * Must produce the same output as the CLI daemon's `deriveBearerToken()`
 * (packages/remcli-cli/src/daemon/p2p/p2pAuth.ts).
 */
export function deriveBearerToken(sharedSecret: Uint8Array): string {
    const data = new TextEncoder().encode(P2P_AUTH_CONTEXT);
    const hash = hmacSha512(sharedSecret, data);
    return Array.from(hash)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

// ─── Endpoint ────────────────────────────────────────────────────

export function buildEndpoint(config: P2PConnectionConfig): string {
    if (config.port === 0) {
        // Tunnel mode — host contains full URL with protocol (e.g. "https://abc.trycloudflare.com")
        return config.host;
    }
    return `http://${config.host}:${config.port}`;
}

// ─── Persistence (localStorage) ──────────────────────────────────

const CONNECTION_STORAGE_KEY = 'remcli-web:p2p-connection';

function getLocalStorage(): Storage | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

export function getStoredConnection(): P2PConnectionConfig | null {
    const storage = getLocalStorage();
    const raw = storage?.getItem(CONNECTION_STORAGE_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as P2PConnectionConfig;
        if (typeof parsed.host !== 'string' || typeof parsed.port !== 'number' || typeof parsed.key !== 'string') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
}

export function storeConnection(config: P2PConnectionConfig): void {
    getLocalStorage()?.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(config));
}

export function clearStoredConnection(): void {
    getLocalStorage()?.removeItem(CONNECTION_STORAGE_KEY);
}

// ─── Connection Setup ────────────────────────────────────────────

export interface P2PCredentials {
    token: string;
    secret: Uint8Array;
    endpoint: string;
}

/**
 * Process a P2P payload: decode the shared secret, derive the bearer token,
 * build the endpoint URL, persist the connection config.
 */
export function connectP2P(payload: P2PQRPayload): P2PCredentials {
    const sharedSecret = decodeBase64(payload.key);
    const token = deriveBearerToken(sharedSecret);
    const config: P2PConnectionConfig = { host: payload.host, port: payload.port, key: payload.key };
    storeConnection(config);
    return { token, secret: sharedSecret, endpoint: buildEndpoint(config) };
}

/**
 * Restore credentials from a persisted connection (page reload). Null when
 * the user never connected or logged out.
 */
export function restoreCredentials(): P2PCredentials | null {
    const config = getStoredConnection();
    if (!config) return null;
    try {
        const sharedSecret = decodeBase64(config.key);
        return {
            token: deriveBearerToken(sharedSecret),
            secret: sharedSecret,
            endpoint: buildEndpoint(config)
        };
    } catch {
        return null;
    }
}

/** Logout — forget the stored connection. */
export function disconnectP2P(): void {
    clearStoredConnection();
}
