import { Platform } from 'react-native';

// ─── Storage Abstraction ────────────────────────────────────────
// MMKV does not support web — use localStorage as fallback

interface KVStorage {
    getString(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
}

function createStorage(id: string): KVStorage {
    if (Platform.OS === 'web') {
        const prefix = `mmkv-${id}:`;
        return {
            getString(key: string) {
                return localStorage.getItem(prefix + key) ?? undefined;
            },
            set(key: string, value: string) {
                localStorage.setItem(prefix + key, value);
            },
            delete(key: string) {
                localStorage.removeItem(prefix + key);
            }
        };
    }

    // Native: use MMKV
    const { MMKV } = require('react-native-mmkv');
    return new MMKV({ id });
}

const serverConfigStorage = createStorage('server-config');

const P2P_CONFIG_KEY = 'p2p-config';
// ─── P2P Config ──────────────────────────────────────────────────

export interface P2PConfig {
    host: string;
    port: number;
    key: string;  // base64-encoded shared secret
}

export function getP2PConfig(): P2PConfig | null {
    const raw = serverConfigStorage.getString(P2P_CONFIG_KEY);
    if (!raw) return null;
    try {
        return JSON.parse(raw) as P2PConfig;
    } catch {
        return null;
    }
}

export function setP2PConfig(config: P2PConfig): void {
    serverConfigStorage.set(P2P_CONFIG_KEY, JSON.stringify(config));
}

export function clearP2PConfig(): void {
    serverConfigStorage.delete(P2P_CONFIG_KEY);
}

export function isP2PMode(): boolean {
    return getP2PConfig() !== null;
}

// ─── Server URL ──────────────────────────────────────────────────

export function getServerUrl(): string {
    const p2p = getP2PConfig();
    if (p2p) {
        if (p2p.port === 0) {
            // Tunnel mode — host contains full URL with protocol (e.g. "https://abc.ngrok.io")
            return p2p.host;
        }
        return `http://${p2p.host}:${p2p.port}`;
    }

    return '';
}

export function getServerInfo(): { hostname: string; port?: number; isP2P: boolean } {
    const url = getServerUrl();
    const p2p = isP2PMode();

    try {
        const parsed = new URL(url);
        const port = parsed.port ? parseInt(parsed.port) : undefined;
        return {
            hostname: parsed.hostname,
            port,
            isP2P: p2p
        };
    } catch {
        return {
            hostname: url,
            port: undefined,
            isP2P: p2p
        };
    }
}
