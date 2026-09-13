import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '@/ui/logger';
import { redactSensitiveText } from '@/utils/redaction';
import { z } from 'zod';
import { buildAntigravityCommand, type AntigravityLaunchControls, type AntigravityNativeMode } from './antigravityCli';

const DEFAULT_COMMAND = 'agy';
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_INIT_TIMEOUT_MS = 10_000;
const MAX_NDJSON_LINE_BYTES = 256 * 1024;
const MAX_STDERR_BYTES = 32 * 1024;
const MAX_DIAGNOSTIC_BYTES = 2_000;

export const ANTIGRAVITY_STATUSES = ['SUCCESS', 'ERROR', 'CANCELED', 'INTERRUPTED', 'INVALID', 'WAITING', 'RUNNING'] as const;
export type AntigravityStatus = typeof ANTIGRAVITY_STATUSES[number];
export type AntigravityStreamMode = AntigravityNativeMode;

const StatusSchema = z.enum(ANTIGRAVITY_STATUSES);
const ConversationIdSchema = z.string().min(1).max(256);
const InitSchema = z.object({
    event: z.literal('init'),
    conversation_id: ConversationIdSchema,
    init: z.record(z.unknown()),
});
const StepUpdateSchema = z.object({
    event: z.literal('step_update'),
    step_update: z.object({
        conversation_id: ConversationIdSchema,
        step_index: z.number().int().nonnegative(),
        state: z.enum(['ACTIVE', 'DONE', 'ERROR']),
        step_type: z.string().min(1).max(128),
        text_delta: z.string().max(MAX_NDJSON_LINE_BYTES).optional(),
        tool_name: z.string().min(1).max(256).optional(),
        tool_info: z.record(z.unknown()).optional(),
    }).passthrough(),
});
const ResultSchema = z.object({
    event: z.literal('result'),
    result: z.object({
        conversation_id: ConversationIdSchema,
        status: StatusSchema,
        response: z.string().max(MAX_NDJSON_LINE_BYTES).default(''),
        error: z.string().max(MAX_NDJSON_LINE_BYTES).optional(),
    }).passthrough(),
});
const PromptContentSchema = z.union([
    z.string().max(MAX_NDJSON_LINE_BYTES),
    z.array(z.object({
        type: z.literal('text'),
        text: z.string().max(MAX_NDJSON_LINE_BYTES),
    }).strict()).min(1).max(1_024),
]);

export type AntigravityChild = Pick<ChildProcessWithoutNullStreams, 'stdin' | 'stdout' | 'stderr' | 'kill' | 'on' | 'once' | 'removeListener'> & {
    pid?: number;
    exitCode?: number | null;
    signalCode?: NodeJS.Signals | null;
};

export interface AntigravitySpawnOptions {
    cwd: string;
    detached: boolean;
    env: NodeJS.ProcessEnv;
    shell: false;
    stdio: ['pipe', 'pipe', 'pipe'];
    windowsHide: boolean;
}

export type AntigravitySpawn = (command: string, args: string[], options: AntigravitySpawnOptions) => AntigravityChild;

export interface AntigravityStreamClientOptions extends AntigravityLaunchControls {
    cwd: string;
    conversationId?: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high';
    command?: string;
    shutdownTimeoutMs?: number;
    initTimeoutMs?: number;
    platform?: NodeJS.Platform;
    spawn?: AntigravitySpawn;
    onEvent?: (event: AntigravityStreamEvent) => unknown;
    onStderr?: (diagnostic: string) => unknown;
}

export type AntigravityInitEvent = z.infer<typeof InitSchema>;
export type AntigravityStepUpdateEvent = z.infer<typeof StepUpdateSchema>;
export type AntigravityResultEvent = z.infer<typeof ResultSchema>;
export type AntigravityStreamEvent = AntigravityInitEvent | AntigravityStepUpdateEvent | AntigravityResultEvent;
export type AntigravityTurnResult = AntigravityResultEvent['result'];

export interface AntigravityUserMessage {
    event: 'user';
    message: { content: string | Array<{ type: 'text'; text: string }> };
}

interface ActiveTurn {
    resolve: (result: AntigravityTurnResult) => void;
    reject: (error: Error) => void;
}

