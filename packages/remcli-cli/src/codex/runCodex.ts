import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import {
    CodexAppServerClient,
    CodexAppServerJsonRpcError,
    CodexAppServerAmbiguousThreadStartError,
    isCodexAppServerActiveTurnHandoffError,
    isCodexAppServerRecoverableStateError,
    isCodexAppServerTransientTransportError,
} from './codexAppServerClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { redactDiagnosticData, redactSensitiveText } from '@/utils/redaction';
import { Credentials, readDaemonState, readSettings } from '@/persistence';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2, type MessageQueueBatch } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import {
    bindDaemonCodexThread,
    openDaemonCodexRemoteTui,
} from "@/daemon/controlClient";
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { stopCaffeinate } from "@/utils/caffeinate";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { createAutoTitleSetter } from '@/utils/autoSessionTitle';
import type { ApiSessionClient } from '@/api/apiSession';
import {
    RetryableUserMessageDeliveryError,
    type DeliveredUserMessage,
    type PermissionMode,
} from '@/api/types';
import {
    acquireDaemonRunnerCredential,
    reportTerminalSessionStarted,
} from '@/utils/daemonRunnerCredentialBootstrap';
import { replayCodexSessionHistory } from './utils/replayCodexSessionHistory';
import type { CodexApprovalPolicy, CodexSandbox, CodexToolResponse } from './types';
import {
    CODEX_DEFAULT_REASONING_EFFORT,
    isCodexAppServerStateUsable,
} from './codexAppServerHost';

type ReadyEventOptions = {
    pending: unknown;
    queueSize: () => number;
    shouldExit: boolean;
    sendReady: () => void;
    notify?: () => void;
};

export const CODEX_DEFAULT_PERMISSION_MODE: CodexSandbox = 'workspace-write';
const REMOTE_TUI_RETRY_DELAYS_MS = [250, 1_000] as const;
const CODEX_DELIVERY_RECOVERY_DELAYS_MS = [250, 1_000, 3_000] as const;
const CODEX_APP_SERVER_OVERLOADED_ERROR_CODE = -32001;
const CODEX_APP_SERVER_OVERLOADED_ERROR_MESSAGE = 'Server overloaded; retry later.';
const CODEX_INTERRUPTED_TURN_SETTLE_TIMEOUT_MS = 10_000;

interface CodexPermissionConfig {
    approvalPolicy: CodexApprovalPolicy;
    sandbox: CodexSandbox;
}

type NativeThreadBootstrap =
    | { state: 'unstarted' }
    | { state: 'resume-pending'; threadId: string }
    | { state: 'ready'; threadId: string }
    | { state: 'ambiguous'; error: CodexAppServerAmbiguousThreadStartError };

interface ScheduledDeliveryRecovery {
    deliveryId: string;
    timeout: ReturnType<typeof setTimeout>;
}

function isCodexPermissionMode(permissionMode: PermissionMode): permissionMode is CodexSandbox {
    return permissionMode === 'read-only'
        || permissionMode === 'workspace-write'
        || permissionMode === 'danger-full-access';
}

export function resolveCodexPermissionConfig(permissionMode: CodexSandbox): CodexPermissionConfig {
    switch (permissionMode) {
        case 'read-only':
            return {
                approvalPolicy: 'on-request',
                sandbox: 'read-only',
            };
        case 'workspace-write':
            return {
                approvalPolicy: 'on-request',
                sandbox: 'workspace-write',
            };
        case 'danger-full-access':
            return {
                approvalPolicy: 'never',
                sandbox: 'danger-full-access',
            };
    }
}

function formatUnsupportedCodexPermissionMessage(permissionMode: PermissionMode): string {
    return `Unsupported Codex permission mode "${permissionMode}". Use read-only, workspace-write, or danger-full-access.`;
}

function getCodexErrorText(response: CodexToolResponse): string {
    if (Array.isArray(response.content)) {
        const text = response.content
            .map((content) => content.text)
            .filter((text): text is string => typeof text === 'string' && text.length > 0)
            .join(' ')
            .trim();

        if (text.length > 0) {
            return text;
        }
    }

    return 'Codex returned an error.';
}

/** Error text crosses into the encrypted chat history only after secret redaction. */
export function redactCodexErrorForSession(error: unknown, fallback: string): string {
    const source = typeof error === 'string'
        ? error
        : error instanceof Error
            ? error.message
            : fallback;
    const redacted = redactSensitiveText(source).trim();
    return redacted || fallback;
}

function isRecoverableCodexDeliveryError(error: unknown): boolean {
    if (
        isCodexAppServerTransientTransportError(error)
        || isCodexAppServerRecoverableStateError(error)
    ) {
        return true;
    }

    return error instanceof CodexAppServerJsonRpcError
        && error.code === CODEX_APP_SERVER_OVERLOADED_ERROR_CODE
        && error.message === CODEX_APP_SERVER_OVERLOADED_ERROR_MESSAGE;
}

/**
 * Notify connected clients when Codex finishes processing and the queue is idle.
 * Returns true when a ready event was emitted.
 */
export function emitReadyIfIdle({ pending, queueSize, shouldExit, sendReady, notify }: ReadyEventOptions): boolean {
    if (shouldExit) {
        return false;
    }
    if (pending) {
        return false;
    }
    if (queueSize() > 0) {
        return false;
    }

    sendReady();
    notify?.();
    return true;
}

interface CodexAppServerClientSelection {
    client: CodexAppServerClient;
    usesSharedEndpoint: boolean;
    remoteTuiEndpoint?: string;
}

async function createCodexAppServerClient(): Promise<CodexAppServerClientSelection> {
    const daemonState = await readDaemonState();
    const sharedEndpoint = daemonState?.codexAppServerEndpoint;
    if (sharedEndpoint && await isCodexAppServerStateUsable(daemonState)) {
        logger.debug(`[Codex] Using shared daemon Codex app-server ${sharedEndpoint}`);
        return {
            client: new CodexAppServerClient({ endpoint: sharedEndpoint }),
            usesSharedEndpoint: true,
            remoteTuiEndpoint: sharedEndpoint,
        };
    }

    if (sharedEndpoint) {
        logger.warn('[Codex] Shared daemon Codex app-server endpoint is stale; starting private app-server over stdio');
    } else {
        logger.debug('[Codex] No shared daemon Codex app-server endpoint found; starting private app-server over stdio');
    }
    return { client: new CodexAppServerClient(), usesSharedEndpoint: false };
}

