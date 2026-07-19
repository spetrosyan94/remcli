import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline';

import { logger } from '@/ui/logger';
import { redactDiagnosticData, redactSensitiveText } from '@/utils/redaction';
import type { CodexApprovalPolicy, CodexSandbox, CodexToolResponse } from './types';
import { CodexPermissionHandler, type PermissionResult } from './utils/permissionHandler';

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000;
const CONNECTION_HANDSHAKE_TIMEOUT = 10_000;
const WEBSOCKET_OPEN_STATE = 1;
const MAX_ACTIVE_USER_MESSAGE_ITEMS = 256;
const MAX_RECENT_USER_MESSAGE_IDS = 512;
const MAX_RECENT_COMPLETED_ITEM_IDS = 512;
const MAX_RECENT_TURN_THREAD_IDS = 512;
const WEBSOCKET_RECOVERY_DELAYS_MS = [0, 100, 500] as const;
const RECOVERY_REQUEST_TIMEOUT = 10_000;
const THREAD_START_RESPONSE_TIMEOUT = 10_000;
const CAPABILITY_REQUEST_TIMEOUT = 10_000;

type JsonRpcId = number;

interface JsonRpcMessage {
    id?: JsonRpcId;
    method?: string;
    params?: any;
    result?: any;
    error?: {
        code?: number;
        message?: string;
        data?: unknown;
    };
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    cleanup?: () => void;
}

interface TurnWaiter {
    turnId: string;
    completion: Promise<CodexToolResponse>;
    resolve: (value: CodexToolResponse) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    cleanup?: () => void;
}

interface InterruptedTurnWaiter {
    threadId: string;
    turnId: string;
    completion: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    cleanup?: () => void;
}

interface StartedTurn {
    turnId: string;
    completion: Promise<CodexToolResponse>;
}

interface WebSocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener(type: string, listener: (event: unknown) => void): void;
    removeEventListener?(type: string, listener: (event: unknown) => void): void;
}

class BoundedIdSet {
    private readonly ids = new Map<string, undefined>();

    constructor(private readonly maxSize: number) {}

    get size(): number {
        return this.ids.size;
    }

    has(id: string): boolean {
        return this.ids.has(id);
    }

    add(id: string): void {
        this.ids.delete(id);
        this.ids.set(id, undefined);
        while (this.ids.size > this.maxSize) {
            const oldestId = this.ids.keys().next().value;
            if (typeof oldestId !== 'string') return;
            this.ids.delete(oldestId);
        }
    }

    delete(id: string): void {
        this.ids.delete(id);
    }

    clear(): void {
        this.ids.clear();
    }
}

export interface CodexAppServerClientOptions {
    endpoint?: string;
    webSocketFactory?: (endpoint: string) => WebSocketLike;
}

export interface CodexAppServerReasoningEffort {
    reasoningEffort: string;
    description?: string;
}

export interface CodexAppServerModel {
    id: string;
    displayName: string;
    defaultReasoningEffort?: string;
    supportedReasoningEfforts: CodexAppServerReasoningEffort[];
    isDefault: boolean;
}

export interface CodexAppServerModelListPage {
    data: CodexAppServerModel[];
    nextCursor?: string;
}

export interface CodexAppServerConfigRequirements {
    allowedApprovalPolicies?: string[];
    allowedSandboxModes?: string[];
}

export type CodexUserMessageSource = 'own' | 'external';

export interface CodexTextUserMessageContent {
    type: 'text';
    text: string;
}

export interface CodexOpaqueUserMessageContent {
    type: 'other';
    originalType: string;
    value: Readonly<Record<string, unknown>>;
}

export type CodexUserMessageContent = CodexTextUserMessageContent | CodexOpaqueUserMessageContent;

export type CodexAgentMessageOrigin = 'live' | 'replay';

export interface CodexAgentMessageEvent {
    type: 'agent_message';
    message: string;
    origin: CodexAgentMessageOrigin;
}

export interface CodexUserMessageEvent {
    type: 'user_message';
    itemId: string;
    text: string;
    content: CodexUserMessageContent[];
    clientId: string | null;
    source: CodexUserMessageSource;
}

export type CodexAppServerEvent =
    | CodexUserMessageEvent
    | { type: 'task_started' }
    | { type: 'task_complete' }
    | { type: 'turn_aborted' }
    | { type: 'turn_diff'; unified_diff: string }
    | { type: 'agent_error'; message: string }
    | CodexAgentMessageEvent
    | { type: 'agent_reasoning'; text: string }
    | { type: 'exec_command_begin'; command: string }
    | { type: 'exec_command_end'; output: string; error?: string }
    | { type: 'patch_apply_begin'; changes: Record<string, unknown> }
    | { type: 'patch_apply_end'; success: boolean; stdout: string; stderr: string };

interface CodexAppServerResumeOptions {
    threadId: string;
    cwd: string;
    sandbox: CodexSandbox;
    approvalPolicy: CodexApprovalPolicy;
    model?: string;
}

interface CodexAppServerStartThreadOptions {
    cwd: string;
    sandbox: CodexSandbox;
    approvalPolicy: CodexApprovalPolicy;
    model?: string;
    ephemeral?: boolean;
}

interface CodexAppServerTurnOptions {
    threadId: string;
    prompt: string;
    clientUserMessageId?: string;
    sandbox: CodexSandbox;
    approvalPolicy: CodexApprovalPolicy;
    model?: string;
    effort?: string;
    signal?: AbortSignal;
}

interface CodexAppServerSteerOptions {
    threadId: string;
    expectedTurnId: string;
    prompt: string;
    clientUserMessageId?: string;
}

interface CodexAppServerTurnCompletionOptions {
    threadId: string;
    turnId: string;
    signal?: AbortSignal;
    interruptOnAbort?: boolean;
    timeoutMs?: number;
}

interface ReconciledTurn {
    id: string;
    status: string;
    turn: Record<string, unknown>;
}

type ReconciledThreadStatus = 'idle' | 'active';

interface ReconciledThread {
    status: ReconciledThreadStatus;
    turns: ReconciledTurn[];
    activeTurn: ReconciledTurn | null;
}

interface ReconciledThreadMessage {
    acceptedTurn: ReconciledTurn | null;
    activeTurn: ReconciledTurn | null;
}

interface ReconciledUserMessage {
    acceptedTurn: ReconciledTurn;
    activeTurn: ReconciledTurn | null;
}

type CodexThreadStartAmbiguityReason =
    | 'invalid-response'
    | 'response-lost'
    | 'previous-start-ambiguous';

type CodexThreadStateErrorReason =
    | 'active-without-turn'
    | 'idle-with-active-turn'
    | 'invalid-status'
    | 'not-loaded'
    | 'system-error'
    | 'unknown-status';

export class CodexAppServerTransportError extends Error {
    readonly isRecoverable = true;

    constructor(message: string) {
        super(message);
        this.name = 'CodexAppServerTransportError';
    }
}

export class CodexAppServerThreadStateError extends Error {
    readonly isRecoverable = true;
    readonly code = 'CODEX_THREAD_STATE_UNAVAILABLE';

    constructor(
        readonly reason: CodexThreadStateErrorReason,
        message: string,
    ) {
        super(message);
        this.name = 'CodexAppServerThreadStateError';
    }
}

export class CodexAppServerJsonRpcError extends Error {
    constructor(
        message: string,
        readonly code?: number,
    ) {
        super(message);
        this.name = 'CodexAppServerJsonRpcError';
    }
}

export class CodexAppServerActiveTurnHandoffError extends Error {
    readonly code = 'CODEX_ACTIVE_TURN_HANDOFF';

    constructor(
        readonly threadId: string,
        readonly turnId: string,
    ) {
        super(`Codex app-server has an active turn ${turnId} in thread ${threadId}.`);
        this.name = 'CodexAppServerActiveTurnHandoffError';
    }
}

/**
 * A `thread/start` write can reach app-server while its response is lost. The
 * caller must not retry that non-idempotent operation without the native id.
 */
export class CodexAppServerAmbiguousThreadStartError extends Error {
    readonly code = 'CODEX_THREAD_START_AMBIGUOUS';

    constructor(readonly reason: CodexThreadStartAmbiguityReason = 'response-lost') {
        super('Codex app-server may have created a thread, but its id was not confirmed.');
        this.name = 'CodexAppServerAmbiguousThreadStartError';
    }
}

export function isCodexAppServerTransientTransportError(error: unknown): error is CodexAppServerTransportError {
    return error instanceof CodexAppServerTransportError;
}

export function isCodexAppServerRecoverableStateError(error: unknown): error is CodexAppServerThreadStateError {
    return error instanceof CodexAppServerThreadStateError;
}

export function isCodexAppServerActiveTurnHandoffError(error: unknown): error is CodexAppServerActiveTurnHandoffError {
    return error instanceof CodexAppServerActiveTurnHandoffError;
}

export function isCodexAppServerFreshThreadUnmaterializedError(
    error: unknown,
    threadId: string,
): error is CodexAppServerJsonRpcError {
    return error instanceof CodexAppServerJsonRpcError
        && error.code === -32600
        && error.message === `thread ${threadId} is not materialized yet; includeTurns is unavailable before first user message`;
}

