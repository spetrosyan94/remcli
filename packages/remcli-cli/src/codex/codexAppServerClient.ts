import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

import { logger } from '@/ui/logger';
import type { CodexApprovalPolicy, CodexSandbox, CodexToolResponse } from './types';
import { CodexPermissionHandler, type PermissionResult } from './utils/permissionHandler';

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000;
const CONNECT_TIMEOUT = 10_000;
const WEBSOCKET_OPEN_STATE = 1;

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
    resolve: (value: CodexToolResponse) => void;
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

export interface CodexAppServerClientOptions {
    endpoint?: string;
    webSocketFactory?: (endpoint: string) => WebSocketLike;
}

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
    sandbox: CodexSandbox;
    approvalPolicy: CodexApprovalPolicy;
    model?: string;
    signal?: AbortSignal;
}

interface CodexAppServerSteerOptions {
    threadId: string;
    expectedTurnId: string;
    prompt: string;
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
    return new Error(text);
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

export class CodexAppServerClient {
    private readonly endpoint?: string;
    private readonly webSocketFactory: (endpoint: string) => WebSocketLike;
    private proc: ChildProcessWithoutNullStreams | null = null;
    private rl: readline.Interface | null = null;
    private ws: WebSocketLike | null = null;
    private connected = false;
    private nextRequestId = 1;
    private pendingRequests = new Map<JsonRpcId, PendingRequest>();
    private turnWaiters = new Map<string, TurnWaiter>();
    private completedTurns = new Map<string, CodexToolResponse>();
    private handler: ((event: any) => void) | null = null;
    private threadIdChangeHandler: ((threadId: string) => void) | null = null;
    private permissionHandler: CodexPermissionHandler | null = null;
    private activeThreadId: string | null = null;
    private activeTurnId: string | null = null;

    constructor(options: CodexAppServerClientOptions = {}) {
        this.endpoint = options.endpoint;
        this.webSocketFactory = options.webSocketFactory ?? createGlobalWebSocket;
    }

    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    setThreadIdChangeHandler(handler: ((threadId: string) => void) | null): void {
        this.threadIdChangeHandler = handler;
    }

