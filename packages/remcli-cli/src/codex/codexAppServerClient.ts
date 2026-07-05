import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

import { logger } from '@/ui/logger';
import type { CodexApprovalPolicy, CodexSandbox, CodexToolResponse } from './types';
import { CodexPermissionHandler, type PermissionResult } from './utils/permissionHandler';

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000;

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

export class CodexAppServerClient {
    private proc: ChildProcessWithoutNullStreams | null = null;
    private rl: readline.Interface | null = null;
    private connected = false;
    private nextRequestId = 1;
    private pendingRequests = new Map<JsonRpcId, PendingRequest>();
    private turnWaiters = new Map<string, TurnWaiter>();
    private completedTurns = new Map<string, CodexToolResponse>();
    private handler: ((event: any) => void) | null = null;
    private threadIdChangeHandler: ((threadId: string) => void) | null = null;
    private permissionHandler: CodexPermissionHandler | null = null;
    private activeThreadId: string | null = null;

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

        logger.debug('[CodexAppServer] Starting codex app-server');
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
        logger.debug('[CodexAppServer] Connected');
    }

    async resumeThread(options: CodexAppServerResumeOptions): Promise<void> {
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
        }
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
            return { content: [], isError: false };
        }

        const completedTurn = this.completedTurns.get(turnId);
        if (completedTurn) {
            this.completedTurns.delete(turnId);
            return completedTurn;
        }

        return new Promise<CodexToolResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.turnWaiters.delete(turnId);
                waiter.cleanup?.();
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

    clearSession(): void {
        this.activeThreadId = null;
    }

    private request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
        if (!this.proc) {
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
            this.proc?.stdin.write(`${JSON.stringify(payload)}\n`);
        });
    }

    private notify(method: string, params: unknown): void {
        this.proc?.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }

    private respond(id: JsonRpcId, result: unknown): void {
        this.proc?.stdin.write(`${JSON.stringify({ id, result })}\n`);
    }

    private respondError(id: JsonRpcId, code: number, message: string): void {
        this.proc?.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
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
            return;
        }
        this.turnWaiters.delete(turnId);
        clearTimeout(waiter.timeout);
        waiter.cleanup?.();
        if (errorText) {
            waiter.resolve(response);
        } else {
            waiter.resolve(response);
        }
    }

    private rejectAll(error: Error): void {
        this.completedTurns.clear();
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