export function codexSandboxToAppServerPolicy(sandbox: CodexSandbox): Record<string, unknown> {
    switch (sandbox) {
        case 'read-only':
            return { type: 'readOnly', networkAccess: false };
        case 'workspace-write':
            return {
                type: 'workspaceWrite',
                writableRoots: [],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
            };
        case 'danger-full-access':
            return { type: 'dangerFullAccess' };
    }
}

function permissionResultToCommandDecision(result: PermissionResult): string {
    if (result.decision === 'approved_for_session') return 'acceptForSession';
    if (result.decision === 'approved') return 'accept';
    if (result.decision === 'denied') return 'decline';
    return 'cancel';
}

function permissionResultToMcpAction(result: PermissionResult): string {
    if (result.decision === 'approved' || result.decision === 'approved_for_session') return 'accept';
    if (result.decision === 'denied') return 'decline';
    return 'cancel';
}

function errorFromJsonRpc(message: JsonRpcMessage): Error {
    const text = message.error?.message ?? 'Codex app-server request failed.';
    return new CodexAppServerJsonRpcError(
        text,
        typeof message.error?.code === 'number' ? message.error.code : undefined,
    );
}

function getTurnErrorText(turn: any): string | null {
    const error = turn?.error;
    if (!error) return null;
    if (typeof error === 'string') return error;
    if (typeof error?.message === 'string') return error.message;
    return JSON.stringify(error);
}

function createGlobalWebSocket(endpoint: string): WebSocketLike {
    const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
    if (!WebSocketCtor) {
        throw new Error('WebSocket runtime is not available for Codex app-server remote transport.');
    }
    return new WebSocketCtor(endpoint);
}

function webSocketDataToString(data: unknown): string | null {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    }
    return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
}

function readStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
    const value = record[key];
    if (!Array.isArray(value)) {
        return undefined;
    }
    return value.filter((item): item is string => typeof item === 'string');
}

function normalizeReasoningEfforts(value: unknown): CodexAppServerReasoningEffort[] {
    if (!Array.isArray(value)) return [];

    const efforts: CodexAppServerReasoningEffort[] = [];
    for (const entry of value) {
        if (typeof entry === 'string' && entry !== '') {
            efforts.push({ reasoningEffort: entry });
            continue;
        }
        if (!isRecord(entry)) continue;
        const reasoningEffort = readString(entry, 'reasoningEffort');
        if (!reasoningEffort) continue;
        efforts.push({
            reasoningEffort,
            ...(readString(entry, 'description') ? { description: readString(entry, 'description') } : {}),
        });
    }
    return efforts;
}

function normalizeModelListPage(result: unknown): CodexAppServerModelListPage {
    if (!isRecord(result)) {
        throw new Error('Codex app-server returned an invalid model list response.');
    }

    const rawModels = Array.isArray(result.data)
        ? result.data
        : Array.isArray(result.models)
            ? result.models
            : Array.isArray(result.items)
                ? result.items
                : null;
    if (!rawModels) {
        throw new Error('Codex app-server model list response is missing data.');
    }

    const data: CodexAppServerModel[] = [];
    for (const rawModel of rawModels) {
        if (!isRecord(rawModel)) continue;
        const id = readString(rawModel, 'id') ?? readString(rawModel, 'model');
        if (!id) continue;
        data.push({
            id,
            displayName: readString(rawModel, 'displayName') ?? id,
            ...(readString(rawModel, 'defaultReasoningEffort')
                ? { defaultReasoningEffort: readString(rawModel, 'defaultReasoningEffort') }
                : {}),
            supportedReasoningEfforts: normalizeReasoningEfforts(rawModel.supportedReasoningEfforts),
            isDefault: rawModel.isDefault === true,
        });
    }

    return {
        data,
        ...(readString(result, 'nextCursor') ? { nextCursor: readString(result, 'nextCursor') } : {}),
    };
}

function normalizeConfigRequirements(result: unknown): CodexAppServerConfigRequirements {
    if (!isRecord(result)) {
        throw new Error('Codex app-server returned invalid configuration requirements.');
    }
    const requirements = isRecord(result.requirements) ? result.requirements : result;
    const allowedApprovalPolicies = readStringArray(requirements, 'allowedApprovalPolicies');
    const allowedSandboxModes = readStringArray(requirements, 'allowedSandboxModes');
    return {
        ...(allowedApprovalPolicies ? { allowedApprovalPolicies } : {}),
        ...(allowedSandboxModes ? { allowedSandboxModes } : {}),
    };
}

function getNotificationThreadId(params: unknown): string | null {
    if (!isRecord(params)) return null;
    if (typeof params.threadId === 'string') return params.threadId;
    return isRecord(params.thread) && typeof params.thread.id === 'string'
        ? params.thread.id
        : null;
}

function getNotificationTurnId(params: unknown): string | null {
    if (!isRecord(params)) return null;
    if (typeof params.turnId === 'string') return params.turnId;
    return isRecord(params.turn) && typeof params.turn.id === 'string'
        ? params.turn.id
        : null;
}

function normalizeUserMessageContent(content: unknown): CodexUserMessageContent | null {
    if (!isRecord(content) || typeof content.type !== 'string') return null;
    if (content.type === 'text' && typeof content.text === 'string') {
        return { type: 'text', text: content.text };
    }
    return {
        type: 'other',
        originalType: content.type,
        value: { ...content },
    };
}

function getReconciledTurns(response: unknown): ReconciledThread | null {
    if (!isRecord(response) || !isRecord(response.thread)) {
        return null;
    }

    const status = getReconciledThreadStatus(response.thread.status);
    if (!Array.isArray(response.thread.turns)) {
        return null;
    }
    const turns: ReconciledTurn[] = [];
    for (const turn of response.thread.turns) {
        if (!isRecord(turn) || typeof turn.id !== 'string' || typeof turn.status !== 'string') {
            return null;
        }
        turns.push({ id: turn.id, status: turn.status, turn });
    }

    const activeTurns = turns.filter((turn) => turn.status === 'inProgress');
    if (status === 'active') {
        if (activeTurns.length !== 1) {
            throw new CodexAppServerThreadStateError(
                'active-without-turn',
                'Codex app-server reported an active thread without exactly one in-progress turn.',
            );
        }
        return { status, turns, activeTurn: activeTurns[0] };
    }

    if (activeTurns.length > 0) {
        throw new CodexAppServerThreadStateError(
            'idle-with-active-turn',
            'Codex app-server reported an idle thread with an in-progress turn.',
        );
    }
    return { status, turns, activeTurn: null };
}

function getReconciledThreadStatus(status: unknown): ReconciledThreadStatus {
    if (!isRecord(status) || typeof status.type !== 'string') {
        throw new CodexAppServerThreadStateError(
            'invalid-status',
            'Codex app-server thread status is invalid or unavailable.',
        );
    }

    switch (status.type) {
        case 'idle':
            return 'idle';
        case 'active':
            if (!Array.isArray(status.activeFlags) || !status.activeFlags.every((flag) => typeof flag === 'string')) {
                throw new CodexAppServerThreadStateError(
                    'invalid-status',
                    'Codex app-server active thread status is invalid.',
                );
            }
            return 'active';
        case 'notLoaded':
            throw new CodexAppServerThreadStateError(
                'not-loaded',
                'Codex app-server thread state is not loaded.',
            );
        case 'systemError':
            throw new CodexAppServerThreadStateError(
                'system-error',
                'Codex app-server thread is in a system error state.',
            );
        default:
            throw new CodexAppServerThreadStateError(
                'unknown-status',
                `Codex app-server returned unknown thread status "${status.type}".`,
            );
    }
}

function turnHasClientUserMessage(turn: ReconciledTurn, clientUserMessageId: string): boolean {
    if (!Array.isArray(turn.turn.items)) {
        return false;
    }

    return turn.turn.items.some((item) => isRecord(item)
        && item.type === 'userMessage'
        && item.clientId === clientUserMessageId);
}

function isRemcliP2PDeliveryId(clientId: string | null): boolean {
    return clientId?.startsWith('p2p:') ?? false;
}

function getReconciledTurnResponse(turn: ReconciledTurn): CodexToolResponse {
    const errorText = getTurnErrorText(turn.turn);
    if (errorText) {
        return { content: [{ type: 'text', text: errorText }], isError: true };
    }

    const content = Array.isArray(turn.turn.items)
        ? turn.turn.items.flatMap((item): Array<{ type: 'text'; text: string }> => (
            isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string' && item.text.length > 0
                ? [{ type: 'text', text: item.text }]
                : []
        ))
        : [];
    return { content, isError: false };
}

