/**
 * Socket.IO client for the daemon's P2P server.
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
let hasCompletedInitialConnection = false;
const INITIAL_CONNECTION_TIMEOUT_MS = 10_000;

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
    hasCompletedInitialConnection = false;

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
        const isReconnect = hasCompletedInitialConnection;
        hasCompletedInitialConnection = true;
        updateStatus('connected');
        if (isReconnect) {
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

/** Resolve only after the current Socket.IO handshake is authenticated. */
export function waitForSocketConnection(timeoutMs = INITIAL_CONNECTION_TIMEOUT_MS): Promise<void> {
    if (!socket) {
        return Promise.reject(new Error('Socket is not connected'));
    }
    if (currentStatus === 'connected') {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
        let didSettle = false;
        let unsubscribe = () => {};
        const timeout = setTimeout(() => {
            finish(new Error('Timed out waiting for Socket.IO authentication'));
        }, timeoutMs);
        const finish = (error?: Error): void => {
            if (didSettle) return;
            didSettle = true;
            clearTimeout(timeout);
            unsubscribe();
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };

        unsubscribe = onSocketStatusChange((status) => {
            if (status === 'connected') {
                finish();
            } else if (status === 'error') {
                finish(new Error('Socket.IO authentication failed'));
            }
        });
        if (didSettle) unsubscribe();
    });
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

export type TerminalLaunchOutcome =
    | { type: 'opened' }
    | { type: 'unavailable'; error: 'terminal-unavailable' }
    | { type: 'not-requested' };

export type SpawnSessionResult =
    | { type: 'success'; sessionId: string; terminal?: TerminalLaunchOutcome }
    | { type: 'requestToApproveDirectoryCreation'; directory: string }
    | { type: 'error'; errorMessage: string };

const INVALID_SPAWN_SESSION_RESPONSE_ERROR = 'Spawn session RPC returned an invalid response';

/** Provider-defined value, validated against the daemon's live model snapshot. */
export type CodexReasoningEffort = string;

export interface CodexExecutionConfig {
    model: string;
    /** Omitted only when the selected provider model exposes no reasoning choices. */
    reasoningEffort?: CodexReasoningEffort;
    catalogVersion: string;
}

export interface CodexModelCapability {
    id: string;
    displayName: string;
    defaultReasoningEffort?: CodexReasoningEffort;
    supportedReasoningEfforts: CodexReasoningEffort[];
    isDefault: boolean;
}

export interface CodexCapabilitiesSnapshot {
    agent: 'codex';
    status: 'ready' | 'unavailable';
    fetchedAt: number | null;
    expiresAt: number | null;
    catalogVersion: string | null;
    models: CodexModelCapability[];
    permissionModes: Array<Extract<PermissionMode, 'read-only' | 'workspace-write' | 'danger-full-access'>>;
    errorCode?: 'unavailable' | 'expired' | 'unsupported_selection' | 'policy_denied';
}

/** Provider-defined Cursor selection, validated against the daemon's live catalog. */
export interface CursorExecutionConfig {
    model: string;
    catalogVersion: string;
}

export type CursorExecutionMode = 'agent' | 'plan' | 'ask';
export type CursorSandboxMode = 'local-configuration' | 'enabled' | 'disabled';

/** Native Cursor controls fixed at session creation and validated by the daemon. */
export interface CursorLaunchControls {
    executionMode: CursorExecutionMode;
    force: boolean;
    autoReview: boolean;
    sandbox: CursorSandboxMode;
    approveMcps: boolean;
}

export const DEFAULT_CURSOR_LAUNCH_CONTROLS: CursorLaunchControls = {
    executionMode: 'agent',
    force: false,
    autoReview: false,
    sandbox: 'local-configuration',
    approveMcps: false,
};

export interface CursorModelCapability {
    id: string;
    displayName: string;
    isDefault: boolean;
}

export interface CursorCapabilitiesSnapshot {
    agent: 'cursor';
    status: 'ready' | 'unavailable';
    fetchedAt: number | null;
    expiresAt: number | null;
    catalogVersion: string | null;
    models: CursorModelCapability[];
    errorCode?: 'unavailable' | 'expired' | 'unsupported_selection';
}

