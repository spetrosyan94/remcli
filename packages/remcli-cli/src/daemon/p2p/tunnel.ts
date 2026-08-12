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
    onUnexpectedStop: (listener: () => void) => () => void;
}

type TunnelStartupFailureReason = 'process-error' | 'exit-code' | 'no-edge-registration' | 'timeout';

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
    let isStopExpected = false;
    let hasUnexpectedlyStopped = false;
    let hasProcessError = false;
    let hasReceivedTunnelUrl = false;
    let exitCode: number | null = null;
    const unexpectedStopListeners = new Set<() => void>();
    let settleStartup: ((url: string | null) => void) | null = null;

    const notifyUnexpectedStop = (): void => {
        if (isStopExpected || hasUnexpectedlyStopped) {
            return;
        }

        hasUnexpectedlyStopped = true;
        for (const listener of unexpectedStopListeners) {
            listener();
        }
        unexpectedStopListeners.clear();
    };

    const settleFailedStartup = (): void => {
        if (settleStartup) {
            settleStartup(null);
        }
    };

    cfProcess.on('exit', (code) => {
        exited = true;
        exitCode = code;
        logger.debug(`[TUNNEL] cloudflared exited with code ${code}`);
        notifyUnexpectedStop();
    });
    cfProcess.on('error', () => {
        exited = true;
        hasProcessError = true;
        logger.debug('[TUNNEL] cloudflared process error');
        notifyUnexpectedStop();
        settleFailedStartup();
    });

    // Wait for both the public URL and cloudflared's edge-registration signal.
    // A quick-tunnel URL can be emitted before the edge connection is usable.
    const tunnelUrl = await new Promise<string | null>((resolve) => {
        let resolved = false;
        let discoveredUrl: string | null = null;
        let hasRegisteredConnection = false;
        let outputTail = '';
        const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
        const registeredConnectionRegex = /\bregistered tunnel connection\b/i;

        const settle = (url: string | null): void => {
            if (resolved) {
                return;
            }

            resolved = true;
            clearTimeout(timeout);
            settleStartup = null;
            resolve(url);
        };
        settleStartup = (url) => settle(url);

        const timeout = setTimeout(() => {
            settle(null);
        }, 30_000);

        const handleData = (data: Buffer) => {
            if (resolved) return;
            const output = outputTail + data.toString();
            outputTail = output.slice(-128);

            const match = output.match(urlRegex);
            if (match) {
                discoveredUrl = match[0];
                hasReceivedTunnelUrl = true;
            }
            if (registeredConnectionRegex.test(output)) {
                hasRegisteredConnection = true;
            }
            if (discoveredUrl && hasRegisteredConnection) {
                settle(discoveredUrl);
            }
        };

        cfProcess.stdout?.on('data', handleData);
        cfProcess.stderr?.on('data', handleData);

        // `exit` can precede buffered stdout/stderr data, so classify startup
        // failure only after the child and its stdio streams have closed.
        cfProcess.on('close', () => {
            settle(null);
        });
    });

    if (!tunnelUrl || exited) {
        const startupFailureReason: TunnelStartupFailureReason = hasProcessError
            ? 'process-error'
            : hasReceivedTunnelUrl
                ? 'no-edge-registration'
                : exitCode !== null
                    ? 'exit-code'
                    : 'timeout';

        logger.debug(`[TUNNEL] Failed to start tunnel (reason=${startupFailureReason}, exited=${exited}, code=${exitCode})`);
        try { cfProcess.kill(); } catch { /* already dead */ }
        switch (startupFailureReason) {
            case 'process-error':
                console.log('  cloudflared failed to start');
                break;
            case 'exit-code':
                console.log(`  cloudflared failed with exit code ${exitCode}`);
                break;
            case 'no-edge-registration':
                console.log('  cloudflared did not connect to the Cloudflare edge; check your DNS or VPN and restart the tunnel.');
                break;
            case 'timeout':
                console.log('  cloudflared timed out — could not establish tunnel');
                break;
        }
        return null;
    }

    logger.debug('[TUNNEL] Tunnel established');

    // Replace data listeners with drain handlers — cloudflared outputs connection
    // metrics, reconnect info, etc. continuously. Without draining, the pipe buffer
    // fills up (~64KB) and the process blocks on write(), killing the tunnel.
    cfProcess.stdout?.removeAllListeners('data');
    cfProcess.stderr?.removeAllListeners('data');
    cfProcess.stdout?.on('data', () => { /* drain */ });
    cfProcess.stderr?.on('data', () => { /* drain */ });

    const stop = () => {
        try {
            if (!exited) {
                isStopExpected = true;
                cfProcess.kill();
                logger.debug('[TUNNEL] cloudflared process killed');
            }
        } catch (error) {
            logger.debug('[TUNNEL] Error killing cloudflared:', error);
        }
    };

    const onUnexpectedStop = (listener: () => void): (() => void) => {
        if (hasUnexpectedlyStopped) {
            listener();
            return () => undefined;
        }

        unexpectedStopListeners.add(listener);
        return () => unexpectedStopListeners.delete(listener);
    };

    return { url: tunnelUrl, stop, onUnexpectedStop };
}