export class CodexAppServerClient {
    private readonly endpoint?: string;
    private readonly webSocketFactory: (endpoint: string) => WebSocketLike;
    private proc: ChildProcessWithoutNullStreams | null = null;
    private rl: readline.Interface | null = null;
    private ws: WebSocketLike | null = null;
    private connected = false;
    private connectionPromise: Promise<void> | null = null;
    private recoveryPromise: Promise<void> | null = null;
    private isDisconnecting = false;
    private nextRequestId = 1;
    private pendingRequests = new Map<JsonRpcId, PendingRequest>();
    private turnWaiters = new Map<string, TurnWaiter>();
    private completedTurns = new Map<string, CodexToolResponse>();
    private readonly ownUserMessageIds = new Map<string, string | null>();
    private readonly recentOwnUserMessageIds = new BoundedIdSet(MAX_RECENT_USER_MESSAGE_IDS);
    private readonly activeUserMessageItemIds = new Map<string, string | null>();
    private readonly recentUserMessageItemIds = new BoundedIdSet(MAX_RECENT_USER_MESSAGE_IDS);
    private readonly recentCompletedItemIds = new BoundedIdSet(MAX_RECENT_COMPLETED_ITEM_IDS);
    private readonly interruptingTurnIds = new Map<string, string>();
    private readonly interruptedTurnWaiters = new Map<string, InterruptedTurnWaiter>();
    private readonly interruptedTurnFailures = new Map<string, Error>();
    private readonly turnThreadIds = new Map<string, string>();
    private isStartingThread = false;
    private resumingThreadId: string | null = null;
    private hasAmbiguousThreadStart = false;
    private handler: ((event: CodexAppServerEvent) => void) | null = null;
    private threadIdChangeHandler: ((threadId: string) => void) | null = null;
    private permissionHandler: CodexPermissionHandler | null = null;
    private activeThreadId: string | null = null;
    private activeTurnId: string | null = null;

    constructor(options: CodexAppServerClientOptions = {}) {
        this.endpoint = options.endpoint;
        this.webSocketFactory = options.webSocketFactory ?? createGlobalWebSocket;
    }

    setHandler(handler: ((event: CodexAppServerEvent) => void) | null): void {
        this.handler = handler;
    }

    setThreadIdChangeHandler(handler: ((threadId: string) => void) | null): void {
        this.threadIdChangeHandler = handler;
    }

    setPermissionHandler(handler: CodexPermissionHandler): void {
        this.permissionHandler = handler;
    }

    private setActiveThreadId(threadId: string): void {
        if (this.activeThreadId === threadId) {
            return;
        }

        this.activeThreadId = threadId;
        this.threadIdChangeHandler?.(threadId);
    }

    private rememberTurnThreadId(threadId: string, turnId: string): void {
        this.turnThreadIds.delete(turnId);
        this.turnThreadIds.set(turnId, threadId);
        while (this.turnThreadIds.size > MAX_RECENT_TURN_THREAD_IDS) {
            const oldestTurnId = this.turnThreadIds.keys().next().value;
            if (typeof oldestTurnId !== 'string') return;
            this.turnThreadIds.delete(oldestTurnId);
        }
    }

    private shouldHandleThreadScopedNotification(
        method: string,
        params: unknown,
        allowThreadActivation: boolean,
    ): boolean {
        if (this.isStartingThread) {
            logger.debug(`[CodexAppServer] ignoring ${method} while waiting for thread/start response`);
            return false;
        }

        const notificationThreadId = getNotificationThreadId(params);
        const notificationTurnId = getNotificationTurnId(params);
        if (notificationThreadId) {
            if (this.resumingThreadId && notificationThreadId !== this.resumingThreadId) {
                logger.debug(`[CodexAppServer] ignoring ${method} for foreign thread during resume`);
                return false;
            }
            if (!this.resumingThreadId && this.activeThreadId && this.activeThreadId !== notificationThreadId) {
                logger.debug(`[CodexAppServer] ignoring ${method} for foreign thread ${notificationThreadId}`);
                return false;
            }
            if (!this.activeThreadId && !allowThreadActivation && !this.resumingThreadId) {
                logger.debug(`[CodexAppServer] ignoring ${method} before a thread is established`);
                return false;
            }

            const knownThreadId = notificationTurnId ? this.turnThreadIds.get(notificationTurnId) : undefined;
            if (knownThreadId && knownThreadId !== notificationThreadId) {
                logger.debug(`[CodexAppServer] ignoring ${method} with mismatched turn ${notificationTurnId}`);
                return false;
            }

            if (this.activeThreadId !== notificationThreadId) {
                this.setActiveThreadId(notificationThreadId);
            }
            if (notificationTurnId) {
                this.rememberTurnThreadId(notificationThreadId, notificationTurnId);
            }
            return true;
        }

        if (!notificationTurnId) {
            logger.debug(`[CodexAppServer] ignoring unscoped ${method} notification`);
            return false;
        }

        const knownThreadId = this.turnThreadIds.get(notificationTurnId);
        if (this.resumingThreadId && knownThreadId !== this.resumingThreadId) {
            logger.debug(`[CodexAppServer] ignoring ${method} for unassociated turn during resume`);
            return false;
        }
        if (!knownThreadId || knownThreadId !== this.activeThreadId) {
            logger.debug(`[CodexAppServer] ignoring ${method} for unassociated turn ${notificationTurnId}`);
            return false;
        }
        return true;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        this.isDisconnecting = false;
        if (this.connectionPromise) {
            return await this.connectionPromise;
        }

        const connection = this.connectTransport();
        this.connectionPromise = connection;
        try {
            await connection;
        } finally {
            if (this.connectionPromise === connection) {
                this.connectionPromise = null;
            }
        }
    }

    /**
     * Reads the account-visible model picker catalog. The daemon projects this
     * response into a small, safe capability snapshot before it reaches web UI.
     */
    async listModels(cursor?: string): Promise<CodexAppServerModelListPage> {
        await this.connect();
        const result = await this.request(
            'model/list',
            {
                includeHidden: false,
                ...(cursor ? { cursor } : {}),
            },
            undefined,
            CAPABILITY_REQUEST_TIMEOUT,
        );
        return normalizeModelListPage(result);
    }

    /** Reads managed sandbox restrictions without exposing raw app-server config. */
    async readConfigRequirements(): Promise<CodexAppServerConfigRequirements> {
        await this.connect();
        const result = await this.request(
            'configRequirements/read',
            null,
            undefined,
            CAPABILITY_REQUEST_TIMEOUT,
        );
        return normalizeConfigRequirements(result);
    }

    private async connectTransport(): Promise<void> {
        if (this.endpoint) {
            await this.connectWebSocket();
        } else {
            this.connectStdio();
        }

        try {
            await this.request('initialize', {
                clientInfo: {
                    name: 'remcli',
                    title: 'Remcli',
                    version: '1.0.0',
                },
                capabilities: {
                    experimentalApi: true,
                },
            }, undefined, CONNECTION_HANDSHAKE_TIMEOUT);
            this.notify('initialized', {});
            this.connected = true;
            logger.debug(`[CodexAppServer] Connected via ${this.endpoint ? 'websocket' : 'stdio'}`);
        } catch (error) {
            if (this.endpoint && this.ws) {
                this.closeWebSocketTransport(
                    this.ws,
                    error instanceof CodexAppServerJsonRpcError
                        ? error
                        : error instanceof CodexAppServerTransportError
                            ? error
                            : new CodexAppServerTransportError(
                                error instanceof Error
                                    ? error.message
                                    : 'Codex app-server websocket initialization failed.',
                            ),
                );
            }
            throw error;
        }
    }

