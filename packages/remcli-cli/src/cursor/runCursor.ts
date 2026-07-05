/**
 * Cursor CLI Entry Point
 *
 * Main entry point for running Cursor agent through Remcli.
 * Manages the agent lifecycle, session state, and communication
 * with the Remcli server and mobile app.
 *
 * Follows the same pattern as runCodex.ts / runGemini.ts:
 * session setup → message queue → UI → main loop → cleanup
 */

import { render } from 'ink';
import React from 'react';
import { randomUUID } from 'node:crypto';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { Credentials, readSettings } from '@/persistence';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { startRemcliServer } from '@/claude/utils/startRemcliServer';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import type { ApiSessionClient } from '@/api/apiSession';
import type { CursorPermissionMode, PermissionMode } from '@/api/types';

import { createAutoTitleSetter } from '@/utils/autoSessionTitle';
import { cursorQuery } from './cursorQuery';
import type { CursorMode, CursorStreamEvent } from './types';

function isCursorPermissionMode(mode: PermissionMode): mode is CursorPermissionMode {
    return mode === 'agent'
        || mode === 'plan'
        || mode === 'ask'
        || mode === 'force'
        || mode === 'auto-review';
}

/**
 * Main entry point for the cursor command with ink UI
 */
export async function runCursor(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    resumeSessionId?: string;
}): Promise<void> {
    //
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings
    connectionState.setBackend('Cursor');

    const api = await ApiClient.create(opts.credentials);

    //
    // Machine
    //

    const settings = await readSettings();
    const machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings. Make sure daemon is running: remcli daemon start`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    //
    // Create session
    //

    const { state, metadata } = createSessionMetadata({
        flavor: 'cursor',
        machineId,
        startedBy: opts.startedBy,
    });
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });

    // Handle server unreachable — create offline stub with hot reconnection
    let session: ApiSessionClient;

    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata,
        state,
        response,
        onSessionSwap: (newSession) => {
            session = newSession;
        },
    });
    session = initialSession;

    // Report to daemon
    if (response) {
        try {
            logger.debug(`[START] Reporting session ${response.id} to daemon`);
            const result = await notifyDaemonSessionStarted(response.id, metadata);
            if (result.error) {
                logger.debug(`[START] Failed to report to daemon:`, result.error);
            }
        } catch (error) {
            logger.debug('[START] Failed to report to daemon:', error);
        }
    }

    const messageQueue = new MessageQueue2<CursorMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
    }));

    // Track current overrides
    let currentPermissionMode: CursorPermissionMode | undefined = undefined;
    let currentModel: string | undefined = undefined;

    session.onUserMessage((message) => {
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            const requestedMode = message.meta.permissionMode as PermissionMode;
            if (isCursorPermissionMode(requestedMode)) {
                messagePermissionMode = requestedMode;
                currentPermissionMode = messagePermissionMode;
                logger.debug(`[Cursor] Permission mode updated: ${currentPermissionMode}`);
            } else {
                logger.debug(`[Cursor] Ignoring unsupported permission mode: ${requestedMode}`);
            }
        }

        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Cursor] Model updated: ${messageModel || 'reset to default'}`);
        }

        const mode: CursorMode = {
            permissionMode: messagePermissionMode || 'agent',
            model: messageModel,
        };
        messageQueue.push(message.content.text, mode);
    });

    let thinking = false;
    session.keepAlive(thinking, 'remote');
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(thinking, 'remote');
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
    };

    //
    // Abort handling
    //

    let abortController = new AbortController();
    let shouldExit = false;
    // Seed with the resume target so the first cursorQuery is spawned with --resume.
    // Cursor rewrites the session id via the `init` system event, updating this afterwards.
    let cursorSessionId: string | null = opts.resumeSessionId ?? null;
    if (cursorSessionId) {
        logger.debug(`[Cursor] Resuming session: ${cursorSessionId}`);
    }

    async function handleAbort() {
        logger.debug('[Cursor] Abort requested');
        try {
            abortController.abort();
            logger.debug('[Cursor] Abort completed');
        } catch (error) {
            logger.debug('[Cursor] Error during abort:', error);
        } finally {
            abortController = new AbortController();
        }
    }

    const handleKillSession = async () => {
        logger.debug('[Cursor] Kill session requested');
        await handleAbort();

        try {
            if (session) {
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated',
                }));

                session.sendSessionDeath();
                await session.flush();
                await session.close();
            }

            stopCaffeinate();
            remcliServer.stop();

            logger.debug('[Cursor] Session termination complete, exiting');
            process.exit(0);
        } catch (error) {
            logger.debug('[Cursor] Error during session termination:', error);
            process.exit(1);
        }
    };

    session.rpcHandlerManager.registerHandler('abort', handleAbort);
    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    //
    // Initialize Ink UI (reuse CodexDisplay)
    //

    const messageBuffer = new MessageBuffer();
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    let inkInstance: ReturnType<typeof render> | null = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(CodexDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? logger.getLogPath() : undefined,
            agentLabel: 'Cursor Agent',
            onExit: async () => {
                logger.debug('[cursor]: Exiting agent via Ctrl-C');
                shouldExit = true;
                await handleAbort();
            },
        }), {
            exitOnCtrlC: false,
            patchConsole: false,
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding('utf8');
    }

    //
    // Start Remcli MCP server (for RPC tools)
    // Note: Cursor auto-discovers MCP from .cursor/mcp.json — change_title not available
    //

    const remcliServer = await startRemcliServer(session);

    try {
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: CursorMode; isolate: boolean; hash: string } | null = null;
        const autoSetTitle = createAutoTitleSetter(session);

        while (!shouldExit) {
            let message: { message: string; mode: CursorMode; isolate: boolean; hash: string } | null = pending;
            pending = null;

            if (!message) {
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    if (waitSignal.aborted && !shouldExit) {
                        logger.debug('[cursor] Wait aborted while idle, continuing');
                        continue;
                    }
                    break;
                }
                message = batch;
            }

            if (!message) break;

            // Mode change → reset cursor session
            if (currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Cursor] Mode changed – resetting session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Cursor session (mode changed)...', 'status');
                cursorSessionId = null;
            }

            currentModeHash = message.hash;
            messageBuffer.addMessage(message.message, 'user');

            try {
                // Build prompt (no CHANGE_TITLE_INSTRUCTION — Cursor doesn't have access to remcli MCP server)
                const prompt = message.message;

                // Map permission mode → Cursor CLI flags.
                const cursorMode = (() => {
                    switch (message.mode.permissionMode) {
                        case 'plan': return 'plan' as const;
                        case 'ask': return 'ask' as const;
                        default: return 'agent' as const;
                    }
                })();
                const cursorForce = message.mode.permissionMode === 'force';
                const cursorAutoReview = message.mode.permissionMode === 'auto-review';

                // Show active mode in terminal
                const modeLabel = cursorMode === 'plan'
                    ? 'Plan'
                    : cursorMode === 'ask'
                        ? 'Ask'
                        : cursorForce
                            ? 'Agent + Force'
                            : cursorAutoReview
                                ? 'Agent + Auto-review'
                                : 'Agent';
                messageBuffer.addMessage(`Mode: ${modeLabel}`, 'system');
                logger.debug(`[Cursor] Spawning with mode=${cursorMode} force=${cursorForce} autoReview=${cursorAutoReview} permissionMode=${message.mode.permissionMode}`);

                const extraEnv: Record<string, string> = {};

                // Send task_started
                session.sendAgentMessage('cursor', {
                    type: 'task_started',
                    id: randomUUID(),
                });
                thinking = true;
                session.keepAlive(thinking, 'remote');

                // Iterate NDJSON events from cursor agent
                let accumulatedResponse = '';
                isStreamingAssistant = false;

                for await (const event of cursorQuery({
                    prompt,
                    cwd: process.cwd(),
                    model: message.mode.model,
                    resumeSessionId: cursorSessionId || undefined,
                    abort: abortController.signal,
                    env: extraEnv,
                    mode: cursorMode,
                    force: cursorForce,
                    autoReview: cursorAutoReview,
                })) {
                    // Debug: log every event type for diagnosis
                    logger.debug(`[Cursor] Event: type=${event.type} subtype=${event.subtype ?? '-'} hasContent=${!!event.message?.content} hasTextDelta=${!!event.text_delta} hasText=${!!event.text}`);

                    handleCursorEvent(event, messageBuffer);

                    // Accumulate text ONLY from assistant events (not thinking — user doesn't want reasoning)
                    if (event.type === 'assistant' && event.message?.content) {
                        for (const part of event.message.content) {
                            if (part.type === 'text') {
                                accumulatedResponse += part.text;
                            }
                        }
                    }
                    if (event.type === 'assistant' && event.text_delta) {
                        accumulatedResponse += event.text_delta;
                    }
                    if (event.type === 'assistant' && event.text) {
                        accumulatedResponse += event.text;
                    }

                    // Capture session ID
                    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
                        cursorSessionId = event.session_id;
                        logger.debug(`[Cursor] Session ID: ${cursorSessionId}`);
                    }
                }

                // Send accumulated message to mobile
                if (accumulatedResponse.trim()) {
                    session.sendAgentMessage('cursor', {
                        type: 'message',
                        message: accumulatedResponse,
                    });
                }

                // Task complete
                session.sendAgentMessage('cursor', {
                    type: 'task_complete',
                    id: randomUUID(),
                });

                // Auto-set session title from first user message
                // (Cursor can't call change_title MCP tool like Claude/Gemini/Codex)
                autoSetTitle(message.message);

            } catch (error) {
                logger.debug('[cursor] Error in cursor session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                } else {
                    const errorMsg = error instanceof Error ? error.message : String(error);

                    // Check for command not found
                    if (errorMsg.includes('ENOENT') || errorMsg.includes('not found')) {
                        messageBuffer.addMessage(
                            'Cursor CLI ("agent") not found. Make sure it is installed and in your PATH.',
                            'status',
                        );
                    } else {
                        messageBuffer.addMessage(`Error: ${errorMsg}`, 'status');
                    }

                    session.sendAgentMessage('cursor', {
                        type: 'message',
                        message: `Error: ${errorMsg}`,
                    });
                }
            } finally {
                thinking = false;
                session.keepAlive(thinking, 'remote');
                sendReady();
            }
        }
    } finally {
        logger.debug('[cursor]: Final cleanup start');

        if (reconnectionHandle) {
            reconnectionHandle.cancel();
        }

        try {
            session.sendSessionDeath();
            await session.flush();
            await session.close();
        } catch (e) {
            logger.debug('[cursor]: Error while closing session', e);
        }

        remcliServer.stop();

        if (process.stdin.isTTY) {
            try { process.stdin.setRawMode(false); } catch { /* ignore */ }
        }
        if (hasTTY) {
            try { process.stdin.pause(); } catch { /* ignore */ }
        }

        clearInterval(keepAliveInterval);
        if (inkInstance) {
            inkInstance.unmount();
        }
        messageBuffer.clear();

        logger.debug('[cursor]: Final cleanup completed');
    }
}


