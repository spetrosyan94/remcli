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
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { stopCaffeinate } from '@/utils/caffeinate';
import { connectionState } from '@/utils/serverConnectionErrors';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import {
    acquireDaemonRunnerCredential,
    reportTerminalSessionStarted,
} from '@/utils/daemonRunnerCredentialBootstrap';
import { redactDiagnosticData } from '@/utils/redaction';
import {
    acquireDaemonCursorHeadlessWriterLease,
    bindDaemonCursorSession,
    preflightDaemonCursorRunner,
    releaseDaemonCursorNativeWriterLease,
    reportDaemonRunnerStopped,
    reportDaemonRunnerStopping,
} from '@/daemon/controlClient';
import type { CursorNativeWriterLease } from '@/daemon/types';
import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';
import {
    isCursorRunnerIdentity,
    verifyCursorRunnerIdentity,
    type CursorExecutionConfig,
    type CursorRunnerIdentity,
} from './cursorCapabilities';
import {
    DEFAULT_CURSOR_LAUNCH_CONTROLS,
    isCursorLaunchControls,
    type CursorLaunchControls,
} from './cursorLaunchControls';

import { createAutoTitleSetter } from '@/utils/autoSessionTitle';
import {
    CursorTurnError,
    isCursorTurnAbortError,
    runCursorTurn,
    type CursorTurnOutcome,
} from './cursorQuery';
import { type CursorMode, type CursorStreamEvent } from './types';

const LIFECYCLE_METADATA_UPDATE_OPTIONS = {
    maxAttempts: 2,
    timeoutMs: 1_000,
} as const;

const MAX_PROVISIONAL_PARENT_ROLLBACK_UPDATES = 2;
const DAEMON_EXECUTION_SELECTION_REQUIRED_ERROR = 'Cursor daemon runner requires a validated execution and control selection.';

function withoutResumedFromRemcliSessionId(metadata: Metadata): Metadata {
    const updatedMetadata = { ...metadata };
    delete updatedMetadata.resumedFromRemcliSessionId;
    return updatedMetadata;
}

/**
 * Main entry point for the cursor command with ink UI
 */