    private connectStdio(): void {
        logger.debug('[CodexAppServer] Starting codex app-server over stdio');
        this.proc = spawn('codex', ['app-server'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: Object.fromEntries(
                Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            ),
        });
        this.rl = readline.createInterface({ input: this.proc.stdout });
        this.rl.on('line', (line) => this.handleLine(line));
        this.proc.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text) logger.debug('[CodexAppServer][stderr]', redactSensitiveText(text));
        });
        this.proc.on('exit', (code, signal) => {
            logger.debug(`[CodexAppServer] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
            this.connected = false;
            const error = new Error('Codex app-server exited.');
            this.rejectAll(error);
        });
        this.proc.on('error', (error) => {
            logger.debug('[CodexAppServer] process error:', redactDiagnosticData(error));
            this.connected = false;
            this.rejectAll(error);
        });
    }

    private async connectWebSocket(): Promise<void> {
        if (!this.endpoint) return;
        logger.debug(`[CodexAppServer] Connecting to shared app-server ${this.endpoint}`);
        const ws = this.webSocketFactory(this.endpoint);
        this.ws = ws;

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                clearTimeout(timeout);
                ws.removeEventListener?.('open', onOpen);
                ws.removeEventListener?.('error', onError);
                ws.removeEventListener?.('close', onCloseBeforeOpen);
            };
            const fail = (error: Error) => {
                if (settled) return;
                settled = true;
                cleanup();
                this.closeWebSocketTransport(ws, error);
                reject(error);
            };
            const onOpen = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };
            const onError = (event: unknown) => {
                fail(new CodexAppServerTransportError(
                    `Codex app-server websocket error: ${redactSensitiveText(String(event))}`,
                ));
            };
            const onCloseBeforeOpen = () => {
                fail(new CodexAppServerTransportError('Codex app-server websocket closed before connection opened.'));
            };
            const timeout = setTimeout(() => {
                fail(new CodexAppServerTransportError(`Timed out connecting to Codex app-server ${this.endpoint}.`));
            }, CONNECTION_HANDSHAKE_TIMEOUT);

            ws.addEventListener('open', onOpen);
            ws.addEventListener('error', onError);
            ws.addEventListener('close', onCloseBeforeOpen);

            if (ws.readyState === WEBSOCKET_OPEN_STATE) {
                onOpen();
            }
        });

        ws.addEventListener('message', (event: unknown) => {
            const data = (event as { data?: unknown }).data;
            const text = webSocketDataToString(data);
            if (!text) {
                logger.debug('[CodexAppServer] Ignoring websocket message with unsupported data type');
                return;
            }
            this.handleTransportText(text);
        });
        ws.addEventListener('close', () => {
            if (this.ws !== ws) {
                return;
            }
            logger.debug('[CodexAppServer] websocket closed');
            this.connected = false;
            this.ws = null;
            const error = new CodexAppServerTransportError('Codex app-server websocket disconnected.');
            this.rejectPendingRequests(error);
            if (this.isDisconnecting) {
                return;
            }
            this.recoverActiveWebSocketTurn();
        });
        ws.addEventListener('error', (event: unknown) => {
            logger.debug('[CodexAppServer] websocket error:', redactDiagnosticData(event));
        });
    }

    private closeWebSocketTransport(ws: WebSocketLike, error: Error): void {
        if (this.ws !== ws) {
            return;
        }

        this.ws = null;
        this.connected = false;
        try {
            ws.close();
        } catch {
            // best effort
        }
        this.rejectPendingRequests(error);
        this.recoverActiveWebSocketTurn();
    }

    private recoverActiveWebSocketTurn(): void {
        const threadId = this.activeThreadId;
        const turnId = this.activeTurnId;
        if (
            !this.endpoint
            || !threadId
            || !turnId
            || this.isDisconnecting
            || this.recoveryPromise
        ) {
            return;
        }

        const recovery = this.recoverWebSocketTurn(threadId, turnId);
        this.recoveryPromise = recovery;
        void recovery.finally(() => {
            if (this.recoveryPromise === recovery) {
                this.recoveryPromise = null;
            }
        }).catch((error) => logger.debug(
            '[CodexAppServer] websocket recovery failed unexpectedly:',
            redactDiagnosticData(error),
        ));
    }

    private async recoverWebSocketTurn(threadId: string, turnId: string): Promise<void> {
        let lastError: Error = new Error('Codex app-server websocket recovery failed.');

        for (const delayMs of WEBSOCKET_RECOVERY_DELAYS_MS) {
            if (this.isDisconnecting || this.activeThreadId !== threadId) {
                return;
            }
            if (delayMs > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
            }
            if (this.isDisconnecting || this.activeThreadId !== threadId) {
                return;
            }

            try {
                await this.connect();
                const observedThread = await this.readThreadTurns(threadId, RECOVERY_REQUEST_TIMEOUT);

                const observedTurn = observedThread.turns.find((turn) => turn.id === turnId);
                if (!observedTurn) {
                    throw new Error(`Codex turn ${turnId} was not found during websocket recovery.`);
                }

                const observedActiveTurn = observedThread.activeTurn;
                const attachedThread = observedActiveTurn
                    ? await this.attachReconciledThread(threadId, RECOVERY_REQUEST_TIMEOUT)
                    : observedThread;
                const reconciledTurn = attachedThread.turns.find((turn) => turn.id === turnId) ?? observedTurn;
                const activeTurn = attachedThread.activeTurn;

                this.replayReconciledTurnItems(threadId, reconciledTurn);
                if (activeTurn && activeTurn.id !== reconciledTurn.id) {
                    this.replayReconciledTurnItems(threadId, activeTurn);
                    this.applyReconciledTurn(threadId, undefined, activeTurn);
                }
                this.applyReconciledTurn(threadId, undefined, reconciledTurn);
                return;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                logger.debug(
                    `[CodexAppServer] websocket recovery attempt failed for turn ${turnId}:`,
                    redactDiagnosticData(lastError),
                );
            }
        }

        if (!this.isDisconnecting && this.activeThreadId === threadId) {
            this.rejectTurnWaiter(turnId, lastError);
        }
    }

    async resumeThread(options: CodexAppServerResumeOptions): Promise<string> {
        const previousResumingThreadId = this.resumingThreadId;
        this.resumingThreadId = options.threadId;
        try {
            await this.connect();
            this.clearUserMessageTracking();
            logger.debug('[CodexAppServer] Resuming thread:', {
                threadId: options.threadId,
                cwd: options.cwd,
                sandbox: options.sandbox,
                approvalPolicy: options.approvalPolicy,
                model: options.model,
            });
            const result = await this.request(
                'thread/resume',
                {
                    threadId: options.threadId,
                    cwd: options.cwd,
                    sandbox: options.sandbox,
                    approvalPolicy: options.approvalPolicy,
                    ...(options.model ? { model: options.model } : {}),
                },
                undefined,
                RECOVERY_REQUEST_TIMEOUT,
            );
            const returnedThreadId = typeof result?.thread?.id === 'string' ? result.thread.id : options.threadId;
            if (returnedThreadId !== options.threadId) {
                throw new CodexAppServerThreadStateError(
                    'unknown-status',
                    'Codex app-server resumed a thread other than the requested native thread.',
                );
            }
            const threadId = options.threadId;
            this.hasAmbiguousThreadStart = false;
            this.setActiveThreadId(threadId);

            // `thread/resume` only returns the thread summary. The active turn is
            // available from the documented `thread/read` response with turns.
            const activeTurn = (await this.readThreadTurns(threadId, RECOVERY_REQUEST_TIMEOUT)).activeTurn;
            if (activeTurn) {
                this.replayReconciledTurnItems(threadId, activeTurn);
                this.applyReconciledTurn(threadId, undefined, activeTurn);
            }

            return threadId;
        } finally {
            if (this.resumingThreadId === options.threadId) {
                this.resumingThreadId = previousResumingThreadId;
            }
        }
    }

    async startThread(options: CodexAppServerStartThreadOptions): Promise<string> {
        if (this.hasAmbiguousThreadStart) {
            throw new CodexAppServerAmbiguousThreadStartError('previous-start-ambiguous');
        }
        await this.connect();
        this.clearUserMessageTracking();
        this.isStartingThread = true;

        try {
            const result = await this.request('thread/start', {
                cwd: options.cwd,
                sandbox: options.sandbox,
                approvalPolicy: options.approvalPolicy,
                ephemeral: options.ephemeral ?? false,
                ...(options.model ? { model: options.model } : {}),
            }, undefined, THREAD_START_RESPONSE_TIMEOUT);
            const threadId = result?.thread?.id;
            if (typeof threadId !== 'string') {
                this.hasAmbiguousThreadStart = true;
                throw new CodexAppServerAmbiguousThreadStartError('invalid-response');
            }
            this.hasAmbiguousThreadStart = false;
            this.setActiveThreadId(threadId);
            return threadId;
        } catch (error) {
            if (error instanceof CodexAppServerJsonRpcError) {
                throw error;
            }

            if (error instanceof CodexAppServerAmbiguousThreadStartError) {
                this.hasAmbiguousThreadStart = true;
                throw error;
            }

            this.hasAmbiguousThreadStart = true;
            throw new CodexAppServerAmbiguousThreadStartError('response-lost');
        } finally {
            this.isStartingThread = false;
        }
    }

    /**
     * Re-attach a known native thread after Remcli was disconnected while the
     * terminal was idle. A terminal can start a turn during that gap, so the
     * caller must hydrate it before deciding whether a phone prompt starts or
     * steers a turn.
     */
    async hydrateThreadIfNeeded(threadId: string): Promise<void> {
        if (
            !threadId
            || this.activeThreadId !== null && this.activeThreadId !== threadId
            || this.activeThreadId === threadId && this.activeTurnId !== null
        ) {
            return;
        }

        let observedThread: ReconciledThread;
        try {
            observedThread = await this.readThreadTurns(threadId, RECOVERY_REQUEST_TIMEOUT);
        } catch (error) {
            if (
                (error instanceof CodexAppServerThreadStateError && error.reason === 'not-loaded')
                || isCodexAppServerFreshThreadUnmaterializedError(error, threadId)
            ) {
                return;
            }
            throw error;
        }
        const observedActiveTurn = observedThread.activeTurn;
        if (!observedActiveTurn) {
            return;
        }

        // `thread/read` is a snapshot only. `thread/resume` joins the native
        // live stream before we apply terminal-origin items or steer the turn.
        const attachedThread = await this.attachReconciledThread(threadId, RECOVERY_REQUEST_TIMEOUT);
        const activeTurn = attachedThread.activeTurn;
        if (activeTurn) {
            this.replayReconciledTurnItems(threadId, activeTurn);
            this.applyReconciledTurn(threadId, undefined, activeTurn);
            return;
        }

        const completedTurn = attachedThread.turns.find((turn) => turn.id === observedActiveTurn.id);
        if (completedTurn) {
            this.replayReconciledTurnItems(threadId, completedTurn);
            this.applyReconciledTurn(threadId, undefined, completedTurn);
        }
    }

    isTurnInterrupting(turnId: string): boolean {
        return this.interruptingTurnIds.has(turnId);
    }

    interruptActiveTurn(): Promise<void> {
        const threadId = this.activeThreadId;
        const turnId = this.activeTurnId;
        if (!threadId || !turnId) {
            return Promise.resolve();
        }

        return this.requestTurnInterrupt(threadId, turnId);
    }

    waitForInterruptedTurn(options: CodexAppServerTurnCompletionOptions): Promise<void> {
        if (this.interruptingTurnIds.get(options.turnId) !== options.threadId) {
            return Promise.resolve();
        }

        const interruptionFailure = this.interruptedTurnFailures.get(options.turnId);
        if (interruptionFailure) {
            return Promise.reject(interruptionFailure);
        }

        const existingWaiter = this.interruptedTurnWaiters.get(options.turnId);
        if (existingWaiter) {
            return existingWaiter.completion;
        }

        let resolveCompletion: () => void = () => {};
        let rejectCompletion: (error: Error) => void = () => {};
        const completion = new Promise<void>((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
        });
        let waiter: InterruptedTurnWaiter;
        const timeout = setTimeout(() => {
            const timeoutError = new Error('Timed out waiting for Codex interrupted turn to settle.');
            if (this.interruptingTurnIds.get(options.turnId) === options.threadId) {
                this.interruptedTurnFailures.set(options.turnId, timeoutError);
            }
            this.rejectInterruptedTurnWaiter(options.turnId, timeoutError);
        }, options.timeoutMs ?? DEFAULT_TIMEOUT);
        waiter = {
            threadId: options.threadId,
            turnId: options.turnId,
            completion,
            resolve: resolveCompletion,
            reject: rejectCompletion,
            timeout,
        };
        this.interruptedTurnWaiters.set(options.turnId, waiter);

        if (options.signal) {
            const onAbort = () => {
                const abortError = new Error('Aborted');
                abortError.name = 'AbortError';
                this.rejectInterruptedTurnWaiter(options.turnId, abortError);
            };
            waiter.cleanup = () => options.signal?.removeEventListener('abort', onAbort);
            if (options.signal.aborted) {
                onAbort();
                return completion;
            }
            options.signal.addEventListener('abort', onAbort, { once: true });
        }

        return completion;
    }

    async startTurn(options: CodexAppServerTurnOptions): Promise<CodexToolResponse> {
        const startedTurn = await this.beginTurn(options);
        return await startedTurn.completion;
    }

    async beginTurn(options: CodexAppServerTurnOptions): Promise<StartedTurn> {
        await this.connect();
        const clientUserMessageId = this.trackOwnUserMessage(options.clientUserMessageId);
        const reconciliation = options.clientUserMessageId
            ? await this.reconcileThreadUserMessage(options.threadId, clientUserMessageId)
            : null;
        if (reconciliation?.acceptedTurn) {
            return this.createReconciledStartedTurn(
                options,
                clientUserMessageId,
                reconciliation.acceptedTurn,
                reconciliation.activeTurn,
            );
        }
        if (reconciliation?.activeTurn) {
            const activeTurnHandoff = await this.reconcileActiveTurnHandoff(
                options.threadId,
                clientUserMessageId,
            );
            if (activeTurnHandoff) {
                throw activeTurnHandoff;
            }
        }

        let result: unknown;
        try {
            result = await this.request(
                'turn/start',
                {
                    threadId: options.threadId,
                    input: [{ type: 'text', text: options.prompt, text_elements: [] }],
                    clientUserMessageId,
                    approvalPolicy: options.approvalPolicy,
                    sandboxPolicy: codexSandboxToAppServerPolicy(options.sandbox),
                    ...(options.model ? { model: options.model } : {}),
                    ...(options.effort ? { effort: options.effort } : {}),
                },
                options.signal,
            );
        } catch (error) {
            const reconciliationAfterFailure = await this.reconcileThreadUserMessage(options.threadId, clientUserMessageId);
            if (reconciliationAfterFailure.acceptedTurn) {
                return this.createReconciledStartedTurn(
                    options,
                    clientUserMessageId,
                    reconciliationAfterFailure.acceptedTurn,
                    reconciliationAfterFailure.activeTurn,
                );
            }
            if (reconciliationAfterFailure.activeTurn) {
                const activeTurnHandoff = await this.reconcileActiveTurnHandoff(
                    options.threadId,
                    clientUserMessageId,
                );
                if (activeTurnHandoff) {
                    throw activeTurnHandoff;
                }
            }
            this.forgetOwnUserMessage(clientUserMessageId);
            throw error;
        }

        const turnId = isRecord(result) && isRecord(result.turn) ? result.turn.id : undefined;
        if (typeof turnId !== 'string') {
            const reconciliationAfterMissingTurn = await this.reconcileThreadUserMessage(options.threadId, clientUserMessageId);
            if (reconciliationAfterMissingTurn.acceptedTurn) {
                return this.createReconciledStartedTurn(
                    options,
                    clientUserMessageId,
                    reconciliationAfterMissingTurn.acceptedTurn,
                    reconciliationAfterMissingTurn.activeTurn,
                );
            }
            if (reconciliationAfterMissingTurn.activeTurn) {
                const activeTurnHandoff = await this.reconcileActiveTurnHandoff(
                    options.threadId,
                    clientUserMessageId,
                );
                if (activeTurnHandoff) {
                    throw activeTurnHandoff;
                }
            }
            this.forgetOwnUserMessage(clientUserMessageId);
            throw new Error('Codex app-server did not return a turn id for turn/start.');
        }
        return this.createStartedTurn(options, clientUserMessageId, turnId);
    }

    async steerTurn(options: CodexAppServerSteerOptions): Promise<string> {
        await this.connect();
        const clientUserMessageId = this.trackOwnUserMessage(options.clientUserMessageId);
        const reconciliation = options.clientUserMessageId
            ? await this.reconcileAcceptedUserMessage(options.threadId, clientUserMessageId)
            : null;
        if (reconciliation) {
            return (await this.prepareReconciledTurn(
                options.threadId,
                clientUserMessageId,
                reconciliation.acceptedTurn,
                reconciliation.activeTurn,
            )).id;
        }

        let result: unknown;
        try {
            result = await this.request('turn/steer', {
                threadId: options.threadId,
                expectedTurnId: options.expectedTurnId,
                input: [{ type: 'text', text: options.prompt, text_elements: [] }],
                clientUserMessageId,
            });
        } catch (error) {
            const reconciliationAfterFailure = await this.reconcileAcceptedUserMessage(options.threadId, clientUserMessageId);
            if (reconciliationAfterFailure) {
                return (await this.prepareReconciledTurn(
                    options.threadId,
                    clientUserMessageId,
                    reconciliationAfterFailure.acceptedTurn,
                    reconciliationAfterFailure.activeTurn,
                )).id;
            }
            await this.reconcileCompletedTurn(options.threadId, options.expectedTurnId);
            this.forgetOwnUserMessage(clientUserMessageId);
            throw error;
        }
        const turnId = isRecord(result) ? result.turnId : undefined;
        if (typeof turnId !== 'string') {
            const reconciliationAfterMissingTurn = await this.reconcileAcceptedUserMessage(options.threadId, clientUserMessageId);
            if (reconciliationAfterMissingTurn) {
                return (await this.prepareReconciledTurn(
                    options.threadId,
                    clientUserMessageId,
                    reconciliationAfterMissingTurn.acceptedTurn,
                    reconciliationAfterMissingTurn.activeTurn,
                )).id;
            }
            this.forgetOwnUserMessage(clientUserMessageId);
            throw new Error('Codex app-server did not return a turn id for turn/steer.');
        }
        this.associateOwnUserMessageWithTurn(clientUserMessageId, turnId);
        this.setActiveThreadId(options.threadId);
        this.rememberTurnThreadId(options.threadId, turnId);
        this.activeTurnId = turnId;
        return turnId;
    }

    waitForTurnCompletion(options: CodexAppServerTurnCompletionOptions): Promise<CodexToolResponse> {
        const completedTurn = this.completedTurns.get(options.turnId);
        if (completedTurn) {
            this.completedTurns.delete(options.turnId);
            this.completeUserMessageTrackingForTurn(options.turnId);
            if (this.activeTurnId === options.turnId) {
                this.activeTurnId = null;
            }
            return Promise.resolve(completedTurn);
        }

        const existingWaiter = this.turnWaiters.get(options.turnId);
        if (existingWaiter) {
            return existingWaiter.completion;
        }

        let resolveCompletion: (value: CodexToolResponse) => void = () => {};
        let rejectCompletion: (error: Error) => void = () => {};
        const completion = new Promise<CodexToolResponse>((resolve, reject) => {
            resolveCompletion = resolve;
            rejectCompletion = reject;
        });
        const timeout = setTimeout(() => {
            this.turnWaiters.delete(options.turnId);
            waiter.cleanup?.();
            this.completeUserMessageTrackingForTurn(options.turnId);
            if (this.activeTurnId === options.turnId) {
                this.activeTurnId = null;
            }
            rejectCompletion(new Error('Timed out waiting for Codex turn to complete.'));
        }, options.timeoutMs ?? DEFAULT_TIMEOUT);
        const waiter: TurnWaiter = {
            turnId: options.turnId,
            completion,
            resolve: resolveCompletion,
            reject: rejectCompletion,
            timeout,
        };
        this.turnWaiters.set(options.turnId, waiter);

        if (options.signal) {
            const onAbort = () => {
                if (options.interruptOnAbort !== false) {
                    void this.requestTurnInterrupt(options.threadId, options.turnId).catch((error) => logger.debug(
                        '[CodexAppServer] turn interrupt failed:',
                        redactDiagnosticData(error),
                    ));
                }
                this.turnWaiters.delete(options.turnId);
                clearTimeout(timeout);
                if (options.interruptOnAbort !== false) {
                    this.completeUserMessageTrackingForTurn(options.turnId);
                }
                const abortError = new Error('Aborted');
                abortError.name = 'AbortError';
                rejectCompletion(abortError);
            };
            waiter.cleanup = () => options.signal?.removeEventListener('abort', onAbort);
            if (options.signal.aborted) {
                onAbort();
                return completion;
            }
            options.signal.addEventListener('abort', onAbort, { once: true });
        }

        return completion;
    }

    private createStartedTurn(
        options: CodexAppServerTurnOptions,
        clientUserMessageId: string,
        turnId: string,
    ): StartedTurn {
        this.associateOwnUserMessageWithTurn(clientUserMessageId, turnId);
        this.setActiveThreadId(options.threadId);
        this.rememberTurnThreadId(options.threadId, turnId);
        this.activeTurnId = turnId;
        return {
            turnId,
            completion: this.waitForTurnCompletion({
                threadId: options.threadId,
                turnId,
                signal: options.signal,
            }),
        };
    }

    private async createReconciledStartedTurn(
        options: CodexAppServerTurnOptions,
        clientUserMessageId: string,
        acceptedTurn: ReconciledTurn,
        observedActiveTurn: ReconciledTurn | null,
    ): Promise<StartedTurn> {
        const reconciledTurn = await this.prepareReconciledTurn(
            options.threadId,
            clientUserMessageId,
            acceptedTurn,
            observedActiveTurn,
        );
        return {
            turnId: reconciledTurn.id,
            completion: this.waitForTurnCompletion({
                threadId: options.threadId,
                turnId: reconciledTurn.id,
                signal: options.signal,
            }),
        };
    }

    private async prepareReconciledTurn(
        threadId: string,
        clientUserMessageId: string,
        turn: ReconciledTurn,
        observedActiveTurn: ReconciledTurn | null = null,
    ): Promise<ReconciledTurn> {
        let reconciledTurn = turn;
        let attachedThread: ReconciledThread | null = null;

        if (turn.status === 'inProgress' || observedActiveTurn?.id !== undefined && observedActiveTurn.id !== turn.id) {
            // thread/resume re-joins a running thread on this connection, which
            // is required before acknowledging a replayed P2P delivery.
            attachedThread = await this.attachReconciledThread(threadId);
            reconciledTurn = attachedThread.turns.find((candidate) => candidate.id === turn.id) ?? turn;
        }

        const activeTurn = attachedThread ? attachedThread.activeTurn : observedActiveTurn;

        this.trackOwnUserMessage(clientUserMessageId);
        this.replayReconciledTurnItems(threadId, reconciledTurn);
        this.applyReconciledTurn(threadId, clientUserMessageId, reconciledTurn);
        if (activeTurn && activeTurn.id !== reconciledTurn.id) {
            this.replayReconciledTurnItems(threadId, activeTurn);
            this.applyReconciledTurn(threadId, undefined, activeTurn);
        }
        return reconciledTurn;
    }

    private async attachReconciledThread(
        threadId: string,
        timeoutMs: number = RECOVERY_REQUEST_TIMEOUT,
    ): Promise<ReconciledThread> {
        await this.request('thread/resume', { threadId }, undefined, timeoutMs);
        return await this.readThreadTurns(threadId, timeoutMs);
    }

    private replayReconciledTurnItems(threadId: string, turn: ReconciledTurn): void {
        if (!Array.isArray(turn.turn.items)) {
            return;
        }

        for (const item of turn.turn.items) {
            if (!isRecord(item)) continue;
            this.handleItemCompleted(item, turn.id, 'replay');
        }
    }

    private async reconcileAcceptedUserMessage(
        threadId: string,
        clientUserMessageId: string,
    ): Promise<ReconciledUserMessage | null> {
        const reconciliation = await this.reconcileThreadUserMessage(threadId, clientUserMessageId);
        if (!reconciliation.acceptedTurn) {
            return null;
        }
        return {
            acceptedTurn: reconciliation.acceptedTurn,
            activeTurn: reconciliation.activeTurn,
        };
    }

    private async reconcileThreadUserMessage(
        threadId: string,
        clientUserMessageId: string,
    ): Promise<ReconciledThreadMessage> {
        let reconciledThread: ReconciledThread;
        try {
            reconciledThread = await this.readThreadTurns(threadId);
        } catch (error) {
            if (isCodexAppServerFreshThreadUnmaterializedError(error, threadId)) {
                return { acceptedTurn: null, activeTurn: null };
            }
            throw error;
        }
        return {
            acceptedTurn: reconciledThread.turns.find((turn) => turnHasClientUserMessage(turn, clientUserMessageId)) ?? null,
            activeTurn: reconciledThread.activeTurn,
        };
    }

    private async reconcileActiveTurnHandoff(
        threadId: string,
        clientUserMessageId: string,
    ): Promise<CodexAppServerActiveTurnHandoffError | null> {
        const attachedThread = await this.attachReconciledThread(threadId);
        const activeTurn = attachedThread.activeTurn;
        if (!activeTurn) {
            return null;
        }

        this.forgetOwnUserMessage(clientUserMessageId);
        this.replayReconciledTurnItems(threadId, activeTurn);
        this.applyReconciledTurn(threadId, undefined, activeTurn);
        return new CodexAppServerActiveTurnHandoffError(threadId, activeTurn.id);
    }

    private async reconcileCompletedTurn(threadId: string, turnId: string): Promise<void> {
        const reconciledThread = await this.readThreadTurns(threadId);
        const activeTurn = reconciledThread.activeTurn;
        const completedTurn = reconciledThread.turns.find((turn) => turn.id === turnId && turn.status !== 'inProgress');
        if (activeTurn && completedTurn && activeTurn.id !== completedTurn.id) {
            const attachedThread = await this.attachReconciledThread(threadId);
            if (attachedThread.activeTurn) {
                this.replayReconciledTurnItems(threadId, attachedThread.activeTurn);
                this.applyReconciledTurn(threadId, undefined, attachedThread.activeTurn);
            }
        } else if (activeTurn) {
            this.replayReconciledTurnItems(threadId, activeTurn);
            this.applyReconciledTurn(threadId, undefined, activeTurn);
        }
        if (completedTurn) {
            this.replayReconciledTurnItems(threadId, completedTurn);
            this.applyReconciledTurn(threadId, undefined, completedTurn);
        }
    }

    private async readThreadTurns(
        threadId: string,
        timeoutMs: number = RECOVERY_REQUEST_TIMEOUT,
    ): Promise<ReconciledThread> {
        await this.connect();
        const result = await this.request('thread/read', { threadId, includeTurns: true }, undefined, timeoutMs);
        const reconciledThread = getReconciledTurns(result);
        if (!reconciledThread) {
            throw new Error(`Codex app-server returned an invalid thread/read response for ${threadId}.`);
        }
        return reconciledThread;
    }

    private applyReconciledTurn(
        threadId: string,
        clientUserMessageId: string | undefined,
        turn: ReconciledTurn,
    ): void {
        this.setActiveThreadId(threadId);
        this.rememberTurnThreadId(threadId, turn.id);
        if (clientUserMessageId) {
            this.associateOwnUserMessageWithTurn(clientUserMessageId, turn.id);
        }

        if (turn.status === 'inProgress') {
            this.activeTurnId = turn.id;
            return;
        }

        const hasInterruptedBarrier = this.interruptingTurnIds.get(turn.id) === threadId;
        const isCurrentActiveTurn = this.activeThreadId === threadId && this.activeTurnId === turn.id;
        if (hasInterruptedBarrier) {
            if (turn.status === 'interrupted' && isCurrentActiveTurn) {
                this.settleCompletedTurn(turn.id, getReconciledTurnResponse(turn));
                this.releaseInterruptedTurnBarrier(threadId, turn.id);
            }
            return;
        }

        this.settleCompletedTurn(turn.id, getReconciledTurnResponse(turn));
    }

    async disconnect(): Promise<void> {
        this.isDisconnecting = true;
        this.clearUserMessageTracking();
        this.rl?.close();
        this.rl = null;
        if (this.proc) {
            try {
                this.proc.kill('SIGTERM');
            } catch {
                // best effort
            }
        }
        this.proc = null;
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // best effort
            }
        }
        this.ws = null;
        this.connected = false;
        this.rejectAll(new Error('Codex app-server disconnected.'));
    }

    async forceCloseSession(): Promise<void> {
        await this.disconnect();
        this.activeThreadId = null;
        this.turnThreadIds.clear();
    }

    hasActiveSession(): boolean {
        return this.activeThreadId !== null;
    }

    getActiveThreadId(): string | null {
        return this.activeThreadId;
    }

    getActiveTurnId(): string | null {
        return this.activeTurnId;
    }

    clearSession(): void {
        this.activeThreadId = null;
        this.activeTurnId = null;
        this.turnThreadIds.clear();
        this.clearUserMessageTracking();
    }

    private trackOwnUserMessage(clientUserMessageId: string = randomUUID()): string {
        this.ownUserMessageIds.set(clientUserMessageId, null);
        this.boundOwnUserMessageIds();
        return clientUserMessageId;
    }

    private clearUserMessageTracking(): void {
        this.ownUserMessageIds.clear();
        this.recentOwnUserMessageIds.clear();
        this.activeUserMessageItemIds.clear();
        this.recentUserMessageItemIds.clear();
        this.recentCompletedItemIds.clear();
    }

    private boundOwnUserMessageIds(): void {
        while (this.ownUserMessageIds.size > MAX_ACTIVE_USER_MESSAGE_ITEMS) {
            const oldestId = this.ownUserMessageIds.keys().next().value;
            if (typeof oldestId !== 'string') return;
            this.ownUserMessageIds.delete(oldestId);
            this.recentOwnUserMessageIds.add(oldestId);
        }
    }

    private associateOwnUserMessageWithTurn(clientUserMessageId: string, turnId: string): void {
        if (this.ownUserMessageIds.has(clientUserMessageId)) {
            this.ownUserMessageIds.set(clientUserMessageId, turnId);
        }
    }

    private forgetOwnUserMessage(clientUserMessageId: string): void {
        this.ownUserMessageIds.delete(clientUserMessageId);
        this.recentOwnUserMessageIds.delete(clientUserMessageId);
    }

    private completeOwnUserMessage(clientUserMessageId: string): void {
        this.ownUserMessageIds.delete(clientUserMessageId);
        this.recentOwnUserMessageIds.add(clientUserMessageId);
    }

    private completeUserMessageTrackingForTurn(turnId: string): void {
        for (const [clientUserMessageId, trackedTurnId] of this.ownUserMessageIds) {
            if (trackedTurnId === turnId) {
                this.completeOwnUserMessage(clientUserMessageId);
            }
        }
        for (const [itemId, trackedTurnId] of this.activeUserMessageItemIds) {
            if (trackedTurnId === turnId) {
                this.activeUserMessageItemIds.delete(itemId);
                this.recentUserMessageItemIds.add(itemId);
            }
        }
    }

    private request(
        method: string,
        params: unknown,
        signal?: AbortSignal,
        timeoutMs: number = DEFAULT_TIMEOUT,
    ): Promise<any> {
        if (!this.proc && !this.ws) {
            return Promise.reject(new Error('Codex app-server is not running.'));
        }
        const id = this.nextRequestId++;
        const payload = { method, id, params };
        const requestWebSocket = this.ws;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                pending.cleanup?.();
                const timeoutError = requestWebSocket
                    ? new CodexAppServerTransportError(`Timed out waiting for Codex app-server ${method}.`)
                    : new Error(`Timed out waiting for Codex app-server ${method}.`);
                if (requestWebSocket) {
                    this.closeWebSocketTransport(requestWebSocket, timeoutError);
                }
                reject(timeoutError);
            }, timeoutMs);
            const pending: PendingRequest = { resolve, reject, timeout };
            this.pendingRequests.set(id, pending);
            if (signal) {
                const onAbort = () => {
                    this.pendingRequests.delete(id);
                    clearTimeout(timeout);
                    const abortError = new Error('Aborted');
                    abortError.name = 'AbortError';
                    reject(abortError);
                };
                pending.cleanup = () => signal.removeEventListener('abort', onAbort);
                if (signal.aborted) {
                    onAbort();
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }
            try {
                this.sendPayload(payload);
            } catch (error) {
                this.pendingRequests.delete(id);
                clearTimeout(timeout);
                pending.cleanup?.();
                const requestError = error instanceof Error ? error : new Error(String(error));
                if (requestWebSocket && requestError instanceof CodexAppServerTransportError) {
                    this.closeWebSocketTransport(requestWebSocket, requestError);
                }
                reject(requestError);
            }
        });
    }

    private notify(method: string, params: unknown): void {
        this.sendPayload({ method, params });
    }

    private respond(id: JsonRpcId, result: unknown): void {
        this.sendPayload({ id, result });
    }

    private respondError(id: JsonRpcId, code: number, message: string): void {
        this.sendPayload({ id, error: { code, message } });
    }

    private sendPayload(payload: unknown): void {
        const serialized = JSON.stringify(payload);
        if (this.ws) {
            if (this.ws.readyState !== WEBSOCKET_OPEN_STATE) {
                throw new CodexAppServerTransportError('Codex app-server websocket is not open.');
            }
            this.ws.send(serialized);
            return;
        }
        if (this.proc) {
            this.proc.stdin.write(`${serialized}\n`);
            return;
        }
        throw new Error('Codex app-server is not running.');
    }

    private handleTransportText(text: string): void {
        const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        for (const line of lines) {
            this.handleLine(line);
        }
    }

    private handleLine(line: string): void {
        let message: JsonRpcMessage;
        try {
            message = JSON.parse(line) as JsonRpcMessage;
        } catch {
            logger.debug('[CodexAppServer] Ignoring non-json line:', redactSensitiveText(line));
            return;
        }

        if (typeof message.id === 'number' && !message.method) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                this.pendingRequests.delete(message.id);
                clearTimeout(pending.timeout);
                pending.cleanup?.();
                if (message.error) {
                    pending.reject(errorFromJsonRpc(message));
                } else {
                    pending.resolve(message.result);
                }
            }
            return;
        }

        if (typeof message.id === 'number' && typeof message.method === 'string') {
            void this.handleServerRequest(message);
            return;
        }

        if (typeof message.method === 'string') {
            this.handleNotification(message.method, message.params);
        }
    }

    private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
        const id = message.id;
        if (typeof id !== 'number') return;
        const method = message.method;
        const params = message.params ?? {};

        try {
            if (method === 'item/commandExecution/requestApproval') {
                const result = await this.requestPermission(params.itemId ?? params.approvalId ?? String(id), 'CodexBash', {
                    command: params.command,
                    cwd: params.cwd,
                    reason: params.reason,
                    commandActions: params.commandActions,
                });
                this.respond(id, { decision: permissionResultToCommandDecision(result) });
                return;
            }
            if (method === 'item/fileChange/requestApproval') {
                const result = await this.requestPermission(params.itemId ?? String(id), 'CodexFileChange', params);
                this.respond(id, { decision: permissionResultToCommandDecision(result) });
                return;
            }
            if (method === 'mcpServer/elicitation/request') {
                const result = await this.requestPermission(String(id), 'CodexMcpElicitation', params);
                const action = permissionResultToMcpAction(result);
                this.respond(id, { action, content: action === 'accept' ? {} : null, _meta: null });
                return;
            }
            if (method === 'item/permissions/requestApproval') {
                const result = await this.requestPermission(params.itemId ?? String(id), 'CodexPermissions', params);
                if (result.decision === 'approved' || result.decision === 'approved_for_session') {
                    this.respond(id, {
                        permissions: params.permissions ?? {},
                        scope: result.decision === 'approved_for_session' ? 'session' : 'turn',
                    });
                } else {
                    this.respond(id, { permissions: {}, scope: 'turn', strictAutoReview: true });
                }
                return;
            }
            this.respondError(id, -32601, `Unsupported remcli app-server request: ${method ?? 'unknown'}`);
        } catch (error) {
            logger.debug('[CodexAppServer] request handler failed:', redactDiagnosticData(error));
            this.respond(id, { decision: 'cancel' });
        }
    }

    private async requestPermission(id: string, toolName: string, input: unknown): Promise<PermissionResult> {
        if (!this.permissionHandler) {
            return { decision: 'denied' };
        }
        return this.permissionHandler.handleToolCall(id, toolName, input);
    }

    private handleNotification(method: string, params: any): void {
        logger.debug(`[CodexAppServer] notification ${method}:`, redactDiagnosticData(params));
        if (this.hasAmbiguousThreadStart && method !== 'error') {
            logger.debug(`[CodexAppServer] ignoring ${method} after an ambiguous thread/start result`);
            return;
        }
        switch (method) {
            case 'thread/started':
                this.shouldHandleThreadScopedNotification(method, params, true);
                return;
            case 'thread/status/changed':
                this.shouldHandleThreadScopedNotification(method, params, true);
                return;
            case 'turn/started':
                if (!this.shouldHandleThreadScopedNotification(method, params, true)) return;
                if (typeof params?.turn?.id === 'string') {
                    this.activeTurnId = params.turn.id;
                }
                this.handler?.({ type: 'task_started' });
                return;
            case 'turn/completed':
                {
                    if (!this.shouldHandleThreadScopedNotification(method, params, true)) return;
                    const completionEvent = this.completeTurn(params);
                    if (completionEvent) {
                        this.handler?.(completionEvent);
                    }
                }
                return;
            case 'item/started':
                if (!this.shouldHandleThreadScopedNotification(method, params, false)) return;
                this.handleItemStarted(params?.item, getNotificationTurnId(params));
                return;
            case 'item/completed':
                if (!this.shouldHandleThreadScopedNotification(method, params, false)) return;
                this.handleItemCompleted(params?.item, getNotificationTurnId(params));
                return;
            case 'turn/diff/updated':
                if (!this.shouldHandleThreadScopedNotification(method, params, false)) return;
                if (typeof params?.diff === 'string') {
                    this.handler?.({ type: 'turn_diff', unified_diff: params.diff });
                }
                return;
            case 'error':
                if (
                    (getNotificationThreadId(params) || getNotificationTurnId(params))
                    && !this.shouldHandleThreadScopedNotification(method, params, false)
                ) {
                    return;
                }
                this.handler?.({ type: 'agent_error', message: params?.message ?? 'Codex app-server error.' });
                return;
            default:
                return;
        }
    }

    private handleItemStarted(item: any, notificationTurnId: unknown): void {
        if (!item || typeof item !== 'object') return;
        if (item.type === 'userMessage') {
            this.emitUserMessage(item, notificationTurnId, 'started');
            return;
        }
        if (item.type === 'commandExecution') {
            this.handler?.({ type: 'exec_command_begin', command: item.command });
        }
        if (item.type === 'fileChange') {
            this.handler?.({ type: 'patch_apply_begin', changes: {} });
        }
    }

    private handleItemCompleted(
        item: any,
        notificationTurnId: unknown,
        origin: CodexAgentMessageOrigin = 'live',
    ): void {
        if (!item || typeof item !== 'object') return;
        if (item.type === 'userMessage') {
            this.emitUserMessage(item, notificationTurnId, 'completed');
            return;
        }
        if (typeof item.id === 'string') {
            if (this.recentCompletedItemIds.has(item.id)) {
                return;
            }
            this.recentCompletedItemIds.add(item.id);
        }
        if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.length > 0) {
            this.handler?.({ type: 'agent_message', message: item.text, origin });
        }
        if (item.type === 'reasoning') {
            const text = [
                ...(Array.isArray(item.summary) ? item.summary : []),
                ...(Array.isArray(item.content) ? item.content : []),
            ].join('\n').trim();
            if (text) this.handler?.({ type: 'agent_reasoning', text });
        }
        if (item.type === 'commandExecution') {
            this.handler?.({
                type: 'exec_command_end',
                output: item.aggregatedOutput ?? '',
                error: item.status === 'failed' ? item.aggregatedOutput : undefined,
            });
        }
        if (item.type === 'fileChange') {
            this.handler?.({
                type: 'patch_apply_end',
                success: item.status === 'applied' || item.status === 'completed',
                stdout: '',
                stderr: item.status,
            });
        }
    }

    private emitUserMessage(item: unknown, notificationTurnId: unknown, lifecycle: 'started' | 'completed'): void {
        if (!isRecord(item) || item.type !== 'userMessage' || typeof item.id !== 'string') return;

        if (this.recentUserMessageItemIds.has(item.id)) return;
        if (this.activeUserMessageItemIds.has(item.id)) {
            if (lifecycle === 'completed') {
                this.activeUserMessageItemIds.delete(item.id);
                this.recentUserMessageItemIds.add(item.id);
            }
            return;
        }

        const content = Array.isArray(item.content)
            ? item.content.map(normalizeUserMessageContent).filter((part): part is CodexUserMessageContent => part !== null)
            : [];
        const text = content
            .filter((part): part is CodexTextUserMessageContent => part.type === 'text')
            .map((part) => part.text)
            .join('\n');
        const clientId = typeof item.clientId === 'string' ? item.clientId : null;
        const source: CodexUserMessageSource = clientId !== null && (
            isRemcliP2PDeliveryId(clientId)
            || this.ownUserMessageIds.has(clientId)
            || this.recentOwnUserMessageIds.has(clientId)
        )
            ? 'own'
            : 'external';

        if (lifecycle === 'started') {
            const turnId = typeof notificationTurnId === 'string' ? notificationTurnId : this.activeTurnId;
            this.activeUserMessageItemIds.set(item.id, turnId);
            this.boundActiveUserMessageItemIds();
        } else {
            this.recentUserMessageItemIds.add(item.id);
        }
        if (clientId !== null && source === 'own') {
            this.completeOwnUserMessage(clientId);
        }
        this.handler?.({
            type: 'user_message',
            itemId: item.id,
            text,
            content,
            clientId,
            source,
        });
    }

    private boundActiveUserMessageItemIds(): void {
        while (this.activeUserMessageItemIds.size > MAX_ACTIVE_USER_MESSAGE_ITEMS) {
            const oldestItemId = this.activeUserMessageItemIds.keys().next().value;
            if (typeof oldestItemId !== 'string') return;
            this.activeUserMessageItemIds.delete(oldestItemId);
            this.recentUserMessageItemIds.add(oldestItemId);
        }
    }

    private completeTurn(params: any): CodexAppServerEvent | null {
        const turnId = params?.turn?.id;
        if (typeof turnId !== 'string') return null;
        const threadId = getNotificationThreadId(params) ?? this.turnThreadIds.get(turnId);
        if (!threadId) return null;
        const status = params.turn.status;
        const errorText = getTurnErrorText(params.turn);
        const isInterrupted = status === 'interrupted';
        const isSuccessful = status === 'completed' && !errorText;
        const response: CodexToolResponse = errorText
            ? { content: [{ type: 'text', text: errorText }], isError: true }
            : { content: [], isError: !isSuccessful && !isInterrupted };

        const isCurrentActiveTurn = this.activeThreadId === threadId && this.activeTurnId === turnId;
        const hasInterruptedBarrier = this.interruptingTurnIds.get(turnId) === threadId;
        if (hasInterruptedBarrier) {
            if (!isCurrentActiveTurn || !isInterrupted) {
                return null;
            }

            this.settleCompletedTurn(turnId, response);
            this.releaseInterruptedTurnBarrier(threadId, turnId);
            return { type: 'turn_aborted' };
        }

        this.settleCompletedTurn(turnId, response);
        if (!isCurrentActiveTurn) {
            return null;
        }
        if (isInterrupted) {
            return { type: 'turn_aborted' };
        }
        if (isSuccessful) {
            return { type: 'task_complete' };
        }
        return {
            type: 'agent_error',
            message: errorText ?? 'Codex app-server turn failed.',
        };
    }

    private settleCompletedTurn(turnId: string, response: CodexToolResponse): void {
        this.completeUserMessageTrackingForTurn(turnId);
        const waiter = this.turnWaiters.get(turnId);
        if (!waiter) {
            this.completedTurns.set(turnId, response);
            if (this.activeTurnId === turnId) {
                this.activeTurnId = null;
            }
            return;
        }
        this.turnWaiters.delete(turnId);
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        if (this.activeTurnId === turnId) {
            this.activeTurnId = null;
        }
        waiter.resolve(response);
    }

    private requestTurnInterrupt(threadId: string, turnId: string): Promise<void> {
        const interruptedThreadId = this.interruptingTurnIds.get(turnId);
        if (interruptedThreadId) {
            if (interruptedThreadId !== threadId) {
                return Promise.reject(new Error(`Codex turn ${turnId} is already interrupting in another thread.`));
            }
            const interruptionFailure = this.interruptedTurnFailures.get(turnId);
            return interruptionFailure
                ? Promise.reject(interruptionFailure)
                : Promise.resolve();
        }

        this.interruptingTurnIds.set(turnId, threadId);
        return this.request('turn/interrupt', { threadId, turnId }, undefined, RECOVERY_REQUEST_TIMEOUT)
            .then(() => undefined)
            .catch((error) => {
                const interruptionFailure = error instanceof Error ? error : new Error(String(error));
                if (this.interruptingTurnIds.get(turnId) === threadId) {
                    this.interruptedTurnFailures.set(turnId, interruptionFailure);
                    this.rejectInterruptedTurnWaiter(turnId, interruptionFailure);
                }
                throw interruptionFailure;
            });
    }

    private releaseInterruptedTurnBarrier(threadId: string, turnId: string): void {
        if (this.interruptingTurnIds.get(turnId) !== threadId) {
            return;
        }

        this.interruptingTurnIds.delete(turnId);
        this.interruptedTurnFailures.delete(turnId);
        const waiter = this.interruptedTurnWaiters.get(turnId);
        if (!waiter) {
            return;
        }
        this.interruptedTurnWaiters.delete(turnId);
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.resolve();
    }

    private rejectPendingRequests(error: Error): void {
        for (const [id, pending] of this.pendingRequests.entries()) {
            this.pendingRequests.delete(id);
            clearTimeout(pending.timeout);
            pending.cleanup?.();
            pending.reject(error);
        }
    }

    private rejectTurnWaiter(turnId: string, error: Error): void {
        const waiter = this.turnWaiters.get(turnId);
        if (!waiter) {
            return;
        }
        this.turnWaiters.delete(turnId);
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        this.completeUserMessageTrackingForTurn(turnId);
        if (this.activeTurnId === turnId) {
            this.activeTurnId = null;
        }
        waiter.reject(error);
    }

    private rejectInterruptedTurnWaiter(turnId: string, error: Error): void {
        const waiter = this.interruptedTurnWaiters.get(turnId);
        if (!waiter) {
            return;
        }
        this.interruptedTurnWaiters.delete(turnId);
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        waiter.reject(error);
    }

    private rejectAll(error: Error): void {
        this.clearUserMessageTracking();
        this.completedTurns.clear();
        for (const turnId of Array.from(this.interruptedTurnWaiters.keys())) {
            this.rejectInterruptedTurnWaiter(turnId, error);
        }
        this.interruptingTurnIds.clear();
        this.interruptedTurnFailures.clear();
        this.activeTurnId = null;
        this.rejectPendingRequests(error);
        for (const [turnId, waiter] of this.turnWaiters.entries()) {
            this.turnWaiters.delete(turnId);
            clearTimeout(waiter.timeout);
            waiter.cleanup?.();
            waiter.reject(error);
        }
    }
}