export interface SpawnSessionOptions {
    machineId: string;
    directory: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    agent?: AgentKind;
    permissionMode?: PermissionMode;
    codexExecution?: CodexExecutionConfig;
    cursorExecution?: CursorExecutionConfig;
    cursorLaunchControls?: CursorLaunchControls;
    resumeSessionId?: string;
    resumeSessionName?: string;
    environmentVariables?: Record<string, string>;
}

export type DirectoryPathStyle = 'posix' | 'win32';

export interface DirectoryHome {
    path: string;
    displayPath: string;
}

interface DirectoryPathMetadata {
    path: string;
    displayPath: string;
    style: DirectoryPathStyle;
    separator: string;
    home: DirectoryHome;
}

export interface DirectoryEntry {
    name: string;
    path: string;
    displayPath: string;
    type: 'directory';
    hidden: boolean;
}

export interface DirectoryListing {
    path: string;
    displayPath: string;
    style: DirectoryPathStyle;
    separator: string;
    home: DirectoryHome;
    parent: string | null;
    parentDisplayPath: string | null;
    entries: DirectoryEntry[];
}

export type RecentDirectoriesErrorCode = 'unavailable' | 'invalid_machine_id';

export interface RecentDirectory {
    canonicalPath: string;
    displayPath: string;
    lastUsedAt: number;
}

interface RecentDirectoriesResponse {
    directories: RecentDirectory[];
}

interface RecentDirectoriesErrorResponse {
    error: {
        code: RecentDirectoriesErrorCode;
        message: string;
    };
}

export class RecentDirectoriesRpcError extends Error {
    readonly code: RecentDirectoriesErrorCode;

    constructor(code: RecentDirectoriesErrorCode, message: string) {
        super(message);
        this.code = code;
        this.name = 'RecentDirectoriesRpcError';
    }
}

interface RpcErrorEnvelope {
    error: string;
}

interface AgentSessionListResponse {
    sessions: AgentSessionInfo[];
}

export interface SealedPairingQr {
    format: 'nacl-box-v1';
    payload: string;
    expiresAt: number;
}

export interface PairingRekeyRequest {
    requestId: string;
    approvalCode: string;
    ticket: string;
    expiresAt: number;
}

export type PairingRekeyCancellationResult =
    | { type: 'cancelled' }
    | { type: 'not-found' }
    | { type: 'expired' }
    | { type: 'already-approved' }
    | { type: 'invalid-code' };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRpcErrorEnvelope(value: unknown): value is RpcErrorEnvelope {
    return isRecord(value) && typeof value.error === 'string';
}

function isDirectoryPathStyle(value: unknown): value is DirectoryPathStyle {
    return value === 'posix' || value === 'win32';
}

function isDirectoryHome(value: unknown): value is DirectoryHome {
    if (!isRecord(value)) return false;
    return typeof value.path === 'string' && typeof value.displayPath === 'string';
}

function isDirectoryPathMetadata(value: unknown): value is DirectoryPathMetadata {
    if (!isRecord(value)) return false;
    return (
        typeof value.path === 'string' &&
        typeof value.displayPath === 'string' &&
        isDirectoryPathStyle(value.style) &&
        typeof value.separator === 'string' &&
        value.separator.length > 0 &&
        isDirectoryHome(value.home)
    );
}

function isDirectoryEntry(value: unknown): value is DirectoryEntry {
    if (!isRecord(value)) return false;
    return (
        typeof value.name === 'string' &&
        typeof value.path === 'string' &&
        typeof value.displayPath === 'string' &&
        value.type === 'directory' &&
        typeof value.hidden === 'boolean'
    );
}

function isDirectoryListing(value: unknown): value is DirectoryListing {
    if (!isRecord(value)) return false;
    return (
        isDirectoryPathMetadata(value) &&
        (value.parent === null || typeof value.parent === 'string') &&
        (value.parentDisplayPath === null || typeof value.parentDisplayPath === 'string') &&
        Array.isArray(value.entries) &&
        value.entries.every(isDirectoryEntry)
    );
}

function isRecentDirectoriesErrorCode(value: unknown): value is RecentDirectoriesErrorCode {
    return value === 'unavailable' || value === 'invalid_machine_id';
}

function isRecentDirectory(value: unknown): value is RecentDirectory {
    if (!isRecord(value)) return false;
    return typeof value.canonicalPath === 'string'
        && value.canonicalPath.trim().length > 0
        && typeof value.displayPath === 'string'
        && value.displayPath.trim().length > 0
        && typeof value.lastUsedAt === 'number'
        && Number.isFinite(value.lastUsedAt)
        && value.lastUsedAt >= 0;
}