export async function runCursor(opts: {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    resumeSessionId?: string;
    execution?: CursorExecutionConfig;
    launchControls?: CursorLaunchControls;
    runner?: CursorRunnerIdentity;
}): Promise<void> {
    // Define session
    //

    const sessionTag = randomUUID();

    // Set backend for offline warnings
    connectionState.setBackend('Cursor');

    const settings = await readSettings();
    const machineId = settings?.machineId;
    if (!machineId) {
        console.error(`[START] No machine ID found in settings. Make sure daemon is running: remcli daemon start`);
        process.exit(1);
    }
    logger.debug(`Using machineId: ${machineId}`);

    if (opts.startedBy === 'daemon'
        && process.env.REMCLI_DAEMON_RUNNER_TOKEN
        && (!opts.execution
            || !opts.launchControls
            || !opts.runner
            || !isCursorLaunchControls(opts.launchControls)
            || !isCursorRunnerIdentity(opts.runner))) {
        logger.warn(`[Cursor] ${DAEMON_EXECUTION_SELECTION_REQUIRED_ERROR}`);
        return;
    }

    let trustedStartedBy: 'daemon' | 'terminal' | undefined;
    let resumedFromRemcliSessionId: string | undefined;
    if (opts.startedBy === 'daemon') {
        try {
            if (process.env.REMCLI_DAEMON_RUNNER_TOKEN
                && (!opts.runner || !await verifyCursorRunnerIdentity(opts.runner))) {
                logger.debug('[Cursor] Daemon runner CLI identity did not match capability validation.');
                return;
            }
            const runnerPreflight = await preflightDaemonCursorRunner({
                agent: 'cursor',
                nativeResumeSessionId: opts.resumeSessionId,
                pid: process.pid,
            });
            if (!runnerPreflight.ok || runnerPreflight.data.type !== 'verified') {
                logger.debug('[Cursor] Daemon runner preflight rejected.');
                return;
            }
            trustedStartedBy = 'daemon';
            resumedFromRemcliSessionId = runnerPreflight.data.parentRemcliSessionId;
        } catch {
            logger.debug('[Cursor] Daemon runner preflight failed.');
            return;
        }
    } else {
        trustedStartedBy = opts.startedBy;
    }

    //
    // Create session
    //

    const { state, metadata: baseMetadata } = createSessionMetadata({
        flavor: 'cursor',
        machineId,
        startedBy: trustedStartedBy,
    });
    // The daemon returns a parent only after it verified the runner capability,
    // native Cursor lineage, and workspace. Publish that verified relation with
    // the child session so the P2P client can load the parent history before
    // Cursor receives its first child prompt and emits system/init.
    const initialMetadata: Metadata = resumedFromRemcliSessionId
        ? { ...baseMetadata, resumedFromRemcliSessionId }
        : baseMetadata;
    // `getOrCreateSession` publishes this exact first snapshot. Reconnection
    // needs its own mutable template so a failed native resume cannot mutate
    // the already-published request object while still preventing future swaps
    // from recreating a provisional parent relation.
    const reconnectMetadata: Metadata = { ...initialMetadata };
    const api = await ApiClient.create(opts.credentials);
    const response = await api.getOrCreateSession({ tag: sessionTag, metadata: initialMetadata, state });

    if (trustedStartedBy === 'daemon') {
        if (!response) {
            logger.warn('[Cursor] Daemon-owned runner cannot start without a P2P session for credential handoff.');
            return;
        }
        if (!await acquireDaemonRunnerCredential({ agentName: 'Cursor', sessionId: response.id, metadata: initialMetadata })) {
            return;
        }
    } else if (response) {
        await reportTerminalSessionStarted({ agentName: 'Cursor', sessionId: response.id, metadata: initialMetadata });
    }

    // Handle server unreachable — create offline stub with hot reconnection
    let session: ApiSessionClient;
    let bindSessionHandlers: ((target: ApiSessionClient) => void) | null = null;
    let scheduleParentRelationRollbackForSession: ((target: ApiSessionClient) => Promise<void>) | null = null;

    const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
        api,
        sessionTag,
        metadata: reconnectMetadata,
        state,
        response,
        canCreateReconnectedSessionConsumer: trustedStartedBy === 'daemon'
            ? async (reconnectedSession) => acquireDaemonRunnerCredential({
                agentName: 'Cursor',
                sessionId: reconnectedSession.id,
                metadata: reconnectMetadata,
            })
            : undefined,
        onSessionSwap: (newSession) => {
            session = newSession;
            bindSessionHandlers?.(newSession);
            // A reconnect may have begun before the local metadata template was
            // sanitized. Queue a bounded cleanup for that replacement session.
            void scheduleParentRelationRollbackForSession?.(newSession).catch((error) => {
                logger.debug('[Cursor] Error while rolling back parent lineage after reconnect:', redactDiagnosticData(error));
            });
        },
    });
    session = initialSession;

    const messageQueue = new MessageQueue2<CursorMode>((mode) => hashObject({
        launchControls: mode.launchControls,
        model: mode.model,
    }));

    // Native launch controls and account-validated model are session-level
    // selection. A phone message never changes the daemon-owned runner.
    const currentLaunchControls = opts.launchControls ?? DEFAULT_CURSOR_LAUNCH_CONTROLS;
    const currentModel = opts.execution?.model;

    const createUserMessageHandler = (target: ApiSessionClient) => (message: Parameters<ApiSessionClient['onUserMessage']>[0] extends (value: infer T) => unknown ? T : never) => {
        const messageMeta = message.meta;
        if (messageMeta?.permissionMode) {
            logger.warn('[Cursor] Ignoring generic per-message permission override; launch controls are fixed for this session.');
        }

        if (Object.prototype.hasOwnProperty.call(messageMeta ?? {}, 'model')) {
            logger.warn('[Cursor] Ignoring per-message model override; the selected Cursor model is fixed for this session.');
        }

        const mode: CursorMode = {
            launchControls: currentLaunchControls,
            model: currentModel,
        };
        messageQueue.push(message.content.text, mode);
    };

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
    let activeTurn: Promise<CursorTurnOutcome> | null = null;
    // The daemon-verified parent is visible immediately. Cursor still has to
    // confirm the requested native resume before its native ID is promoted.
    let cursorSessionId: string | null = null;
    let requestedResumeSessionId = opts.resumeSessionId;
    let initialParentRelationState: 'none' | 'pending' | 'confirmed' | 'rolled-back' = (
        resumedFromRemcliSessionId ? 'pending' : 'none'
    );
    if (requestedResumeSessionId) {
        logger.debug(`[Cursor] Resume requested for session: ${requestedResumeSessionId}`);
    }

    const shouldPublishParentRelation = (): boolean => (
        initialParentRelationState === 'confirmed'
    );

    let parentRelationRollbackPromise: Promise<void> = Promise.resolve();
    let parentRelationRollbackTarget: ApiSessionClient | null = null;
    let parentRelationRollbackUpdateCount = 0;

    const queueParentRelationRollback = (targetSession: ApiSessionClient): Promise<void> => {
        if (parentRelationRollbackTarget === targetSession
            || parentRelationRollbackUpdateCount >= MAX_PROVISIONAL_PARENT_ROLLBACK_UPDATES) {
            return parentRelationRollbackPromise;
        }

        parentRelationRollbackTarget = targetSession;
        parentRelationRollbackUpdateCount += 1;
        parentRelationRollbackPromise = parentRelationRollbackPromise
            .catch((error) => {
                logger.debug('[Cursor] Previous parent lineage rollback failed:', redactDiagnosticData(error));
            })
            .then(() => targetSession.updateMetadata(
                withoutResumedFromRemcliSessionId,
                LIFECYCLE_METADATA_UPDATE_OPTIONS,
            ));

        return parentRelationRollbackPromise;
    };

    const awaitQueuedParentRelationRollback = async (): Promise<void> => {
        for (let attempt = 0; attempt < MAX_PROVISIONAL_PARENT_ROLLBACK_UPDATES; attempt += 1) {
            const queuedRollback = parentRelationRollbackPromise;
            await queuedRollback;
            if (queuedRollback === parentRelationRollbackPromise) {
                return;
            }
        }
    };

    scheduleParentRelationRollbackForSession = (targetSession) => {
        if (initialParentRelationState !== 'rolled-back') {
            return Promise.resolve();
        }
        return queueParentRelationRollback(targetSession);
    };

    const confirmInitialParentRelation = (nativeSessionId: string): void => {
        // A shutdown that has already begun must win over a late init event.
        if (shouldExit || initialParentRelationState !== 'pending') {
            return;
        }

        if (nativeSessionId !== requestedResumeSessionId) {
            throw new CursorTurnError(
                'resume-mismatch',
                'Cursor resumed a different native session. The existing session was not changed.',
            );
        }

        initialParentRelationState = 'confirmed';
    };

    const abandonUnverifiedResume = async (): Promise<void> => {
        if (initialParentRelationState !== 'pending') {
            requestedResumeSessionId = undefined;
            await awaitQueuedParentRelationRollback();
            return;
        }

        initialParentRelationState = 'rolled-back';
        requestedResumeSessionId = undefined;
        // setupOfflineReconnection closes over this object. Sanitizing it keeps
        // a late reconnect from recreating the provisional parent relation.
        delete reconnectMetadata.resumedFromRemcliSessionId;
        queueParentRelationRollback(session);
        await awaitQueuedParentRelationRollback();
    };

    const bindNativeCursorSession = async (
        nativeSessionId: string,
        writerLeaseId?: string,
    ): Promise<CursorNativeWriterLease | undefined> => {
        if (trustedStartedBy !== 'daemon') {
            return undefined;
        }

        const bindingResult = await bindDaemonCursorSession({
            agent: 'cursor',
            nativeSessionId,
            remcliSessionId: session.sessionId,
            ...(writerLeaseId ? { writerLeaseId } : {}),
        });
        if (!bindingResult.ok) {
            throw new CursorTurnError(
                'native',
                `Cursor native session binding failed: ${bindingResult.error}`,
            );
        }

        switch (bindingResult.data.type) {
            case 'bound':
            case 'already-bound':
                return bindingResult.data.writerLease;
            case 'reuse-active-wrapper':
                throw new CursorTurnError(
                    'native',
                    `Cursor native session is already owned by active wrapper ${bindingResult.data.wrapper.remcliSessionId}.`,
                );
            case 'wrapper-not-tracked':
                throw new CursorTurnError(
                    'native',
                    'Cursor native session binding was rejected because this daemon wrapper is no longer tracked.',
                );
            case 'native-session-mismatch':
                throw new CursorTurnError(
                    'native',
                    'Cursor native session binding was rejected because the selected resume no longer matches this wrapper.',
                );
            case 'agent-mismatch':
                throw new CursorTurnError(
                    'native',
                    `Cursor native session binding was rejected because this wrapper belongs to ${bindingResult.data.trackedAgent}.`,
                );
            case 'writer-busy':
                throw new CursorTurnError(
                    'native',
                    `Cursor native session is already controlled by an active ${bindingResult.data.owner} writer.`,
                );
            case 'writer-lease-mismatch':
                throw new CursorTurnError(
                    'native',
                    'Cursor native writer capability no longer matches this turn.',
                );
        }
    };

    const acquireHeadlessTurnWriterLease = async (
        nativeSessionId: string,
    ): Promise<CursorNativeWriterLease> => {
        const leaseResult = await acquireDaemonCursorHeadlessWriterLease({
            agent: 'cursor',
            nativeSessionId,
            remcliSessionId: session.sessionId,
        });
        if (!leaseResult.ok) {
            throw new CursorTurnError(
                'native',
                `Cursor native writer lease failed: ${leaseResult.error}`,
            );
        }

        switch (leaseResult.data.type) {
            case 'acquired':
                return leaseResult.data.writerLease;
            case 'writer-busy':
                throw new CursorTurnError(
                    'native',
                    `Cursor native session is already controlled by an active ${leaseResult.data.owner} writer.`,
                );
            case 'wrapper-not-tracked':
                throw new CursorTurnError(
                    'native',
                    'Cursor native writer lease was rejected because this daemon wrapper is no longer tracked.',
                );
            case 'agent-mismatch':
                throw new CursorTurnError(
                    'native',
                    `Cursor native writer lease was rejected because this wrapper belongs to ${leaseResult.data.trackedAgent}.`,
                );
            case 'native-session-mismatch':
                throw new CursorTurnError(
                    'native',
                    'Cursor native writer lease was rejected because the selected resume no longer matches this wrapper.',
                );
        }
    };

    const releaseHeadlessTurnWriterLease = async (writerLease: CursorNativeWriterLease): Promise<boolean> => {
        const releaseResult = await releaseDaemonCursorNativeWriterLease({
            agent: 'cursor',
            leaseId: writerLease.leaseId,
            nativeSessionId: writerLease.nativeSessionId,
            remcliSessionId: writerLease.remcliSessionId,
        });
        return releaseResult.ok && releaseResult.data.released;
    };

    async function handleAbort(): Promise<void> {
        logger.debug('[Cursor] Abort requested');
        const parentRelationRollback = abandonUnverifiedResume();
        try {
            abortController.abort();
        } catch (error) {
            logger.debug('[Cursor] Error during abort:', error);
        } finally {
            logger.debug('[Cursor] Abort completed');
        }
        try {
            await parentRelationRollback;
        } catch (error) {
            // Continuing would leave a fresh native turn attached to a child
            // that still renders the wrong parent transcript.
            shouldExit = true;
            // The loop may already have replaced the controller after the
            // first abort. Wake that replacement too so it cannot wait for a
            // new prompt after a failed lineage rollback.
            abortController.abort();
            throw error;
        }
    }

    let cleanupPromise: Promise<void> | null = null;

    const cleanupSession = (): Promise<void> => {
        if (cleanupPromise) {
            return cleanupPromise;
        }

        cleanupPromise = (async () => {
            shouldExit = true;
            if (trustedStartedBy === 'daemon') {
                const stoppingResult = await reportDaemonRunnerStopping(session.sessionId);
                if (!stoppingResult.ok || !stoppingResult.data.accepted) {
                    logger.debug('[Cursor] Daemon did not accept runner stopping signal.');
                }
            }
            try {
                reconnectionHandle?.cancel();
            } catch (error) {
                logger.debug('[Cursor] Error while cancelling reconnection:', redactDiagnosticData(error));
            }

            try {
                await handleAbort();
            } catch (error) {
                logger.debug('[Cursor] Error while rolling back parent lineage during cleanup:', redactDiagnosticData(error));
            }
            if (activeTurn) {
                await activeTurn.catch(() => undefined);
            }

            const targetSession = session;
            try {
                await targetSession.updateMetadata((currentMetadata) => ({
                    ...(initialParentRelationState === 'rolled-back'
                        ? withoutResumedFromRemcliSessionId(currentMetadata)
                        : currentMetadata),
                    lifecycleState: 'archived',
                    lifecycleStateSince: Date.now(),
                    archivedBy: 'cli',
                    archiveReason: 'User terminated',
                }), LIFECYCLE_METADATA_UPDATE_OPTIONS);
            } catch (error) {
                logger.debug('[Cursor] Error while archiving session metadata:', redactDiagnosticData(error));
            }

            try {
                targetSession.sendSessionDeath();
            } catch (error) {
                logger.debug('[Cursor] Error while sending session death:', redactDiagnosticData(error));
            }

            try {
                await targetSession.flush();
            } catch (error) {
                logger.debug('[Cursor] Error while flushing session:', redactDiagnosticData(error));
            }

            try {
                await targetSession.close();
            } catch (error) {
                logger.debug('[Cursor] Error while closing session:', redactDiagnosticData(error));
            }

            if (trustedStartedBy === 'daemon') {
                const stoppedResult = await reportDaemonRunnerStopped(targetSession.sessionId);
                if (!stoppedResult.ok || !stoppedResult.data.accepted) {
                    logger.debug('[Cursor] Daemon could not confirm runner cleanup; it will remain fail-closed for retry.');
                }
            }

            try {
                await stopCaffeinate();
            } catch (error) {
                logger.debug('[Cursor] Error while stopping caffeinate:', redactDiagnosticData(error));
            }
        })();

        return cleanupPromise;
    };

    const canExitProcess = process.env.NODE_ENV !== 'test' && !process.env.VITEST;

    const handleKillSession = async () => {
        logger.debug('[Cursor] Kill session requested');
        try {
            await cleanupSession();

            logger.debug('[Cursor] Session termination complete, exiting');
            if (canExitProcess) process.exit(0);
        } catch (error) {
            logger.debug('[Cursor] Error during session termination:', redactDiagnosticData(error));
            if (canExitProcess) process.exit(1);
        }
    };

    const attachedSessions = new WeakSet<ApiSessionClient>();
    bindSessionHandlers = (target) => {
        if (attachedSessions.has(target)) return;
        attachedSessions.add(target);
        target.onUserMessage(createUserMessageHandler(target));
        target.rpcHandlerManager.registerHandler('abort', handleAbort);
        registerKillSessionHandler(target.rpcHandlerManager, handleKillSession);
    };
    bindSessionHandlers(session);

    const terminationSignals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
    const handleTerminationSignal = () => {
        logger.debug('[Cursor] Received termination signal, starting graceful cleanup');
        void cleanupSession().catch((error: unknown) => {
            logger.debug('[Cursor] Error during signal cleanup:', redactDiagnosticData(error));
        });
    };
    for (const signal of terminationSignals) {
        process.on(signal, handleTerminationSignal);
    }

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
                await cleanupSession();
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

    try {
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: CursorMode; isolate: boolean; hash: string } | null = null;
        const autoSetTitle = createAutoTitleSetter(() => session);

        while (!shouldExit) {
            let message: { message: string; mode: CursorMode; isolate: boolean; hash: string } | null = pending;
            pending = null;

            if (!message) {
                const waitSignal = abortController.signal;
                const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    if (waitSignal.aborted && !shouldExit) {
                        try {
                            // An abort RPC starts its lineage cleanup before
                            // signalling this wait. Do not accept a fresh
                            // prompt until that metadata update is settled.
                            await awaitQueuedParentRelationRollback();
                        } catch (error) {
                            logger.debug('[Cursor] Parent lineage rollback failed while idle:', redactDiagnosticData(error));
                            shouldExit = true;
                            break;
                        }
                        if (shouldExit) {
                            break;
                        }
                        logger.debug('[cursor] Wait aborted while idle, resetting abort controller and continuing');
                        abortController = new AbortController();
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
                try {
                    await abandonUnverifiedResume();
                } catch (error) {
                    logger.debug('[Cursor] Could not safely reset the native Cursor resume:', redactDiagnosticData(error));
                    session.sendAgentMessage('cursor', {
                        type: 'message',
                        message: 'Cursor session stopped because the previous resume history could not be cleared safely.',
                        isError: true,
                    });
                    shouldExit = true;
                    break;
                }
                cursorSessionId = null;
            }

            currentModeHash = message.hash;
            messageBuffer.addMessage(message.message, 'user');

            let headlessWriterLease: CursorNativeWriterLease | undefined;
            try {
                // Build prompt (no CHANGE_TITLE_INSTRUCTION — Cursor doesn't have access to remcli MCP server)
                const prompt = message.message;

                const { launchControls } = message.mode;
                const cursorMode = launchControls.executionMode;

                // Show active mode in terminal
                const modeLabel = cursorMode === 'plan'
                    ? 'Plan'
                    : cursorMode === 'ask'
                        ? 'Ask'
                        : 'Agent';
                messageBuffer.addMessage(`Mode: ${modeLabel}`, 'system');
                logger.debug(`[Cursor] Spawning with executionMode=${cursorMode} force=${launchControls.force} autoReview=${launchControls.autoReview} sandbox=${launchControls.sandbox} approveMcps=${launchControls.approveMcps}`);

                const nativeSessionIdForLease = cursorSessionId ?? requestedResumeSessionId;
                if (trustedStartedBy === 'daemon' && nativeSessionIdForLease) {
                    headlessWriterLease = await acquireHeadlessTurnWriterLease(nativeSessionIdForLease);
                }

                // Send task_started
                session.sendAgentMessage('cursor', {
                    type: 'task_started',
                    id: randomUUID(),
                });
                thinking = true;
                session.keepAlive(thinking, 'remote');

                // Cursor has one canonical terminal result. Streaming events feed
                // the terminal UI, while the result text is sent to the phone once.
                isStreamingAssistant = false;
                const runningTurn = runCursorTurn({
                    prompt,
                    cwd: process.cwd(),
                    model: message.mode.model,
                    resumeSessionId: cursorSessionId ?? requestedResumeSessionId,
                    abort: abortController.signal,
                    launchControls,
                    trustWorkspace: true,
                    ...(opts.runner ? { executable: opts.runner.executable } : {}),
                }, async (event) => {
                    // Debug: log every event type for diagnosis
                    logger.debug(`[Cursor] Event: type=${event.type} subtype=${event.subtype ?? '-'} hasContent=${!!event.message?.content} hasTextDelta=${!!event.text_delta} hasText=${!!event.text}`);

                    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
                        const boundWriterLease = await bindNativeCursorSession(
                            event.session_id,
                            headlessWriterLease?.leaseId,
                        );
                        if (
                            headlessWriterLease
                            && boundWriterLease
                            && headlessWriterLease.leaseId !== boundWriterLease.leaseId
                        ) {
                            throw new CursorTurnError(
                                'native',
                                'Cursor native writer capability changed while this turn was starting.',
                            );
                        }
                        headlessWriterLease = boundWriterLease ?? headlessWriterLease;
                        confirmInitialParentRelation(event.session_id);
                    }

                    handleCursorEvent(event, messageBuffer);

                    // Commit the native ID only after Cursor has confirmed it and,
                    // for daemon runners, the daemon has claimed its ownership.
                    if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
                        cursorSessionId = event.session_id;
                        requestedResumeSessionId = undefined;
                        logger.debug(`[Cursor] Session ID: ${cursorSessionId}`);
                        const targetSession = session;
                        const updatedMetadata = {
                            ...baseMetadata,
                            agentSessionId: cursorSessionId,
                            cursorSessionId: cursorSessionId,
                            ...(shouldPublishParentRelation() ? { resumedFromRemcliSessionId } : {}),
                        };
                        await targetSession.updateMetadata((currentMetadata) => {
                            const nativeMetadata = {
                                ...currentMetadata,
                                agentSessionId: cursorSessionId ?? undefined,
                                cursorSessionId: cursorSessionId ?? undefined,
                            };
                            if (shouldPublishParentRelation()) {
                                return { ...nativeMetadata, resumedFromRemcliSessionId };
                            }
                            return withoutResumedFromRemcliSessionId(nativeMetadata);
                        }, LIFECYCLE_METADATA_UPDATE_OPTIONS);
                        if (trustedStartedBy !== 'daemon') {
                            await reportTerminalSessionStarted({
                                agentName: 'Cursor',
                                sessionId: targetSession.sessionId,
                                metadata: updatedMetadata,
                            });
                        }
                    }
                });
                activeTurn = runningTurn;
                const turn = await runningTurn;
                if (activeTurn === runningTurn) {
                    activeTurn = null;
                }
                if (turn.response.trim()) {
                    session.sendAgentMessage('cursor', {
                        type: 'message',
                        message: turn.response,
                        isError: false,
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
                logger.debug('[cursor] Error in cursor session:', redactDiagnosticData(error));
                const isAbortError = isCursorTurnAbortError(error);
                try {
                    await abandonUnverifiedResume();
                } catch (rollbackError) {
                    logger.debug('[Cursor] Could not safely roll back parent lineage after turn failure:', redactDiagnosticData(rollbackError));
                    shouldExit = true;
                }

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendAgentMessage('cursor', {
                        type: 'turn_aborted',
                        id: randomUUID(),
                    });
                } else {
                    const errorMsg = error instanceof Error
                        ? error.message
                        : 'Cursor CLI could not complete this turn. Check the local Cursor terminal and retry.';
                    messageBuffer.addMessage(`Error: ${errorMsg}`, 'status');

                    session.sendAgentMessage('cursor', {
                        type: 'message',
                        message: errorMsg,
                        isError: true,
                    });
                }
            } finally {
                if (headlessWriterLease) {
                    const didReleaseWriterLease = await releaseHeadlessTurnWriterLease(headlessWriterLease);
                    if (!didReleaseWriterLease) {
                        logger.debug('[Cursor] Daemon could not confirm the headless native writer lease release; stopping this runner fail-closed.');
                        shouldExit = true;
                        abortController.abort();
                        messageBuffer.addMessage('Cursor session stopped because native session ownership could not be released safely.', 'status');
                        session.sendAgentMessage('cursor', {
                            type: 'message',
                            message: 'Cursor session stopped because Remcli could not safely release native session ownership. Resume it to continue.',
                            isError: true,
                        });
                    }
                }
                activeTurn = null;
                thinking = false;
                session.keepAlive(thinking, 'remote');
                if (!shouldExit) {
                    sendReady();
                }
            }
        }
    } finally {
        logger.debug('[cursor]: Final cleanup start');

        for (const signal of terminationSignals) {
            process.off(signal, handleTerminationSignal);
        }

        await cleanupSession();

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
                const toolName = Object.keys(event.tool_call)[0] ?? 'unknown';
                const hasResult = Boolean(toolData && Object.hasOwn(toolData, 'result'));
                logger.debug(`[Cursor] Tool completed: name=${toolName} hasResult=${hasResult}`);
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
