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
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';
import type { ApiSessionClient } from '@/api/apiSession';
import type { PermissionMode } from '@/api/types';

import { cursorQuery } from './cursorQuery';
import type { CursorMode, CursorStreamEvent } from './types';


/**
 * Main entry point for the cursor command with ink UI
 */
export async function runCursor(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
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
    let currentPermissionMode: PermissionMode | undefined = undefined;
    let currentModel: string | undefined = undefined;

    session.onUserMessage((message) => {
        let messagePermissionMode = currentPermissionMode;
        if (message.meta?.permissionMode) {
            messagePermissionMode = message.meta.permissionMode as PermissionMode;
            currentPermissionMode = messagePermissionMode;
            logger.debug(`[Cursor] Permission mode updated: ${currentPermissionMode}`);
        }

        let messageModel = currentModel;
        if (message.meta?.hasOwnProperty('model')) {
            messageModel = message.meta.model || undefined;
            currentModel = messageModel;
            logger.debug(`[Cursor] Model updated: ${messageModel || 'reset to default'}`);
        }

        const mode: CursorMode = {
            permissionMode: messagePermissionMode || 'default',
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
    let cursorSessionId: string | null = null;

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
    // Start Remcli MCP server (for change_title tool)
    // Note: Cursor agent auto-discovers MCP servers from .cursor/mcp.json
    //

    const remcliServer = await startRemcliServer(session);

    let first = true;

    try {
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: CursorMode; isolate: boolean; hash: string } | null = null;

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
                // Build prompt
                const prompt = first
                    ? message.message + '\n\n' + CHANGE_TITLE_INSTRUCTION
                    : message.message;

                // Map permission mode → Cursor CLI flags
                // default → agent mode (no extra flags)
                // plan → --mode plan (read-only planning)
                // read-only → --mode ask (Q&A, no file changes)
                // yolo / bypassPermissions → --force (auto-approve all)
                const cursorMode = (() => {
                    switch (message.mode.permissionMode) {
                        case 'plan': return 'plan' as const;
                        case 'read-only': return 'ask' as const;
                        default: return 'agent' as const;
                    }
                })();
                const cursorForce = message.mode.permissionMode === 'yolo'
                    || message.mode.permissionMode === 'bypassPermissions';

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

                for await (const event of cursorQuery({
                    prompt,
                    cwd: process.cwd(),
                    model: message.mode.model,
                    resumeSessionId: cursorSessionId || undefined,
                    abort: abortController.signal,
                    env: extraEnv,
                    mode: cursorMode,
                    force: cursorForce,
                })) {
                    handleCursorEvent(event, session, messageBuffer, accumulatedResponse);

                    // Accumulate text
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

                if (first) first = false;
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
 * Process a single Cursor NDJSON event and forward to mobile session
 */
function handleCursorEvent(
    event: CursorStreamEvent,
    session: ApiSessionClient,
    messageBuffer: MessageBuffer,
    _accumulated: string,
): void {
    switch (event.type) {
        case 'system':
            if (event.subtype === 'init') {
                logger.debug(`[Cursor] Init: model=${event.model}, session=${event.session_id}`);
                if (event.model) {
                    messageBuffer.addMessage(`Model: ${event.model}`, 'system');
                }
            }
            break;

        case 'assistant':
            if (event.message?.content) {
                for (const part of event.message.content) {
                    if (part.type === 'text') {
                        messageBuffer.addMessage(part.text, 'assistant');
                    }
                }
            }
            if (event.text_delta) {
                messageBuffer.updateLastMessage(event.text_delta, 'assistant');
            }
            break;

        case 'tool_call':
            if (event.subtype === 'started' && event.tool_call) {
                // Cursor tool_call format: { readToolCall: { args: {...} } } or { writeToolCall: { args: {...} } }
                const toolEntries = Object.entries(event.tool_call);
                const toolName = toolEntries.length > 0 ? toolEntries[0][0] : 'unknown';
                const toolData = toolEntries.length > 0 ? toolEntries[0][1] as Record<string, unknown> : {};
                const toolArgs = (toolData?.args ?? toolData) as Record<string, unknown>;
                const inputPreview = JSON.stringify(toolArgs).substring(0, 100);
                messageBuffer.addMessage(`Executing: ${toolName} ${inputPreview}`, 'tool');

                session.sendAgentMessage('cursor', {
                    type: 'tool-call',
                    name: toolName,
                    callId: event.call_id || randomUUID(),
                    input: toolArgs,
                    id: randomUUID(),
                });
            } else if (event.subtype === 'completed' && event.tool_call) {
                // Extract result from tool_call structure
                const toolEntries = Object.entries(event.tool_call);
                const toolData = toolEntries.length > 0 ? toolEntries[0][1] as Record<string, unknown> : {};
                const resultText = toolData?.result ? JSON.stringify(toolData.result).substring(0, 200) : 'Completed';
                messageBuffer.addMessage(`Result: ${resultText}`, 'result');

                session.sendAgentMessage('cursor', {
                    type: 'tool-result',
                    callId: event.call_id || randomUUID(),
                    output: toolData?.result ? JSON.stringify(toolData.result) : event.result,
                    id: randomUUID(),
                });
            }
            break;

        case 'result':
            if (event.subtype === 'success') {
                if (event.duration_ms) {
                    const seconds = (event.duration_ms / 1000).toFixed(1);
                    messageBuffer.addMessage(`Completed in ${seconds}s`, 'status');
                }
            }
            break;

        default:
            logger.debug(`[cursor] Unhandled event type: ${event.type}`);
            break;
    }
}