/**
 * Tracks whether the last event added to messageBuffer was an assistant text_delta.
 * When a non-assistant event interrupts the stream, we reset this so the next
 * text_delta creates a new message instead of appending to a stale one.
 */
let isStreamingAssistant = false;

/**
 * Extract a short human-readable label from a Cursor tool_call object.
 * Cursor format: { readToolCall: { args: { path: "..." } } }
 * Returns e.g. "read_file src/index.ts" or "edit_file package.json"
 */
function formatToolLabel(toolCall: Record<string, unknown>): { name: string; summary: string } {
    const entries = Object.entries(toolCall);
    if (entries.length === 0) return { name: 'unknown', summary: '' };

    const [rawName, rawData] = entries[0];
    const data = rawData as Record<string, unknown> | undefined;
    const args = (data?.args ?? data ?? {}) as Record<string, unknown>;

    // Simplify common tool names: readToolCall → read, editToolCall → edit, etc.
    const name = rawName.replace(/ToolCall$/i, '').replace(/Tool$/i, '');

    // Pick the most useful arg for a short summary (path, file_path, command, query)
    const hint = args.path ?? args.file_path ?? args.filePath ?? args.command ?? args.query ?? '';
    const summary = typeof hint === 'string' ? hint.slice(0, 80) : '';

    return { name, summary };
}

