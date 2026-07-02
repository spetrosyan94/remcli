/**
 * Socket.IO client for the daemon's P2P server — port of remcli-app
 * sources/sync/apiSocket.ts + ops.ts.
 *
 * Handshake: path /v1/updates, auth { token, clientType: 'user-scoped' },
 * transports websocket+polling (LAN/HTTP compatibility), infinite reconnect.
 *
 * RPC (`rpc-call`): method = `${entityId}:${method}`, params/result encrypted
 * with the entity cipher. Daemon-side handlers live in
 * packages/remcli-cli/src/daemon/p2p/p2pSocketHandlers.ts.
 */

import { io, type Socket } from 'socket.io-client';
import type { Cipher } from '@/lib/protocol/encryption';
import type { AgentKind, AgentSessionInfo, PermissionMode } from '@/lib/protocol/types';

// ─── Types ───────────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface SocketConfig {
    endpoint: string;
    token: string;
}

type MessageHandler = (data: unknown) => void;

interface CipherResolver {
    getSessionCipher(sessionId: string): Cipher | null;
    getMachineCipher(machineId: string): Cipher | null;
}

// ─── State ───────────────────────────────────────────────────────

let socket: Socket | null = null;
let ciphers: CipherResolver | null = null;
const messageHandlers = new Map<string, MessageHandler>();
const reconnectedListeners = new Set<() => void>();
const statusListeners = new Set<(status: ConnectionStatus) => void>();
let currentStatus: ConnectionStatus = 'disconnected';

function updateStatus(status: ConnectionStatus): void {
    if (currentStatus !== status) {
        currentStatus = status;
        statusListeners.forEach((listener) => listener(status));
    }
}

// ─── Connection Management ───────────────────────────────────────

export function socketConnect(newConfig: SocketConfig, cipherResolver: CipherResolver): void {
    socketDisconnect();
    ciphers = cipherResolver;

    updateStatus('connecting');

    socket = io(newConfig.endpoint, {
        path: '/v1/updates',
        auth: {
            token: newConfig.token,
            clientType: 'user-scoped' as const
        },
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        reconnectionAttempts: Infinity
    });

    socket.on('connect', () => {
        updateStatus('connected');
        if (!socket?.recovered) {
            reconnectedListeners.forEach((listener) => listener());
        }
    });
    socket.on('disconnect', () => {
        updateStatus('disconnected');
    });
    socket.on('connect_error', () => {
        updateStatus('error');
    });
    socket.on('error', () => {
        updateStatus('error');
    });
    socket.onAny((event: string, data: unknown) => {
        const handler = messageHandlers.get(event);
        if (handler) {
            handler(data);
        }
    });
}

export function socketDisconnect(): void {
    if (socket) {
        socket.disconnect();
        socket = null;
    }
    updateStatus('disconnected');
}

export function getSocketStatus(): ConnectionStatus {
    return currentStatus;
}

// ─── Listener Management ─────────────────────────────────────────

export function onSocketReconnected(listener: () => void): () => void {
    reconnectedListeners.add(listener);
    return () => { reconnectedListeners.delete(listener); };
}

export function onSocketStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    statusListeners.add(listener);
    listener(currentStatus); // immediately notify with current status
    return () => { statusListeners.delete(listener); };
}

/** Subscribe to a server event ('update' | 'ephemeral' | ...). One handler per event. */
export function onSocketMessage(event: string, handler: MessageHandler): () => void {
    messageHandlers.set(event, handler);
    return () => { messageHandlers.delete(event); };
}

// ─── Emit ────────────────────────────────────────────────────────

export function socketSend(event: string, data: unknown): void {
    if (!socket) {
        throw new Error('Socket not connected');
    }
    socket.emit(event, data);
}

export async function socketEmitWithAck<T>(event: string, data: unknown): Promise<T> {
    if (!socket) {
        throw new Error('Socket not connected');
    }
    return await socket.emitWithAck(event, data) as T;
}

// ─── Encrypted RPC ───────────────────────────────────────────────

interface RpcAck {
    ok: boolean;
    result?: string;
    error?: string;
}

async function encryptedRpc<R>(cipher: Cipher, entityId: string, method: string, params: unknown): Promise<R> {
    if (!socket) {
        throw new Error('Socket not connected');
    }
    const result = await socket.emitWithAck('rpc-call', {
        method: `${entityId}:${method}`,
        params: await cipher.encryptRaw(params)
    }) as RpcAck;

    if (result.ok) {
        return await cipher.decryptRaw(result.result ?? '') as R;
    }
    throw new Error(`RPC call failed: ${result.error || 'unknown'}`);
}

/** RPC to a session process — session-specific encryption. */
export async function sessionRpc<R, A>(sessionId: string, method: string, params: A): Promise<R> {
    const cipher = ciphers?.getSessionCipher(sessionId);
    if (!cipher) {
        throw new Error(`Session encryption not found for ${sessionId}`);
    }
    return encryptedRpc<R>(cipher, sessionId, method, params);
}