export class AntigravityStreamClientError extends Error {
    constructor(message: string, readonly status: AntigravityStatus = 'INVALID') {
        super(message);
        this.name = 'AntigravityStreamClientError';
    }
}

function boundedDiagnostic(value: string): string {
    let diagnostic = Buffer.from(redactSensitiveText(value), 'utf8').subarray(0, MAX_DIAGNOSTIC_BYTES).toString('utf8');
    while (Buffer.byteLength(diagnostic, 'utf8') > MAX_DIAGNOSTIC_BYTES) diagnostic = diagnostic.slice(0, -1);
    return diagnostic;
}

function validateStringOption(name: string, value: string | undefined): void {
    if (value !== undefined && (value.trim() === '' || value.includes('\u0000'))) {
        throw new AntigravityStreamClientError(`${name} must be a non-empty string without NUL.`);
    }
}

function serializeUserMessage(content: unknown): string {
    let parsed: z.infer<typeof PromptContentSchema>;
    try {
        const result = PromptContentSchema.safeParse(content);
        if (!result.success) throw new AntigravityStreamClientError('Prompt content is invalid.');
        parsed = result.data;
    } catch (error) {
        if (error instanceof AntigravityStreamClientError) throw error;
        throw new AntigravityStreamClientError('Prompt content is invalid.');
    }

    let payload: string;
    try {
        const message: AntigravityUserMessage = { event: 'user', message: { content: parsed } };
        payload = `${JSON.stringify(message)}\n`;
    } catch {
        throw new AntigravityStreamClientError('Prompt content could not be serialized.');
    }
    if (Buffer.byteLength(payload, 'utf8') > MAX_NDJSON_LINE_BYTES) {
        throw new AntigravityStreamClientError('Prompt payload exceeded its byte bound.');
    }
    return payload;
}

function buildArgs(options: AntigravityStreamClientOptions): string[] {
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json'];
    if (options.conversationId !== undefined) args.push('--conversation', options.conversationId);
    if (options.model !== undefined) args.push('--model', options.model);
    if (options.effort !== undefined) args.push('--effort', options.effort);
    return args.concat(buildAntigravityCommand({
        mode: options.mode,
        dangerouslySkipPermissions: options.dangerouslySkipPermissions,
        sandbox: options.sandbox,
    }).args);
}

export function buildAntigravityStreamArgs(options: AntigravityStreamClientOptions): string[] {
    validateStringOption('conversationId', options.conversationId);
    validateStringOption('model', options.model);
    validateStringOption('effort', options.effort);
    validateStringOption('mode', options.mode);
    return buildArgs(options);
}

export class AntigravityStreamClient {
    private child: AntigravityChild | null = null;
    private conversationIdValue: string | null = null;
    private requestedConversationId: string | undefined;
    private initPromise: Promise<void> | null = null;
    private activeTurn: ActiveTurn | null = null;
    private stdoutBuffer = Buffer.alloc(0);
    private stderrPartial = Buffer.alloc(0);
    private stderrPartialTruncated = false;
    private stderrDiagnostics: string[] = [];
    private stderrDiagnosticBytes = 0;
    private stopped = false;
    private childExited = false;
    private childClosed = false;
    private fatalError: AntigravityStreamClientError | null = null;
    private initReject: ((error: Error) => void) | null = null;
    private initTimer: NodeJS.Timeout | null = null;
    private exitCloseTimer: NodeJS.Timeout | null = null;
    private exitDrainPromise: Promise<void> | null = null;
    private resolveExitDrain: (() => void) | null = null;
    private stoppingPromise: Promise<void> | null = null;
    private stdoutDataListener: ((chunk: Buffer | string) => void) | null = null;
    private stderrDataListener: ((chunk: Buffer | string) => void) | null = null;
    private childErrorListener: (() => void) | null = null;
    private childExitListener: (() => void) | null = null;
    private childCloseListener: (() => void) | null = null;
    private cancelInputWrite: ((error: Error) => void) | null = null;

    constructor(private readonly options: AntigravityStreamClientOptions) {}

    get conversationId(): string | null { return this.conversationIdValue; }

    get sessionId(): string | null { return this.conversationIdValue; }

