/**
 * Machine-scoped Socket.IO client for the daemon.
 *
 * In P2P mode the daemon IS the server. To handle RPC calls from the web
 * client (e.g. spawn-remcli-session), the daemon connects to its own P2P server
 * as a machine-scoped Socket.IO client and registers RPC handlers via the
 * existing forwarding mechanism.
 */

import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { logger } from '@/ui/logger';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { registerCommonHandlers, SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { listDirectoryForBrowser } from '@/daemon/directoryBrowser/directoryBrowserService';
import {
    createRecentDirectoriesStore,
    RecentDirectoriesError,
    type ListRecentDirectoriesRpcResponse,
    type RecentDirectoriesStore,
} from '@/daemon/recentDirectories';
import { buildSafeSpawnSessionLogPayload } from '@/daemon/spawnSessionLog';
import type {
    ListDirectoryParams,
    ListDirectoryResponse,
} from '@/daemon/directoryBrowser/types';
import { listAllAgentSessions } from '@/daemon/sessions/listAgentSessions';
import {
    CodexCapabilitiesError,
    CodexCapabilitiesService,
} from '@/codex/codexCapabilities';
import {
    CursorCapabilitiesError,
    CursorCapabilitiesService,
} from '@/cursor/cursorCapabilities';
import type {
    DaemonSessionExecutionState,
    SessionExecutionLookupResult,
    SessionExecutionSetResult,
    StopSessionResult,
} from '@/daemon/types';
import type { SessionExecutionSelection } from '@/api/types';
import { parseProviderSpawnRequest } from '@/daemon/providerSpawnRequest';
import type { PairingRekeyCoordinator } from './p2p/pairingRekey';
import {
    calculateRequestProofMac,
    REQUEST_PROOF_TTL_MS,
    REQUEST_PROOF_VERSION,
    type P2PRequestProof,
} from './p2p/p2pRequestProof';

export interface MachineSocketDeps {
    p2pPort: number;
    machineId: string;
    bearerToken: string;
    authSecret: Uint8Array;
    contentSecret: Uint8Array;
    pairingRekeyCoordinator: PairingRekeyCoordinator;
    codexCapabilities: CodexCapabilitiesService;
    cursorCapabilities: CursorCapabilitiesService;
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => StopSessionResult | Promise<StopSessionResult>;
    getSessionExecution: (sessionId: string) => SessionExecutionLookupResult;
    getSessionExecutionState: (sessionId: string) => DaemonSessionExecutionState | undefined;
    setSessionExecution: (
        sessionId: string,
        expectedRevision: number,
        execution: SessionExecutionSelection,
    ) => SessionExecutionSetResult;
    requestShutdown: () => void;
    recentDirectories?: RecentDirectoriesStore;
}

const sessionExecutionSelectionSchema = z.discriminatedUnion('provider', [
    z.object({
        provider: z.literal('codex'),
        model: z.string().min(1),
        reasoningEffort: z.string().min(1).optional(),
        catalogVersion: z.string().min(1),
    }).strict(),
    z.object({
        provider: z.literal('cursor'),
        model: z.string().min(1),
        catalogVersion: z.string().min(1),
    }).strict(),
]);

const getSessionExecutionParamsSchema = z.object({
    sessionId: z.string().min(1),
}).strict();

const setSessionExecutionParamsSchema = z.object({
    sessionId: z.string().min(1),
    expectedRevision: z.number().int().nonnegative(),
    execution: sessionExecutionSelectionSchema,
}).strict();

function requireExecutionSnapshot(result: SessionExecutionLookupResult): SessionExecutionSelection {
    if (result.type === 'found') {
        return result.snapshot.current;
    }
    throw new Error('Daemon-owned session execution is unavailable.');
}

export interface MachineSocketHandle {
    socket: ClientSocket;
    close: () => void;
}

function signMachineRpcRegistration(
    authSecret: Uint8Array,
    operation: string,
    payload: Record<string, unknown>,
): Record<string, unknown> {
    if (operation !== 'rpc-register' || typeof payload.method !== 'string') {
        throw new Error('Machine socket can sign only RPC registrations');
    }

    const id = randomUUID();
    const expiresAt = Date.now() + REQUEST_PROOF_TTL_MS;
    const mac = calculateRequestProofMac(authSecret, {
        v: REQUEST_PROOF_VERSION,
        transport: 'socket',
        operation,
        requestId: id,
        expiresAt,
        payload: { method: payload.method },
    });
    if (!mac) {
        throw new Error('Could not create machine RPC request proof');
    }

    const proof: P2PRequestProof = { v: REQUEST_PROOF_VERSION, id, expiresAt, mac };
    return { ...payload, proof };
}

export function bootstrapMachineSocket(deps: MachineSocketDeps): MachineSocketHandle {
    const {
        p2pPort,
        machineId,
        bearerToken,
        authSecret,
        contentSecret,
        pairingRekeyCoordinator,
        codexCapabilities,
        cursorCapabilities,
        spawnSession,
        stopSession,
        getSessionExecution,
        getSessionExecutionState,
        setSessionExecution,
        requestShutdown,
        recentDirectories = createRecentDirectoriesStore({ machineId }),
    } = deps;

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
        encryptionKey: contentSecret,
        encryptionVariant: 'legacy',
        logger: (msg, data) => logger.debug(msg, data),
        signOutboundMutation: (operation, payload) => signMachineRpcRegistration(authSecret, operation, payload),
    });

    // Register common handlers (bash, readFile, listDirectory, etc.)
    registerCommonHandlers(machineRpcManager, process.cwd());

    // Register daemon-specific RPC handlers
    machineRpcManager.registerHandler('spawn-remcli-session', async (params: unknown) => {
        const request = parseProviderSpawnRequest(params);
        logger.debugLargeJson('[DAEMON RUN] RPC spawn-remcli-session', buildSafeSpawnSessionLogPayload(request));
        let spawnOptions: SpawnSessionOptions = request;

        if (request.agent === 'codex') {
            try {
                await codexCapabilities.validateSelection(request.codexExecution, request.permissionMode);
            } catch (error) {
                if (error instanceof CodexCapabilitiesError) {
                    throw new Error(`Codex capability selection rejected: ${error.code}.`);
                }
                throw new Error('Codex capability discovery is unavailable. Refresh and try again.');
            }
        }

        if (request.agent === 'cursor') {
            try {
                const cursorRunner = await cursorCapabilities.validateSelection(request.cursorExecution);
                spawnOptions = { ...request, cursorRunner };
            } catch (error) {
                if (error instanceof CursorCapabilitiesError) {
                    throw new Error(`Cursor capability selection rejected: ${error.code}.`);
                }
                throw new Error('Cursor capability discovery is unavailable. Refresh and try again.');
            }
        }

        const result = await spawnSession(spawnOptions);

        switch (result.type) {
            case 'success':
                try {
                    recentDirectories.recordSuccessfulSpawn(request.directory);
                } catch (error) {
                    const code = error instanceof RecentDirectoriesError ? error.code : 'unavailable';
                    logger.warn(`[DAEMON RUN] Recent directory persistence failed: ${code}`);
                }
                logger.debug(`[DAEMON RUN] RPC spawned session ${result.sessionId}`);
                return {
                    type: 'success',
                    sessionId: result.sessionId,
                    ...(result.terminal ? { terminal: result.terminal } : {}),
                };
            case 'requestToApproveDirectoryCreation':
                logger.debug(`[DAEMON RUN] RPC requesting directory approval: ${result.directory}`);
                return { type: 'requestToApproveDirectoryCreation', directory: result.directory };
            case 'error':
                throw new Error(result.errorMessage);
        }
    });

    machineRpcManager.registerHandler('get-codex-capabilities', async (params: { forceRefresh?: unknown }) => {
        const forceRefresh = params?.forceRefresh === true;
        return await codexCapabilities.getCapabilities(forceRefresh);
    });

    machineRpcManager.registerHandler('get-cursor-capabilities', async (params: { forceRefresh?: unknown }) => {
        const forceRefresh = params?.forceRefresh === true;
        return await cursorCapabilities.getCapabilities(forceRefresh);
    });

    machineRpcManager.registerHandler('get-session-execution', (params: unknown) => {
        const { sessionId } = getSessionExecutionParamsSchema.parse(params);
        const result = getSessionExecution(sessionId);
        if (result.type !== 'found') {
            throw new Error('Daemon-owned session execution is unavailable.');
        }
        return result.snapshot;
    });

    machineRpcManager.registerHandler('set-session-execution', async (params: unknown) => {
        const { sessionId, expectedRevision, execution } = setSessionExecutionParamsSchema.parse(params);
        const executionState = getSessionExecutionState(sessionId);
        const current = requireExecutionSnapshot(getSessionExecution(sessionId));
        if (current.provider !== execution.provider || !executionState) {
            throw new Error('Session execution provider does not match the daemon-owned runner.');
        }

        if (execution.provider === 'codex') {
            if (!executionState.codexPermissionMode) {
                throw new Error('Daemon-owned Codex permission selection is unavailable.');
            }
            try {
                await codexCapabilities.validateSelection(execution, executionState.codexPermissionMode);
            } catch (error) {
                if (error instanceof CodexCapabilitiesError) {
                    throw new Error(`Codex capability selection rejected: ${error.code}.`);
                }
                throw new Error('Codex capability discovery is unavailable. Refresh and try again.');
            }
        } else {
            try {
                const freshRunner = await cursorCapabilities.validateSelection(execution);
                if (!executionState.cursorRunner
                    || freshRunner.executable !== executionState.cursorRunner.executable
                    || freshRunner.cliFingerprint !== executionState.cursorRunner.cliFingerprint) {
                    throw new Error('Cursor capability selection rejected: runner_identity_changed.');
                }
            } catch (error) {
                if (error instanceof CursorCapabilitiesError) {
                    throw new Error(`Cursor capability selection rejected: ${error.code}.`);
                }
                throw error instanceof Error
                    ? error
                    : new Error('Cursor capability discovery is unavailable. Refresh and try again.');
            }
        }

        const result = setSessionExecution(sessionId, expectedRevision, execution);
        if (result.type === 'updated') {
            return result.snapshot;
        }
        if (result.type === 'revision-mismatch') {
            throw new Error(`Session execution revision mismatch: ${result.snapshot.revision}.`);
        }
        throw new Error('Daemon-owned session execution is unavailable.');
    });

    machineRpcManager.registerHandler('stop-session', async (params: { sessionId?: string }) => {
        const { sessionId: targetSessionId } = params || {};
        if (!targetSessionId) {
            throw new Error('Session ID is required');
        }

        const result = await stopSession(targetSessionId);
        if (!result.success) {
            throw new Error('Session not found or failed to stop');
        }

        logger.debug(`[DAEMON RUN] RPC stopped session ${result.stoppedSessionId}`);
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

    machineRpcManager.registerHandler<unknown, ListRecentDirectoriesRpcResponse>('list-recent-directories', () => {
        try {
            return recentDirectories.list();
        } catch (error) {
            if (error instanceof RecentDirectoriesError) {
                return {
                    error: {
                        code: error.code,
                        message: error.message,
                    },
                };
            }

            return {
                error: {
                    code: 'unavailable',
                    message: 'Recent directories are unavailable.',
                },
            };
        }
    });

    machineRpcManager.registerHandler('show-pairing-qr', async (params: { clientPublicKey?: string }) => {
        if (!params?.clientPublicKey) {
            throw new Error('Pairing QR public key is required');
        }
        return await pairingRekeyCoordinator.showQr(params.clientPublicKey);
    });

    machineRpcManager.registerHandler('request-pairing-rekey', (params: { clientPublicKey?: string }) => {
        if (!params?.clientPublicKey) {
            throw new Error('Pairing rekey public key is required');
        }
        return pairingRekeyCoordinator.requestRekey(params.clientPublicKey);
    });

    machineRpcManager.registerHandler('cancel-pairing-rekey', (params: { requestId?: string; approvalCode?: string }) => {
        if (!params?.requestId || !params.approvalCode) {
            throw new Error('Pairing rekey request ID and approval code are required');
        }
        return pairingRekeyCoordinator.cancel(params.requestId, params.approvalCode);
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
