/**
 * Daemon heartbeat loop.
 *
 * Runs on an interval and:
 * 1. Prunes stale (dead) sessions
 * 2. Checks whether the daemon is running an outdated CLI version and, if so,
 *    spawns a fresh daemon and self-terminates (auto-update)
 * 3. Detects a foreign daemon that took over the state file and self-terminates
 * 4. Writes a heartbeat to the daemon state file
 */

import { readFileSync } from 'fs';
import { join } from 'path';

import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { spawnRemcliCLI } from '@/utils/spawnRemcliCLI';
import { writeDaemonState, readDaemonState, DaemonLocallyPersistedState } from '@/persistence';
import packageJson from '../../package.json';

import { encodeSharedSecret } from './p2p/p2pAuth';

type ShutdownRequester = (
    source: 'remcli-app' | 'remcli-cli' | 'os-signal' | 'exception',
    errorMessage?: string
) => void;

export interface HeartbeatDeps {
    controlPort: number;
    p2pPort: number;
    lanIP: string;
    sharedSecret: Uint8Array;
    startTime: string;
    daemonLogPath: string | undefined;
    tunnelUrl: string | undefined;
    pruneDeadSessions: () => void;
    requestShutdown: ShutdownRequester;
}

/**
 * Start the heartbeat loop. Returns the interval handle so the caller can
 * clear it during shutdown.
 */
export function startHeartbeatLoop(deps: HeartbeatDeps): NodeJS.Timeout {
    const {
        controlPort,
        p2pPort,
        lanIP,
        sharedSecret,
        startTime,
        daemonLogPath,
        tunnelUrl,
        pruneDeadSessions,
        requestShutdown
    } = deps;

    const heartbeatIntervalMs = parseInt(process.env.REMCLI_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let heartbeatRunning = false;

    const interval = setInterval(async () => {
        if (heartbeatRunning) {
            return;
        }
        heartbeatRunning = true;

        if (process.env.DEBUG) {
            logger.debug(`[DAEMON RUN] Health check started at ${new Date().toLocaleString()}`);
        }

        // Prune stale sessions
        pruneDeadSessions();

        // Check if daemon needs update
        // If version on disk is different from the one in package.json - we need to restart
        // BIG if - does this get updated from underneath us on npm upgrade?
        const projectVersion = JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;
        if (projectVersion !== configuration.currentCliVersion) {
            logger.debug('[DAEMON RUN] Daemon is outdated, triggering self-restart with latest version, clearing heartbeat interval');

            clearInterval(interval);

            // Spawn new daemon through the CLI
            // We do not need to clean ourselves up - we will be killed by
            // the CLI start command.
            // 1. It will first check if daemon is running (yes in this case)
            // 2. If the version is stale (it will read daemon.state.json file and check startedWithCliVersion) & compare it to its own version
            // 3. Next it will start a new daemon with the latest version with daemon-sync :D
            // Done!
            try {
                spawnRemcliCLI(['daemon', 'start'], {
                    detached: true,
                    stdio: 'ignore'
                });
            } catch (error) {
                logger.debug('[DAEMON RUN] Failed to spawn new daemon, this is quite likely to happen during integration tests as we are cleaning out dist/ directory', error);
            }

            // So we can just hang forever
            logger.debug('[DAEMON RUN] Hanging for a bit - waiting for CLI to kill us because we are running outdated version of the code');
            await new Promise(resolve => setTimeout(resolve, 10_000));
            process.exit(0);
        }

        // Before wrecklessly overriting the daemon state file, we should check if we are the ones who own it
        // Race condition is possible, but thats okay for the time being :D
        const daemonState = await readDaemonState();
        if (daemonState && daemonState.pid !== process.pid) {
            logger.debug('[DAEMON RUN] Somehow a different daemon was started without killing us. We should kill ourselves.');
            requestShutdown('exception', 'A different daemon was started without killing us. We should kill ourselves.');
        }

        // Heartbeat
        try {
            const updatedState: DaemonLocallyPersistedState = {
                pid: process.pid,
                httpPort: controlPort,
                startTime,
                startedWithCliVersion: packageJson.version,
                lastHeartbeat: new Date().toLocaleString(),
                daemonLogPath,
                p2pPort,
                p2pHost: lanIP,
                p2pSharedSecret: encodeSharedSecret(sharedSecret),
                tunnelUrl
            };
            writeDaemonState(updatedState);
            if (process.env.DEBUG) {
                logger.debug(`[DAEMON RUN] Health check completed at ${updatedState.lastHeartbeat}`);
            }
        } catch (error) {
            logger.debug('[DAEMON RUN] Failed to write heartbeat', error);
        }

        heartbeatRunning = false;
    }, heartbeatIntervalMs); // Every 60 seconds in production

    return interval;
}