    async start(resumeConversationId = this.options.conversationId): Promise<string> {
        if (this.child || this.stopped) throw new AntigravityStreamClientError('Antigravity stream client is already started.');
        const spawnOptions = { ...this.options, conversationId: resumeConversationId };
        this.requestedConversationId = resumeConversationId;
        const spawnProcess = this.options.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
        this.child = spawnProcess(this.options.command ?? DEFAULT_COMMAND, buildAntigravityStreamArgs(spawnOptions), {
            cwd: spawnOptions.cwd,
            detached: (this.options.platform ?? process.platform) !== 'win32',
            env: { ...process.env },
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        this.initPromise = new Promise<void>((resolve, reject) => {
            this.initReject = reject;
            const initTimeoutMs = this.options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
            if (!Number.isSafeInteger(initTimeoutMs) || initTimeoutMs <= 0) {
                reject(new AntigravityStreamClientError('Antigravity init timeout is invalid.'));
                return;
            }
            this.initTimer = setTimeout(() => {
                const error = new AntigravityStreamClientError('Antigravity init timed out.', 'INTERRUPTED');
                this.fail(error);
            }, initTimeoutMs);
            this.initTimer.unref?.();
            const onInit = (event: AntigravityStreamEvent) => {
                if (event.event !== 'init') return;
                if (this.requestedConversationId !== undefined && event.conversation_id !== this.requestedConversationId) {
                    this.fail(new AntigravityStreamClientError('Antigravity conversation_id does not match the requested resume conversation.'));
                    return;
                }
                this.clearInitTimer();
                this.conversationIdValue = event.conversation_id;
                this.initReject = null;
                this.initListener = null;
                resolve();
                this.invokeCallback('onEvent', this.options.onEvent, event);
            };
            this.initListener = onInit;
            if (this.fatalError) reject(this.fatalError);
        });
        this.attachChild(this.child);
        try {
            await this.initPromise;
            const terminal = this.getTerminalOutcome();
            if (terminal) await terminal;
            return this.conversationIdValue!;
        } catch (error) {
            const startError = error instanceof Error
                ? error
                : new AntigravityStreamClientError('Antigravity stream initialization failed.');
            try {
                await this.beginStopping(this.fatalError ?? startError);
            } catch (cleanupError) {
                throw this.normalizeCleanupError(cleanupError);
            }
            throw this.fatalError ?? startError;
        }
    }

    async resume(conversationId: string): Promise<string> {
        if (conversationId.trim() === '') throw new AntigravityStreamClientError('conversationId must be a non-empty string.');
        return this.start(conversationId);
    }

    async prompt(content: string | Array<{ type: 'text'; text: string }>): Promise<AntigravityTurnResult> {
        const payload = serializeUserMessage(content);
        let terminal = this.getTerminalOutcome();
        if (terminal) await terminal;
        if (!this.child || !this.initPromise) throw new AntigravityStreamClientError('Antigravity stream client is not started.');
        await this.initPromise;
        terminal = this.getTerminalOutcome();
        if (terminal) await terminal;
        if (this.activeTurn) throw new AntigravityStreamClientError('An Antigravity turn is already active.', 'RUNNING');
        const turn = new Promise<AntigravityTurnResult>((resolve, reject) => {
            this.activeTurn = { resolve, reject };
        });
        void this.writeInput(payload).catch(() => {
            if (!this.stopped) this.fail(new AntigravityStreamClientError('Failed to write the Antigravity prompt.'));
        });
        return turn;
    }

    async sendTurn(content: string | Array<{ type: 'text'; text: string }>): Promise<AntigravityTurnResult> {
        return this.prompt(content);
    }

    async cancel(): Promise<void> {
        const turn = this.activeTurn;
        if (turn) this.activeTurn = null;
        try {
            await this.stop();
        } catch (error) {
            const cleanupError = this.normalizeCleanupError(error);
            turn?.reject(cleanupError);
            throw cleanupError;
        }
        if (this.fatalError) {
            turn?.reject(this.fatalError);
            throw this.fatalError;
        }
        turn?.resolve({ conversation_id: this.conversationIdValue ?? 'unknown', status: 'CANCELED', response: '' });
    }

    async abort(): Promise<void> {
        return this.cancel();
    }

    async stop(): Promise<void> {
        const stopError = new AntigravityStreamClientError('Antigravity stream client was stopped.', 'CANCELED');
        return this.beginStopping(stopError);
    }

    private beginStopping(pendingError: Error): Promise<void> {
        if (this.stoppingPromise) return this.stoppingPromise;
        this.stopped = true;
        this.clearInitTimer();
        this.finishExitDrain();
        this.cancelInputWrite?.(pendingError);
        const cleanup = this.performStop();
        this.stoppingPromise = cleanup;
        void cleanup.then(
            () => this.settlePending(this.fatalError ?? pendingError),
            (error: unknown) => {
                const cleanupError = this.normalizeCleanupError(error);
                this.fatalError = cleanupError;
                this.settlePending(cleanupError);
            },
        );
        return cleanup;
    }

    private async performStop(): Promise<void> {
        const child = this.child;
        if (!child) return;
        this.detachStdoutListener(child);
        try { child.stdin.end(); } catch { /* input already closed */ }
        if (this.childClosed) {
            this.drainStderr(true);
            this.detachChildListeners(child);
            return;
        }
        const timeoutMs = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
        if (await this.waitForClose(child, timeoutMs)) return;
        if ((this.options.platform ?? process.platform) === 'win32') {
            const closeAfterFallback = this.waitForClose(child, timeoutMs);
            this.signalChild(child, 'SIGKILL');
            if (await closeAfterFallback) return;
            this.finishUnconfirmedCleanup(child);
            throw new AntigravityStreamClientError('Antigravity Windows process did not confirm close.', 'INTERRUPTED');
        }
        const closeAfterTerm = this.waitForClose(child, timeoutMs);
        this.signal(child, 'SIGTERM');
        if (await closeAfterTerm) return;
        const closeAfterKill = this.waitForClose(child, timeoutMs);
        this.signal(child, 'SIGKILL');
        if (await closeAfterKill) return;
        this.finishUnconfirmedCleanup(child);
        throw new AntigravityStreamClientError('Antigravity process did not exit after SIGKILL.', 'INTERRUPTED');
    }

    async dispose(): Promise<void> {
        return this.stop();
    }

    private initListener: ((event: AntigravityStreamEvent) => void) | null = null;

    private attachChild(child: AntigravityChild): void {
        this.stdoutDataListener = (chunk) => this.consumeStdout(Buffer.from(chunk));
        this.stderrDataListener = (chunk) => this.consumeStderr(Buffer.from(chunk));
        this.childErrorListener = () => {
            if (!this.stopped) this.fail(new AntigravityStreamClientError('Antigravity process failed.'));
        };
        this.childExitListener = () => {
            this.childExited = true;
            if (!this.stopped && !this.childClosed) this.startExitDrain();
        };
        this.childCloseListener = () => {
            this.childClosed = true;
            this.finishExitDrain();
            this.drainStderr(true);
            this.detachChildListeners(child);
            if (this.stopped) return;
            this.fail(new AntigravityStreamClientError(
                this.activeTurn ? 'Antigravity process exited before the turn completed.' : 'Antigravity process exited unexpectedly.',
                'INTERRUPTED',
            ));
        };
        child.stdout.on('data', this.stdoutDataListener);
        child.stderr.on('data', this.stderrDataListener);
        child.once('error', this.childErrorListener);
        child.once('exit', this.childExitListener);
        child.once('close', this.childCloseListener);
    }

    private consumeStdout(chunk: Buffer): void {
        let offset = 0;
        while (offset < chunk.length) {
            const newline = chunk.indexOf(0x0a, offset);
            const end = newline < 0 ? chunk.length : newline;
            const part = chunk.subarray(offset, end);
            if (this.stdoutBuffer.length + part.length > MAX_NDJSON_LINE_BYTES) {
                this.fail(new AntigravityStreamClientError('Antigravity NDJSON line exceeded its byte bound.'));
                return;
            }
            if (part.length > 0) this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, part]);
            if (newline < 0) return;
            const lineBuffer = this.stdoutBuffer.length > 0 && this.stdoutBuffer[this.stdoutBuffer.length - 1] === 0x0d
                ? this.stdoutBuffer.subarray(0, this.stdoutBuffer.length - 1)
                : this.stdoutBuffer;
            this.stdoutBuffer = Buffer.alloc(0);
            this.consumeLine(lineBuffer.toString('utf8'));
            if (this.fatalError) return;
            offset = newline + 1;
        }
    }

