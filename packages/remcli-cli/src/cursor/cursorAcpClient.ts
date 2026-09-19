import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
    ClientSideConnection,
    ndJsonStream,
    type Agent,
    type Client,
    type InitializeResponse,
    type McpServer,
    type PermissionOption,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
    type SessionModeState,
    type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { logger } from '@/ui/logger';
import { redactSensitiveText } from '@/utils/redaction';

const CURSOR_COMMAND = 'agent';
const CURSOR_ARGS = ['acp'];
const SHUTDOWN_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 30_000;
const SAFE_ERROR = 'Cursor ACP session failed.';

export type CursorMode = 'agent' | 'plan' | 'ask';
export type CursorPermissionDecision = 'allow_once' | 'allow_always' | 'reject_once';

export interface CursorAcpCallbacks {
    onSessionUpdate?: (notification: SessionNotification) => void | Promise<void>;
    onNotification?: (method: string, params: unknown) => void;
    onPermission?: (request: RequestPermissionRequest) => Promise<CursorPermissionDecision>;
    onExtension?: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
    onError?: (error: Error) => void;
}

export interface CursorAcpClientOptions extends CursorAcpCallbacks {
    cwd: string;
    mode?: CursorMode;
    model?: string;
    resumeSessionId?: string;
    mcpServers?: McpServer[];
    command?: string;
    args?: string[];
    spawn?: CursorSpawn;
    connectionFactory?: CursorConnectionFactory;
    shutdownTimeoutMs?: number;
    requestTimeoutMs?: number;
}

export interface CursorChild {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    kill(signal?: NodeJS.Signals): boolean;
    once(event: 'error' | 'exit', listener: (...args: unknown[]) => void): this;
    on(event: 'error' | 'exit', listener: (...args: unknown[]) => void): this;
    readonly exitCode?: number | null;
    readonly signalCode?: NodeJS.Signals | null;
    readonly pid?: number;
}

export type CursorSpawn = (command: string, args: string[], options: {
    cwd: string;
    detached: boolean;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
    windowsHide: boolean;
}) => CursorChild;

export interface CursorConnection {
    initialize(params: { protocolVersion: 1; clientCapabilities: { fs: { readTextFile: false; writeTextFile: false } }; clientInfo: { name: string; version: string } }): Promise<InitializeResponse>;
    authenticate(params: { methodId: string }): Promise<unknown>;
    newSession(params: { cwd: string; mcpServers: McpServer[] }): Promise<CursorSessionResponse>;
    loadSession(params: { cwd: string; mcpServers: McpServer[]; sessionId: string }): Promise<CursorLoadedSessionResponse>;
    setSessionMode(params: { sessionId: string; modeId: string }): Promise<unknown>;
    setSessionModel(params: { sessionId: string; modelId: string }): Promise<unknown>;
    prompt(params: { sessionId: string; prompt: Array<{ type: 'text'; text: string }> }): Promise<{ stopReason: string }>;
    cancel(params: { sessionId: string }): Promise<void>;
    readonly closed?: Promise<void>;
}

export interface CursorSessionModel {
    modelId: string;
    name: string;
}

/** Cursor-specific model selector retained as an ACP extension. */
export interface CursorSessionModelState {
    availableModels: CursorSessionModel[];
    currentModelId: string;
}

export type CursorConnectionFactory = (child: CursorChild, callbacks: Client) => CursorConnection;

export interface CursorSessionResponse {
    sessionId: string;
    modes?: SessionModeState | null;
    models?: CursorSessionModelState | null;
}

export type CursorLoadedSessionResponse = Omit<CursorSessionResponse, 'sessionId'>;

export interface CursorAcpSession {
    sessionId: string;
    modes: SessionModeState;
    models?: CursorSessionModelState;
}

function safeError(error: unknown): Error {
    const message = error instanceof Error ? redactSensitiveText(error.message) : '';
    logger.debug('[Cursor ACP] operation failed', { hasProviderMessage: Boolean(message) });
    return new Error(SAFE_ERROR);
}

async function withRequestTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cursor ACP request timed out.')), timeoutMs);
        timer.unref?.();
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function fallbackModeState(mode: CursorMode): SessionModeState {
    const name = mode === 'agent' ? 'Agent' : mode === 'plan' ? 'Plan' : 'Ask';
    return { availableModes: [{ id: mode, name }], currentModeId: mode };
}

function fallbackModelState(model: string): CursorSessionModelState {
    return {
        availableModels: [{ modelId: model, name: model }],
        currentModelId: model,
    };
}

function streamsToSdk(child: CursorChild): { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> } {
    const writable = new WritableStream<Uint8Array>({
        write(chunk) {
            return new Promise<void>((resolve, reject) => {
                child.stdin.write(chunk, (error) => error ? reject(error) : resolve());
            });
        },
        close() { child.stdin.end(); },
        abort(reason) { child.stdin.destroy(reason instanceof Error ? reason : undefined); },
    });
    const readable = new ReadableStream<Uint8Array>({
        start(controller) {
            child.stdout.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            child.stdout.once('end', () => controller.close());
            child.stdout.once('error', (error) => controller.error(error));
        },
        cancel() { child.stdout.destroy(); },
    });
    return { writable, readable };
}

