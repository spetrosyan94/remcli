/**
 * Daemon heartbeat loop.
 *
 * The daemon coordinator owns persistence. Heartbeat only validates that its
 * instance still owns the state snapshot, then asks the coordinator to commit
 * a current snapshot. This prevents an already-stopping daemon from writing
 * over a successor's lifecycle state.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { readDaemonState, type DaemonLocallyPersistedState } from '@/persistence';
import { isCodexAppServerStateUsable } from '@/codex/codexAppServerHost';

type ShutdownRequester = (
    source: 'remcli-web' | 'remcli-cli' | 'os-signal' | 'exception',
    errorMessage?: string,
    restartAfterShutdown?: boolean,
) => void;

export interface HeartbeatDeps {
    instanceId: string;
    pruneDeadSessions: () => void;
    requestShutdown: ShutdownRequester;
    isStateWriterActive: () => boolean;
    persistHeartbeat: (
        state: DaemonLocallyPersistedState,
        heartbeatAtMs: number,
        codexAppServerIsUsable: boolean,
    ) => Promise<void> | void;
    getDaemonState?: () => Promise<DaemonLocallyPersistedState | null>;
    getProjectVersion?: () => string;
    getNow?: () => number;
    onVersionMismatch?: () => void;
    isCodexAppServerStateUsable?: (state: DaemonLocallyPersistedState) => Promise<boolean>;
}

export interface DaemonHeartbeatHandle {
    stop: () => void;
    waitForIdle: () => Promise<void>;
}

function readCurrentProjectVersion(): string {
    return JSON.parse(readFileSync(join(projectPath(), 'package.json'), 'utf-8')).version;
}

function defaultVersionMismatchHandler(requestShutdown: ShutdownRequester): void {
    logger.debug('[DAEMON RUN] Daemon version changed; replacement will start after graceful shutdown releases its lock.');
    requestShutdown('exception', 'Daemon CLI version changed.', true);
}

export async function runDaemonHeartbeat(deps: HeartbeatDeps): Promise<void> {
    if (!deps.isStateWriterActive()) {
        return;
    }

    deps.pruneDeadSessions();

    const projectVersion = (deps.getProjectVersion ?? readCurrentProjectVersion)();
    if (projectVersion !== configuration.currentCliVersion) {
        (deps.onVersionMismatch ?? (() => defaultVersionMismatchHandler(deps.requestShutdown)))();
        return;
    }

    const daemonState = await (deps.getDaemonState ?? readDaemonState)();
    if (
        !daemonState
        || daemonState.instanceId !== deps.instanceId
        || daemonState.state !== 'running'
    ) {
        logger.debug('[DAEMON RUN] Daemon state ownership changed or is no longer running; requesting shutdown.');
        deps.requestShutdown('exception', 'Daemon state ownership changed.');
        return;
    }

    const codexAppServerIsUsable = await (
        deps.isCodexAppServerStateUsable ?? isCodexAppServerStateUsable
    )(daemonState);
    if (daemonState.codexAppServerEndpoint && !codexAppServerIsUsable) {
        logger.debug('[DAEMON RUN] Shared Codex app-server endpoint is stale; removing it from daemon state.');
    }

    if (!deps.isStateWriterActive()) {
        return;
    }

    await deps.persistHeartbeat(
        daemonState,
        (deps.getNow ?? Date.now)(),
        codexAppServerIsUsable,
    );
}

/**
 * Start the heartbeat loop. stop() prevents future ticks; waitForIdle() lets
 * shutdown wait for an already-running asynchronous tick before releasing the
 * daemon lock.
 */
export function startHeartbeatLoop(deps: HeartbeatDeps): DaemonHeartbeatHandle {
    const heartbeatIntervalMs = parseInt(process.env.REMCLI_DAEMON_HEARTBEAT_INTERVAL || '60000');
    let inFlightHeartbeat: Promise<void> | null = null;

    const tick = (): void => {
        if (inFlightHeartbeat) {
            return;
        }

        inFlightHeartbeat = runDaemonHeartbeat(deps)
            .catch((error) => {
                logger.debug('[DAEMON RUN] Heartbeat failed:', error);
            })
            .finally(() => {
                inFlightHeartbeat = null;
            });
    };

    const interval = setInterval(tick, heartbeatIntervalMs);

    return {
        stop: () => clearInterval(interval),
        waitForIdle: async () => {
            await inFlightHeartbeat;
        },
    };
}
