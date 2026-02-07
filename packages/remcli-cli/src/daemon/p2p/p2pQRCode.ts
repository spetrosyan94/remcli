/**
 * P2P QR Code generation
 * Generates a QR code containing a URL that opens the web app with connection info in the hash
 */

import qrcode from 'qrcode-terminal';
import { encodeSharedSecret } from './p2pAuth';

// ─── Types ───────────────────────────────────────────────────────

export interface P2PConnectionInfo {
    mode: 'p2p';
    host: string;      // LAN IP (e.g. "192.168.1.5") or full tunnel URL (e.g. "https://abc.ngrok.io")
    port: number;       // Socket.IO server port (0 when using tunnel)
    key: string;        // Base64-encoded shared secret
    v: 1;               // Protocol version
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
 * The hash fragment contains the P2P connection JSON — the web app's
 * terminal/connect page already reads and parses it from window.location.hash.
 *
 * LAN:    http://192.168.1.x:PORT/terminal/connect#<encoded_json>
 * Tunnel: https://abc.ngrok.io/terminal/connect#<encoded_json>
 */
export function buildP2PQRUrl(
    info: P2PConnectionInfo,
    tunnelUrl?: string
): string {
    const hash = encodeURIComponent(JSON.stringify(info));

    if (tunnelUrl) {
        // Tunnel URL already includes protocol
        const base = tunnelUrl.replace(/\/$/, '');
        return `${base}/terminal/connect#${hash}`;
    }

    return `http://${info.host}:${info.port}/terminal/connect#${hash}`;
}

/**
 * Display P2P QR code in the terminal.
 * The QR encodes a URL so any phone camera can open it in a browser.
 */
export function displayP2PQRCode(url: string): void {
    console.log();
    console.log('='.repeat(60));
    console.log('  P2P Direct Connection');
    console.log('='.repeat(60));
    console.log();
    console.log('  Scan this QR code with your phone camera:');
    console.log();

    qrcode.generate(url, { small: true }, (qr) => {
        for (const line of qr.split('\n')) {
            console.log('    ' + line);
        }
    });

    console.log();
    console.log(`  URL: ${url.split('#')[0]}`);
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