/** RPC to a machine daemon — machine-specific encryption. */
export async function machineRpc<R, A>(machineId: string, method: string, params: A): Promise<R> {
    const cipher = ciphers?.getMachineCipher(machineId);
    if (!cipher) {
        throw new Error(`Machine encryption not found for ${machineId}`);
    }
    return encryptedRpc<R>(cipher, machineId, method, params);
}

// ─── Typed operations (port of sources/sync/ops.ts) ─────────────

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

export interface SpawnSessionOptions {
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    agent?: AgentKind;
    resumeSessionId?: string;
    resumeSessionName?: string;
    environmentVariables?: Record<string, string>;
}

/** Spawn a new agent session on a machine (daemon RPC `spawn-remcli-session`). */
export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
    const { machineId, directory, approvedNewDirectoryCreation = false, token, agent, resumeSessionId, resumeSessionName, environmentVariables } = options;
    try {
        const result = await machineRpc<SpawnSessionResult | null, {
            type: 'spawn-in-directory';
            directory: string;
            approvedNewDirectoryCreation?: boolean;
            token?: string;
            agent?: AgentKind;
            resumeSessionId?: string;
            resumeSessionName?: string;
            environmentVariables?: Record<string, string>;
        }>(
            machineId,
            'spawn-remcli-session',
            { type: 'spawn-in-directory', directory, approvedNewDirectoryCreation, token, agent, resumeSessionId, resumeSessionName, environmentVariables }
        );
        if (!result) {
            return { type: 'error', errorMessage: 'RPC returned null — decryption likely failed' };
        }
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to spawn session'
        };
    }
}

/** List past agent sessions on a machine (resume feature, RPC `list-agent-sessions`). */
export async function machineListAgentSessions(
    machineId: string,
    agent?: string,
    directory?: string,
    limit?: number
): Promise<AgentSessionInfo[]> {
    try {
        const result = await machineRpc<{ sessions: AgentSessionInfo[] } | null, {
            agent?: string;
            directory?: string;
            limit?: number;
        }>(machineId, 'list-agent-sessions', { agent, directory, limit });
        return result?.sessions ?? [];
    } catch {
        return [];
    }
}

/** Stop a daemon-tracked session by its remcli session id (daemon RPC `stop-session`). */
export async function machineStopSession(machineId: string, sessionId: string): Promise<{ message: string }> {
    return machineRpc<{ message: string }, { sessionId: string }>(machineId, 'stop-session', { sessionId });
}

/** Request daemon shutdown on a machine (RPC `stop-daemon`). */
export async function machineStopDaemon(machineId: string): Promise<{ message: string }> {
    return machineRpc<{ message: string }, Record<string, never>>(machineId, 'stop-daemon', {});
}

// Session-scoped operations

interface SessionPermissionRequest {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

/** Allow a pending permission request. */
export async function sessionAllow(
    sessionId: string,
    id: string,
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    allowedTools?: string[],
    decision?: 'approved' | 'approved_for_session'
): Promise<void> {
    const request: SessionPermissionRequest = { id, approved: true, mode, allowTools: allowedTools, decision };
    await sessionRpc(sessionId, 'permission', request);
}

/** Deny a pending permission request. */
export async function sessionDeny(
    sessionId: string,
    id: string,
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan',
    allowedTools?: string[],
    decision?: 'denied' | 'abort'
): Promise<void> {
    const request: SessionPermissionRequest = { id, approved: false, mode, allowTools: allowedTools, decision };
    await sessionRpc(sessionId, 'permission', request);
}

/** Abort the current agent turn. */
export async function sessionAbort(sessionId: string): Promise<void> {
    await sessionRpc(sessionId, 'abort', {
        reason: `The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.`
    });
}

/** Switch session control between terminal (local) and this client (remote). */
export async function sessionSwitch(sessionId: string, to: 'remote' | 'local'): Promise<boolean> {
    return sessionRpc<boolean, { to: 'remote' | 'local' }>(sessionId, 'switch', { to });
}

/** Kill the session process immediately. */
export async function sessionKill(sessionId: string): Promise<{ success: boolean; message: string }> {
    try {
        return await sessionRpc<{ success: boolean; message: string }, Record<string, never>>(sessionId, 'killSession', {});
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

/** Send an already-encrypted user message record into a session. */
export function sendEncryptedMessage(options: {
    sessionId: string;
    encryptedRecord: string;
    localId: string;
    permissionMode?: PermissionMode;
}): void {
    socketSend('message', {
        sid: options.sessionId,
        message: options.encryptedRecord,
        localId: options.localId,
        sentFrom: 'web',
        permissionMode: options.permissionMode ?? 'default'
    });
}