    private consumeLine(line: string): void {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { this.fail(new AntigravityStreamClientError('Antigravity emitted malformed NDJSON.')); return; }
        if (typeof parsed !== 'object' || parsed === null || !('event' in parsed)) { this.fail(new AntigravityStreamClientError('Antigravity emitted an invalid stream event.')); return; }
        const eventName = (parsed as { event?: unknown }).event;
        const result = eventName === 'init' ? InitSchema.safeParse(parsed) : eventName === 'step_update' ? StepUpdateSchema.safeParse(parsed) : eventName === 'result' ? ResultSchema.safeParse(parsed) : null;
        if (result === null) {
            logger.debug('[AntigravityStreamClient] ignored unsupported stream event', boundedDiagnostic(String(eventName)));
            return;
        }
        if (!result.success) { this.fail(new AntigravityStreamClientError('Antigravity emitted an invalid known stream event.')); return; }
        const event = result.data;
        if (event.event === 'init') {
            if (this.conversationIdValue !== null) { this.fail(new AntigravityStreamClientError('Antigravity emitted duplicate init.')); return; }
            this.initListener?.(event);
            return;
        }
        if (this.conversationIdValue === null || event.event === 'step_update' && event.step_update.conversation_id !== this.conversationIdValue || event.event === 'result' && event.result.conversation_id !== this.conversationIdValue) {
            this.fail(new AntigravityStreamClientError('Antigravity emitted a foreign conversation_id.')); return;
        }
        if (!this.activeTurn) {
            this.fail(new AntigravityStreamClientError(`Antigravity emitted ${event.event} without an active turn.`)); return;
        }
        if (event.event === 'result') {
            const turn = this.activeTurn;
            this.activeTurn = null;
            this.drainStderr(false);
            turn.resolve(event.result);
            this.invokeCallback('onEvent', this.options.onEvent, event);
            return;
        }
        this.invokeCallback('onEvent', this.options.onEvent, event);
    }

