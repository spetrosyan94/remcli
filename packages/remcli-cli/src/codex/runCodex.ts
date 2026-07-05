import { render } from "ink";
import React from "react";
import { ApiClient } from '@/api/api';
import { CodexAppServerClient } from './codexAppServerClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Credentials, readDaemonState, readSettings } from '@/persistence';
import { configuration } from '@/configuration';
import packageJson from '../../package.json';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { CodexDisplay } from "@/ui/ink/CodexDisplay";
import { notifyDaemonSessionStarted } from "@/daemon/controlClient";
import { registerKillSessionHandler } from "@/claude/registerKillSessionHandler";
import { delay } from "@/utils/time";
import { stopCaffeinate } from "@/utils/caffeinate";
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { createAutoTitleSetter } from '@/utils/autoSessionTitle';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';
import { replayCodexSessionHistory } from './utils/replayCodexSessionHistory';
import type { CodexApprovalPolicy, CodexSandbox, CodexToolResponse } from './types';
import { isCodexAppServerStateUsable } from './codexAppServerHost';
import { createCodexRemoteTuiOpener } from './codexRemoteTui';

type ReadyEventOptions = {
    pending: unknown;
    queueSize: () => number;
    shouldExit: boolean;
    sendReady: () => void;
    notify?: () => void;
};

export const CODEX_DEFAULT_PERMISSION_MODE: CodexSandbox = 'workspace-write';