function isRecentDirectoriesResponse(value: unknown): value is RecentDirectoriesResponse {
    return isRecord(value)
        && Array.isArray(value.directories)
        && value.directories.every(isRecentDirectory);
}

function isRecentDirectoriesErrorResponse(value: unknown): value is RecentDirectoriesErrorResponse {
    if (!isRecord(value) || !isRecord(value.error)) return false;
    return isRecentDirectoriesErrorCode(value.error.code)
        && typeof value.error.message === 'string'
        && value.error.message.trim().length > 0;
}

function isAgentKind(value: unknown): value is AgentKind {
    return value === 'claude' || value === 'codex' || value === 'cursor' || value === 'gemini';
}

function isAgentSessionInfo(value: unknown): value is AgentSessionInfo {
    if (!isRecord(value)) return false;
    return (
        typeof value.sessionId === 'string' &&
        isAgentKind(value.agent) &&
        typeof value.projectPath === 'string' &&
        typeof value.lastModified === 'number' &&
        (value.firstMessage === null || typeof value.firstMessage === 'string') &&
        typeof value.messageCount === 'number' &&
        (value.createdAt === null || typeof value.createdAt === 'number') &&
        (value.sessionName === null || typeof value.sessionName === 'string')
    );
}

function isAgentSessionListResponse(value: unknown): value is AgentSessionListResponse {
    return isRecord(value) && Array.isArray(value.sessions) && value.sessions.every(isAgentSessionInfo);
}

function isCursorCapabilityErrorCode(value: unknown): value is NonNullable<CursorCapabilitiesSnapshot['errorCode']> {
    return value === 'unavailable' || value === 'expired' || value === 'unsupported_selection';
}

function isCursorModelCapability(value: unknown): value is CursorModelCapability {
    return isRecord(value)
        && typeof value.id === 'string'
        && value.id.length > 0
        && typeof value.displayName === 'string'
        && value.displayName.trim().length > 0
        && typeof value.isDefault === 'boolean';
}

function isCursorCapabilitiesSnapshot(value: unknown): value is CursorCapabilitiesSnapshot {
    if (!isRecord(value)
        || value.agent !== 'cursor'
        || (value.status !== 'ready' && value.status !== 'unavailable')
        || !Array.isArray(value.models)
        || !value.models.every(isCursorModelCapability)
        || (value.errorCode !== undefined && !isCursorCapabilityErrorCode(value.errorCode))) {
        return false;
    }

    if (value.status === 'ready') {
        return typeof value.fetchedAt === 'number'
            && Number.isFinite(value.fetchedAt)
            && typeof value.expiresAt === 'number'
            && Number.isFinite(value.expiresAt)
            && typeof value.catalogVersion === 'string'
            && value.catalogVersion.length > 0
            && value.models.filter((model) => model.isDefault).length === 1
            && value.errorCode === undefined;
    }

    return value.fetchedAt === null
        && value.expiresAt === null
        && value.catalogVersion === null
        && value.models.length === 0;
}

function isSealedPairingQr(value: unknown): value is SealedPairingQr {
    return isRecord(value)
        && value.format === 'nacl-box-v1'
        && typeof value.payload === 'string'
        && typeof value.expiresAt === 'number'
        && Number.isSafeInteger(value.expiresAt);
}

function isPairingRekeyRequest(value: unknown): value is PairingRekeyRequest {
    return isRecord(value)
        && typeof value.requestId === 'string'
        && typeof value.approvalCode === 'string'
        && typeof value.ticket === 'string'
        && typeof value.expiresAt === 'number'
        && Number.isSafeInteger(value.expiresAt);
}

function isPairingRekeyCancellationResult(value: unknown): value is PairingRekeyCancellationResult {
    return isRecord(value)
        && (value.type === 'cancelled'
            || value.type === 'not-found'
            || value.type === 'expired'
            || value.type === 'already-approved'
            || value.type === 'invalid-code');
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).every((key) => keys.includes(key));
}