    setPermissionHandler(handler: CodexPermissionHandler): void {
        this.permissionHandler = handler;
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        if (this.endpoint) {
            await this.connectWebSocket();
        } else {
            this.connectStdio();
        }

        await this.request('initialize', {
            clientInfo: {
                name: 'remcli',
                title: 'Remcli',
                version: '1.0.0',
            },
            capabilities: {
                experimentalApi: true,
            },
        });
        this.notify('initialized', {});
        this.connected = true;
        logger.debug(`[CodexAppServer] Connected via ${this.endpoint ? 'websocket' : 'stdio'}`);
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
            if (text) logger.debug('[CodexAppServer][stderr]', text);
        });
        this.proc.on('exit', (code, signal) => {
            logger.debug(`[CodexAppServer] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
            this.connected = false;
            const error = new Error('Codex app-server exited.');
            this.rejectAll(error);
        });
        this.proc.on('error', (error) => {
            logger.debug('[CodexAppServer] process error:', error);
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
                this.ws = null;
                reject(error);
            };
            const onOpen = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };
            const onError = (event: unknown) => {
                fail(new Error(`Codex app-server websocket error: ${String(event)}`));
            };
            const onCloseBeforeOpen = () => {
                fail(new Error('Codex app-server websocket closed before connection opened.'));
            };
            const timeout = setTimeout(() => {
                fail(new Error(`Timed out connecting to Codex app-server ${this.endpoint}.`));
            }, CONNECT_TIMEOUT);

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
            logger.debug('[CodexAppServer] websocket closed');
            this.connected = false;
            this.ws = null;
            this.rejectAll(new Error('Codex app-server websocket disconnected.'));
        });
        ws.addEventListener('error', (event: unknown) => {
            logger.debug('[CodexAppServer] websocket error:', event);
        });
    }

    async resumeThread(options: CodexAppServerResumeOptions): Promise<string> {
        await this.connect();
        logger.debug('[CodexAppServer] Resuming thread:', {
            threadId: options.threadId,
            cwd: options.cwd,
            sandbox: options.sandbox,
            approvalPolicy: options.approvalPolicy,
            model: options.model,
        });
        const result = await this.request('thread/resume', {
            threadId: options.threadId,
            cwd: options.cwd,
            sandbox: options.sandbox,
            approvalPolicy: options.approvalPolicy,
            ...(options.model ? { model: options.model } : {}),
        });
        const threadId = result?.thread?.id;
        if (typeof threadId === 'string') {
            this.activeThreadId = threadId;
            this.threadIdChangeHandler?.(threadId);
            return threadId;
        }
        this.activeThreadId = options.threadId;
        this.threadIdChangeHandler?.(options.threadId);
        return options.threadId;
    }

    async startThread(options: CodexAppServerStartThreadOptions): Promise<string> {
        await this.connect();
        const result = await this.request('thread/start', {
            cwd: options.cwd,
            sandbox: options.sandbox,
            approvalPolicy: options.approvalPolicy,
            ephemeral: options.ephemeral ?? false,
            ...(options.model ? { model: options.model } : {}),
        });
        const threadId = result?.thread?.id;
        if (typeof threadId !== 'string') {
            throw new Error('Codex app-server did not return a thread id.');
        }
        this.activeThreadId = threadId;
        this.threadIdChangeHandler?.(threadId);
        return threadId;
    }

    async startTurn(options: CodexAppServerTurnOptions): Promise<CodexToolResponse> {
        const startedTurn = await this.beginTurn(options);
        return await startedTurn.completion;
    }

    async beginTurn(options: CodexAppServerTurnOptions): Promise<StartedTurn> {
        await this.connect();
        const result = await this.request('turn/start', {
            threadId: options.threadId,
            input: [{ type: 'text', text: options.prompt, text_elements: [] }],
            approvalPolicy: options.approvalPolicy,
            sandboxPolicy: codexSandboxToAppServerPolicy(options.sandbox),
            ...(options.model ? { model: options.model } : {}),
        }, options.signal);

        const turnId = result?.turn?.id;
        if (typeof turnId !== 'string') {
            const response = { content: [], isError: false };
            return { turnId: '', completion: Promise.resolve(response) };
        }
        this.activeTurnId = turnId;

        const completedTurn = this.completedTurns.get(turnId);
        if (completedTurn) {
            this.completedTurns.delete(turnId);
            if (this.activeTurnId === turnId) {
                this.activeTurnId = null;
            }
            return { turnId, completion: Promise.resolve(completedTurn) };
        }

        const completion = new Promise<CodexToolResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.turnWaiters.delete(turnId);
                waiter.cleanup?.();
                if (this.activeTurnId === turnId) {
                    this.activeTurnId = null;
                }
                reject(new Error('Timed out waiting for Codex turn to complete.'));
            }, DEFAULT_TIMEOUT);
            const waiter: TurnWaiter = { turnId, resolve, reject, timeout };
            this.turnWaiters.set(turnId, waiter);

            if (options.signal) {
                const onAbort = () => {
                    void this.request('turn/interrupt', { threadId: options.threadId, turnId })
                        .catch((error) => logger.debug('[CodexAppServer] turn interrupt failed:', error));
                    this.turnWaiters.delete(turnId);
                    clearTimeout(timeout);
                    if (this.activeTurnId === turnId) {
                        this.activeTurnId = null;
                    }
                    const abortError = new Error('Aborted');
                    abortError.name = 'AbortError';
                    reject(abortError);
                };
                waiter.cleanup = () => options.signal?.removeEventListener('abort', onAbort);
                if (options.signal.aborted) {
                    onAbort();
                    return;
                }
                options.signal.addEventListener('abort', onAbort, { once: true });
            }
        });
        return { turnId, completion };
    }

    async steerTurn(options: CodexAppServerSteerOptions): Promise<string> {
        await this.connect();
        const result = await this.request('turn/steer', {
            threadId: options.threadId,
            expectedTurnId: options.expectedTurnId,
            input: [{ type: 'text', text: options.prompt, text_elements: [] }],
        });
        const turnId = result?.turnId;
        if (typeof turnId !== 'string') {
            throw new Error('Codex app-server did not return a turn id for turn/steer.');
        }
        this.activeTurnId = turnId;
        return turnId;
    }

    async disconnect(): Promise<void> {
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
    }

    private request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
        if (!this.proc && !this.ws) {
            return Promise.reject(new Error('Codex app-server is not running.'));
        }
        const id = this.nextRequestId++;
        const payload = { method, id, params };
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(id);
                pending.cleanup?.();
                reject(new Error(`Timed out waiting for Codex app-server ${method}.`));
            }, DEFAULT_TIMEOUT);
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
                reject(error instanceof Error ? error : new Error(String(error)));
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
                throw new Error('Codex app-server websocket is not open.');
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
            logger.debug('[CodexAppServer] Ignoring non-json line:', line);
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
            logger.debug('[CodexAppServer] request handler failed:', error);
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
        logger.debug(`[CodexAppServer] notification ${method}: ${JSON.stringify(params)}`);
        switch (method) {
            case 'thread/started':
            case 'thread/status/changed':
                if (typeof params?.threadId === 'string') {
                    this.activeThreadId = params.threadId;
                    this.threadIdChangeHandler?.(params.threadId);
                } else if (typeof params?.thread?.id === 'string') {
                    this.activeThreadId = params.thread.id;
                    this.threadIdChangeHandler?.(params.thread.id);
                }
                return;
            case 'turn/started':
                this.handler?.({ type: 'task_started' });
                return;
            case 'turn/completed':
                this.completeTurn(params);
                this.handler?.({ type: 'task_complete' });
                return;
            case 'item/started':
                this.handleItemStarted(params?.item);
                return;
            case 'item/completed':
                this.handleItemCompleted(params?.item);
                return;
            case 'turn/diff/updated':
                if (typeof params?.diff === 'string') {
                    this.handler?.({ type: 'turn_diff', unified_diff: params.diff });
                }
                return;
            case 'error':
                this.handler?.({ type: 'agent_error', message: params?.message ?? 'Codex app-server error.' });
                return;
            default:
                return;
        }
    }

    private handleItemStarted(item: any): void {
        if (!item || typeof item !== 'object') return;
        if (item.type === 'commandExecution') {
            this.handler?.({ type: 'exec_command_begin', command: item.command });
        }
        if (item.type === 'fileChange') {
            this.handler?.({ type: 'patch_apply_begin', changes: {} });
        }
    }

    private handleItemCompleted(item: any): void {
        if (!item || typeof item !== 'object') return;
        if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text.length > 0) {
            this.handler?.({ type: 'agent_message', message: item.text });
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

    private completeTurn(params: any): void {
        const turnId = params?.turn?.id;
        if (typeof turnId !== 'string') return;
        const waiter = this.turnWaiters.get(turnId);
        const errorText = getTurnErrorText(params.turn);
        const response: CodexToolResponse = errorText
            ? { content: [{ type: 'text', text: errorText }], isError: true }
            : { content: [], isError: false };
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
        if (errorText) {
            waiter.resolve(response);
        } else {
            waiter.resolve(response);
        }
    }

    private rejectAll(error: Error): void {
        this.completedTurns.clear();
        this.activeTurnId = null;
        for (const [id, pending] of this.pendingRequests.entries()) {
            this.pendingRequests.delete(id);
            clearTimeout(pending.timeout);
            pending.cleanup?.();
            pending.reject(error);
        }
        for (const [turnId, waiter] of this.turnWaiters.entries()) {
            this.turnWaiters.delete(turnId);
            clearTimeout(waiter.timeout);
            waiter.cleanup?.();
            waiter.reject(error);
        }
    }
}
