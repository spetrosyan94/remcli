import { logger } from '@/ui/logger'
import { EventEmitter } from 'node:events'
import { io, Socket } from 'socket.io-client'
import { AgentState, ClientToServerEvents, DeliveredUserMessage, MessageContent, Metadata, RetryableUserMessageDeliveryError, ServerToClientEvents, Session, Update, UserMessageSchema, Usage } from './types'
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import { backoff } from '@/utils/time';
import { getEffectiveServerUrl } from '@/daemon/p2p/p2pSession';
import { getSessionRunnerCredential, SESSION_MESSAGE_ACK_VERSION } from '@/daemon/p2p/p2pRunnerCredentials';
import { RawJSONLines } from '@/claude/types';
import { randomUUID } from 'node:crypto';
import { AsyncLock } from '@/utils/lock';
import { RpcHandlerManager } from './rpc/RpcHandlerManager';
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers';
import { calculateCost } from '@/utils/pricing';

/**
 * ACP (Agent Communication Protocol) message data types.
 * This is the unified format for all agent messages - CLI adapts each provider's format to ACP.
 */
export type ACPMessageData =
    // Core message types
    | { type: 'message'; message: string; isError?: boolean }
    | { type: 'reasoning'; message: string }
    | { type: 'thinking'; text: string }
    // Tool interactions
    | { type: 'tool-call'; callId: string; name: string; input: unknown; id: string }
    | { type: 'tool-result'; callId: string; output: unknown; id: string; isError?: boolean }
    // File operations
    | { type: 'file-edit'; description: string; filePath: string; diff?: string; oldContent?: string; newContent?: string; id: string }
    // Terminal/command output
    | { type: 'terminal-output'; data: string; callId: string }
    // Task lifecycle events
    | { type: 'task_started'; id: string }
    | { type: 'task_complete'; id: string }
    | { type: 'turn_aborted'; id: string }
    // Permissions
    | { type: 'permission-request'; permissionId: string; toolName: string; description: string; options?: unknown }
    // Usage/metrics
    | { type: 'token_count';[key: string]: unknown };

export type ACPProvider = 'gemini' | 'codex' | 'cursor' | 'claude' | 'opencode';

export type SessionEvent = {
    type: 'switch', mode: 'local' | 'remote'
} | {
    type: 'message', message: string, isError?: boolean
} | {
    type: 'permission-mode-changed', mode: 'manual' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' | 'dontAsk'
} | {
    type: 'ready'
};

const TERMINAL_LIFECYCLE_STATE = 'archived';
const P2P_DELIVERY_ID_PREFIX = 'p2p';

export interface MetadataUpdateOptions {
    maxAttempts?: number;
    timeoutMs?: number;
}

class MetadataUpdateRejectedError extends Error {
    public constructor() {
        super('Session metadata update was rejected by the server');
        this.name = 'MetadataUpdateRejectedError';
    }
}

interface PendingUserMessage {
    message: DeliveredUserMessage;
    sequence: number;
}