function defaultConnectionFactory(child: CursorChild, callbacks: Client): CursorConnection {
    const { writable, readable } = streamsToSdk(child);
    const stream = ndJsonStream(writable, readable);
    const connection = new ClientSideConnection((_agent: Agent) => callbacks, stream);
    return {
        initialize: (params) => connection.initialize(params),
        authenticate: (params) => connection.authenticate(params),
        newSession: (params) => connection.newSession(params) as Promise<CursorSessionResponse>,
        loadSession: (params) => connection.loadSession(params) as Promise<CursorLoadedSessionResponse>,
        setSessionMode: (params) => connection.setSessionMode(params),
        setSessionModel: (params) => connection.extMethod('session/set_model', params),
        prompt: (params) => connection.prompt(params),
        cancel: (params) => connection.cancel(params),
        closed: connection.closed,
    };
}

export class CursorAcpClient {
    private child: CursorChild | null = null;
    private connection: CursorConnection | null = null;
    private sessionId: string | null = null;
    private activePrompt: Promise<{ stopReason: string }> | null = null;
    private disposed = false;
    private crashError: Error | null = null;
    private sessionState: CursorSessionResponse | null = null;
    private crashReject: ((error: Error) => void) | null = null;
    private activePromptAbort: AbortController | null = null;

    constructor(private readonly options: CursorAcpClientOptions) {}

