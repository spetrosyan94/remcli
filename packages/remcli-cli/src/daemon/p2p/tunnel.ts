/**
 * Ngrok tunnel support for P2P remote access
 *
 * When --tunnel flag is used, starts an ngrok tunnel pointing at the local
 * P2P server port. The tunnel URL replaces the LAN IP in the QR code,
 * enabling access from anywhere (not just local network).
 *
 * Prerequisites: ngrok must be installed and authenticated.
 */

import { execSync, spawn, ChildProcess } from 'node:child_process';
import { logger } from '@/ui/logger';
import axios from 'axios';

interface TunnelInfo {
    url: string;
    stop: () => void;
}

/**
 * Check if ngrok is available on the system
 */
export function isNgrokAvailable(): boolean {
    try {
        execSync('which ngrok', { stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Start an ngrok tunnel for the given local port.
 *
 * Spawns `ngrok http <port>` and polls the local ngrok API to retrieve the
 * public URL. Returns the tunnel URL and a stop function.
 *
 * Returns null if ngrok is not installed or fails to start.
 */
export async function startNgrokTunnel(localPort: number): Promise<TunnelInfo | null> {
    if (!isNgrokAvailable()) {
        console.log('  ngrok is not installed. Install it from https://ngrok.com/download');
        console.log('  Then authenticate: ngrok config add-authtoken <your-token>');
        return null;
    }

    logger.debug(`[TUNNEL] Starting ngrok tunnel for port ${localPort}`);

    // Spawn ngrok as a background process
    const ngrokProcess: ChildProcess = spawn('ngrok', ['http', String(localPort)], {
        stdio: 'ignore',
        detached: true
    });

    // Handle early exit
    let exited = false;
    ngrokProcess.on('exit', (code) => {
        exited = true;
        logger.debug(`[TUNNEL] ngrok exited with code ${code}`);
    });

    ngrokProcess.on('error', (error) => {
        exited = true;
        logger.debug(`[TUNNEL] ngrok error: ${error.message}`);
    });

    // Poll ngrok local API for tunnel URL
    // ngrok exposes API at http://127.0.0.1:4040/api/tunnels
    const maxAttempts = 30;
    const pollIntervalMs = 500;
    let tunnelUrl: string | null = null;

    for (let i = 0; i < maxAttempts; i++) {
        if (exited) {
            logger.debug('[TUNNEL] ngrok exited before tunnel was established');
            return null;
        }

        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        try {
            const response = await axios.get('http://127.0.0.1:4040/api/tunnels', {
                timeout: 2000
            });

            const tunnels = response.data?.tunnels;
            if (tunnels && tunnels.length > 0) {
                // Prefer HTTPS tunnel
                const httpsTunnel = tunnels.find((t: { proto: string }) => t.proto === 'https');
                tunnelUrl = httpsTunnel?.public_url || tunnels[0].public_url;
                break;
            }
        } catch {
            // ngrok API not ready yet, keep polling
        }
    }

    if (!tunnelUrl) {
        logger.debug('[TUNNEL] Failed to get tunnel URL after polling');
        ngrokProcess.kill();
        return null;
    }

    logger.debug(`[TUNNEL] Tunnel established: ${tunnelUrl}`);

    const stop = () => {
        try {
            if (!exited) {
                ngrokProcess.kill();
                logger.debug('[TUNNEL] ngrok process killed');
            }
        } catch (error) {
            logger.debug('[TUNNEL] Error killing ngrok:', error);
        }
    };

    return { url: tunnelUrl, stop };
}