function isTerminalLaunchOutcome(value: unknown): value is TerminalLaunchOutcome {
    if (!isRecord(value) || !Object.hasOwn(value, 'type') || typeof value.type !== 'string') return false;

    if (value.type === 'opened' || value.type === 'not-requested') {
        return hasOnlyKeys(value, ['type']);
    }

    return value.type === 'unavailable'
        && Object.hasOwn(value, 'error')
        && value.error === 'terminal-unavailable'
        && hasOnlyKeys(value, ['type', 'error']);
}

function isSpawnSessionResult(value: unknown): value is SpawnSessionResult {
    if (!isRecord(value) || !Object.hasOwn(value, 'type') || typeof value.type !== 'string') return false;

    if (value.type === 'success') {
        return Object.hasOwn(value, 'sessionId')
            && typeof value.sessionId === 'string'
            && value.sessionId.trim().length > 0
            && (!Object.hasOwn(value, 'terminal') || isTerminalLaunchOutcome(value.terminal))
            && hasOnlyKeys(value, ['type', 'sessionId', 'terminal']);
    }

    if (value.type === 'requestToApproveDirectoryCreation') {
        return Object.hasOwn(value, 'directory')
            && typeof value.directory === 'string'
            && value.directory.trim().length > 0
            && hasOnlyKeys(value, ['type', 'directory']);
    }

    return value.type === 'error'
        && Object.hasOwn(value, 'errorMessage')
        && typeof value.errorMessage === 'string'
        && value.errorMessage.trim().length > 0
        && hasOnlyKeys(value, ['type', 'errorMessage']);
}

/** Spawn a new agent session on a machine (daemon RPC `spawn-remcli-session`). */
export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
    const {
        machineId,
        directory,
        approvedNewDirectoryCreation = false,
        token,
        agent,
        resumeSessionId,
        resumeSessionName,
        environmentVariables,
        permissionMode,
        codexExecution,
        cursorExecution,
        cursorLaunchControls,
    } = options;
    try {
        const result = await machineRpc<unknown, {
            type: 'spawn-in-directory';
            directory: string;
            approvedNewDirectoryCreation?: boolean;
            token?: string;
            agent?: AgentKind;
            resumeSessionId?: string;
            resumeSessionName?: string;
            environmentVariables?: Record<string, string>;
            permissionMode?: PermissionMode;
            codexExecution?: CodexExecutionConfig;
            cursorExecution?: CursorExecutionConfig;
            cursorLaunchControls?: CursorLaunchControls;
        }>(
            machineId,
            'spawn-remcli-session',
            {
                type: 'spawn-in-directory',
                directory,
                approvedNewDirectoryCreation,
                token,
                agent,
                resumeSessionId,
                resumeSessionName,
                environmentVariables,
                permissionMode,
                codexExecution,
                cursorExecution,
                cursorLaunchControls,
            }
        );
        if (!result) {
            return { type: 'error', errorMessage: 'RPC returned null — decryption likely failed' };
        }
        if (!isSpawnSessionResult(result)) {
            return { type: 'error', errorMessage: INVALID_SPAWN_SESSION_RESPONSE_ERROR };
        }
        return result;
    } catch (error) {
        return {
            type: 'error',
            errorMessage: error instanceof Error ? error.message : 'Failed to spawn session'
        };
    }
}

/** Read the daemon-normalized, account-specific Codex capability snapshot. */
export async function machineGetCodexCapabilities(
    machineId: string,
    forceRefresh: boolean = false,
): Promise<CodexCapabilitiesSnapshot> {
    return await machineRpc<CodexCapabilitiesSnapshot, { forceRefresh?: boolean }>(
        machineId,
        'get-codex-capabilities',
        forceRefresh ? { forceRefresh: true } : {},
    );
}

/** Read the daemon-normalized, account-specific Cursor model catalog. */
export async function machineGetCursorCapabilities(
    machineId: string,
    forceRefresh: boolean = false,
): Promise<CursorCapabilitiesSnapshot> {
    const result = await machineRpc<unknown, { forceRefresh?: boolean }>(
        machineId,
        'get-cursor-capabilities',
        forceRefresh ? { forceRefresh: true } : {},
    );
    if (isRpcErrorEnvelope(result)) {
        throw new Error(result.error || 'Cursor capability RPC failed');
    }
    if (!isCursorCapabilitiesSnapshot(result)) {
        throw new Error('Cursor capability RPC returned invalid response');
    }
    return result;
}