    private consumeStderr(chunk: Buffer): void {
        let offset = 0;
        while (offset < chunk.length) {
            const newline = chunk.indexOf(0x0a, offset);
            const end = newline < 0 ? chunk.length : newline;
            this.appendStderrPartial(chunk.subarray(offset, end));
            if (newline < 0) return;
            this.completeStderrLine();
            offset = newline + 1;
        }
    }

    private appendStderrPartial(part: Buffer): void {
        if (part.length === 0 || this.stderrPartialTruncated) return;
        const remaining = MAX_STDERR_BYTES - this.stderrPartial.length;
        if (remaining <= 0) {
            this.stderrPartialTruncated = true;
            return;
        }
        const accepted = part.subarray(0, remaining);
        this.stderrPartial = Buffer.concat([this.stderrPartial, accepted]);
        if (accepted.length < part.length) this.stderrPartialTruncated = true;
    }

    private completeStderrLine(): void {
        const endsWithCarriageReturn = this.stderrPartial.length > 0
            && this.stderrPartial[this.stderrPartial.length - 1] === 0x0d;
        const line = (endsWithCarriageReturn
            ? this.stderrPartial.subarray(0, this.stderrPartial.length - 1)
            : this.stderrPartial).toString('utf8');
        this.queueStderrDiagnostic(this.stderrPartialTruncated ? `${line}\n[truncated]` : line);
        this.clearStderrPartial();
    }

    private queueStderrDiagnostic(raw: string): void {
        const diagnostic = boundedDiagnostic(raw);
        if (!diagnostic) return;
        const diagnosticBytes = Buffer.byteLength(diagnostic, 'utf8');
        while (this.stderrDiagnostics.length > 0
            && this.stderrDiagnosticBytes + diagnosticBytes > MAX_STDERR_BYTES) {
            const evicted = this.stderrDiagnostics.shift();
            if (evicted) this.stderrDiagnosticBytes -= Buffer.byteLength(evicted, 'utf8');
        }
        this.stderrDiagnostics.push(diagnostic);
        this.stderrDiagnosticBytes += diagnosticBytes;
    }

