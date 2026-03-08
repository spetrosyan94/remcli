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
import { delimiter } from 'node:path';
import { logger } from '@/ui/logger';
import axios from 'axios';

const IS_WINDOWS = process.platform === 'win32';
const PATH_KEY = IS_WINDOWS ? 'Path' : 'PATH';
const WHICH_CMD = IS_WINDOWS ? 'where' : 'which';

interface TunnelInfo {
    url: string;
    stop: () => void;
}

/**
 * Resolve the path to the SYSTEM ngrok binary, skipping node_modules/.bin.
 *
 * When running inside npm scripts, PATH is prepended with node_modules/.bin
 * which may contain @expo/ngrok-bin (a JS wrapper that uses its own config
 * and does NOT share the system ngrok authtoken). We must use the real
 * system-installed ngrok binary.
 */
export function resolveNgrokBinary(): string | null {
    // Filter PATH to exclude node_modules/.bin entries
    const systemPath = (process.env[PATH_KEY] || '')
        .split(delimiter)
        .filter(p => !p.includes('node_modules'))
        .join(delimiter);

    try {
        const resolved = execSync(`${WHICH_CMD} ngrok`, {
            stdio: 'pipe',
            encoding: 'utf-8',
            env: { ...process.env, [PATH_KEY]: systemPath },
        }).trim().split('\n')[0]; // `where` on Windows may return multiple lines
        logger.debug(`[TUNNEL] Resolved system ngrok: ${resolved}`);
        return resolved;
    } catch {
        return null;
    }
}

/**
 * Check if ngrok is available on the system
 */
export function isNgrokAvailable(): boolean {
    return resolveNgrokBinary() !== null;
}

/**
 * Kill any existing ngrok processes and wait for port 4040 to be freed.
 */
async function killExistingNgrok(): Promise<void> {
    try {
        if (IS_WINDOWS) {
            execSync('taskkill /F /IM ngrok.exe', { stdio: 'pipe' });
        } else {
            execSync('pkill -f "ngrok http"', { stdio: 'pipe' });
        }
        logger.debug('[TUNNEL] Killed existing ngrok processes');
    } catch {
        // No ngrok running
    }

    if (!IS_WINDOWS) {
        try {
            execSync('lsof -ti :4040 | xargs kill -9', { stdio: 'pipe' });
            logger.debug('[TUNNEL] Killed processes on port 4040');
        } catch {
            // Nothing on 4040
        }
    }

    // Wait until port 4040 is actually free (up to 5 seconds)
    const portCheckCmd = IS_WINDOWS
        ? 'netstat -ano | findstr :4040 | findstr LISTENING'
        : 'lsof -i :4040';

    for (let i = 0; i < 10; i++) {
        try {
            execSync(portCheckCmd, { stdio: 'pipe' });
            logger.debug(`[TUNNEL] Port 4040 still in use, waiting... (${i + 1}/10)`);
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch {
            logger.debug('[TUNNEL] Port 4040 is free');
            return;
        }
    }
    logger.debug('[TUNNEL] Port 4040 may still be in use after waiting');
}

/**
 * Start an ngrok tunnel for the given local port.
 *
 * Spawns `ngrok http <port>` and polls the local ngrok API (http://127.0.0.1:4040)
 * to retrieve the public URL. Returns the tunnel URL and a stop function.
 *
 * IMPORTANT: Do NOT add extra flags (--log, --config, etc.) to the ngrok command.
 * ngrok v3 has bugs where certain flags cause it to skip loading its config file,
 * resulting in ERR_NGROK_4018 (authtoken not found) even when properly configured.
 * The simplest invocation `ngrok http <port>` works reliably.
 */
export async function startNgrokTunnel(localPort: number): Promise<TunnelInfo | null> {
    const ngrokBin = resolveNgrokBinary();
    if (!ngrokBin) {
        console.log('  ngrok is not installed. Install it from https://ngrok.com/download');
        console.log('  Then authenticate: ngrok config add-authtoken <your-token>');
        return null;
    }

    await killExistingNgrok();

    logger.debug(`[TUNNEL] Starting ngrok tunnel for port ${localPort} using ${ngrokBin}`);

    // Spawn system ngrok binary directly (not the node_modules/.bin wrapper)
    const ngrokProcess: ChildProcess = spawn(ngrokBin, ['http', String(localPort)], {
        stdio: 'ignore',
        detached: true,
    });
    ngrokProcess.unref();

    let exited = false;
    let exitCode: number | null = null;
    ngrokProcess.on('exit', (code) => {
        exited = true;
        exitCode = code;
        logger.debug(`[TUNNEL] ngrok exited with code ${code}`);
    });
    ngrokProcess.on('error', (error) => {
        exited = true;
        logger.debug(`[TUNNEL] ngrok spawn error: ${error.message}`);
    });

    // Poll ngrok local API for tunnel URL
    const maxAttempts = 30;
    const pollIntervalMs = 500;
    let tunnelUrl: string | null = null;

    for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

        if (exited) {
            logger.debug(`[TUNNEL] ngrok exited with code ${exitCode}`);
            showNgrokError(exitCode);
            return null;
        }

        try {
            const response = await axios.get('http://127.0.0.1:4040/api/tunnels', {
                timeout: 2000,
            });
            const tunnels = response.data?.tunnels;
            if (tunnels && tunnels.length > 0) {
                const httpsTunnel = tunnels.find((t: { proto: string }) => t.proto === 'https');
                tunnelUrl = httpsTunnel?.public_url || tunnels[0].public_url;
                break;
            }
        } catch {
            // ngrok API not ready yet
        }
    }

    if (!tunnelUrl) {
        logger.debug('[TUNNEL] Failed to get tunnel URL after polling');
        try { ngrokProcess.kill(); } catch { /* already dead */ }
        console.log('  ngrok timed out — could not establish tunnel');
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

/**
 * Show user-friendly ngrok error based on exit code
 */
function showNgrokError(exitCode: number | null): void {
    if (exitCode === 1) {
        console.log('  ngrok failed (exit code 1). Most common cause: missing authtoken.');
        console.log('  Run: ngrok config add-authtoken <your-token>');
        console.log('  Get your token at: https://dashboard.ngrok.com/get-started/your-authtoken');
    } else {
        console.log(`  ngrok failed with exit code ${exitCode}`);
    }
}