/** List child directories on a machine (daemon RPC `list-directory`). */
export async function machineListDirectory(machineId: string, path?: string): Promise<DirectoryListing> {
    const result = await machineRpc<unknown, { path?: string }>(
        machineId,
        'list-directory',
        path ? { path } : {}
    );
    if (isRpcErrorEnvelope(result)) {
        throw new Error(result.error || 'Directory list RPC failed');
    }
    if (!isDirectoryListing(result)) {
        throw new Error('Directory list RPC returned invalid response');
    }
    return result;
}

/** List daemon-owned, machine-scoped recent directories (RPC `list-recent-directories`). */
export async function machineListRecentDirectories(machineId: string): Promise<RecentDirectory[]> {
    const result = await machineRpc<unknown, Record<string, never>>(
        machineId,
        'list-recent-directories',
        {},
    );
    if (isRecentDirectoriesErrorResponse(result)) {
        throw new RecentDirectoriesRpcError(result.error.code, result.error.message);
    }
    if (!isRecentDirectoriesResponse(result)) {
        throw new Error('Recent directories RPC returned invalid response');
    }
    return result.directories;
}

/** List past agent sessions on a machine (resume feature, RPC `list-agent-sessions`). */
export async function machineListAgentSessions(
    machineId: string,
    agent?: string,
    directory?: string,
    limit?: number
): Promise<AgentSessionInfo[]> {
    const result = await machineRpc<unknown, {
        agent?: string;
        directory?: string;
        limit?: number;
    }>(machineId, 'list-agent-sessions', { agent, directory, limit });
    if (isRpcErrorEnvelope(result)) {
        throw new Error(result.error || 'Agent session list RPC failed');
    }
    if (!isAgentSessionListResponse(result)) {
        throw new Error('Agent session list RPC returned invalid response');
    }
    return result.sessions;
}

/** Stop a daemon-tracked session by its remcli session id (daemon RPC `stop-session`). */
export async function machineStopSession(machineId: string, sessionId: string): Promise<{ message: string }> {
    return machineRpc<{ message: string }, { sessionId: string }>(machineId, 'stop-session', { sessionId });
}

/** Request daemon shutdown on a machine (RPC `stop-daemon`). */
export async function machineStopDaemon(machineId: string): Promise<{ message: string }> {
    return machineRpc<{ message: string }, Record<string, never>>(machineId, 'stop-daemon', {});
}

/** Fetch a QR sealed to the ephemeral browser public key. */
export async function machineShowPairingQr(machineId: string, clientPublicKey: string): Promise<SealedPairingQr> {
    const result = await machineRpc<unknown, { clientPublicKey: string }>(
        machineId,
        'show-pairing-qr',
        { clientPublicKey },
    );
    if (!isSealedPairingQr(result)) {
        throw new Error('Pairing QR RPC returned invalid response');
    }
    return result;
}

/** Create a host-approved, expiring pairing key rotation request. */
export async function machineRequestPairingRekey(machineId: string, clientPublicKey: string): Promise<PairingRekeyRequest> {
    const result = await machineRpc<unknown, { clientPublicKey: string }>(
        machineId,
        'request-pairing-rekey',
        { clientPublicKey },
    );
    if (!isPairingRekeyRequest(result)) {
        throw new Error('Pairing rekey RPC returned invalid response');
    }
    return result;
}

/** Cancel a pending rekey before the local host approves it. */
export async function machineCancelPairingRekey(
    machineId: string,
    requestId: string,
    approvalCode: string,
): Promise<PairingRekeyCancellationResult> {
    const result = await machineRpc<unknown, { requestId: string; approvalCode: string }>(
        machineId,
        'cancel-pairing-rekey',
        { requestId, approvalCode },
    );
    if (!isPairingRekeyCancellationResult(result)) {
        throw new Error('Pairing rekey cancellation RPC returned invalid response');
    }
    return result;
}

// Session-scoped operations

interface SessionPermissionRequest {
    id: string;
    approved: boolean;
    reason?: string;
    mode?: 'manual' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' | 'dontAsk';
    allowTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

/** Allow a pending permission request. */
export async function sessionAllow(
    sessionId: string,
    id: string,
    mode?: 'manual' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' | 'dontAsk',
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
    mode?: 'manual' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' | 'dontAsk',
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
        ...(options.permissionMode ? { permissionMode: options.permissionMode } : {})
    });
}
