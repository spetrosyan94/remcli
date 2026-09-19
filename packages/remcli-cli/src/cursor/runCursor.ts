/**
 * Cursor CLI Entry Point
 *
 * Main entry point for running Cursor agent through Remcli.
 * Manages the agent lifecycle, session state, and communication
 * with the Remcli server and mobile app.
 *
 * Follows the same pattern as runCodex.ts:
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
import { redactDiagnosticData, redactSensitiveText } from '@/utils/redaction';
import {
    acquireDaemonCursorHeadlessWriterLease,
    bindDaemonCursorSession,
    consumeDaemonSessionExecution,
    preflightDaemonCursorRunner,
    reportDaemonCursorRunnerBootstrapFailure,
    releaseDaemonCursorNativeWriterLease,
    reportDaemonRunnerStopped,
    reportDaemonRunnerStopping,
} from '@/daemon/controlClient';
import type { CursorNativeWriterLease } from '@/daemon/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { RetryableUserMessageDeliveryError, type Metadata } from '@/api/types';
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
    CursorAcpClient,
    type CursorAcpSession,
    type CursorMode as CursorAcpMode,
    type SessionUpdate as CursorAcpUpdate,
} from './cursorAcpClient';
import { CursorPermissionHandler } from './cursorPermissionHandler';
import { CursorStructuredInputBroker, type CursorStructuredMethod } from './cursorStructuredInputBroker';
import {
    applyCursorSessionInfoUpdate,
    hasCursorNativeTitleDirective,
    parseCursorSessionUpdatedAt,
} from './cursorSessionInfo';
import type { CursorMode } from './types';

const LIFECYCLE_METADATA_UPDATE_OPTIONS = {
    maxAttempts: 2,
    timeoutMs: 1_000,
} as const;

const MAX_PROVISIONAL_PARENT_ROLLBACK_UPDATES = 2;
const MAX_PENDING_CURSOR_SESSION_INFO_UPDATES = 16;
const DAEMON_EXECUTION_SELECTION_REQUIRED_ERROR = 'Cursor daemon runner requires a validated execution and control selection.';

class CursorLifecycleError extends Error {
    public constructor(
        public readonly kind: 'native' | 'resume-mismatch' | 'metadata',
        message: string,
    ) {
        super(message);
        this.name = 'CursorLifecycleError';
    }
}

interface ActiveCursorAcpTurn {
    messageId: string;
    response: string;
    toolCalls: Map<string, { name: string; status?: string }>;
    acceptDelivery: () => void;
}

interface CursorNativeMetadataReconciliation {
    nativeSessionId: string;
    model?: string;
    resumedFromRemcliSessionId?: string;
}

function redactCursorErrorForSession(error: unknown, fallback: string): string {
    const source = typeof error === 'string'
        ? error
        : error instanceof Error
            ? error.message
            : fallback;
    const redacted = redactSensitiveText(source).trim();
    return redacted || fallback;
}

async function reportDaemonCursorBootstrapFailure(): Promise<void> {
    if (!process.env.REMCLI_DAEMON_RUNNER_TOKEN) {
        return;
    }

    try {
        const result = await reportDaemonCursorRunnerBootstrapFailure({
            agent: 'cursor',
            pid: process.pid,
        });
        if (!result.ok || !result.data.accepted) {
            logger.debug('[Cursor] Daemon did not accept bootstrap failure report.');
        }
    } catch {
        logger.debug('[Cursor] Daemon bootstrap failure report failed.');
    }
}

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
        if (opts.startedBy === 'daemon') {
            await reportDaemonCursorBootstrapFailure();
        }
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
        await reportDaemonCursorBootstrapFailure();
        return;
    }

    let trustedStartedBy: 'daemon' | 'terminal' | undefined;
    let resumedFromRemcliSessionId: string | undefined;
    if (opts.startedBy === 'daemon') {
        try {
            if (process.env.REMCLI_DAEMON_RUNNER_TOKEN
                && (!opts.runner || !await verifyCursorRunnerIdentity(opts.runner))) {
                logger.debug('[Cursor] Daemon runner CLI identity did not match capability validation.');
                await reportDaemonCursorBootstrapFailure();
                return;
            }
            const runnerPreflight = await preflightDaemonCursorRunner({
                agent: 'cursor',
                nativeResumeSessionId: opts.resumeSessionId,
                pid: process.pid,
            });
            if (!runnerPreflight.ok || runnerPreflight.data.type !== 'verified') {
                logger.debug('[Cursor] Daemon runner preflight rejected.');
                await reportDaemonCursorBootstrapFailure();
                return;
            }
            trustedStartedBy = 'daemon';
            resumedFromRemcliSessionId = runnerPreflight.data.parentRemcliSessionId;
        } catch {
            logger.debug('[Cursor] Daemon runner preflight failed.');
            await reportDaemonCursorBootstrapFailure();
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
    const daemonCursorExecutionMetadata = trustedStartedBy === 'daemon' && opts.execution
        ? { cursorExecution: { model: opts.execution.model } }
        : {};
    const initialMetadata: Metadata = resumedFromRemcliSessionId
        ? { ...baseMetadata, ...daemonCursorExecutionMetadata, resumedFromRemcliSessionId }
        : { ...baseMetadata, ...daemonCursorExecutionMetadata };
    // `getOrCreateSession` publishes this exact first snapshot. Reconnection
    // needs its own mutable template so a failed native resume cannot mutate
    // the already-published request object while still preventing future swaps
    // from recreating a provisional parent relation.
    const reconnectMetadata: Metadata = { ...initialMetadata };
    const p2pBootstrap = await (async () => {
        try {
            const api = await ApiClient.create(opts.credentials);
            const response = await api.getOrCreateSession({ tag: sessionTag, metadata: initialMetadata, state });
            return { api, response };
        } catch (error) {
            if (trustedStartedBy !== 'daemon') {
                throw error;
            }
            logger.debug('[Cursor] Daemon runner could not initialize P2P before credential handoff:', redactDiagnosticData(error));
            await reportDaemonCursorBootstrapFailure();
            return undefined;
        }
    })();
    if (!p2pBootstrap) {
        return;
    }
    const { api, response } = p2pBootstrap;

    if (trustedStartedBy === 'daemon') {
        if (!response) {
            logger.warn('[Cursor] Daemon-owned runner cannot start without a P2P session for credential handoff.');
            await reportDaemonCursorBootstrapFailure();
            return;
        }
        if (!await acquireDaemonRunnerCredential({ agentName: 'Cursor', sessionId: response.id, metadata: initialMetadata })) {
            await reportDaemonCursorBootstrapFailure();
            return;
        }
    } else if (response) {
        await reportTerminalSessionStarted({ agentName: 'Cursor', sessionId: response.id, metadata: initialMetadata });
    }

    // Handle server unreachable — create offline stub with hot reconnection
    let session: ApiSessionClient;
    let bindSessionHandlers: ((target: ApiSessionClient) => void) | null = null;
    let scheduleParentRelationRollbackForSession: ((target: ApiSessionClient) => Promise<void>) | null = null;
    let cursorPermissionHandler: CursorPermissionHandler | null = null;
    let cursorStructuredInputBroker: CursorStructuredInputBroker | null = null;
    let canBindSessionHandlers = !opts.resumeSessionId;

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
            cursorPermissionHandler?.updateSession(newSession);
            cursorStructuredInputBroker?.updateSession(newSession);
            if (canBindSessionHandlers) bindSessionHandlers?.(newSession);
            // A reconnect may have begun before the local metadata template was
            // sanitized. Queue a bounded cleanup for that replacement session.
            void scheduleParentRelationRollbackForSession?.(newSession).catch((error) => {
                logger.debug('[Cursor] Error while rolling back parent lineage after reconnect:', redactDiagnosticData(error));
            });
        },
    });
    session = initialSession;
    cursorPermissionHandler = new CursorPermissionHandler(session);
    cursorStructuredInputBroker = new CursorStructuredInputBroker(session, {
        onWarning: (message) => {
            logger.debug('[Cursor] Structured input warning:', message);
            session.sendAgentMessage('cursor', { type: 'message', message, isError: true });
        },
    });

    const messageQueue = new MessageQueue2<CursorMode>((mode) => hashObject({
        launchControls: mode.launchControls,
        model: mode.model,
        deliveryId: mode.deliveryId,
    }));

    // Native launch controls and account-validated model are session-level
    // selection. A phone message never changes the daemon-owned runner.
    const currentLaunchControls = opts.launchControls ?? DEFAULT_CURSOR_LAUNCH_CONTROLS;
    let currentModel = opts.execution?.model;
    let doesExecutionMetadataNeedReconciliation = false;
    const publishExecutionError = (target: ApiSessionClient, error: unknown, fallback: string): string => {
        const errorMessage = redactCursorErrorForSession(error, fallback);
        target.sendAgentMessage('cursor', { type: 'message', message: errorMessage, isError: true });
        return errorMessage;
    };

    const reconcileCursorNativeMetadata = async (
        target: ApiSessionClient,
        reconciliation: CursorNativeMetadataReconciliation,
    ): Promise<void> => {
        await target.updateMetadata((currentMetadata) => {
            const nativeMetadata: Metadata = {
                ...currentMetadata,
                agentSessionId: reconciliation.nativeSessionId,
                cursorSessionId: reconciliation.nativeSessionId,
                ...(reconciliation.model
                    ? { cursorExecution: { model: reconciliation.model } }
                    : {}),
            };
            if (reconciliation.resumedFromRemcliSessionId) {
                return {
                    ...nativeMetadata,
                    resumedFromRemcliSessionId: reconciliation.resumedFromRemcliSessionId,
                };
            }
            return withoutResumedFromRemcliSessionId(nativeMetadata);
        }, LIFECYCLE_METADATA_UPDATE_OPTIONS);
    };

    const createUserMessageHandler = (target: ApiSessionClient) => async (message: Parameters<ApiSessionClient['onUserMessage']>[0] extends (value: infer T) => unknown ? T : never) => {
        const messageMeta = message.meta;
        if (messageMeta?.permissionMode) {
            logger.warn('[Cursor] Ignoring generic per-message permission override; launch controls are fixed for this session.');
        }

        if (Object.prototype.hasOwnProperty.call(messageMeta ?? {}, 'model')) {
            logger.warn('[Cursor] Ignoring unvalidated per-message model override.');
        }

        if (trustedStartedBy === 'daemon') {
            const executionResult = await consumeDaemonSessionExecution(target.sessionId, 'cursor');
            if (!executionResult.ok) {
                const failure = publishExecutionError(
                    target,
                    `Cursor execution selection could not be applied: ${executionResult.error}`,
                    'Cursor execution selection could not be applied.',
                );
                throw new RetryableUserMessageDeliveryError(new Error(failure));
            }
            if (executionResult.data.current.provider !== 'cursor') {
                if (message.deliveryId) {
                    target.cancelPendingUserMessageDelivery(message.deliveryId);
                }
                publishExecutionError(
                    target,
                    'Daemon returned an invalid Cursor execution selection.',
                    'Cursor execution selection could not be applied.',
                );
                return;
            }
            currentModel = executionResult.data.current.model;
            if (executionResult.data.didApplyPending) {
                doesExecutionMetadataNeedReconciliation = true;
            }
            if (doesExecutionMetadataNeedReconciliation) {
                try {
                    await target.updateMetadata((currentMetadata) => ({
                        ...currentMetadata,
                        cursorExecution: { model: currentModel! },
                    }), LIFECYCLE_METADATA_UPDATE_OPTIONS);
                    doesExecutionMetadataNeedReconciliation = false;
                } catch (error) {
                    const failure = publishExecutionError(
                        target,
                        error,
                        'Cursor execution metadata update failed.',
                    );
                    throw new RetryableUserMessageDeliveryError(new Error(failure));
                }
            }
        }

        const mode: CursorMode = {
            launchControls: currentLaunchControls,
            model: currentModel,
            ...(message.deliveryId ? { deliveryId: message.deliveryId } : {}),
        };
        if (message.deliveryId) {
            await messageQueue.pushWithAcceptance(message.content.text, mode);
            return;
        }
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
    let activeTurn: Promise<{ stopReason: string }> | null = null;
    let activeAcpTurn: ActiveCursorAcpTurn | null = null;
    let cursorAcpClient: CursorAcpClient | null = null;
    let cursorAcpSession: CursorAcpSession | null = null;
    let cursorTurnGeneration = 0;
    let activeStructuredTurnScope: { nativeSessionId: string; turnGeneration: number } | null = null;
    let cursorWriterLease: CursorNativeWriterLease | undefined;
    let doesNativeMetadataNeedReconciliation = false;
    let didReportNativeTerminalSession = false;
    let isCollectingCursorHistory = false;
    let cursorHistoryRole: 'user' | 'assistant' | null = null;
    const cursorHistoryEntries: Array<{ role: 'user' | 'assistant'; text: string }> = [];
    const pendingCursorSessionInfoUpdates: Array<{
        sessionId: string;
        update: Extract<CursorAcpUpdate, { sessionUpdate: 'session_info_update' }>;
    }> = [];
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
            throw new CursorLifecycleError(
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
            throw new CursorLifecycleError(
                'native',
                `Cursor native session binding failed: ${bindingResult.error}`,
            );
        }

        switch (bindingResult.data.type) {
            case 'bound':
            case 'already-bound':
                return bindingResult.data.writerLease;
            case 'reuse-active-wrapper':
                throw new CursorLifecycleError(
                    'native',
                    `Cursor native session is already owned by active wrapper ${bindingResult.data.wrapper.remcliSessionId}.`,
                );
            case 'wrapper-not-tracked':
                throw new CursorLifecycleError(
                    'native',
                    'Cursor native session binding was rejected because this daemon wrapper is no longer tracked.',
                );
            case 'native-session-mismatch':
                throw new CursorLifecycleError(
                    'native',
                    'Cursor native session binding was rejected because the selected resume no longer matches this wrapper.',
                );
            case 'agent-mismatch':
                throw new CursorLifecycleError(
                    'native',
                    `Cursor native session binding was rejected because this wrapper belongs to ${bindingResult.data.trackedAgent}.`,
                );
            case 'writer-busy':
                throw new CursorLifecycleError(
                    'native',
                    `Cursor native session is already controlled by an active ${bindingResult.data.owner} writer.`,
                );
            case 'writer-lease-mismatch':
                throw new CursorLifecycleError(
                    'native',
                    'Cursor native writer capability no longer matches this turn.',
                );
        }
    };

    const acquireCursorWriterLease = async (
        nativeSessionId: string,
    ): Promise<CursorNativeWriterLease> => {
        const leaseResult = await acquireDaemonCursorHeadlessWriterLease({
            agent: 'cursor',
            nativeSessionId,
            remcliSessionId: session.sessionId,
        });
        if (!leaseResult.ok) {
            throw new CursorLifecycleError(
                'native',
                `Cursor native writer lease failed: ${leaseResult.error}`,
            );
        }

        switch (leaseResult.data.type) {
            case 'acquired':
                return leaseResult.data.writerLease;
            case 'writer-busy':
                throw new CursorLifecycleError(
                    'native',
                    `Cursor native session is already controlled by an active ${leaseResult.data.owner} writer.`,
                );
            case 'wrapper-not-tracked':
                throw new CursorLifecycleError(
                    'native',
                    'Cursor native writer lease was rejected because this daemon wrapper is no longer tracked.',
                );
            case 'agent-mismatch':
                throw new CursorLifecycleError(
                    'native',
                    `Cursor native writer lease was rejected because this wrapper belongs to ${leaseResult.data.trackedAgent}.`,
                );
            case 'native-session-mismatch':
                throw new CursorLifecycleError(
                    'native',
                    'Cursor native writer lease was rejected because the selected resume no longer matches this wrapper.',
                );
        }
    };

    const releaseCursorWriterLease = async (writerLease: CursorNativeWriterLease): Promise<boolean> => {
        const releaseResult = await releaseDaemonCursorNativeWriterLease({
            agent: 'cursor',
            leaseId: writerLease.leaseId,
            nativeSessionId: writerLease.nativeSessionId,
            remcliSessionId: writerLease.remcliSessionId,
        });
        return releaseResult.ok && releaseResult.data.released;
    };

    const appendCursorHistoryText = (role: 'user' | 'assistant', text: string): void => {
        if (!text) return;
        const last = cursorHistoryEntries.at(-1);
        if (cursorHistoryRole === role && last?.role === role) {
            last.text += text;
        } else {
            cursorHistoryEntries.push({ role, text });
        }
        cursorHistoryRole = role;
    };

    let hasPersistedNativeCursorTitle = false;
    let latestPersistedNativeCursorUpdatedAt: number | null = null;
    let cursorSessionInfoWriteQueue: Promise<void> = Promise.resolve();
    const persistCursorSessionInfo = (
        update: Extract<CursorAcpUpdate, { sessionUpdate: 'session_info_update' }>,
    ): void => {
        const hasNativeTitleDirective = hasCursorNativeTitleDirective(update);
        const nativeUpdatedAt = parseCursorSessionUpdatedAt(update.updatedAt);
        cursorSessionInfoWriteQueue = cursorSessionInfoWriteQueue
            .then(async () => {
                if (nativeUpdatedAt !== null
                    && latestPersistedNativeCursorUpdatedAt !== null
                    && nativeUpdatedAt < latestPersistedNativeCursorUpdatedAt) {
                    return;
                }
                await session.updateMetadata(
                    (metadata) => applyCursorSessionInfoUpdate(metadata, update),
                    LIFECYCLE_METADATA_UPDATE_OPTIONS,
                );
                if (nativeUpdatedAt !== null) {
                    latestPersistedNativeCursorUpdatedAt = nativeUpdatedAt;
                }
                if (hasNativeTitleDirective) {
                    hasPersistedNativeCursorTitle = true;
                }
            })
            .catch((error) => {
                logger.debug('[Cursor] Native session info metadata update failed:', redactDiagnosticData(error));
            });
    };

    const flushCursorHistory = (): void => {
        for (const entry of cursorHistoryEntries) {
            const text = entry.text.trim();
            if (!text) continue;
            if (entry.role === 'user') {
                session.sendUserTextMessage(text, { sentFrom: 'cursor' });
            } else {
                session.sendAgentMessage('cursor', {
                    type: 'message',
                    message: text,
                    isError: false,
                    historical: true,
                });
            }
        }
        cursorHistoryEntries.length = 0;
        cursorHistoryRole = null;
    };

    const handleCursorAcpUpdate = (update: CursorAcpUpdate): void => {
        if (update.sessionUpdate === 'session_info_update') {
            persistCursorSessionInfo(update);
            return;
        }
        const turn = activeAcpTurn;
        if (!turn) {
            if (!isCollectingCursorHistory) return;
            if (update.sessionUpdate === 'user_message_chunk' && update.content.type === 'text') {
                appendCursorHistoryText('user', update.content.text);
            } else if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
                appendCursorHistoryText('assistant', update.content.text);
            } else {
                cursorHistoryRole = null;
            }
            return;
        }
        turn.acceptDelivery();

        switch (update.sessionUpdate) {
            case 'agent_message_chunk':
                if (update.content.type !== 'text' || !update.content.text) return;
                turn.response += update.content.text;
                if (isStreamingAssistant) {
                    messageBuffer.updateLastMessage(update.content.text, 'assistant');
                } else {
                    messageBuffer.addMessage(update.content.text, 'assistant');
                    isStreamingAssistant = true;
                }
                session.sendAgentMessage('cursor', {
                    type: 'message',
                    message: update.content.text,
                    isError: false,
                    messageId: turn.messageId,
                    streamState: 'delta',
                });
                return;
            case 'agent_thought_chunk':
                return;
            case 'tool_call': {
                isStreamingAssistant = false;
                const name = update.title || update.kind || 'Cursor tool';
                turn.toolCalls.set(update.toolCallId, { name, status: update.status });
                messageBuffer.addMessage(name, 'tool');
                session.sendAgentMessage('cursor', {
                    type: 'tool-call',
                    callId: update.toolCallId,
                    name,
                    input: {
                        ...(update.kind ? { kind: update.kind } : {}),
                        ...(update.locations?.length ? { locations: update.locations } : {}),
                    },
                    id: randomUUID(),
                });
                return;
            }
            case 'tool_call_update': {
                isStreamingAssistant = false;
                const previous = turn.toolCalls.get(update.toolCallId);
                const name = update.title || previous?.name || update.kind || 'Cursor tool';
                const status = update.status ?? previous?.status;
                turn.toolCalls.set(update.toolCallId, { name, ...(status ? { status } : {}) });
                if (status === 'completed' || status === 'failed') {
                    session.sendAgentMessage('cursor', {
                        type: 'tool-result',
                        callId: update.toolCallId,
                        output: { name, status },
                        id: randomUUID(),
                        ...(status === 'failed' ? { isError: true } : {}),
                    });
                }
                return;
            }
            case 'plan':
                isStreamingAssistant = false;
                messageBuffer.addMessage('Cursor plan updated', 'status');
                return;
            case 'user_message_chunk':
            case 'available_commands_update':
            case 'current_mode_update':
                return;
        }
    };

    const createCursorAcpClient = (mode: CursorAcpMode, model?: string): CursorAcpClient => new CursorAcpClient({
        cwd: process.cwd(),
        mode,
        ...(model ? { model } : {}),
        resumeSessionId: requestedResumeSessionId,
        ...(opts.runner ? { command: opts.runner.executable } : {}),
        onSessionUpdate: (notification) => {
            if (!cursorSessionId) {
                if (requestedResumeSessionId) {
                    if (notification.sessionId === requestedResumeSessionId) {
                        handleCursorAcpUpdate(notification.update);
                    }
                    return;
                }
                if (notification.update.sessionUpdate === 'session_info_update') {
                    if (pendingCursorSessionInfoUpdates.length >= MAX_PENDING_CURSOR_SESSION_INFO_UPDATES) {
                        pendingCursorSessionInfoUpdates.shift();
                    }
                    pendingCursorSessionInfoUpdates.push({
                        sessionId: notification.sessionId,
                        update: notification.update,
                    });
                }
                return;
            }
            if (notification.sessionId !== cursorSessionId) return;
            handleCursorAcpUpdate(notification.update);
        },
        onPermission: (request) => cursorPermissionHandler!.handleRequest(request),
        onExtension: async (method, params) => {
            const scope = activeStructuredTurnScope;
            if (!scope || (method !== 'cursor/ask_question' && method !== 'cursor/create_plan')) {
                return { outcome: { outcome: 'cancelled' } };
            }
            return await cursorStructuredInputBroker!.handleRequest({
                method: method as CursorStructuredMethod,
                params,
                nativeSessionId: scope.nativeSessionId,
                turnGeneration: scope.turnGeneration,
            });
        },
        onError: () => cursorStructuredInputBroker?.clearAll(),
    });

    const ensureCursorAcpSession = async (
        mode: CursorAcpMode,
        model?: string,
    ): Promise<CursorAcpSession> => {
        if (cursorAcpClient && cursorAcpSession) {
            if (model && cursorAcpSession.models?.currentModelId !== model) {
                await cursorAcpClient.setModel(model);
                cursorAcpSession.models ??= {
                    availableModels: [{ modelId: model, name: model }],
                    currentModelId: model,
                };
                cursorAcpSession.models.currentModelId = model;
            }
            if (cursorAcpSession.modes.currentModeId !== mode) {
                await cursorAcpClient.setMode(mode);
                cursorAcpSession.modes.currentModeId = mode;
            }
            return cursorAcpSession;
        }

        let candidateLease: CursorNativeWriterLease | undefined;
        const candidate = createCursorAcpClient(mode, model);
        const attemptedResume = Boolean(requestedResumeSessionId);
        isCollectingCursorHistory = attemptedResume && !resumedFromRemcliSessionId;
        cursorHistoryEntries.length = 0;
        cursorHistoryRole = null;
        try {
            if (trustedStartedBy === 'daemon' && requestedResumeSessionId) {
                candidateLease = await acquireCursorWriterLease(requestedResumeSessionId);
            }
            const nativeSession = await candidate.start();
            const boundLease = await bindNativeCursorSession(
                nativeSession.sessionId,
                candidateLease?.leaseId,
            );
            if (candidateLease && boundLease && candidateLease.leaseId !== boundLease.leaseId) {
                throw new CursorLifecycleError(
                    'native',
                    'Cursor native writer capability changed while ACP was starting.',
                );
            }
            candidateLease = boundLease ?? candidateLease;
            if (trustedStartedBy === 'daemon' && !candidateLease) {
                throw new CursorLifecycleError('native', 'Cursor native writer lease was not established.');
            }
            confirmInitialParentRelation(nativeSession.sessionId);

            cursorAcpClient = candidate;
            cursorAcpSession = nativeSession;
            cursorWriterLease = candidateLease;
            cursorSessionId = nativeSession.sessionId;
            requestedResumeSessionId = undefined;
            doesNativeMetadataNeedReconciliation = true;
            for (const notification of pendingCursorSessionInfoUpdates) {
                if (notification.sessionId === cursorSessionId) {
                    handleCursorAcpUpdate(notification.update);
                }
            }
            pendingCursorSessionInfoUpdates.length = 0;
            flushCursorHistory();
            await cursorSessionInfoWriteQueue;
            return nativeSession;
        } catch (error) {
            pendingCursorSessionInfoUpdates.length = 0;
            if (attemptedResume) shouldExit = true;
            await candidate.dispose().catch(() => undefined);
            if (candidateLease) {
                await releaseCursorWriterLease(candidateLease).catch(() => false);
            }
            await abandonUnverifiedResume();
            throw error;
        } finally {
            isCollectingCursorHistory = false;
        }
    };

    const reconcileInitializedCursorSession = async (nativeSession: CursorAcpSession): Promise<void> => {
        if (!doesNativeMetadataNeedReconciliation) return;
        const nativeMetadataReconciliation: CursorNativeMetadataReconciliation = {
            nativeSessionId: nativeSession.sessionId,
            model: nativeSession.models?.currentModelId,
            ...(shouldPublishParentRelation() && resumedFromRemcliSessionId
                ? { resumedFromRemcliSessionId }
                : {}),
        };
        await reconcileCursorNativeMetadata(session, nativeMetadataReconciliation);
        doesNativeMetadataNeedReconciliation = false;
    };

    const reportNativeTerminalSession = async (nativeSession: CursorAcpSession): Promise<void> => {
        if (trustedStartedBy === 'daemon' || didReportNativeTerminalSession) return;
        didReportNativeTerminalSession = true;
        await reportTerminalSessionStarted({
            agentName: 'Cursor',
            sessionId: session.sessionId,
            metadata: {
                ...baseMetadata,
                agentSessionId: nativeSession.sessionId,
                cursorSessionId: nativeSession.sessionId,
            },
        });
    };

    async function handleAbort(): Promise<void> {
        logger.debug('[Cursor] Abort requested');
        const parentRelationRollback = abandonUnverifiedResume();
        try {
            activeStructuredTurnScope = null;
            cursorPermissionHandler?.reset();
            cursorStructuredInputBroker?.clearAll();
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

            const activeAcpClient = cursorAcpClient;
            cursorStructuredInputBroker?.clearAll();
            cursorAcpClient = null;
            cursorAcpSession = null;
            activeAcpTurn = null;
            if (activeAcpClient) {
                await activeAcpClient.dispose().catch((error) => {
                    logger.debug('[Cursor] Error while stopping ACP transport:', redactDiagnosticData(error));
                });
            }
            if (cursorWriterLease) {
                const writerLease = cursorWriterLease;
                cursorWriterLease = undefined;
                const released = await releaseCursorWriterLease(writerLease).catch(() => false);
                if (!released) {
                    logger.debug('[Cursor] Daemon could not confirm Cursor ACP writer lease release.');
                }
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
    if (canBindSessionHandlers) bindSessionHandlers(session);

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
        const autoSetTitle = createAutoTitleSetter(() => session);

        if (requestedResumeSessionId) {
            try {
                const nativeSession = await ensureCursorAcpSession(
                    currentLaunchControls.executionMode as CursorAcpMode,
                    currentModel,
                );
                currentModel = nativeSession.models?.currentModelId ?? currentModel;
                await reconcileInitializedCursorSession(nativeSession);
                await reportNativeTerminalSession(nativeSession);
                canBindSessionHandlers = true;
                bindSessionHandlers(session);
                sendReady();
            } catch (error) {
                shouldExit = true;
                publishExecutionError(
                    session,
                    error instanceof CursorLifecycleError
                        ? error
                        : 'Cursor session could not be resumed. Check Cursor CLI authentication and retry.',
                    'Cursor session could not be resumed.',
                );
            }
        }

        while (!shouldExit) {
            const waitSignal = abortController.signal;
            const message = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
            if (!message) {
                if (waitSignal.aborted && !shouldExit) {
                    try {
                        // An abort RPC starts its lineage cleanup before
                        // signalling this wait. Do not accept a fresh prompt
                        // until that metadata update is settled.
                        await awaitQueuedParentRelationRollback();
                    } catch (error) {
                        logger.debug('[Cursor] Parent lineage rollback failed while idle:', redactDiagnosticData(error));
                        shouldExit = true;
                        break;
                    }
                    if (shouldExit) break;
                    logger.debug('[cursor] Wait aborted while idle, resetting abort controller and continuing');
                    abortController = new AbortController();
                    continue;
                }
                break;
            }

            let didSettleDelivery = false;
            const acknowledgeQueuedDelivery = (): void => {
                if (!message.mode.deliveryId || didSettleDelivery) return;
                didSettleDelivery = true;
                message.acknowledge();
            };
            const rejectQueuedDelivery = (error: unknown): void => {
                if (!message.mode.deliveryId || didSettleDelivery) return;
                didSettleDelivery = true;
                message.reject(error);
            };
            const cancelQueuedDelivery = (): void => {
                if (!message.mode.deliveryId || didSettleDelivery) return;
                if (message.mode.deliveryId) {
                    session.cancelPendingUserMessageDelivery(message.mode.deliveryId);
                }
                acknowledgeQueuedDelivery();
            };

            messageBuffer.addMessage(message.message, 'user');

            try {
                const prompt = message.message;
                const { launchControls } = message.mode;
                const cursorMode = launchControls.executionMode as CursorAcpMode;
                const requestedModel = message.mode.model ?? currentModel;

                const modeLabel = cursorMode === 'plan'
                    ? 'Plan'
                    : cursorMode === 'ask'
                        ? 'Ask'
                        : 'Agent';
                messageBuffer.addMessage(`Mode: ${modeLabel}`, 'system');
                logger.debug(`[Cursor] Starting ACP turn mode=${cursorMode} hasModel=true`);

                const nativeSession = await ensureCursorAcpSession(cursorMode, requestedModel);
                const selectedModel = nativeSession.models?.currentModelId ?? requestedModel;
                currentModel = selectedModel;
                try {
                    await reconcileInitializedCursorSession(nativeSession);
                } catch (error) {
                    const failure = publishExecutionError(
                        session,
                        error,
                        'Cursor native session metadata update failed.',
                    );
                    throw new RetryableUserMessageDeliveryError(new Error(failure));
                }
                await reportNativeTerminalSession(nativeSession);

                session.sendAgentMessage('cursor', {
                    type: 'task_started',
                    id: randomUUID(),
                });
                thinking = true;
                session.keepAlive(thinking, 'remote');

                isStreamingAssistant = false;
                activeAcpTurn = {
                    messageId: randomUUID(),
                    response: '',
                    toolCalls: new Map(),
                    acceptDelivery: () => {
                        acknowledgeQueuedDelivery();
                    },
                };
                const turnGeneration = ++cursorTurnGeneration;
                activeStructuredTurnScope = {
                    nativeSessionId: nativeSession.sessionId,
                    turnGeneration,
                };
                const runningTurn = cursorAcpClient!.prompt(prompt, abortController.signal);
                activeTurn = runningTurn;
                const turn = await runningTurn;
                const completedAcpTurn = activeAcpTurn;
                activeAcpTurn = null;
                if (activeTurn === runningTurn) {
                    activeTurn = null;
                }
                acknowledgeQueuedDelivery();

                if (turn.stopReason === 'cancelled') {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendAgentMessage('cursor', { type: 'turn_aborted', id: randomUUID() });
                    continue;
                }

                const responseText = completedAcpTurn?.response.trim() ?? '';
                if (responseText) {
                    session.sendAgentMessage('cursor', {
                        type: 'message',
                        message: responseText,
                        isError: false,
                        messageId: completedAcpTurn!.messageId,
                        streamState: 'final',
                    });
                }

                session.sendAgentMessage('cursor', {
                    type: 'task_complete',
                    id: randomUUID(),
                });

                await cursorSessionInfoWriteQueue;
                if (!hasPersistedNativeCursorTitle) {
                    autoSetTitle(message.message);
                }

            } catch (error) {
                activeAcpTurn = null;
                if (error instanceof RetryableUserMessageDeliveryError) {
                    rejectQueuedDelivery(error);
                } else {
                    cancelQueuedDelivery();
                }
                logger.debug('[cursor] Error in cursor session:', redactDiagnosticData(error));
                const isAbortError = abortController.signal.aborted;
                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendAgentMessage('cursor', {
                        type: 'turn_aborted',
                        id: randomUUID(),
                    });
                } else {
                    const errorMsg = error instanceof RetryableUserMessageDeliveryError
                        ? error.message
                        : error instanceof CursorLifecycleError
                            ? error.message
                            : 'Cursor ACP could not complete this turn. Check Cursor CLI authentication and retry.';
                    messageBuffer.addMessage(`Error: ${errorMsg}`, 'status');

                    session.sendAgentMessage('cursor', {
                        type: 'message',
                        message: errorMsg,
                        isError: true,
                    });
                }
            } finally {
                if (activeStructuredTurnScope) {
                    cursorStructuredInputBroker?.clearForTurn(
                        activeStructuredTurnScope.nativeSessionId,
                        activeStructuredTurnScope.turnGeneration,
                    );
                    activeStructuredTurnScope = null;
                }
                activeTurn = null;
                activeAcpTurn = null;
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
 * Tracks whether the active ACP turn is appending assistant text to the latest
 * terminal message.
 */
let isStreamingAssistant = false;