/**
 * Process a single Cursor NDJSON event and update terminal display.
 * Tool calls are NOT forwarded to mobile — only the final assistant message is sent.
 */
function handleCursorEvent(
    event: CursorStreamEvent,
    messageBuffer: MessageBuffer,
): void {
    switch (event.type) {
        case 'system':
            isStreamingAssistant = false;
            if (event.subtype === 'init') {
                logger.debug(`[Cursor] Init: model=${event.model}, session=${event.session_id}`);
                if (event.model) {
                    messageBuffer.addMessage(`Model: ${event.model}`, 'system');
                }
            }
            break;

        case 'assistant':
            // Full message content — start a new assistant block
            if (event.message?.content) {
                for (const part of event.message.content) {
                    if (part.type === 'text') {
                        messageBuffer.addMessage(part.text, 'assistant');
                        isStreamingAssistant = true;
                    }
                }
            }
            // Streaming delta — append to current block only if we're mid-stream
            if (event.text_delta) {
                if (isStreamingAssistant) {
                    messageBuffer.updateLastMessage(event.text_delta, 'assistant');
                } else {
                    messageBuffer.addMessage(event.text_delta, 'assistant');
                    isStreamingAssistant = true;
                }
            }
            // Standalone text (no delta, no content array)
            if (event.text && !event.text_delta && !event.message?.content) {
                messageBuffer.addMessage(event.text, 'assistant');
                isStreamingAssistant = true;
            }
            break;

        case 'thinking':
            // Skip thinking/reasoning in UI — user doesn't want to see model reasoning
            logger.debug(`[Cursor] Thinking event (suppressed from UI)`);
            break;

        case 'tool_call':
            isStreamingAssistant = false;
            if (event.subtype === 'started' && event.tool_call) {
                const { name, summary } = formatToolLabel(event.tool_call);
                // Terminal: short one-liner
                messageBuffer.addMessage(`${name}${summary ? ' ' + summary : ''}`, 'tool');
            } else if (event.subtype === 'completed' && event.tool_call) {
                const toolData = Object.values(event.tool_call)[0] as Record<string, unknown> | undefined;
                logger.debug(`[Cursor] Tool completed: ${JSON.stringify(toolData?.result).substring(0, 200)}`);
            }
            // No tool-call/tool-result sent to mobile — Cursor's tool details are too verbose
            // and not useful on a phone screen. The final assistant message is enough.
            break;

        case 'result':
            isStreamingAssistant = false;
            if (event.subtype === 'success') {
                if (event.duration_ms) {
                    const seconds = (event.duration_ms / 1000).toFixed(1);
                    messageBuffer.addMessage(`Completed in ${seconds}s`, 'status');
                }
            }
            break;

        default:
            isStreamingAssistant = false;
            logger.debug(`[cursor] Unhandled event type: ${event.type}`);
            break;
    }
}