/**
 * Main entry point for the codex command with ink UI
 */
export async function runCodex(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    resumeSessionId?: string;
    reasoningEffort?: string;
}): Promise<void> {
    interface EnhancedMode {
        permissionMode: CodexSandbox;
        model?: string;
        reasoningEffort?: string;
        clientUserMessageId?: string;
        abortGeneration: number;
    }
    type QueuedCodexMessage = MessageQueueBatch<EnhancedMode>;
    type StartedCodexTurn = {
        turnId: string;
        completion: Promise<CodexToolResponse>;
    };
    type TurnCompletionResult =
        | { type: 'completed'; response: CodexToolResponse }
        | { type: 'failed'; error: unknown };
    type TurnQueueResult =
        | TurnCompletionResult
        | { type: 'queued'; message: QueuedCodexMessage | null };

    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings (before any API calls)
    connectionState.setBackend('Codex');

    const api = await ApiClient.create(opts.credentials);

    // Log startup options
    logger.debug(`[codex] Starting with options: startedBy=${opts.startedBy || 'terminal'}, resume=${opts.resumeSessionId || 'none'}`);

    //
    // Machine
    //

    const settings = await readSettings();
    let machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings. Make sure daemon is running: remcli daemon start`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    //
    // Create session
    //

    const { state, metadata } = createSessionMetadata({
        flavor: 'codex',
        machineId,
        startedBy: opts.startedBy
    });
    if (opts.resumeSessionId) {
        metadata.agentSessionId = opts.resumeSessionId;
        metadata.codexSessionId = opts.resumeSessionId;
    }
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

    // A daemon-owned runner must authenticate as an ACK-capable consumer before
    // it can create a session socket. Otherwise it could consume a prompt on a
    // legacy connection and make it unavailable to the next valid runner.
    if (opts.startedBy === 'daemon') {
        if (!response) {
            logger.warn('[Codex] Daemon-owned runner cannot start without a P2P session for credential handoff.');
            return;
        }

        if (!await acquireDaemonRunnerCredential({ agentName: 'Codex', sessionId: response.id, metadata })) {
            return;
        }
    } else if (response) {
        await reportTerminalSessionStarted({ agentName: 'Codex', sessionId: response.id, metadata });
    }

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    let userMessageConsumer: ((message: DeliveredUserMessage) => Promise<void>) | null = null;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        canCreateReconnectedSessionConsumer: opts.startedBy === 'daemon'
            ? async (reconnectedSession) => acquireDaemonRunnerCredential({
                agentName: 'Codex',
                sessionId: reconnectedSession.id,
                metadata,
            })
            : undefined,
        onSessionSwap: (newSession) => {
            session = newSession;
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
            if (userMessageConsumer) {
                newSession.onUserMessage(userMessageConsumer);
            }
        }
    });
    session = initialSession;

    // A queued P2P delivery can be drained synchronously by onUserMessage().
    // Initialise the chat-error sink before registering any delivery handler.
    const messageBuffer = new MessageBuffer();
    const publishSessionError = (error: unknown, fallback: string): string => {
        const errorMessage = redactCodexErrorForSession(error, fallback);
        messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');
        session.sendSessionEvent({ type: 'message', message: errorMessage, isError: true });
        return errorMessage;
    };

    const getTurnModeHash = (mode: EnhancedMode): string => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        reasoningEffort: mode.reasoningEffort,
    });
    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        turnModeHash: getTurnModeHash(mode),
        clientUserMessageId: mode.clientUserMessageId,
        abortGeneration: mode.abortGeneration,
    }));
    const deliveryRetryAttempts = new Map<string, number>();
    const scheduledDeliveryRecoveries = new Map<string, ScheduledDeliveryRecovery>();
    const cancelledDeliveryKeys = new Set<string>();
    let activeDeliveryRetryKey: string | null = null;
    let activeDeliveryId: string | null = null;
    let abortGeneration = 0;
    const getDeliveryRetryKey = (message: QueuedCodexMessage): string => (
        message.mode.clientUserMessageId ?? `${message.hash}:${message.message}`
    );
    let clearScheduledDeliveryRecovery = (retryKey: string): void => {
        deliveryRetryAttempts.delete(retryKey);
    };
    let cancelScheduledDeliveryRecoveries = (): string[] => [];
    const acknowledgeQueuedMessage = (message: QueuedCodexMessage): void => {
        clearScheduledDeliveryRecovery(getDeliveryRetryKey(message));
        message.acknowledge();
    };
    const cancelQueuedMessageAfterAbort = (message: QueuedCodexMessage): void => {
        const deliveryId = message.mode.clientUserMessageId;
        if (deliveryId) {
            session.cancelPendingUserMessageDelivery(deliveryId);
        }
        acknowledgeQueuedMessage(message);
        messageBuffer.addMessage('Aborted by user', 'status');
        session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
    };

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: CodexSandbox | undefined = undefined;
    let currentModel: string | undefined = undefined;
    const currentReasoningEffort = opts.reasoningEffort ?? CODEX_DEFAULT_REASONING_EFFORT;

    userMessageConsumer = async (message) => {
        if (message.meta?.sentFrom === 'history' || message.meta?.sentFrom === 'native-app-server') {
            logger.debug(`[Codex] Ignoring ${message.meta.sentFrom} user message in turn queue`);
            return;
        }

        // Resolve permission mode (accept all modes, will be mapped in switch statement)
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const requestedPermissionMode = message.meta.permissionMode as PermissionMode;
            if (isCodexPermissionMode(requestedPermissionMode)) {
                messagePermissionMode = requestedPermissionMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[Codex] Permission mode updated from user message to: ${currentPermissionMode}`);
            } else {
                const errorText = formatUnsupportedCodexPermissionMessage(requestedPermissionMode);
                logger.warn(`[Codex] ${errorText}`);
                publishSessionError(errorText, 'Codex rejected the requested permission mode.');
                return;
            }
        } else {
            const effectivePermissionMode = currentPermissionMode ?? `${CODEX_DEFAULT_PERMISSION_MODE} (effective)`;
            logger.debug(`[Codex] User message received with no permission mode override, using current: ${effectivePermissionMode}`);
        }

        // Resolve model; explicit null resets to undefined (let Codex choose)
        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            const raw = message.meta.model;
            messageModel = raw ? raw : undefined;
            currentModel = messageModel;
            logger.debug(`[Codex] Model updated from user message: ${messageModel || 'reset to default'}`);
        } else {
            logger.debug(`[Codex] User message received with no model override, using current: ${currentModel || 'default'}`);
        }

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode || CODEX_DEFAULT_PERMISSION_MODE,
            model: messageModel,
            reasoningEffort: currentReasoningEffort,
            clientUserMessageId: message.deliveryId,
            abortGeneration,
        };
        await messageQueue.pushWithAcceptance(message.content.text, enhancedMode);
    };
    session.onUserMessage(userMessageConsumer);
    let thinking = false;
    session.keepAlive(thinking, 'remote');
    // Periodic keep-alive; store handle so we can clear on exit
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
    };

    // Debug helper: log active handles/requests if DEBUG is enabled
    function logActiveHandles(tag: string) {
        if (!process.env.DEBUG) return;
        const nodeProc = process as NodeJS.Process & { _getActiveHandles?: () => Array<{ constructor?: { name: string } }>; _getActiveRequests?: () => unknown[] };
        const handles = typeof nodeProc._getActiveHandles === 'function' ? nodeProc._getActiveHandles() : [];
        const requests = typeof nodeProc._getActiveRequests === 'function' ? nodeProc._getActiveRequests() : [];
        logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
        try {
            const kinds = handles.map((h) => (h && h.constructor ? h.constructor.name : typeof h));
            logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
        } catch { }
    }

    //
    // Abort handling
    // IMPORTANT: There are two different operations:
    // 1. Abort (handleAbort): Stops the current inference/task but keeps the session alive
    //    - Used by the 'abort' RPC from mobile app
    //    - Similar to Claude Code's abort behavior
    //    - Allows continuing with new prompts after aborting
    // 2. Kill (handleKillSession): Terminates the entire process
    //    - Used by the 'killSession' RPC
    //    - Completely exits the CLI process
    //

    let abortController = new AbortController();
    let shouldExit = false;
    let activeClient: CodexAppServerClient | null = null;

    /**
     * Handles aborting the current task/inference without exiting the process.
     * This is the equivalent of Claude Code's abort - it stops what's currently
     * happening but keeps the session alive for new prompts.
     */
    async function handleAbort() {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            abortGeneration += 1;
            const cancelledRecoveryDeliveryIds = cancelScheduledDeliveryRecoveries();
            if (activeDeliveryRetryKey) {
                cancelledDeliveryKeys.add(activeDeliveryRetryKey);
            }
            if (activeDeliveryId) {
                session.cancelPendingUserMessageDelivery(activeDeliveryId);
            }
            for (const deliveryId of cancelledRecoveryDeliveryIds) {
                session.cancelPendingUserMessageDelivery(deliveryId);
            }
            const activeTurnId = activeClient?.getActiveTurnId();
            const interruptRequest = activeClient?.interruptActiveTurn();
            const hasInterruptBarrier = Boolean(
                activeTurnId && activeClient?.isTurnInterrupting(activeTurnId),
            );
            void interruptRequest?.catch((error) => {
                logger.debug('[Codex] Failed to interrupt the active Codex turn:', redactDiagnosticData(error));
                publishSessionError(error, 'Codex app-server rejected turn/interrupt.');
            });
            abortController.abort();
            reasoningProcessor.abort();
            if (!hasInterruptBarrier && !activeDeliveryId && cancelledRecoveryDeliveryIds.length > 0) {
                messageBuffer.addMessage('Aborted by user', 'status');
                session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
            }
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', redactDiagnosticData(error));
        } finally {
            abortController = new AbortController();
        }
    }

    /**
     * Handles session termination and process exit.
     * This is called when the session needs to be completely killed (not just aborted).
     * Abort stops the current inference but keeps the session alive.
     * Kill terminates the entire process.
     */
    const handleKillSession = async () => {
        logger.debug('[Codex] Kill session requested - terminating process');
        await handleAbort();
        logger.debug('[Codex] Abort completed, proceeding with termination');

        try {
            // Update lifecycle state to archived before closing
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated'
                }));
                
                // Send session death message
                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            // Force close Codex transport (best-effort) so we don't leave stray processes
            try {
                await activeClient?.forceCloseSession();
            } catch (e) {
                logger.debug(
                    '[Codex] Error while force closing Codex session during termination',
                    redactDiagnosticData(e),
                );
            }

            // Stop caffeinate
            stopCaffeinate();

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', redactDiagnosticData(error));
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            onExit: async () => {
                // Exit the agent
                logger.debug('[codex]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    //
    // Start Context 
    //

    const appServerSelection = await createCodexAppServerClient();
    let appServerClient = appServerSelection.client;
    let usesSharedAppServer = appServerSelection.usesSharedEndpoint;
    let remoteTuiEndpoint = appServerSelection.remoteTuiEndpoint;
    activeClient = appServerClient;
    let activeCodexThreadId = opts.resumeSessionId ?? appServerClient.getActiveThreadId();

    const handleThreadIdChange = (threadId: string) => {
        activeCodexThreadId = threadId;
        session.updateMetadata((currentMetadata) => ({
            ...currentMetadata,
            agentSessionId: threadId,
            codexSessionId: threadId,
        }));
    };
    appServerClient.setThreadIdChangeHandler(handleThreadIdChange);

    if (opts.resumeSessionId) {
        logger.debug(`[codex] Resume requested for Codex thread ${opts.resumeSessionId} via app-server`);
        const count = await replayCodexSessionHistory(
            opts.resumeSessionId,
            process.cwd(),
            (text) => session.sendUserTextMessage(text, { sentFrom: 'history' }),
            (text) => session.sendCodexMessage({
                type: 'message',
                message: text,
                id: randomUUID()
            })
        );
        logger.debug(`[RESUME] Replayed ${count} historical Codex messages for thread ${opts.resumeSessionId}`);
    }

    permissionHandler = new CodexPermissionHandler(session);
    const reasoningProcessor = new ReasoningProcessor((message) => {
        // Filter out tool-call/tool-call-result — only forward reasoning text to mobile
        if (message.type === 'tool-call' || message.type === 'tool-call-result') return;
        session.sendCodexMessage(message);
    });
    const diffProcessor = new DiffProcessor((message) => {
        // Filter out tool-call/tool-call-result — only forward diff info to mobile
        if (message.type === 'tool-call' || message.type === 'tool-call-result') return;
        session.sendCodexMessage(message);
    });
    appServerClient.setPermissionHandler(permissionHandler);
    const handleCodexClientMessage = (msg: any) => {
        logger.debug('[Codex] app-server message:', redactDiagnosticData(msg));

        if (msg.type === 'user_message') {
            if (msg.source === 'external') {
                session.sendUserTextMessage(msg.text, { sentFrom: 'native-app-server' });
            }
            return;
        }

        // Add messages to the ink UI buffer based on message type
        if (msg.type === 'agent_message') {
            messageBuffer.addMessage(msg.message, 'assistant');
        } else if (msg.type === 'agent_reasoning_delta') {
            // Skip reasoning deltas in the UI to reduce noise
        } else if (msg.type === 'agent_reasoning') {
            messageBuffer.addMessage(`[Thinking] ${msg.text.substring(0, 100)}...`, 'system');
        } else if (msg.type === 'exec_command_begin') {
            messageBuffer.addMessage(`Executing: ${msg.command}`, 'tool');
        } else if (msg.type === 'exec_command_end') {
            const output = msg.output || msg.error || 'Command completed';
            const truncatedOutput = output.substring(0, 200);
            messageBuffer.addMessage(
                `Result: ${truncatedOutput}${output.length > 200 ? '...' : ''}`,
                'result'
            );
        } else if (msg.type === 'task_started') {
            messageBuffer.addMessage('Starting task...', 'status');
        } else if (msg.type === 'task_complete') {
            messageBuffer.addMessage('Task completed', 'status');
            sendReady();
        } else if (msg.type === 'turn_aborted') {
            messageBuffer.addMessage('Turn aborted', 'status');
            sendReady();
        } else if (msg.type === 'agent_error') {
            publishSessionError(msg.message, 'Codex app-server error.');
        }

        if (msg.type === 'task_started') {
            if (!thinking) {
                logger.debug('thinking started');
                thinking = true;
                session.keepAlive(thinking, 'remote');
            }
        }
        if (msg.type === 'task_complete' || msg.type === 'turn_aborted') {
            if (thinking) {
                logger.debug('thinking completed');
                thinking = false;
                session.keepAlive(thinking, 'remote');
            }
            // Reset diff processor on task end or abort
            diffProcessor.reset();
        }
        if (msg.type === 'agent_reasoning_section_break') {
            // Reset reasoning processor for new section
            reasoningProcessor.handleSectionBreak();
        }
        if (msg.type === 'agent_reasoning_delta') {
            // Process reasoning delta - tool calls are sent automatically via callback
            reasoningProcessor.processDelta(msg.delta);
        }
        if (msg.type === 'agent_reasoning') {
            // Complete the reasoning section - tool results or reasoning messages sent via callback
            reasoningProcessor.complete(msg.text);
        }
        if (msg.type === 'agent_message') {
            session.sendCodexMessage({
                type: 'message',
                message: msg.message,
                id: randomUUID()
            });
            if (msg.origin === 'live' && msg.message.trim()) {
                session.recordSuccessfulAgentOutput();
            }
        }
        if (msg.type === 'exec_approval_request') {
            // Permission request — must be forwarded to mobile for approve/deny
            let { call_id, type, ...inputs } = msg;
            session.sendCodexMessage({
                type: 'tool-call',
                name: 'CodexBash',
                callId: call_id,
                input: inputs,
                id: randomUUID()
            });
        }
        // exec_command_begin / exec_command_end — informational only, skip sending to mobile
        if (msg.type === 'token_count') {
            session.sendCodexMessage({
                ...msg,
                id: randomUUID()
            });
        }
        if (msg.type === 'patch_apply_begin') {
            // Terminal UI feedback only — no mobile message
            const { changes } = msg;
            const changeCount = Object.keys(changes).length;
            const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
            messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');
        }
        if (msg.type === 'patch_apply_end') {
            // Terminal UI feedback only — no mobile message
            const { stdout, stderr, success } = msg;
            if (success) {
                const message = stdout || 'Files modified successfully';
                messageBuffer.addMessage(message.substring(0, 200), 'result');
            } else {
                const errorMsg = stderr || 'Failed to modify files';
                messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
            }
        }
        if (msg.type === 'turn_diff') {
            // Handle turn_diff messages and track unified_diff changes
            if (msg.unified_diff) {
                diffProcessor.processDiff(msg.unified_diff);
            }
        }
    };
    appServerClient.setHandler(handleCodexClientMessage);

    const autoSetTitle = createAutoTitleSetter(session);

    try {
        logger.debug('[codex]: client.connect begin');
        try {
            await activeClient.connect();
        } catch (error) {
            if (!usesSharedAppServer || !isCodexAppServerTransientTransportError(error)) throw error;
            logger.warn(
                '[Codex] Shared daemon Codex app-server connect failed; retrying with private stdio app-server:',
                redactDiagnosticData(error),
            );
            try {
                await activeClient.disconnect();
            } catch (disconnectError) {
                logger.debug(
                    '[Codex] Failed to disconnect stale shared app-server client:',
                    redactDiagnosticData(disconnectError),
                );
            }
            appServerClient = new CodexAppServerClient();
            usesSharedAppServer = false;
            remoteTuiEndpoint = undefined;
            activeClient = appServerClient;
            activeCodexThreadId = opts.resumeSessionId ?? appServerClient.getActiveThreadId();
            appServerClient.setThreadIdChangeHandler(handleThreadIdChange);
            appServerClient.setPermissionHandler(permissionHandler);
            appServerClient.setHandler(handleCodexClientMessage);
            await activeClient.connect();
        }
        logger.debug('[codex]: client.connect done');
        let nativeThreadBootstrap: NativeThreadBootstrap = opts.resumeSessionId
            ? { state: 'resume-pending', threadId: opts.resumeSessionId }
            : { state: 'unstarted' };
        const getAmbiguousNativeThreadBootstrapError = (): CodexAppServerAmbiguousThreadStartError | null => {
            const bootstrap = nativeThreadBootstrap as NativeThreadBootstrap;
            return bootstrap.state === 'ambiguous' ? bootstrap.error : null;
        };
        let pending: QueuedCodexMessage | null = null;
        const nativeThreadBindingResults = new Map<string, Promise<'open-tui' | 'skip-tui' | 'stop-runner'>>();
        const openedRemoteTuiThreadIds = new Set<string>();
        const pendingRemoteTuiOpenPromises = new Map<string, Promise<boolean>>();

        const publishNativeThreadBindingError = (errorMessage: string): void => {
            const safeErrorMessage = redactCodexErrorForSession(errorMessage, 'Codex thread binding failed.');
            logger.warn(`[Codex] ${safeErrorMessage}`);
            publishSessionError(safeErrorMessage, 'Codex thread binding failed.');
        };

        const bindNativeThread = (nativeThreadId: string): Promise<'open-tui' | 'skip-tui' | 'stop-runner'> => {
            const existingResult = nativeThreadBindingResults.get(nativeThreadId);
            if (existingResult) {
                return existingResult;
            }

            if (opts.startedBy !== 'daemon') {
                const skippedBinding = Promise.resolve('skip-tui' as const);
                nativeThreadBindingResults.set(nativeThreadId, skippedBinding);
                return skippedBinding;
            }

            const bindingResult = bindDaemonCodexThread({
                agent: 'codex',
                nativeThreadId,
                remcliSessionId: session.sessionId,
            }).then((result) => {
                if (!result.ok) {
                    publishNativeThreadBindingError(`Failed to bind Codex thread ${nativeThreadId} to the daemon: ${result.error}`);
                    return 'stop-runner' as const;
                }

                switch (result.data.type) {
                    case 'bound':
                    case 'already-bound':
                        return 'open-tui' as const;
                    case 'reuse-active-wrapper':
                        logger.debug(`[Codex] Native thread ${nativeThreadId} already belongs to active wrapper ${result.data.wrapper.remcliSessionId}; stopping redundant runner`);
                        return 'stop-runner' as const;
                    case 'wrapper-not-tracked':
                    case 'agent-mismatch': {
                        const errorMessage = result.data.type === 'wrapper-not-tracked'
                            ? `Codex thread ${nativeThreadId} is not tracked by the daemon.`
                            : `Codex thread ${nativeThreadId} cannot bind to ${result.data.trackedAgent} wrapper.`;
                        publishNativeThreadBindingError(errorMessage);
                        return 'stop-runner' as const;
                    }
                }
            }).catch((error) => {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                publishNativeThreadBindingError(`Failed to bind Codex thread ${nativeThreadId} to the daemon: ${errorMessage}`);
                return 'stop-runner' as const;
            });
            nativeThreadBindingResults.set(nativeThreadId, bindingResult);
            return bindingResult;
        };

        const ensureNativeThreadBinding = async (nativeThreadId: string): Promise<'open-tui' | 'skip-tui' | 'stop-runner'> => {
            const bindingResult = await bindNativeThread(nativeThreadId);
            if (bindingResult === 'stop-runner') {
                shouldExit = true;
                await handleAbort();
            }
            return bindingResult;
        };

        const openRemoteTuiAfterThreadBinding = (nativeThreadId: string): Promise<boolean> => {
            if (openedRemoteTuiThreadIds.has(nativeThreadId)) {
                return Promise.resolve(true);
            }

            const pendingOpen = pendingRemoteTuiOpenPromises.get(nativeThreadId);
            if (pendingOpen) {
                return pendingOpen;
            }

            const open = async (): Promise<boolean> => {
                const bindingResult = await ensureNativeThreadBinding(nativeThreadId);
                if (bindingResult === 'stop-runner') {
                    return false;
                }
                const endpoint = remoteTuiEndpoint;
                if (bindingResult !== 'open-tui' || !endpoint) {
                    return true;
                }

                for (let attempt = 0; attempt <= REMOTE_TUI_RETRY_DELAYS_MS.length; attempt += 1) {
                    if (attempt > 0) {
                        const delay = REMOTE_TUI_RETRY_DELAYS_MS[attempt - 1];
                        logger.debug(`[Codex] Retrying remote TUI open for thread ${nativeThreadId} after ${delay}ms.`);
                        await new Promise<void>((resolve) => setTimeout(resolve, delay));
                    }

                    const remoteTuiResult = await openDaemonCodexRemoteTui({
                        agent: 'codex',
                        nativeThreadId,
                        remcliSessionId: session.sessionId,
                        endpoint,
                        reasoningEffort: currentReasoningEffort,
                        model: currentModel,
                    });
                    if (
                        remoteTuiResult.ok
                        && (remoteTuiResult.data.type === 'opened' || remoteTuiResult.data.type === 'already-open')
                    ) {
                        openedRemoteTuiThreadIds.add(nativeThreadId);
                        return true;
                    }

                    const isRetryable = !remoteTuiResult.ok
                        || remoteTuiResult.data.type === 'host-unavailable';
                    if (isRetryable && attempt < REMOTE_TUI_RETRY_DELAYS_MS.length) {
                        continue;
                    }

                    const errorMessage = remoteTuiResult.ok
                        ? remoteTuiResult.data.type === 'host-unavailable'
                            ? remoteTuiResult.data.error ?? 'tmux host is unavailable'
                            : `Daemon rejected the Codex remote TUI request: ${remoteTuiResult.data.type}`
                        : remoteTuiResult.error;
                    publishNativeThreadBindingError(`Could not open Codex remote TUI for thread ${nativeThreadId}: ${errorMessage}`);
                    return true;
                }

                return true;
            };

            let openPromise: Promise<boolean>;
            openPromise = open().finally(() => {
                if (pendingRemoteTuiOpenPromises.get(nativeThreadId) === openPromise) {
                    pendingRemoteTuiOpenPromises.delete(nativeThreadId);
                }
            });
            pendingRemoteTuiOpenPromises.set(nativeThreadId, openPromise);
            return openPromise;
        };

        if (opts.resumeSessionId) {
            if (await ensureNativeThreadBinding(opts.resumeSessionId) === 'stop-runner') {
                return;
            }
        }

        clearScheduledDeliveryRecovery = (retryKey: string): void => {
            const scheduledRecovery = scheduledDeliveryRecoveries.get(retryKey);
            if (scheduledRecovery) {
                clearTimeout(scheduledRecovery.timeout);
                scheduledDeliveryRecoveries.delete(retryKey);
            }
            deliveryRetryAttempts.delete(retryKey);
            cancelledDeliveryKeys.delete(retryKey);
        };

        cancelScheduledDeliveryRecoveries = (): string[] => {
            const cancelledDeliveryIds: string[] = [];
            for (const [retryKey, scheduledRecovery] of scheduledDeliveryRecoveries) {
                clearTimeout(scheduledRecovery.timeout);
                scheduledDeliveryRecoveries.delete(retryKey);
                deliveryRetryAttempts.delete(retryKey);
                cancelledDeliveryKeys.add(retryKey);
                cancelledDeliveryIds.push(scheduledRecovery.deliveryId);
            }
            return cancelledDeliveryIds;
        };

        const reportDeliveryRecoveryFailure = (error: unknown): void => {
            logger.warn('[Codex] Could not recover an unacknowledged P2P delivery:', redactDiagnosticData(error));
            publishSessionError(error, 'Codex app-server recovery failed.');
        };

        const scheduleDeliveryRecovery = (
            message: QueuedCodexMessage,
            recoveryError: unknown,
        ): boolean => {
            const deliveryId = message.mode.clientUserMessageId;
            if (!deliveryId) {
                return false;
            }

            const retryKey = getDeliveryRetryKey(message);
            if (cancelledDeliveryKeys.has(retryKey) || scheduledDeliveryRecoveries.has(retryKey)) {
                return false;
            }

            const retryAttempt = deliveryRetryAttempts.get(retryKey) ?? 0;
            const retryDelay = CODEX_DELIVERY_RECOVERY_DELAYS_MS[retryAttempt];
            if (retryDelay === undefined) {
                return false;
            }

            deliveryRetryAttempts.set(retryKey, retryAttempt + 1);
            const scheduledRecovery = {
                deliveryId,
                timeout: setTimeout(() => {
                    void (async () => {
                        if (
                            scheduledDeliveryRecoveries.get(retryKey) !== scheduledRecovery
                            || shouldExit
                            || cancelledDeliveryKeys.has(retryKey)
                        ) {
                            return;
                        }

                        try {
                            await appServerClient.connect();
                        } catch (error) {
                            if (scheduledDeliveryRecoveries.get(retryKey) === scheduledRecovery) {
                                scheduledDeliveryRecoveries.delete(retryKey);
                                if (!scheduleDeliveryRecovery(message, error)) {
                                    reportDeliveryRecoveryFailure(error);
                                }
                            }
                            return;
                        }

                        if (scheduledDeliveryRecoveries.get(retryKey) === scheduledRecovery) {
                            scheduledDeliveryRecoveries.delete(retryKey);
                            session.requestPendingUserMessageRedelivery();
                        }
                    })();
                }, retryDelay),
            } satisfies ScheduledDeliveryRecovery;
            scheduledDeliveryRecoveries.set(retryKey, scheduledRecovery);
            logger.warn(`[Codex] Deferring unacknowledged delivery until app-server recovery (attempt ${retryAttempt + 1}/${CODEX_DELIVERY_RECOVERY_DELAYS_MS.length}).`);
            return true;
        };

        const handleTurnResponse = (response: CodexToolResponse) => {
            if (!response.isError) {
                return;
            }

            const errorText = publishSessionError(getCodexErrorText(response), 'Codex returned an error.');
            logger.warn('[Codex] app-server turn returned error:', errorText);
        };

        const waitForCompletion = async (completionPromise: Promise<TurnCompletionResult>): Promise<void> => {
            const completion = await completionPromise;
            if (completion.type === 'failed') {
                throw completion.error;
            }
            handleTurnResponse(completion.response);
        };

        const waitForThreadToBecomeIdle = async (
            threadId: string,
            initialTurnId: string,
            turnSignal: AbortSignal,
        ): Promise<void> => {
            let turnId = initialTurnId;
            while (true) {
                await appServerClient.waitForTurnCompletion({
                    threadId,
                    turnId,
                    signal: turnSignal,
                    interruptOnAbort: false,
                });
                const activeTurnId = appServerClient.getActiveTurnId();
                if (!activeTurnId) {
                    return;
                }
                turnId = activeTurnId;
            }
        };

        const waitForTurnWithSteering = async (
            startedTurn: StartedCodexTurn,
            threadId: string,
            originalMessageHash: string,
            turnSignal: AbortSignal,
        ): Promise<QueuedCodexMessage | null> => {
            const completionPromise: Promise<TurnCompletionResult> = startedTurn.completion.then(
                (response) => ({ type: 'completed', response }),
                (error) => ({ type: 'failed', error }),
            );
            let activeTurnId = startedTurn.turnId;

            if (!activeTurnId) {
                await waitForCompletion(completionPromise);
                return null;
            }

            while (!shouldExit) {
                const queueController = new AbortController();
                const relayAbort = () => queueController.abort();
                turnSignal.addEventListener('abort', relayAbort, { once: true });

                const queuedMessagePromise: Promise<TurnQueueResult> = messageQueue
                    .waitForMessagesAndGetAsString(queueController.signal)
                    .then((queuedMessage) => ({ type: 'queued', message: queuedMessage }));

                const result = await Promise.race<TurnQueueResult>([
                    completionPromise,
                    queuedMessagePromise,
                ]);

                queueController.abort();
                turnSignal.removeEventListener('abort', relayAbort);

                if (result.type === 'completed') {
                    handleTurnResponse(result.response);
                    const queuedAfterCompletion = await queuedMessagePromise;
                    return queuedAfterCompletion.type === 'queued'
                        ? queuedAfterCompletion.message
                        : null;
                }

                if (result.type === 'failed') {
                    throw result.error;
                }

                if (!result.message) {
                    if (turnSignal.aborted || shouldExit) {
                        await waitForCompletion(completionPromise);
                        return null;
                    }
                    continue;
                }

                if (getTurnModeHash(result.message.mode) !== originalMessageHash) {
                    logger.debug('[Codex] Message mode/model changed during active turn; deferring to next turn');
                    await waitForCompletion(completionPromise);
                    return result.message;
                }

                try {
                    activeTurnId = await appServerClient.steerTurn({
                        threadId,
                        expectedTurnId: activeTurnId,
                        prompt: result.message.message,
                        clientUserMessageId: result.message.mode.clientUserMessageId,
                    });
                    acknowledgeQueuedMessage(result.message);
                    messageBuffer.addMessage(result.message.message, 'user');
                    autoSetTitle(result.message.message);
                } catch (error) {
                    logger.warn(
                        '[Codex] turn/steer failed; deferring message to next turn:',
                        redactDiagnosticData(error),
                    );
                    const currentActiveTurnId = appServerClient.getActiveTurnId();
                    if (currentActiveTurnId && currentActiveTurnId !== activeTurnId) {
                        await waitForThreadToBecomeIdle(threadId, activeTurnId, turnSignal);
                    } else {
                        await waitForCompletion(completionPromise);
                    }
                    return result.message;
                }
            }

            await waitForCompletion(completionPromise);
            return null;
        };

        while (!shouldExit) {
            logActiveHandles('loop-top');
            // Get next batch; respect mode boundaries like Claude
            let message: QueuedCodexMessage | null = pending;
            pending = null;
            if (!message) {
                // Capture the current signal to distinguish idle-abort from queue close
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    // If wait was aborted (e.g., remote abort with no active inference), ignore and continue
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; resetting abort controller and continuing');
                        abortController = new AbortController();
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${shouldExit}`);
                    break;
                }
                message = batch;
            }

            // Defensive check for TS narrowing
            if (!message) {
                break;
            }

            if (message.mode.abortGeneration !== abortGeneration) {
                cancelQueuedMessageAfterAbort(message);
                continue;
            }

            activeDeliveryRetryKey = getDeliveryRetryKey(message);
            activeDeliveryId = message.mode.clientUserMessageId ?? null;

            try {
                const bootstrapError = getAmbiguousNativeThreadBootstrapError();
                if (bootstrapError) {
                    throw bootstrapError;
                }
                const permissionConfig = resolveCodexPermissionConfig(message.mode.permissionMode);
                const turnSignal = abortController.signal;
                let didSteerActiveTurn = false;

                // A terminal can begin a turn while the app-server websocket is
                // disconnected and Remcli is otherwise idle. Hydrate it before
                // choosing turn/start, otherwise the phone would create a
                // parallel turn and miss the terminal prompt in its chat.
                if (activeCodexThreadId) {
                    await appServerClient.hydrateThreadIfNeeded(activeCodexThreadId);
                }

                const steerActiveTurn = async (threadId: string, turnId: string): Promise<void> => {
                    try {
                        const steeredTurnId = await appServerClient.steerTurn({
                            threadId,
                            expectedTurnId: turnId,
                            prompt: message.message,
                            clientUserMessageId: message.mode.clientUserMessageId,
                        });
                        acknowledgeQueuedMessage(message);
                        messageBuffer.addMessage(message.message, 'user');
                        nativeThreadBootstrap = { state: 'ready', threadId };
                        autoSetTitle(message.message);
                        pending = await waitForTurnWithSteering({
                            turnId: steeredTurnId,
                            completion: appServerClient.waitForTurnCompletion({
                                threadId,
                                turnId: steeredTurnId,
                                signal: turnSignal,
                            }),
                        }, threadId, getTurnModeHash(message.mode), turnSignal);
                        didSteerActiveTurn = true;
                    } catch (error) {
                        if (appServerClient.getActiveTurnId() === turnId) {
                            throw error;
                        }

                        logger.debug('[Codex] Active turn changed before turn/steer could be accepted; waiting for the thread to become idle before starting the same delivery.');
                        await waitForThreadToBecomeIdle(threadId, turnId, turnSignal);
                        activeCodexThreadId = threadId;
                        nativeThreadBootstrap = { state: 'ready', threadId };
                    }
                };

                const activeTurnId = appServerClient.getActiveTurnId();
                const activeThreadId = appServerClient.getActiveThreadId();
                if (
                    activeTurnId
                    && activeThreadId
                    && activeThreadId === activeCodexThreadId
                ) {
                    if (appServerClient.isTurnInterrupting(activeTurnId)) {
                        await appServerClient.waitForInterruptedTurn({
                            threadId: activeThreadId,
                            turnId: activeTurnId,
                            signal: turnSignal,
                            timeoutMs: CODEX_INTERRUPTED_TURN_SETTLE_TIMEOUT_MS,
                        });
                    } else {
                        await steerActiveTurn(activeThreadId, activeTurnId);
                    }
                }

                if (!didSteerActiveTurn) {
                    if (nativeThreadBootstrap.state !== 'ready') {
                        try {
                            if (nativeThreadBootstrap.state === 'resume-pending') {
                                activeCodexThreadId = await appServerClient.resumeThread({
                                    threadId: nativeThreadBootstrap.threadId,
                                    cwd: process.cwd(),
                                    sandbox: permissionConfig.sandbox,
                                    approvalPolicy: permissionConfig.approvalPolicy,
                                    model: message.mode.model,
                                });
                            } else {
                                activeCodexThreadId = await appServerClient.startThread({
                                    cwd: process.cwd(),
                                    sandbox: permissionConfig.sandbox,
                                    approvalPolicy: permissionConfig.approvalPolicy,
                                    model: message.mode.model,
                                });
                            }
                        } catch (error) {
                            if (error instanceof CodexAppServerAmbiguousThreadStartError) {
                                nativeThreadBootstrap = { state: 'ambiguous', error };
                            }
                            throw error;
                        }

                        if (!activeCodexThreadId) {
                            throw new Error('Codex app-server did not provide a thread id.');
                        }
                        nativeThreadBootstrap = { state: 'ready', threadId: activeCodexThreadId };
                        if (!await openRemoteTuiAfterThreadBinding(activeCodexThreadId)) {
                            return;
                        }
                    } else {
                        activeCodexThreadId = nativeThreadBootstrap.threadId;
                    }

                    if (!activeCodexThreadId) {
                        throw new Error('Codex app-server did not provide a thread id.');
                    }

                    // A resumed native thread can already have a terminal-origin
                    // turn. Re-read after resume so the phone prompt steers that
                    // exact turn instead of starting a parallel one.
                    const resumedActiveTurnId = appServerClient.getActiveTurnId();
                    const resumedActiveThreadId = appServerClient.getActiveThreadId();
                    if (
                        resumedActiveTurnId
                        && resumedActiveThreadId === activeCodexThreadId
                    ) {
                        await steerActiveTurn(resumedActiveThreadId, resumedActiveTurnId);
                    }

                    if (didSteerActiveTurn) {
                        continue;
                    }

                    const beginTurnOptions = {
                        threadId: activeCodexThreadId,
                        prompt: message.message,
                        clientUserMessageId: message.mode.clientUserMessageId,
                        sandbox: permissionConfig.sandbox,
                        approvalPolicy: permissionConfig.approvalPolicy,
                        model: message.mode.model,
                        effort: message.mode.reasoningEffort,
                        signal: turnSignal,
                    };
                    let startedTurn: StartedCodexTurn;
                    try {
                        startedTurn = await appServerClient.beginTurn(beginTurnOptions);
                    } catch (error) {
                        if (!isCodexAppServerActiveTurnHandoffError(error)) {
                            throw error;
                        }

                        activeCodexThreadId = error.threadId;
                        beginTurnOptions.threadId = error.threadId;
                        nativeThreadBootstrap = { state: 'ready', threadId: error.threadId };
                        await steerActiveTurn(error.threadId, error.turnId);
                        if (didSteerActiveTurn) {
                            continue;
                        }
                        startedTurn = await appServerClient.beginTurn(beginTurnOptions);
                    }
                    if (!startedTurn.turnId) {
                        throw new Error('Codex app-server did not return a turn id.');
                    }
                    acknowledgeQueuedMessage(message);
                    messageBuffer.addMessage(message.message, 'user');
                    autoSetTitle(message.message);
                    pending = await waitForTurnWithSteering(
                        startedTurn,
                        activeCodexThreadId,
                        getTurnModeHash(message.mode),
                        turnSignal,
                    );
                }
            } catch (error) {
                const retryKey = getDeliveryRetryKey(message);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                const activeTurnId = appServerClient.getActiveTurnId();
                const hasInterruptBarrier = Boolean(
                    activeTurnId && appServerClient.isTurnInterrupting(activeTurnId),
                );
                const canDeferDelivery = !isAbortError
                    && isRecoverableCodexDeliveryError(error)
                    && scheduleDeliveryRecovery(message, error);
                if (canDeferDelivery) {
                    message.reject(new RetryableUserMessageDeliveryError(error));
                    logger.warn('[Codex] Waiting for a controlled app-server recovery before re-offering the same P2P delivery.');
                } else if (isAbortError || cancelledDeliveryKeys.has(retryKey)) {
                    clearScheduledDeliveryRecovery(retryKey);
                    acknowledgeQueuedMessage(message);
                    if (!hasInterruptBarrier) {
                        messageBuffer.addMessage('Aborted by user', 'status');
                        session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    }
                } else {
                    deliveryRetryAttempts.delete(retryKey);
                    message.reject(error);
                    logger.warn('Error in codex session:', redactDiagnosticData(error));

                    publishSessionError(error, 'Process exited unexpectedly');
                }
            } finally {
                activeDeliveryRetryKey = null;
                activeDeliveryId = null;
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle({
                    pending: pending ?? (scheduledDeliveryRecoveries.size > 0 ? true : null),
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
        cancelScheduledDeliveryRecoveries();
        // Clean up resources when main loop exits
        logger.debug('[codex]: Final cleanup start');
        logActiveHandles('cleanup-start');

        // Cancel offline reconnection if still running
        if (reconnectionHandle) {
            logger.debug('[codex]: Cancelling offline reconnection');
            reconnectionHandle.cancel();
        }

        try {
            logger.debug('[codex]: sendSessionDeath');
            session.sendSessionDeath();
            logger.debug('[codex]: flush begin');
            await session.flush();
            logger.debug('[codex]: flush done');
            logger.debug('[codex]: session.close begin');
            await session.close();
            logger.debug('[codex]: session.close done');
        } catch (e) {
            logger.debug('[codex]: Error while closing session', redactDiagnosticData(e));
        }
        logger.debug('[codex]: client.forceCloseSession begin');
        await activeClient?.forceCloseSession();
        logger.debug('[codex]: client.forceCloseSession done');
        // Clean up ink UI
        if (process.stdin.isTTY) {
            logger.debug('[codex]: setRawMode(false)');
            try { process.stdin.setRawMode(false); } catch { }
        }
        // Stop reading from stdin so the process can exit
        if (hasTTY) {
            logger.debug('[codex]: stdin.pause()');
            try { process.stdin.pause(); } catch { }
        }
        // Clear periodic keep-alive to avoid keeping event loop alive
        logger.debug('[codex]: clearInterval(keepAlive)');
        clearInterval(keepAliveInterval);
        if (inkInstance) {
            logger.debug('[codex]: inkInstance.unmount()');
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logActiveHandles('cleanup-end');
        logger.debug('[codex]: Final cleanup completed');
    }
}
