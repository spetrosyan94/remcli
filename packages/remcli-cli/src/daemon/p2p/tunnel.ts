/**
 * Cloudflare Tunnel (cloudflared) support for P2P remote access
 *
 * When --tunnel flag is used, starts a cloudflared quick tunnel pointing at the
 * local P2P server port. The tunnel URL replaces the LAN IP in the QR code,
 * enabling access from anywhere (not just local network).
 *
 * Quick tunnels require no account or auth — just `cloudflared tunnel --url http://localhost:PORT`.
 * Provides HTTPS with no interstitial page and no account required.
 */

import { execSync, spawn, ChildProcess } from 'node:child_process';
import { delimiter } from 'node:path';
import { logger } from '@/ui/logger';

const IS_WINDOWS = process.platform === 'win32';
const PATH_KEY = IS_WINDOWS ? 'Path' : 'PATH';
const WHICH_CMD = IS_WINDOWS ? 'where' : 'which';

export interface TunnelInfo {
    url: string;
    stop: () => void;
}

/**
 * Resolve the path to the cloudflared binary, skipping node_modules/.bin.
 */
export function resolveCloudflaredBinary(): string | null {
    const systemPath = (process.env[PATH_KEY] || '')
        .split(delimiter)
        .filter(p => !p.includes('node_modules'))
        .join(delimiter);

    try {
        const resolved = execSync(`${WHICH_CMD} cloudflared`, {
            stdio: 'pipe',
            encoding: 'utf-8',
            env: { ...process.env, [PATH_KEY]: systemPath },
        }).trim().split('\n')[0];
        logger.debug(`[TUNNEL] Resolved cloudflared: ${resolved}`);
        return resolved;
    } catch {
        return null;
    }
}

/**
 * Check if cloudflared is available on the system
 */
export function isCloudflaredAvailable(): boolean {
    return resolveCloudflaredBinary() !== null;
}

/**
 * Start a cloudflared quick tunnel for the given local port.
 *
 * Spawns `cloudflared tunnel --url http://localhost:<port>` and parses stderr
 * for the generated trycloudflare.com URL.
 *
 * Quick tunnels need no account, no auth, and have no interstitial pages.
 *
 * After capturing the tunnel URL, stdout/stderr listeners are replaced with
 * drain handlers to prevent pipe buffer overflow from blocking cloudflared.
 */
export async function startCloudflaredTunnel(localPort: number): Promise<TunnelInfo | null> {
    const bin = resolveCloudflaredBinary();
    if (!bin) {
        console.log('  cloudflared is not installed.');
        console.log('  Install: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
        console.log('  macOS: brew install cloudflared');
        return null;
    }

    logger.debug(`[TUNNEL] Starting cloudflared tunnel for port ${localPort} using ${bin}`);

    const cfProcess: ChildProcess = spawn(
        bin,
        ['tunnel', '--no-autoupdate', '--url', `http://localhost:${localPort}`],
        { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    // Prevent the cloudflared child from keeping the daemon alive on shutdown
    cfProcess.unref();

    let exited = false;
    let exitCode: number | null = null;
    cfProcess.on('exit', (code) => {
        exited = true;
        exitCode = code;
        logger.debug(`[TUNNEL] cloudflared exited with code ${code}`);
    });
    cfProcess.on('error', (error) => {
        exited = true;
        logger.debug(`[TUNNEL] cloudflared spawn error: ${error.message}`);
    });

    // Parse stderr for the tunnel URL (cloudflared prints it there)
    const tunnelUrl = await new Promise<string | null>((resolve) => {
        let resolved = false;
        const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve(null);
            }
        }, 30_000);

        const handleData = (data: Buffer) => {
            if (resolved) return;
            const text = data.toString();
            logger.debug(`[TUNNEL] cloudflared output: ${text.trim()}`);
            const match = text.match(urlRegex);
            if (match) {
                resolved = true;
                clearTimeout(timeout);
                resolve(match[0]);
            }
        };

        cfProcess.stdout?.on('data', handleData);
        cfProcess.stderr?.on('data', handleData);

        cfProcess.on('exit', () => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve(null);
            }
        });
    });

    if (!tunnelUrl || exited) {
        logger.debug(`[TUNNEL] Failed to get tunnel URL (exited=${exited}, code=${exitCode})`);
        try { cfProcess.kill(); } catch { /* already dead */ }
        if (exitCode !== null) {
            console.log(`  cloudflared failed with exit code ${exitCode}`);
        } else {
            console.log('  cloudflared timed out — could not establish tunnel');
        }
        return null;
    }

    logger.debug(`[TUNNEL] Tunnel established: ${tunnelUrl}`);

    // Replace data listeners with drain handlers — cloudflared outputs connection
    // metrics, reconnect info, etc. continuously. Without draining, the pipe buffer
    // fills up (~64KB) and the process blocks on write(), killing the tunnel.
    cfProcess.stdout?.removeAllListeners('data');
    cfProcess.stderr?.removeAllListeners('data');
    cfProcess.stdout?.on('data', () => { /* drain */ });
    cfProcess.stderr?.on('data', (data: Buffer) => {
        // Log only errors/warnings, not routine metrics
        const text = data.toString();
        if (text.includes('ERR') || text.includes('WRN')) {
            logger.debug(`[TUNNEL] ${text.trim()}`);
        }
    });

    const stop = () => {
        try {
            if (!exited) {
                cfProcess.kill();
                logger.debug('[TUNNEL] cloudflared process killed');
            }
        } catch (error) {
            logger.debug('[TUNNEL] Error killing cloudflared:', error);
        }
    };

    return { url: tunnelUrl, stop };
}
