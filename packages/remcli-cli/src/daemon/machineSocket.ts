/**
 * Machine-scoped Socket.IO client for the daemon.
 *
 * In P2P mode the daemon IS the server. To handle RPC calls from the web
 * client (e.g. spawn-remcli-session), the daemon connects to its own P2P server
 * as a machine-scoped Socket.IO client and registers RPC handlers via the
 * existing forwarding mechanism.
 */

import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';

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
    type CodexExecutionConfig,
} from '@/codex/codexCapabilities';
import {
    CursorCapabilitiesError,
    CursorCapabilitiesService,
    type CursorExecutionConfig,
    type CursorRunnerIdentity,
} from '@/cursor/cursorCapabilities';
import type { CodexSandbox } from '@/codex/types';
import { isCursorLaunchControls, type CursorLaunchControls } from '@/cursor/cursorLaunchControls';
import type { StopSessionResult } from '@/daemon/types';
import type { PairingRekeyCoordinator } from './p2p/pairingRekey';

const CODEX_EXECUTION_KEYS = new Set(['model', 'catalogVersion', 'reasoningEffort']);
const CURSOR_EXECUTION_KEYS = new Set(['model', 'catalogVersion']);

export interface MachineSocketDeps {
    p2pPort: number;
    machineId: string;
    bearerToken: string;
    contentSecret: Uint8Array;
    pairingRekeyCoordinator: PairingRekeyCoordinator;
    codexCapabilities: CodexCapabilitiesService;
    cursorCapabilities: CursorCapabilitiesService;
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    stopSession: (sessionId: string) => StopSessionResult | Promise<StopSessionResult>;
    requestShutdown: () => void;
    recentDirectories?: RecentDirectoriesStore;
}

function isCodexSandbox(value: unknown): value is CodexSandbox {
    return value === 'read-only'
        || value === 'workspace-write'
        || value === 'danger-full-access';
}

function isNonEmptyStringDataProperty(value: object, key: string): boolean {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined
        && descriptor.enumerable === true
        && 'value' in descriptor
        && typeof descriptor.value === 'string'
        && descriptor.value !== '';
}

function isOptionalNonEmptyStringDataProperty(value: object, key: string): boolean {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor === undefined
        || (descriptor.enumerable === true
            && 'value' in descriptor
            && typeof descriptor.value === 'string'
            && descriptor.value !== '');
}

function isCodexExecutionConfig(value: unknown): value is CodexExecutionConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

    try {
        if (Object.getPrototypeOf(value) !== Object.prototype) return false;
        if (!Reflect.ownKeys(value).every((key) =>
            typeof key === 'string' && CODEX_EXECUTION_KEYS.has(key))) return false;

        return isNonEmptyStringDataProperty(value, 'model')
            && isNonEmptyStringDataProperty(value, 'catalogVersion')
            && isOptionalNonEmptyStringDataProperty(value, 'reasoningEffort');
    } catch {
        return false;
    }
}

function isCursorExecutionConfig(value: unknown): value is CursorExecutionConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;

    try {
        if (Object.getPrototypeOf(value) !== Object.prototype) return false;
        if (!Reflect.ownKeys(value).every((key) =>
            typeof key === 'string' && CURSOR_EXECUTION_KEYS.has(key))) return false;

        return isNonEmptyStringDataProperty(value, 'model')
            && isNonEmptyStringDataProperty(value, 'catalogVersion');
    } catch {
        return false;
    }
}

export interface MachineSocketHandle {
    socket: ClientSocket;
    close: () => void;
}

export function bootstrapMachineSocket(deps: MachineSocketDeps): MachineSocketHandle {
    const {
        p2pPort,
        machineId,
        bearerToken,
        contentSecret,
        pairingRekeyCoordinator,
        codexCapabilities,
        cursorCapabilities,
        spawnSession,
        stopSession,
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
        logger: (msg, data) => logger.debug(msg, data)
    });

    // Register common handlers (bash, readFile, listDirectory, etc.)
    registerCommonHandlers(machineRpcManager, process.cwd());

    // Register daemon-specific RPC handlers
    machineRpcManager.registerHandler('spawn-remcli-session', async (params: Partial<SpawnSessionOptions> & { directory: string }) => {
        const {
            directory,
            sessionId: sid,
            machineId: targetMachineId,
            approvedNewDirectoryCreation,
            agent,
            token,
            environmentVariables,
            resumeSessionId,
            resumeSessionName,
            permissionMode,
            codexExecution,
            cursorExecution,
            cursorLaunchControls,
        } = params || {};
        let cursorRunner: CursorRunnerIdentity | undefined;
        logger.debugLargeJson('[DAEMON RUN] RPC spawn-remcli-session', buildSafeSpawnSessionLogPayload(params));

        if (!directory) {
            throw new Error('Directory is required');
        }

        if (agent === 'codex') {
            if (!isCodexSandbox(permissionMode) || !isCodexExecutionConfig(codexExecution)) {
                throw new Error('Codex requires a current model, reasoning, and permission selection.');
            }
            try {
                await codexCapabilities.validateSelection(codexExecution, permissionMode);
            } catch (error) {
                if (error instanceof CodexCapabilitiesError) {
                    throw new Error(`Codex capability selection rejected: ${error.code}.`);
                }
                throw new Error('Codex capability discovery is unavailable. Refresh and try again.');
            }
        }

        if (agent === 'cursor') {
            if (Object.prototype.hasOwnProperty.call(params ?? {}, 'permissionMode')) {
                throw new Error('Cursor launch controls must not use the generic permissionMode field.');
            }
            if (!isCursorExecutionConfig(cursorExecution) || !isCursorLaunchControls(cursorLaunchControls)) {
                throw new Error('Cursor requires a current model and validated launch controls.');
            }
            try {
                cursorRunner = await cursorCapabilities.validateSelection(cursorExecution);
            } catch (error) {
                if (error instanceof CursorCapabilitiesError) {
                    throw new Error(`Cursor capability selection rejected: ${error.code}.`);
                }
                throw new Error('Cursor capability discovery is unavailable. Refresh and try again.');
            }
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
            ...(agent !== 'cursor' && permissionMode !== undefined ? { permissionMode } : {}),
            ...(codexExecution ? { codexExecution } : {}),
            ...(agent === 'cursor' && cursorExecution && cursorLaunchControls && cursorRunner
                ? {
                    cursorExecution,
                    cursorLaunchControls: cursorLaunchControls as CursorLaunchControls,
                    cursorRunner,
                }
                : {}),
        });

        switch (result.type) {
            case 'success':
                try {
                    recentDirectories.recordSuccessfulSpawn(directory);
                } catch (error) {
                    const code = error instanceof RecentDirectoriesError ? error.code : 'unavailable';
                    logger.warn(`[DAEMON RUN] Recent directory persistence failed: ${code}`);
                }
                logger.debug(`[DAEMON RUN] RPC spawned session ${result.sessionId}`);
                return { type: 'success', sessionId: result.sessionId };
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