    private drainStderr(flushPartial = false): void {
        if (flushPartial && (this.stderrPartial.length > 0 || this.stderrPartialTruncated)) {
            this.completeStderrLine();
        }
        if (this.stderrDiagnostics.length === 0) return;
        const diagnostics = this.stderrDiagnostics;
        this.stderrDiagnostics = [];
        this.stderrDiagnosticBytes = 0;
        for (const diagnostic of diagnostics) {
            logger.debug('[AntigravityStreamClient][stderr]', diagnostic);
            this.invokeCallback('onStderr', this.options.onStderr, diagnostic);
        }
    }

    private clearStderrPartial(): void {
        this.stderrPartial.fill(0);
        this.stderrPartial = Buffer.alloc(0);
        this.stderrPartialTruncated = false;
    }

    private fail(error: AntigravityStreamClientError): AntigravityStreamClientError {
        if (!this.fatalError) this.fatalError = error;
        const failure = this.fatalError;
        void this.beginStopping(failure).catch(() => undefined);
        return failure;
    }

    private settlePending(error: Error): void {
        this.rejectInit(error);
        this.rejectActive(error);
    }

    private rejectInit(error: Error): void {
        this.clearInitTimer();
        const reject = this.initReject;
        this.initReject = null;
        this.initListener = null;
        reject?.(error);
    }

    private clearInitTimer(): void {
        if (!this.initTimer) return;
        clearTimeout(this.initTimer);
        this.initTimer = null;
    }

    private startExitDrain(): void {
        if (this.exitDrainPromise) return;
        this.exitDrainPromise = new Promise<void>((resolve) => {
            this.resolveExitDrain = resolve;
        });
        const timeoutMs = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
        this.exitCloseTimer = setTimeout(() => {
            this.exitCloseTimer = null;
            const error = new AntigravityStreamClientError(
                this.activeTurn ? 'Antigravity process exited before the turn completed.' : 'Antigravity process exited unexpectedly.',
                'INTERRUPTED',
            );
            this.finishExitDrain();
            this.fail(error);
        }, timeoutMs);
        this.exitCloseTimer.unref?.();
    }

    private finishExitDrain(): void {
        if (this.exitCloseTimer) clearTimeout(this.exitCloseTimer);
        this.exitCloseTimer = null;
        const resolve = this.resolveExitDrain;
        this.resolveExitDrain = null;
        this.exitDrainPromise = null;
        resolve?.();
    }

    private getTerminalOutcome(): Promise<never> | null {
        if (this.childExited && !this.childClosed && this.exitDrainPromise) return this.awaitTerminalOutcome();
        if (this.stopped || this.fatalError) return this.awaitTerminalOutcome();
        return null;
    }

    private async awaitTerminalOutcome(): Promise<never> {
        const exitDrain = this.exitDrainPromise;
        if (this.childExited && !this.childClosed && exitDrain) await exitDrain;
        const cleanup = this.stoppingPromise;
        if (cleanup) {
            try {
                await cleanup;
            } catch (error) {
                throw this.normalizeCleanupError(error);
            }
        }
        if (this.fatalError) throw this.fatalError;
        throw new AntigravityStreamClientError('Antigravity stream client is stopped.', 'CANCELED');
    }

    private normalizeCleanupError(error: unknown): AntigravityStreamClientError {
        return error instanceof AntigravityStreamClientError
            ? error
            : new AntigravityStreamClientError('Antigravity cleanup failed.', 'INTERRUPTED');
    }

    private rejectActive(error: Error): void {
        if (!this.activeTurn) return;
        const turn = this.activeTurn;
        this.activeTurn = null;
        turn.reject(error);
    }

    private waitForClose(child: AntigravityChild, timeoutMs: number): Promise<boolean> {
        if (this.childClosed) return Promise.resolve(true);
        return new Promise((resolve) => {
            const timer = setTimeout(() => { cleanup(); resolve(this.childClosed); }, timeoutMs);
            const onClose = () => {
                this.childClosed = true;
                cleanup();
                resolve(true);
            };
            const cleanup = () => { clearTimeout(timer); child.removeListener('close', onClose); };
            child.once('close', onClose);
        });
    }