interface CodexPermissionConfig {
    approvalPolicy: CodexApprovalPolicy;
    sandbox: CodexSandbox;
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
}): Promise<void> {
    interface EnhancedMode {
        permissionMode: CodexSandbox;
        model?: string;
    }
    type QueuedCodexMessage = { message: string; mode: EnhancedMode; isolate: boolean; hash: string };
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

    // Handle server unreachable case - create offline stub with hot reconnection
    let session: ApiSessionClient;
    // Permission handler declared here so it can be updated in onSessionSwap callback
    // (assigned later at line ~385 after client setup)
    let permissionHandler: CodexPermissionHandler;
    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
            // Update permission handler with new session to avoid stale reference
            if (permissionHandler) {
                permissionHandler.updateSession(newSession);
            }
        }
    });
    session = initialSession;

    // Always report to daemon if it exists (skip if offline)
    if (response) {
        try {
            logger.debug(`[START] Reporting session ${response.id} to daemon`);
            const result = await notifyDaemonSessionStarted(response.id, metadata);
            if (result.error) {
                logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
            } else {
                logger.debug(`[START] Reported session ${response.id} to daemon`);
            }
        } catch (error) {
            logger.debug('[START] Failed to report to daemon (may not be running):', error);
        }
    }

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    // Track current overrides to apply per message
    // Use shared PermissionMode type from api/types for cross-agent compatibility
    let currentPermissionMode: CodexSandbox | undefined = undefined;
    let currentModel: string | undefined = undefined;

    session.onUserMessage((message) => {
        if (message.meta?.sentFrom === 'history') {
            logger.debug('[Codex] Ignoring replayed user message from session history');
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
                session.sendSessionEvent({ type: 'message', message: errorText, isError: true });
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
        };
        messageQueue.push(message.content.text, enhancedMode);
    });
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
            abortController.abort();
            reasoningProcessor.abort();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
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
                logger.debug('[Codex] Error while force closing Codex session during termination', e);
            }

            // Stop caffeinate
            stopCaffeinate();

            logger.debug('[Codex] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Codex] Error during session termination:', error);
            process.exit(1);
        }
    };

    // Register abort handler
    session.rpcHandlerManager.registerHandler('abort', handleAbort);

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI
    //

    const messageBuffer = new MessageBuffer();
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
        logger.debug(`[Codex] app-server message: ${JSON.stringify(msg)}`);

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
            const errorMessage = msg.message ?? 'Codex app-server error.';
            messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');
            session.sendSessionEvent({ type: 'message', message: errorMessage, isError: true });
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
            if (!usesSharedAppServer) throw error;
            logger.warn('[Codex] Shared daemon Codex app-server connect failed; retrying with private stdio app-server:', error);
            try {
                await activeClient.disconnect();
            } catch (disconnectError) {
                logger.debug('[Codex] Failed to disconnect stale shared app-server client:', disconnectError);
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
        let wasCreated = false;
        let pending: QueuedCodexMessage | null = null;
        const remoteTuiOpener = createCodexRemoteTuiOpener({
            startedBy: opts.startedBy,
            getEndpoint: () => remoteTuiEndpoint,
        });

        if (opts.resumeSessionId) {
            remoteTuiOpener.openOnce(opts.resumeSessionId);
        }

        const handleTurnResponse = (response: CodexToolResponse) => {
            if (!response.isError) {
                return;
            }

            const errorText = getCodexErrorText(response);
            logger.warn('[Codex] app-server turn returned error:', errorText);
            messageBuffer.addMessage(`Error: ${errorText}`, 'status');
            session.sendSessionEvent({ type: 'message', message: errorText, isError: true });
        };

        const waitForCompletion = async (completionPromise: Promise<TurnCompletionResult>): Promise<void> => {
            const completion = await completionPromise;
            if (completion.type === 'failed') {
                throw completion.error;
            }
            handleTurnResponse(completion.response);
        };

        const waitForTurnWithSteering = async (
            startedTurn: Awaited<ReturnType<CodexAppServerClient['beginTurn']>>,
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
                    return null;
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

                if (result.message.hash !== originalMessageHash) {
                    logger.debug('[Codex] Message mode/model changed during active turn; deferring to next turn');
                    await waitForCompletion(completionPromise);
                    return result.message;
                }

                try {
                    activeTurnId = await appServerClient.steerTurn({
                        threadId,
                        expectedTurnId: activeTurnId,
                        prompt: result.message.message,
                    });
                    messageBuffer.addMessage(result.message.message, 'user');
                    autoSetTitle(result.message.message);
                } catch (error) {
                    logger.warn('[Codex] turn/steer failed; deferring message to next turn:', error);
                    await waitForCompletion(completionPromise);
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

            // Display user messages in the UI
            messageBuffer.addMessage(message.message, 'user');

            try {
                const permissionConfig = resolveCodexPermissionConfig(message.mode.permissionMode);

                if (!wasCreated) {
                    if (opts.resumeSessionId) {
                        activeCodexThreadId = await appServerClient.resumeThread({
                            threadId: opts.resumeSessionId,
                            cwd: process.cwd(),
                            sandbox: permissionConfig.sandbox,
                            approvalPolicy: permissionConfig.approvalPolicy,
                            model: message.mode.model,
                        });
                        remoteTuiOpener.openOnce(activeCodexThreadId);
                    } else {
                        activeCodexThreadId = await appServerClient.startThread({
                            cwd: process.cwd(),
                            sandbox: permissionConfig.sandbox,
                            approvalPolicy: permissionConfig.approvalPolicy,
                            model: message.mode.model,
                        });
                        remoteTuiOpener.openOnce(activeCodexThreadId);
                    }
                    wasCreated = true;
                }

                if (!activeCodexThreadId) {
                    throw new Error('Codex app-server did not provide a thread id.');
                }

                autoSetTitle(message.message);
                const turnSignal = abortController.signal;
                const startedTurn = await appServerClient.beginTurn({
                    threadId: activeCodexThreadId,
                    prompt: message.message,
                    sandbox: permissionConfig.sandbox,
                    approvalPolicy: permissionConfig.approvalPolicy,
                    model: message.mode.model,
                    signal: turnSignal,
                });
                pending = await waitForTurnWithSteering(startedTurn, activeCodexThreadId, message.hash, turnSignal);
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                
                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    // Abort cancels the current task/inference but keeps the Codex session alive.
                    // Do not clear session state here; the next user message should continue on the
                    // existing session if possible.
                } else {
                    const errorMessage = error instanceof Error ? error.message : 'Process exited unexpectedly';
                    messageBuffer.addMessage(`Error: ${errorMessage}`, 'status');
                    session.sendSessionEvent({ type: 'message', message: errorMessage, isError: true });
                }
            } finally {
                // Reset permission handler, reasoning processor, and diff processor
                permissionHandler.reset();
                reasoningProcessor.abort();  // Use abort to properly finish any in-progress tool calls
                diffProcessor.reset();
                thinking = false;
                session.keepAlive(thinking, 'remote');
                emitReadyIfIdle({
                    pending,
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    sendReady,
                });
                logActiveHandles('after-turn');
            }
        }

    } finally {
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
            logger.debug('[codex]: Error while closing session', e);
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
