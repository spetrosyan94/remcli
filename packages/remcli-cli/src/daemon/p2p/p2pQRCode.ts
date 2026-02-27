/**
 * P2P QR Code generation
 *
 * Generates a compact QR code URL for the web app.
 * Hash fragment contains base64-encoded compact JSON ({k, v}) — host/port
 * are derived from the URL itself by the web client, keeping the QR small.
 */

import QRCode from 'qrcode';
import { encodeSharedSecret } from './p2pAuth';

// ─── Types ───────────────────────────────────────────────────────

export interface P2PConnectionInfo {
    mode: 'p2p';
    host: string;      // LAN IP (e.g. "192.168.1.5") or full tunnel URL (e.g. "https://abc.ngrok.io")
    port: number;       // Socket.IO server port (0 when using tunnel)
    key: string;        // Base64-encoded shared secret
    v: 1;               // Protocol version
}

/** Compact hash payload — only the shared secret key and protocol version */
interface CompactHashPayload {
    k: string;  // Base64-encoded shared secret
    v: number;  // Protocol version
}

// ─── QR Code ─────────────────────────────────────────────────────

/**
 * Build the QR code payload JSON
 */
export function buildP2PConnectionInfo(
    host: string,
    port: number,
    sharedSecret: Uint8Array
): P2PConnectionInfo {
    return {
        mode: 'p2p',
        host,
        port,
        key: encodeSharedSecret(sharedSecret),
        v: 1
    };
}

/**
 * Build a URL that, when opened in a browser, loads the web app and auto-connects.
 *
 * The hash fragment contains a base64-encoded compact JSON with only the shared
 * secret and version — host/port are derived from the URL by the web client.
 * This keeps the QR code ~30-40% smaller than encoding the full JSON.
 *
 * LAN:    http://192.168.1.x:PORT/terminal/connect#<base64>
 * Tunnel: https://abc.ngrok.io/terminal/connect#<base64>
 */
export function buildP2PQRUrl(
    info: P2PConnectionInfo,
    tunnelUrl?: string
): string {
    const compact: CompactHashPayload = { k: info.key, v: info.v };
    const hash = Buffer.from(JSON.stringify(compact)).toString('base64');

    if (tunnelUrl) {
        const base = tunnelUrl.replace(/\/$/, '');
        return `${base}/terminal/connect#${hash}`;
    }

    return `http://${info.host}:${info.port}/terminal/connect#${hash}`;
}

/**
 * Display P2P QR code in the terminal.
 * Uses error correction level L for the smallest possible QR code.
 */
export async function displayP2PQRCode(url: string): Promise<void> {
    console.log();
    console.log('='.repeat(60));
    console.log('  P2P Direct Connection');
    console.log('='.repeat(60));
    console.log();
    console.log('  Scan this QR code with your phone camera:');
    console.log();

    const qr = await QRCode.toString(url, {
        type: 'terminal',
        small: true,
        errorCorrectionLevel: 'L',
    });
    for (const line of qr.split('\n')) {
        console.log('    ' + line);
    }

    console.log();
    console.log(`  Open in browser:`);
    console.log(`  ${url}`);
    console.log();
    console.log('='.repeat(60));
    console.log();
}

/**
 * Display connection info without QR code (for status/logs)
 */
export function displayP2PConnectionStatus(host: string, port: number, tunnelUrl?: string): void {
    console.log();
    console.log('  P2P Server Status:');
    console.log(`    LAN:    http://${host}:${port}`);
    if (tunnelUrl) {
        console.log(`    Tunnel: ${tunnelUrl}`);
    }
    console.log();
}