    private signal(child: AntigravityChild, signal: NodeJS.Signals): void {
        if ((this.options.platform ?? process.platform) !== 'win32' && child.pid !== undefined && child.pid > 0) {
            try {
                process.kill(-child.pid, signal);
                return;
            } catch (error) {
                logger.debug('[AntigravityStreamClient] process group signal failed', boundedDiagnostic(error instanceof Error ? error.message : String(error)));
            }
        }
        this.signalChild(child, signal);
    }

    private signalChild(child: AntigravityChild, signal: NodeJS.Signals): void {
        try { child.kill(signal); } catch (error) { logger.debug('[AntigravityStreamClient] cleanup signal failed', boundedDiagnostic(error instanceof Error ? error.message : String(error))); }
    }

    private detachChildListeners(child: AntigravityChild): void {
        this.detachStdoutListener(child);
        if (this.stderrDataListener) child.stderr.removeListener('data', this.stderrDataListener);
        if (this.childErrorListener) child.removeListener('error', this.childErrorListener);
        if (this.childExitListener) child.removeListener('exit', this.childExitListener);
        if (this.childCloseListener) child.removeListener('close', this.childCloseListener);
        this.stdoutDataListener = null;
        this.stderrDataListener = null;
        this.childErrorListener = null;
        this.childExitListener = null;
        this.childCloseListener = null;
    }

    private detachStdoutListener(child: AntigravityChild): void {
        if (!this.stdoutDataListener) return;
        child.stdout.removeListener('data', this.stdoutDataListener);
        this.stdoutDataListener = null;
    }

    private finishUnconfirmedCleanup(child: AntigravityChild): void {
        this.drainStderr(true);
        this.detachChildListeners(child);
    }

    private invokeCallback<T>(name: 'onEvent' | 'onStderr', callback: ((value: T) => unknown) | undefined, value: T): void {
        if (!callback) return;
        try {
            void Promise.resolve(callback(value)).catch(() => {
                logger.debug('[AntigravityStreamClient] callback rejected', { callback: name });
            });
        } catch {
            logger.debug('[AntigravityStreamClient] callback threw', { callback: name });
        }
    }

    private writeInput(payload: string): Promise<void> {
        const child = this.child;
        if (!child || this.stopped) return Promise.reject(new AntigravityStreamClientError('Antigravity input is closed.', 'CANCELED'));
        return new Promise((resolve, reject) => {
            let callbackDone = false;
            let needsDrain: boolean | null = null;
            let drained = false;
            let settled = false;
            const cleanup = (): void => {
                child.stdin.removeListener('drain', onDrain);
                child.stdin.removeListener('error', onError);
                child.stdin.removeListener('close', onClose);
                if (this.cancelInputWrite === cancelWrite) this.cancelInputWrite = null;
            };
            const finish = (error?: Error): void => {
                if (settled) return;
                if (!error && (!callbackDone || needsDrain === null || needsDrain && !drained)) return;
                settled = true;
                cleanup();
                if (error) reject(error); else resolve();
            };
            const onDrain = (): void => { drained = true; finish(); };
            const onError = (): void => finish(new AntigravityStreamClientError('Antigravity stdin failed.'));
            const onClose = (): void => finish(new AntigravityStreamClientError('Antigravity stdin closed before write completed.', 'INTERRUPTED'));
            const cancelWrite = (error: Error): void => finish(error);
            this.cancelInputWrite = cancelWrite;
            child.stdin.once('error', onError);
            child.stdin.once('close', onClose);
            try {
                const accepted = child.stdin.write(payload, (error) => {
                    if (error) { finish(new AntigravityStreamClientError('Antigravity stdin write failed.')); return; }
                    callbackDone = true;
                    finish();
                });
                needsDrain = !accepted;
                drained = accepted;
                if (!accepted) child.stdin.once('drain', onDrain);
                finish();
            } catch {
                finish(new AntigravityStreamClientError('Antigravity stdin write failed.'));
            }
        });
    }

}