function isRetryableUserMessageDeliveryError(error: unknown): error is RetryableUserMessageDeliveryError {
    return error instanceof RetryableUserMessageDeliveryError;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs?: number): Promise<T> {
    if (!timeoutMs) {
        return operation;
    }

    return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`Metadata update timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        void operation.then(
            (value) => {
                clearTimeout(timeout);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timeout);
                reject(error);
            },
        );
    });
}

export class ApiSessionClient extends EventEmitter {
    private readonly token: string;
    readonly sessionId: string;
    private metadata: Metadata | null;
    private metadataVersion: number;
    private agentState: AgentState | null;
    private agentStateVersion: number;
    private socket: Socket<ServerToClientEvents, ClientToServerEvents>;
    private pendingMessages: PendingUserMessage[] = [];
    private pendingMessageSequences = new Set<number>();
    private processedMessageSequences = new Set<number>();
    private acknowledgedMessageSequence = 0;
    private pendingMessageCallback: ((message: DeliveredUserMessage) => void | Promise<void>) | null = null;
    private isDrainingPendingMessages = false;
    private pendingMessageInFlight: PendingUserMessage | null = null;
    private cancelledPendingMessageSequences = new Set<number>();
    private isRunnerMessageConsumer = false;
    private doesSocketAuthIncludeRunnerCredential = false;
    readonly rpcHandlerManager: RpcHandlerManager;
    private agentStateLock = new AsyncLock();
    private metadataLock = new AsyncLock();
    private hasSessionEnded = false;
    private encryptionKey: Uint8Array;
    private encryptionVariant: 'legacy' | 'dataKey';

    constructor(token: string, session: Session) {
        super()
        this.token = token;
        this.sessionId = session.id;
        this.metadata = session.metadata;
        this.metadataVersion = session.metadataVersion;
        this.agentState = session.agentState;
        this.agentStateVersion = session.agentStateVersion;
        this.encryptionKey = session.encryptionKey;
        this.encryptionVariant = session.encryptionVariant;
        this.doesSocketAuthIncludeRunnerCredential = Boolean(getSessionRunnerCredential(this.sessionId));

        // Initialize RPC handler manager
        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            encryptionKey: this.encryptionKey,
            encryptionVariant: this.encryptionVariant,
            logger: (msg, data) => logger.debug(msg, data)
        });
        registerCommonHandlers(this.rpcHandlerManager, this.metadata.path);

        //
        // Create socket
        //

        this.socket = io(getEffectiveServerUrl(), {
            auth: (callback) => {
                const runnerCredential = getSessionRunnerCredential(this.sessionId);
                this.doesSocketAuthIncludeRunnerCredential = Boolean(runnerCredential);
                callback({
                    token: this.token,
                    clientType: 'session-scoped' as const,
                    sessionId: this.sessionId,
                    ...(runnerCredential ? {
                        messageAckVersion: SESSION_MESSAGE_ACK_VERSION,
                        runnerCredential
                    } : {})
                });
            },
            path: '/v1/updates',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            transports: ['websocket'],
            withCredentials: true,
            autoConnect: false
        });

        //
        // Handlers
        //

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully');
            this.rpcHandlerManager.onSocketConnect(this.socket);
            void this.drainPendingUserMessages();
        })

        // Set up global RPC request handler
        this.socket.on('rpc-request', async (data: { method: string, params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data));
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason);
            this.rpcHandlerManager.onSocketDisconnect();
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error);
            this.rpcHandlerManager.onSocketDisconnect();
        })

        // Server events
        this.socket.on('update', (data: Update) => {
            try {
                logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', data);

                if (!data.body) {
                    logger.debug('[SOCKET] [UPDATE] [ERROR] No body in update!');
                    return;
                }

                if (data.body.t === 'new-message' && data.body.message.content.t === 'encrypted') {
                    const messageSequence = data.body.message.seq;
                    if (messageSequence <= this.acknowledgedMessageSequence) {
                        this.acknowledgeMessageDelivery();
                        return;
                    }

                    const body = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.message.content.c));

                    logger.debugLargeJson('[SOCKET] [UPDATE] Received update:', body)

                    // Try to parse as user message first
                    const userResult = UserMessageSchema.safeParse(body);
                    if (userResult.success) {
                        this.enqueuePendingUserMessage({
                            ...userResult.data,
                            deliveryId: `${P2P_DELIVERY_ID_PREFIX}:${this.sessionId}:${messageSequence}`,
                        }, messageSequence);
                    } else {
                        // If not a user message, it might be a permission response or other message type
                        this.pendingMessageSequences.add(messageSequence);
                        this.emit('message', body);
                        this.pendingMessageSequences.delete(messageSequence);
                        this.markMessageProcessed(messageSequence);
                    }
                } else if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.metadata.value));
                        this.metadataVersion = data.body.metadata.version;
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        this.agentState = data.body.agentState.value ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(data.body.agentState.value)) : null;
                        this.agentStateVersion = data.body.agentState.version;
                    }
                } else if (data.body.t === 'update-machine') {
                    // Session clients shouldn't receive machine updates - log warning
                    logger.debug(`[SOCKET] WARNING: Session client received unexpected machine update - ignoring`);
                } else {
                    // If not a user message, it might be a permission response or other message type
                    this.emit('message', data.body);
                }
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error });
            }
        });

        // DEATH
        this.socket.on('error', (error) => {
            logger.debug('[API] Socket error:', error);
        });

        //
        // Connect (after short delay to give a time to add handlers)
        //

        this.socket.connect();
    }

    onUserMessage(callback: (data: DeliveredUserMessage) => void | Promise<void>): void {
        if (!this.isRunnerMessageConsumer) {
            this.isRunnerMessageConsumer = true;
            if (
                getSessionRunnerCredential(this.sessionId)
                && !this.doesSocketAuthIncludeRunnerCredential
            ) {
                this.socket.disconnect();
                this.socket.connect();
            }
        }

        this.pendingMessageCallback = callback;
        void this.drainPendingUserMessages();
    }

    /**
     * Re-offers the blocked head delivery after the provider runner has
     * completed its own recovery. This intentionally has no timer: transport
     * ordering stays here, while retry policy stays with the provider.
     */
    requestPendingUserMessageRedelivery(): boolean {
        if (
            this.hasSessionEnded
            || !this.socket.connected
            || !this.pendingMessageCallback
            || this.isDrainingPendingMessages
            || this.pendingMessages.length === 0
        ) {
            return false;
        }

        void this.drainPendingUserMessages();
        return true;
    }

    /**
     * A cancelled prompt is terminal for this runner: acknowledge only the
     * matching queue head so it cannot replay after a reconnect.
     */
    cancelPendingUserMessageDelivery(deliveryId: string): boolean {
        const pendingMessage = this.pendingMessages[0];
        if (!pendingMessage || pendingMessage.message.deliveryId !== deliveryId) {
            return false;
        }

        if (this.pendingMessageInFlight === pendingMessage) {
            this.cancelledPendingMessageSequences.add(pendingMessage.sequence);
            return true;
        }

        this.completePendingUserMessage(pendingMessage);
        void this.drainPendingUserMessages();
        return true;
    }

    private enqueuePendingUserMessage(message: DeliveredUserMessage, sequence: number): void {
        if (this.pendingMessageSequences.has(sequence)) {
            logger.debug(`[SOCKET] Ignoring duplicate pending message sequence ${sequence}`);
            void this.drainPendingUserMessages();
            return;
        }

        this.pendingMessages.push({ message, sequence });
        this.pendingMessageSequences.add(sequence);
        void this.drainPendingUserMessages();
    }

    private async drainPendingUserMessages(): Promise<void> {
        if (
            this.isDrainingPendingMessages
            || !this.pendingMessageCallback
        ) {
            return;
        }

        this.isDrainingPendingMessages = true;
        try {
            while (this.pendingMessages.length > 0) {
                const pendingMessage = this.pendingMessages[0];
                this.pendingMessageInFlight = pendingMessage;
                let deliveryError: unknown = null;
                try {
                    await this.pendingMessageCallback(pendingMessage.message);
                } catch (error) {
                    deliveryError = error;
                } finally {
                    if (this.pendingMessageInFlight === pendingMessage) {
                        this.pendingMessageInFlight = null;
                    }
                }

                if (this.cancelledPendingMessageSequences.delete(pendingMessage.sequence)) {
                    this.completePendingUserMessage(pendingMessage);
                    continue;
                }

                if (deliveryError) {
                    if (isRetryableUserMessageDeliveryError(deliveryError)) {
                        return;
                    }
                    logger.warn(`[SOCKET] User message sequence ${pendingMessage.sequence} was not accepted by the session consumer.`, deliveryError);
                    return;
                }

                this.completePendingUserMessage(pendingMessage);
            }
        } finally {
            this.isDrainingPendingMessages = false;
        }
    }

    private completePendingUserMessage(pendingMessage: PendingUserMessage): void {
        const index = this.pendingMessages.indexOf(pendingMessage);
        if (index === -1) {
            return;
        }

        this.pendingMessages.splice(index, 1);
        this.pendingMessageSequences.delete(pendingMessage.sequence);
        this.markMessageProcessed(pendingMessage.sequence);
    }

    private markMessageProcessed(messageSequence: number): void {
        this.processedMessageSequences.add(messageSequence);
        this.acknowledgeMessageDelivery();
    }

    private acknowledgeMessageDelivery(): void {
        if (!this.isRunnerMessageConsumer || !getSessionRunnerCredential(this.sessionId)) {
            return;
        }

        const unprocessedSequences = Array.from(this.processedMessageSequences)
            .filter((messageSequence) => messageSequence > this.acknowledgedMessageSequence)
            .sort((left, right) => left - right);
        const pendingSequences = Array.from(this.pendingMessageSequences)
            .filter((messageSequence) => messageSequence > this.acknowledgedMessageSequence);

        if (pendingSequences.length > 0) {
            const earliestPendingSequence = Math.min(...pendingSequences);
            const lastProcessedSequence = unprocessedSequences
                .filter((messageSequence) => messageSequence < earliestPendingSequence)
                .at(-1);
            if (lastProcessedSequence !== undefined) {
                this.acknowledgedMessageSequence = lastProcessedSequence;
            }
        } else if (unprocessedSequences.length > 0) {
            this.acknowledgedMessageSequence = unprocessedSequences.at(-1)!;
        }

        if (this.acknowledgedMessageSequence === 0) {
            return;
        }

        for (const messageSequence of this.processedMessageSequences) {
            if (messageSequence <= this.acknowledgedMessageSequence) {
                this.processedMessageSequences.delete(messageSequence);
            }
        }

        this.socket.emit('message-ack', {
            sid: this.sessionId,
            seq: this.acknowledgedMessageSequence
        });
    }

    /**
     * Send message to session
     * @param body - Message body (can be MessageContent or raw content for agent messages)
     */
    sendClaudeSessionMessage(body: RawJSONLines) {
        let content: MessageContent;

        // Check if body is already a MessageContent (has role property)
        if (body.type === 'user' && typeof body.message.content === 'string' && body.isSidechain !== true && body.isMeta !== true) {
            content = {
                role: 'user',
                content: {
                    type: 'text',
                    text: body.message.content
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        } else {
            // Wrap Claude messages in the expected format
            content = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: body  // This wraps the entire Claude message
                },
                meta: {
                    sentFrom: 'cli'
                }
            };
        }

        logger.debugLargeJson('[SOCKET] Sending message through socket:', content)

        // Check if socket is connected before sending
        if (!this.socket.connected) {
            logger.debug('[API] Socket not connected, cannot send Claude session message. Message will be lost:', { type: body.type });
            return;
        }

        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });

        // Track usage from assistant messages
        if (body.type === 'assistant' && body.message?.usage) {
            try {
                this.sendUsageData(body.message.usage, body.message.model);
            } catch (error) {
                logger.debug('[SOCKET] Failed to send usage data:', error);
            }
        }

        // Update metadata with summary if this is a summary message
        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }));
        }
    }

    sendCodexMessage(body: any) {
        let content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body  // This wraps the entire Claude message
            },
            meta: {
                sentFrom: 'cli'
            }
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));

        // Check if socket is connected before sending
        if (!this.socket.connected) {
            logger.debug('[API] Socket not connected, cannot send message. Message will be lost:', { type: body.type });
            // TODO: Consider implementing message queue or HTTP fallback for reliability
        }

        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });
    }

    sendUserTextMessage(text: string, meta: { sentFrom?: string } = { sentFrom: 'cli' }) {
        const content: MessageContent = {
            role: 'user',
            content: {
                type: 'text',
                text
            },
            meta: {
                sentFrom: meta.sentFrom ?? 'cli'
            }
        };

        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });
    }

    /**
     * Send a generic agent message to the session using ACP (Agent Communication Protocol) format.
     * Works for any agent type (Gemini, Codex, Claude, etc.) - CLI normalizes to unified ACP format.
     * 
     * @param provider - The agent provider sending the message (e.g., 'gemini', 'codex', 'claude')
     * @param body - The message payload (type: 'message' | 'reasoning' | 'tool-call' | 'tool-result')
     */
    sendAgentMessage(provider: 'claude' | 'codex' | 'cursor' | 'gemini' | 'opencode', body: ACPMessageData) {
        let content = {
            role: 'agent',
            content: {
                type: 'acp',
                provider,
                data: body
            },
            meta: {
                sentFrom: 'cli'
            }
        };

        logger.debug(`[SOCKET] Sending ACP message from ${provider}:`, { type: body.type, hasMessage: 'message' in body });

        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });

        if (body.type === 'message') {
            if (body.isError === true) {
                this.recordExecutionError();
            } else if (body.isError === false && body.message.trim().length > 0) {
                this.recordSuccessfulAgentOutput();
            }
        }
    }

    sendSessionEvent(event: SessionEvent, id?: string) {
        let content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event
            }
        };
        const encrypted = encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, content));
        this.socket.emit('message', {
            sid: this.sessionId,
            message: encrypted
        });

        if (event.type === 'message' && event.isError === true) {
            this.recordExecutionError();
        }
    }

    /**
     * Send a ping message to keep the connection alive
     */
    keepAlive(thinking: boolean, mode: 'local' | 'remote') {
        if (process.env.DEBUG) { // too verbose for production
            logger.debug(`[API] Sending keep alive message: ${thinking}`);
        }
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode
        });
    }

    /**
     * Send session death message
     */
    sendSessionDeath() {
        this.hasSessionEnded = true;
        this.cancelledPendingMessageSequences.clear();
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() });
    }

    /**
     * Records a live, non-error agent output. Callers must not use this for
     * history replay, summaries, status events, or tool output.
     */
    recordSuccessfulAgentOutput(): void {
        const occurredAt = Date.now();
        this.updateExecutionOutcome((metadata) => {
            const currentOutcome = metadata.executionOutcome;
            if (currentOutcome?.occurredAt !== undefined && currentOutcome.occurredAt >= occurredAt) {
                return metadata;
            }

            return {
                ...metadata,
                executionOutcome: {
                    kind: 'success',
                    occurredAt
                }
            };
        });
    }

    private recordExecutionError(): void {
        const occurredAt = Date.now();
        this.updateExecutionOutcome((metadata) => {
            const currentOutcome = metadata.executionOutcome;
            if (currentOutcome?.occurredAt !== undefined && currentOutcome.occurredAt >= occurredAt) {
                return metadata;
            }

            return {
                ...metadata,
                executionOutcome: {
                    kind: 'error',
                    occurredAt
                }
            };
        });
    }

    private updateExecutionOutcome(handler: (metadata: Metadata) => Metadata): void {
        if (this.hasSessionEnded) {
            return;
        }

        void this.updateMetadata((metadata) => {
            if (metadata.lifecycleState === TERMINAL_LIFECYCLE_STATE) {
                return metadata;
            }

            return handler(metadata);
        });
    }

    /**
     * Send usage data to the server
     */
    sendUsageData(usage: Usage, model?: string) {
        // Calculate total tokens
        const totalTokens = usage.input_tokens + usage.output_tokens + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);

        const costs = calculateCost(usage, model);

        // Transform Claude usage format to backend expected format
        const usageReport = {
            key: 'claude-session',
            sessionId: this.sessionId,
            tokens: {
                total: totalTokens,
                input: usage.input_tokens,
                output: usage.output_tokens,
                cache_creation: usage.cache_creation_input_tokens || 0,
                cache_read: usage.cache_read_input_tokens || 0
            },
            cost: {
                total: costs.total,
                input: costs.input,
                output: costs.output
            }
        }
        logger.debugLargeJson('[SOCKET] Sending usage data:', usageReport)
        this.socket.emit('usage-report', usageReport);
    }

    /**
     * Update session metadata
     * @param handler - Handler function that returns the updated metadata
     */
    updateMetadata(
        handler: (metadata: Metadata) => Metadata,
        options?: MetadataUpdateOptions,
    ): Promise<void> {
        const maxAttempts = options?.maxAttempts === undefined
            ? undefined
            : Math.max(options.maxAttempts, 1);
        const operation = this.metadataLock.inLock(async () => {
            const update = async (): Promise<boolean> => {
                const currentMetadata = this.metadata;
                if (!currentMetadata) {
                    return true;
                }

                const updated = handler(currentMetadata);
                if (updated === currentMetadata) {
                    return true;
                }

                const answer = await withTimeout(
                    this.socket.emitWithAck('update-metadata', {
                        sid: this.sessionId,
                        expectedVersion: this.metadataVersion,
                        metadata: encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)),
                    }),
                    options?.timeoutMs,
                );
                if (answer.result === 'success') {
                    this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    this.metadataVersion = answer.version;
                    return true;
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.metadataVersion) {
                        this.metadataVersion = answer.version;
                        this.metadata = decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.metadata));
                    }
                    throw new Error('Metadata version mismatch');
                } else if (answer.result === 'error') {
                    return false;
                }

                return false;
            };

            if (maxAttempts === undefined) {
                const wasAccepted = await backoff(update);
                if (!wasAccepted) {
                    throw new MetadataUpdateRejectedError();
                }
                return;
            }

            let lastError: unknown;
            for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
                try {
                    const wasAccepted = await update();
                    if (!wasAccepted) {
                        throw new MetadataUpdateRejectedError();
                    }
                    return;
                } catch (error) {
                    if (error instanceof MetadataUpdateRejectedError) {
                        throw error;
                    }
                    lastError = error;
                }
            }

            throw lastError;
        });

        const totalTimeoutMs = maxAttempts && options?.timeoutMs
            ? maxAttempts * options.timeoutMs
            : undefined;
        return withTimeout(operation, totalTimeoutMs);
    }

    /**
     * Update session agent state
     * @param handler - Handler function that returns the updated agent state
     */
    updateAgentState(handler: (metadata: AgentState) => AgentState) {
        logger.debugLargeJson('Updating agent state', this.agentState);
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                let updated = handler(this.agentState || {});
                const answer = await this.socket.emitWithAck('update-state', { sid: this.sessionId, expectedVersion: this.agentStateVersion, agentState: updated ? encodeBase64(encrypt(this.encryptionKey, this.encryptionVariant, updated)) : null });
                if (answer.result === 'success') {
                    this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    this.agentStateVersion = answer.version;
                    logger.debug('Agent state updated', this.agentState);
                } else if (answer.result === 'version-mismatch') {
                    if (answer.version > this.agentStateVersion) {
                        this.agentStateVersion = answer.version;
                        this.agentState = answer.agentState ? decrypt(this.encryptionKey, this.encryptionVariant, decodeBase64(answer.agentState)) : null;
                    }
                    throw new Error('Agent state version mismatch');
                } else if (answer.result === 'error') {
                    // console.error('Agent state update error', answer);
                    // Hard error - ignore
                }
            });
        });
    }

    /**
     * Wait for socket buffer to flush
     */
    async flush(): Promise<void> {
        if (!this.socket.connected) {
            return;
        }
        return new Promise((resolve) => {
            this.socket.emit('ping', () => {
                resolve();
            });
            setTimeout(() => {
                resolve();
            }, 10000);
        });
    }

    async close() {
        logger.debug('[API] socket.close() called');
        this.cancelledPendingMessageSequences.clear();
        this.socket.close();
    }
}
