/**
 * Machine-scoped Socket.IO client for the daemon.
 *
 * In P2P mode the daemon IS the server. To handle RPC calls from the mobile
 * app (e.g. spawn-remcli-session), the daemon connects to its own P2P server
 * as a machine-scoped Socket.IO client and registers RPC handlers via the
 * existing forwarding mechanism.
 */

import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

import { logger } from '@/ui/logger';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { listDirectoryForBrowser } from '@/daemon/directoryBrowser/directoryBrowserService';
import { buildSafeSpawnSessionLogPayload } from '@/daemon/spawnSessionLog';
import type {
    ListDirectoryParams,
    ListDirectoryResponse,
} from '@/daemon/directoryBrowser/types';
import { listAllAgentSessions } from '@/daemon/sessions/listAgentSessions';
import type { StopSessionResult } from '@/daemon/types';

export interface MachineSocketDeps {
    p2pPort: number;
    machineId: string;
    bearerToken: string;
    sharedSecret: Uint8Array;
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => StopSessionResult;
    onSessionStopped?: (sessionId: string) => void;
    requestShutdown: () => void;
}

export interface MachineSocketHandle {
    socket: ClientSocket;
    close: () => void;
}

export function bootstrapMachineSocket(deps: MachineSocketDeps): MachineSocketHandle {
    const { p2pPort, machineId, bearerToken, sharedSecret, spawnSession, stopSession, onSessionStopped, requestShutdown } = deps;

    const machineSocket: ClientSocket = ioClient(`http://127.0.0.1:${p2pPort}`, {
        transports: ['websocket'],
        auth: {
            token: bearerToken,
            clientType: 'machine-scoped',
            machineId
        },
        path: '/v1/updates',
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000
    });

    const machineRpcManager = new RpcHandlerManager({
        scopePrefix: machineId,
        encryptionKey: sharedSecret,
        encryptionVariant: 'legacy',
        logger: (msg, data) => logger.debug(msg, data)
    });

    // Register common handlers (bash, readFile, listDirectory, etc.)
    registerCommonHandlers(machineRpcManager, process.cwd());

    // Register daemon-specific RPC handlers
    machineRpcManager.registerHandler('spawn-remcli-session', async (params: Partial<SpawnSessionOptions> & { directory: string }) => {
        const { directory, sessionId: sid, machineId: targetMachineId, approvedNewDirectoryCreation, agent, token, environmentVariables, resumeSessionId, resumeSessionName } = params || {};
        logger.debugLargeJson('[DAEMON RUN] RPC spawn-remcli-session', buildSafeSpawnSessionLogPayload(params));

        if (!directory) {
            throw new Error('Directory is required');
        }

        const result = await spawnSession({
            directory,
            sessionId: sid,
            machineId: targetMachineId,
            approvedNewDirectoryCreation,
            agent,
            token,
            environmentVariables,
            resumeSessionId,
            resumeSessionName,
        });

        switch (result.type) {
            case 'success':
                logger.debug(`[DAEMON RUN] RPC spawned session ${result.sessionId}`);
                return { type: 'success', sessionId: result.sessionId };
            case 'requestToApproveDirectoryCreation':
                logger.debug(`[DAEMON RUN] RPC requesting directory approval: ${result.directory}`);
                return { type: 'requestToApproveDirectoryCreation', directory: result.directory };
            case 'error':
                throw new Error(result.errorMessage);
        }
    });

    machineRpcManager.registerHandler('stop-session', (params: { sessionId?: string }) => {
        const { sessionId: targetSessionId } = params || {};
        if (!targetSessionId) {
            throw new Error('Session ID is required');
        }

        const result = stopSession(targetSessionId);
        if (!result.success) {
            throw new Error('Session not found or failed to stop');
        }

        logger.debug(`[DAEMON RUN] RPC stopped session ${result.stoppedSessionId}`);
        onSessionStopped?.(result.stoppedSessionId);
        return { message: 'Session stopped', sessionId: result.stoppedSessionId };
    });

    machineRpcManager.registerHandler('stop-daemon', () => {
        logger.debug('[DAEMON RUN] RPC stop-daemon received');
        setTimeout(() => requestShutdown(), 100);
        return { message: 'Daemon stop request acknowledged' };
    });

    machineRpcManager.registerHandler('list-agent-sessions', async (params: { agent?: string; directory?: string; limit?: number }) => {
        const { agent, directory, limit } = params || {};
        const sessions = listAllAgentSessions(agent, directory, limit);
        return { sessions };
    });

    machineRpcManager.registerHandler<ListDirectoryParams, ListDirectoryResponse>('list-directory', async (params) => {
        return await listDirectoryForBrowser(params);
    });

    machineSocket.on('connect', () => {
        logger.debug('[DAEMON RUN] Machine RPC socket connected to own P2P server');
        machineRpcManager.onSocketConnect(machineSocket);
    });

    machineSocket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: string) => void) => {
        logger.debug(`[DAEMON RUN] Machine RPC request: ${data.method}`);
        callback(await machineRpcManager.handleRequest(data));
    });

    machineSocket.on('disconnect', () => {
        logger.debug('[DAEMON RUN] Machine RPC socket disconnected');
        machineRpcManager.onSocketDisconnect();
    });

    machineSocket.on('connect_error', (error: Error) => {
        logger.debug(`[DAEMON RUN] Machine RPC socket error: ${error.message}`);
    });

    logger.debug('[DAEMON RUN] Machine RPC socket connecting to own P2P server');

    return {
        socket: machineSocket,
        close: () => {
            machineSocket.close();
        }
    };
}