    async start(): Promise<CursorAcpSession> {
        if (this.disposed || this.child) throw new Error('Cursor ACP client is already started.');
        const spawnProcess = this.options.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
        this.child = spawnProcess(this.options.command ?? CURSOR_COMMAND, this.options.args ?? CURSOR_ARGS, {
            cwd: this.options.cwd,
            detached: process.platform !== 'win32',
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.child.stderr.on('data', () => logger.debug('[Cursor ACP] provider stderr received'));
        this.child.once('error', () => this.handleCrash());
        this.child.once('exit', () => this.handleCrash());

        const client: Client = {
            sessionUpdate: async (notification) => this.options.onSessionUpdate?.(notification),
            requestPermission: (request) => this.requestPermission(request),
            extMethod: (method, params) => this.handleExtension(method, params),
            extNotification: async (method, params) => {
                this.options.onNotification?.(method, params);
            },
        };
        this.connection = (this.options.connectionFactory ?? defaultConnectionFactory)(this.child, client);

        try {
            const init = await this.request(this.connection.initialize({
                protocolVersion: 1,
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
                clientInfo: { name: 'remcli-cursor', version: '1' },
            }));
            if (init.protocolVersion !== 1) throw new Error('Unsupported protocol version.');
            const auth = init.authMethods ?? [];
            if (auth.some((method) => method.id === 'cursor_login')) {
                await this.request(this.connection.authenticate({ methodId: 'cursor_login' }));
            }
            if (this.options.resumeSessionId) {
                if (init.agentCapabilities?.loadSession !== true) throw new Error('Cursor session loading is unavailable.');
                const loaded = await this.request(this.connection.loadSession({
                    cwd: this.options.cwd,
                    mcpServers: this.options.mcpServers ?? [],
                    sessionId: this.options.resumeSessionId,
                }));
                this.sessionState = {
                    sessionId: this.options.resumeSessionId,
                    ...loaded,
                    modes: loaded.modes ?? (this.options.mode ? fallbackModeState(this.options.mode) : undefined),
                    models: loaded.models ?? (this.options.model ? fallbackModelState(this.options.model) : undefined),
                };
                this.sessionId = this.sessionState.sessionId;
            } else {
                this.sessionState = await this.request(this.connection.newSession({
                    cwd: this.options.cwd,
                    mcpServers: this.options.mcpServers ?? [],
                }));
                this.sessionId = this.sessionState.sessionId;
            }
            const session = await this.readSessionState();
            if (!session.modes) {
                throw new Error('Cursor ACP did not return selectable mode capabilities.');
            }
            if (this.options.mode
                && !session.modes.availableModes.some((candidate) => candidate.id === this.options.mode)) {
                throw new Error('Requested Cursor mode is unavailable.');
            }
            if (this.options.model
                && !session.models?.availableModels.some((candidate) => candidate.modelId === this.options.model)) {
                throw new Error('Requested Cursor model is unavailable.');
            }
            if (this.options.mode) await this.setMode(this.options.mode);
            if (this.options.model) await this.setModel(this.options.model);
            return {
                sessionId: this.sessionId,
                modes: session.modes,
                ...(session.models ? { models: session.models } : {}),
            };
        } catch (error) {
            await this.dispose();
            const safe = safeError(error);
            this.options.onError?.(safe);
            throw safe;
        }
    }

    async setMode(mode: CursorMode): Promise<void> {
        const session = await this.readSessionState();
        if (!session.modes?.availableModes.some((candidate) => candidate.id === mode)) {
            throw new Error('Requested Cursor mode is unavailable.');
        }
        await this.request(this.connection!.setSessionMode({ sessionId: this.sessionId!, modeId: mode }));
        session.modes.currentModeId = mode;
    }

    async setModel(model: string): Promise<void> {
        const session = await this.readSessionState();
        if (session.models
            && !session.models.availableModels.some((candidate) => candidate.modelId === model)) {
            throw new Error('Requested Cursor model is unavailable.');
        }
        if (this.activePrompt) throw new Error('Cursor ACP model cannot change during an active prompt.');
        await this.request(this.connection!.setSessionModel({ sessionId: this.sessionId!, modelId: model }));
        session.models ??= fallbackModelState(model);
        session.models.currentModelId = model;
    }

    async prompt(text: string, abort?: AbortSignal): Promise<{ stopReason: string }> {
        if (!this.connection || !this.sessionId || this.disposed) throw new Error('Cursor ACP session is unavailable.');
        if (this.activePrompt) throw new Error('Cursor ACP prompt is already active.');
        this.activePromptAbort = new AbortController();
        const prompt = this.connection.prompt({ sessionId: this.sessionId, prompt: [{ type: 'text', text }] });
        const crash = new Promise<never>((_, reject) => { this.crashReject = reject; });
        const activePrompt = Promise.race([prompt, crash]);
        this.activePrompt = activePrompt;
        const handleAbort = () => { void this.cancel(); };
        if (abort?.aborted) handleAbort();
        else abort?.addEventListener('abort', handleAbort, { once: true });
        try { return await activePrompt; } catch (error) {
            const safe = this.crashError ?? safeError(error);
            if (!this.crashError) this.options.onError?.(safe);
            throw safe;
        } finally {
            abort?.removeEventListener('abort', handleAbort);
            this.activePrompt = null;
            this.crashReject = null;
            this.activePromptAbort = null;
        }
    }

    async cancel(): Promise<void> {
        this.activePromptAbort?.abort();
        if (this.connection && this.sessionId && this.activePrompt) {
            await this.request(this.connection.cancel({ sessionId: this.sessionId }));
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        const child = this.child;
        this.child = null;
        if (!child) return;
        this.activePromptAbort?.abort();
        terminateChild(child, 'SIGTERM');
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => { terminateChild(child, 'SIGKILL'); resolve(); }, this.options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
    }

    private async readSessionState(): Promise<CursorSessionResponse> {
        if (!this.connection || !this.sessionId) throw new Error('Cursor ACP session is unavailable.');
        if (!this.sessionState) throw new Error('Cursor session capabilities were not returned.');
        return this.sessionState;
    }

    private request<T>(operation: Promise<T>): Promise<T> {
        return withRequestTimeout(operation, this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    }

    private async requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        if (!this.options.onPermission) return { outcome: { outcome: 'cancelled' } };
        let decision: CursorPermissionDecision | 'cancelled';
        try {
            const signal = this.activePromptAbort?.signal;
            decision = await Promise.race([
                this.options.onPermission(request),
                new Promise<'cancelled'>((resolve) => {
                    if (!signal) return;
                    if (signal.aborted) resolve('cancelled');
                    else signal.addEventListener('abort', () => resolve('cancelled'), { once: true });
                }),
            ]);
        } catch (error) {
            logger.debug('[Cursor ACP] permission delegate failed', { hasProviderMessage: Boolean(error) });
            return { outcome: { outcome: 'cancelled' } };
        }
        if (decision === 'cancelled') return { outcome: { outcome: 'cancelled' } };
        const option = request.options.find((candidate: PermissionOption) => candidate.kind === decision);
        if (!option) return { outcome: { outcome: 'cancelled' } };
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
    }

    private async handleExtension(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
        if (method === 'cursor/ask_question' || method === 'cursor/create_plan') {
            if (!this.options.onExtension) return { outcome: { outcome: 'cancelled' } };
            try {
                return await this.options.onExtension(method, params);
            } catch (error) {
                logger.debug('[Cursor ACP] extension delegate failed', { method, hasProviderMessage: Boolean(error) });
                return { outcome: { outcome: 'cancelled' } };
            }
        }
        return { outcome: { outcome: 'cancelled' } };
    }

    private handleCrash(): void {
        if (this.disposed || this.crashError) return;
        this.crashError = new Error('Cursor ACP process exited unexpectedly.');
        this.crashReject?.(this.crashError);
        this.options.onError?.(this.crashError);
    }
}

function terminateChild(child: CursorChild, signal: NodeJS.Signals): void {
    try {
        if (process.platform !== 'win32' && child.pid) {
            process.kill(-child.pid, signal);
            return;
        }
    } catch {
        // Fall back to the direct child if the process group already exited.
    }
    try {
        child.kill(signal);
    } catch {
        // The child already exited.
    }
}

export function createCursorAcpConnectionFactory(): CursorConnectionFactory {
    return defaultConnectionFactory;
}

export type { SessionUpdate };
