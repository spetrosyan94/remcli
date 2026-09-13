import { randomUUID } from 'node:crypto';

import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import type { DeliveredUserMessage, Metadata } from '@/api/types';
import { RetryableUserMessageDeliveryError } from '@/api/types';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import {
    bindDaemonAntigravityConversation,
    preflightDaemonAntigravityRunner,
    reportDaemonAntigravityRunnerBootstrapFailure,
    reportDaemonRunnerStopped,
    reportDaemonRunnerStopping,
} from '@/daemon/controlClient';
import { readSettings } from '@/persistence';
import type { Credentials } from '@/persistence';
import { logger } from '@/ui/logger';
import { createAutoTitleSetter } from '@/utils/autoSessionTitle';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import {
    acquireDaemonRunnerCredential,
    reportTerminalSessionStarted,
} from '@/utils/daemonRunnerCredentialBootstrap';
import { hashObject } from '@/utils/deterministicJson';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import {
    redactSensitiveCommand,
    redactSensitiveText,
} from '@/utils/redaction';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';

import type { AntigravityExecutionConfig } from './antigravityCapabilities';
import type { AntigravityLaunchControls } from './antigravityCli';
import {
    AntigravityStreamClient,
    type AntigravityStreamEvent,
    type AntigravityTurnResult,
} from './antigravityStreamClient';

const METADATA_UPDATE_OPTIONS = { maxAttempts: 2, timeoutMs: 1_000 } as const;
const MAX_TOOL_INFO_BYTES = 8 * 1_024;
const MAX_TOOL_STRING_BYTES = 2 * 1_024;
const MAX_TOOL_KEY_LENGTH = 128;
const MAX_TOOL_COLLECTION_ITEMS = 64;
const MAX_TOOL_DEPTH = 6;
const MAX_VISIBLE_DIAGNOSTIC_BYTES = 2_000;
const REDELIVERY_REQUEST_DELAYS_MS = [0, 25, 100] as const;
const MAX_AUTOMATIC_REDELIVERIES_PER_DELIVERY = 1;
const SENSITIVE_TOOL_KEY = /(token|cookie|authorization|auth|secret|password|passphrase|credential|key)/i;

type SafeToolValue = null | boolean | number | string | SafeToolValue[] | { [key: string]: SafeToolValue };

export interface AntigravityRunOptions {
    credentials: Credentials;
    startedBy?: 'daemon' | 'terminal';
    resumeSessionId?: string;
    execution?: AntigravityExecutionConfig;
    launchControls?: AntigravityLaunchControls;
}

interface ActiveDelivery {
    deliveryId?: string;
    sourceSession: ApiSessionClient;
    accepted: boolean;
    settled: boolean;
    acknowledge: () => void;
    reject: (error: unknown) => void;
}

interface QueuedMessageMode {
    deliveryId?: string;
    sourceSession: ApiSessionClient;
}

interface NativeTeardownOperation {
    client: AntigravityStreamClient;
    promise: Promise<void>;
}

interface ScheduledRedelivery {
    cancelled: boolean;
    timer: NodeJS.Timeout | null;
}

interface ActiveTurn {
    messageId: string;
    turnNumber: number;
    responseDeltaSeen: boolean;
    terminalEventSent: boolean;
    toolNames: Map<number, string>;
}

function boundedRedacted(value: string, maxBytes: number): string {
    let result = redactSensitiveCommand(redactSensitiveText(value)).trim();
    if (Buffer.byteLength(result, 'utf8') <= maxBytes) return result;
    result = Buffer.from(result, 'utf8').subarray(0, maxBytes).toString('utf8');
    while (Buffer.byteLength(result, 'utf8') > maxBytes) result = result.slice(0, -1);
    return result;
}

function projectToolValue(value: unknown, depth: number, seen: WeakSet<object>): SafeToolValue {
    if (value === null) return null;
    if (typeof value === 'string') return boundedRedacted(value, MAX_TOOL_STRING_BYTES);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    if (typeof value === 'bigint' || typeof value === 'symbol' || typeof value === 'function') {
        return boundedRedacted(String(value), MAX_TOOL_STRING_BYTES);
    }
    if (typeof value !== 'object') return String(value);
    if (depth >= MAX_TOOL_DEPTH || seen.has(value)) return '[truncated]';

    seen.add(value);
    try {
        if (Array.isArray(value)) {
            const projected = value
                .slice(0, MAX_TOOL_COLLECTION_ITEMS)
                .map((item) => projectToolValue(item, depth + 1, seen));
            if (value.length > MAX_TOOL_COLLECTION_ITEMS) projected.push('[truncated]');
            return projected;
        }

        const projected: { [key: string]: SafeToolValue } = {};
        const entries = Object.entries(value).slice(0, MAX_TOOL_COLLECTION_ITEMS);
        for (const [rawKey, nestedValue] of entries) {
            const key = boundedRedacted(rawKey, MAX_TOOL_KEY_LENGTH) || '[empty-key]';
            projected[key] = SENSITIVE_TOOL_KEY.test(rawKey)
                ? '[REDACTED]'
                : projectToolValue(nestedValue, depth + 1, seen);
        }
        if (Object.keys(value).length > MAX_TOOL_COLLECTION_ITEMS) projected['[truncated]'] = true;
        return projected;
    } finally {
        seen.delete(value);
    }
}

function boundedToolSummary(value: string): string {
    let summary = boundedRedacted(value, MAX_TOOL_INFO_BYTES);
    while (Buffer.byteLength(JSON.stringify({ summary }), 'utf8') > MAX_TOOL_INFO_BYTES) {
        const currentBytes = Buffer.byteLength(summary, 'utf8');
        const overflow = Buffer.byteLength(JSON.stringify({ summary }), 'utf8') - MAX_TOOL_INFO_BYTES;
        summary = Buffer.from(summary, 'utf8')
            .subarray(0, Math.max(0, currentBytes - Math.max(overflow, 1)))
            .toString('utf8');
    }
    return summary;
}

function safeToolInfo(toolInfo: Record<string, unknown> | undefined): Record<string, SafeToolValue> | undefined {
    if (!toolInfo) return undefined;
    const projected = projectToolValue(toolInfo, 0, new WeakSet());
    const record = typeof projected === 'object' && projected !== null && !Array.isArray(projected)
        ? projected
        : { value: projected };
    const serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') <= MAX_TOOL_INFO_BYTES) return record;
    return { summary: boundedToolSummary(serialized) };
}

function errorText(error: unknown, fallback: string): string {
    const source = error instanceof Error ? error.message : fallback;
    return boundedRedacted(source, MAX_VISIBLE_DIAGNOSTIC_BYTES) || fallback;
}

function safeDiagnostic(error: unknown, fallback: string): { error: string } {
    return { error: errorText(error, fallback) };
}

class AntigravityRunnerStoppingError extends Error {
    constructor() {
        super('Antigravity runner is stopping.');
        this.name = 'AntigravityRunnerStoppingError';
    }
}

function validateResumeSessionId(resumeSessionId: string | undefined): string | undefined {
    if (resumeSessionId === undefined) return undefined;
    if (resumeSessionId.trim() === '' || resumeSessionId.includes('\u0000')) {
        throw new Error('Antigravity resume session ID is invalid.');
    }
    return resumeSessionId;
}

function withoutResumeParent(metadata: Metadata): Metadata {
    const next = { ...metadata };
    delete next.resumedFromRemcliSessionId;
    return next;
}

function validateExecution(execution: AntigravityExecutionConfig | undefined): AntigravityExecutionConfig | undefined {
    if (!execution) return undefined;
    if (typeof execution.model !== 'string' || execution.model.trim() === ''
        || typeof execution.catalogVersion !== 'string' || execution.catalogVersion.trim() === '') {
        throw new Error('Antigravity execution selection is invalid.');
    }
    if (execution.reasoningEffort !== undefined
        && execution.reasoningEffort !== 'low'
        && execution.reasoningEffort !== 'medium'
        && execution.reasoningEffort !== 'high') {
        throw new Error('Antigravity reasoning effort is invalid.');
    }
    return { ...execution };
}

function validateLaunchControls(controls: AntigravityLaunchControls | undefined): AntigravityLaunchControls | undefined {
    if (!controls) return undefined;
    if (controls.mode !== undefined
        && controls.mode !== 'default'
        && controls.mode !== 'accept-edits'
        && controls.mode !== 'plan') {
        throw new Error('Antigravity launch mode is invalid.');
    }
    if (controls.dangerouslySkipPermissions !== undefined
        && typeof controls.dangerouslySkipPermissions !== 'boolean') {
        throw new Error('Antigravity permission control is invalid.');
    }
    if (controls.sandbox !== undefined && typeof controls.sandbox !== 'boolean') {
        throw new Error('Antigravity sandbox control is invalid.');
    }
    return { ...controls };
}

function daemonSelectionFromEnvironment(): {
    execution?: AntigravityExecutionConfig;
    launchControls?: AntigravityLaunchControls;
} {
    const model = process.env.REMCLI_ANTIGRAVITY_MODEL;
    const catalogVersion = process.env.REMCLI_ANTIGRAVITY_CATALOG_VERSION;
    const effort = process.env.REMCLI_ANTIGRAVITY_REASONING_EFFORT;
    const mode = process.env.REMCLI_ANTIGRAVITY_MODE;
    const dangerous = process.env.REMCLI_ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS;
    const sandbox = process.env.REMCLI_ANTIGRAVITY_SANDBOX;
    if (!model || !catalogVersion
        || (effort !== undefined && effort !== 'low' && effort !== 'medium' && effort !== 'high')
        || (mode !== 'default' && mode !== 'accept-edits' && mode !== 'plan')
        || (dangerous !== 'true' && dangerous !== 'false')
        || (sandbox !== 'true' && sandbox !== 'false')) {
        return {};
    }
    return {
        execution: {
            model,
            catalogVersion,
            ...(effort ? { reasoningEffort: effort } : {}),
        },
        launchControls: {
            mode,
            dangerouslySkipPermissions: dangerous === 'true',
            sandbox: sandbox === 'true',
        },
    };
}

async function reportBootstrapFailure(): Promise<void> {
    try {
        await reportDaemonAntigravityRunnerBootstrapFailure({ agent: 'antigravity', pid: process.pid });
    } catch (error) {
        logger.debug('[Antigravity] Daemon bootstrap failure report failed.', safeDiagnostic(error, 'report failed'));
    }
}

async function closeP2PSession(
    target: ApiSessionClient,
    options: { archiveReason: string; removeResumeParent: boolean },
): Promise<void> {
    const failures: Error[] = [];
    const recordFailure = (stage: string, error: unknown): void => {
        const detail = errorText(error, `${stage} failed`);
        logger.debug(`[Antigravity] Session ${stage} failed.`, { error: detail });
        try {
            target.sendAgentMessage('antigravity', {
                type: 'message',
                message: `Antigravity session ${stage} failed: ${detail}`,
                isError: true,
            });
        } catch (notificationError) {
            logger.debug(
                '[Antigravity] Could not publish the session teardown failure.',
                safeDiagnostic(notificationError, 'notification failed'),
            );
        }
        failures.push(new Error(`Antigravity session ${stage} could not be confirmed.`));
    };

    try {
        await target.updateMetadata((metadata) => ({
            ...(options.removeResumeParent ? withoutResumeParent(metadata) : metadata),
            lifecycleState: 'archived',
            lifecycleStateSince: Date.now(),
            archivedBy: 'cli',
            archiveReason: options.archiveReason,
        }), METADATA_UPDATE_OPTIONS);
    } catch (error) {
        recordFailure('metadata archival', error);
    }
    try {
        target.sendSessionDeath();
    } catch (error) {
        recordFailure('death notification', error);
    }
    try {
        await target.flush();
    } catch (error) {
        recordFailure('flush', error);
    }
    try {
        await target.close();
    } catch (error) {
        recordFailure('close', error);
    }

    if (failures.length > 0) {
        throw new AggregateError(failures, 'Antigravity P2P teardown could not be confirmed.');
    }
}

export async function runAntigravity(opts: AntigravityRunOptions): Promise<void> {
    const daemonOwned = opts.startedBy === 'daemon';
    const settings = await readSettings();
    const machineId = settings?.machineId;
    if (!machineId) {
        if (daemonOwned) {
            await reportBootstrapFailure();
            return;
        }
        throw new Error('No machine ID found in settings.');
    }

    let requestedResumeConversationId: string | undefined;
    let execution: AntigravityExecutionConfig | undefined;
    let launchControls: AntigravityLaunchControls | undefined;
    try {
        requestedResumeConversationId = validateResumeSessionId(opts.resumeSessionId);
        execution = validateExecution(opts.execution);
        launchControls = validateLaunchControls(opts.launchControls);
    } catch (error) {
        if (!daemonOwned) throw error;
        await reportBootstrapFailure();
        return;
    }
    let verifiedParentRemcliSessionId: string | undefined;

    if (daemonOwned) {
        if (!process.env.REMCLI_DAEMON_RUNNER_TOKEN) {
            await reportBootstrapFailure();
            return;
        }
        const environmentSelection = daemonSelectionFromEnvironment();
        execution ??= environmentSelection.execution;
        launchControls ??= environmentSelection.launchControls;
        if (!execution || !launchControls
            || launchControls.mode === undefined
            || launchControls.dangerouslySkipPermissions === undefined
            || launchControls.sandbox === undefined) {
            await reportBootstrapFailure();
            return;
        }
        const preflight = await preflightDaemonAntigravityRunner({
            agent: 'antigravity',
            ...(requestedResumeConversationId !== undefined
                ? { nativeResumeConversationId: requestedResumeConversationId }
                : {}),
            directory: process.cwd(),
            pid: process.pid,
        }).catch(() => null);
        if (!preflight?.ok || preflight.data.type !== 'verified') {
            await reportBootstrapFailure();
            return;
        }
        verifiedParentRemcliSessionId = preflight.data.parentRemcliSessionId;
    }

    const sessionTag = randomUUID();
    const { state, metadata: baseMetadata } = createSessionMetadata({
        flavor: 'antigravity',
        machineId,
        startedBy: opts.startedBy,
    });
    const executionProjection = execution
        ? {
            antigravityExecution: {
                model: execution.model,
                ...(execution.reasoningEffort ? { reasoningEffort: execution.reasoningEffort } : {}),
            },
        }
        : {};
    const initialMetadata: Metadata = {
        ...baseMetadata,
        ...executionProjection,
        ...(verifiedParentRemcliSessionId
            ? { resumedFromRemcliSessionId: verifiedParentRemcliSessionId }
            : {}),
    };
    const reconnectMetadata = { ...initialMetadata };

    let api: ApiClient;
    let response: Awaited<ReturnType<ApiClient['getOrCreateSession']>>;
    try {
        api = await ApiClient.create(opts.credentials);
        response = await api.getOrCreateSession({ tag: sessionTag, metadata: initialMetadata, state });
    } catch (error) {
        if (!daemonOwned) throw error;
        logger.debug('[Antigravity] P2P bootstrap failed.', safeDiagnostic(error, 'P2P bootstrap failed'));
        await reportBootstrapFailure();
        return;
    }

    if (daemonOwned && !response) {
        await reportBootstrapFailure();
        return;
    }

    if (daemonOwned && response) {
        let credentialAccepted = false;
        try {
            credentialAccepted = await acquireDaemonRunnerCredential({
                agentName: 'Antigravity',
                sessionId: response.id,
                metadata: initialMetadata,
            });
        } catch (error) {
            logger.debug('[Antigravity] Daemon credential handoff failed.', safeDiagnostic(error, 'handoff failed'));
        }
        if (!credentialAccepted) {
            const provisionalSession = api.sessionSyncClient(response);
            let teardownError: unknown;
            try {
                await closeP2PSession(provisionalSession, {
                    archiveReason: 'Daemon credential handoff failed',
                    removeResumeParent: Boolean(verifiedParentRemcliSessionId),
                });
            } catch (error) {
                teardownError = error;
            }
            delete reconnectMetadata.resumedFromRemcliSessionId;
            await reportBootstrapFailure();
            if (teardownError) throw teardownError;
            return;
        }
    } else if (response) {
        await reportTerminalSessionStarted({
            agentName: 'Antigravity',
            sessionId: response.id,
            metadata: initialMetadata,
        });
    }

    let session: ApiSessionClient;
    let bindSessionHandlers: ((target: ApiSessionClient) => void) | null = null;
    let handleSessionSwap: ((target: ApiSessionClient) => void) | null = null;
    const offline = setupOfflineReconnection({
        api,
        sessionTag,
        metadata: reconnectMetadata,
        state,
        response,
        canCreateReconnectedSessionConsumer: daemonOwned
            ? async (reconnected) => acquireDaemonRunnerCredential({
                agentName: 'Antigravity',
                sessionId: reconnected.id,
                metadata: reconnectMetadata,
            })
            : undefined,
        onSessionSwap: (nextSession) => {
            session = nextSession;
            handleSessionSwap?.(nextSession);
            bindSessionHandlers?.(nextSession);
        },
    });
    session = offline.session;

    const queue = new MessageQueue2<QueuedMessageMode>((mode) => hashObject({
        deliveryId: mode.deliveryId,
    }));
    let stream: AntigravityStreamClient | null = null;
    let nativeConversationId: string | null = null;
    let nextNativeConversationId = requestedResumeConversationId;
    let nativeSetupPromise: Promise<void> | null = null;
    let nativeTeardownOperation: NativeTeardownOperation | null = null;
    let nativeMetadataPublished = false;
    let nativeMetadataSession: ApiSessionClient | null = null;
    let resumeVerified = requestedResumeConversationId === undefined;
    let shouldExit = false;
    let cleanupPromise: Promise<void> | null = null;
    let activeDelivery: ActiveDelivery | null = null;
    let activeTurn: ActiveTurn | null = null;
    let activeProviderTurn: Promise<AntigravityTurnResult> | null = null;
    let unconfirmedNativeCleanupError: unknown;
    let turnNumber = 0;
    const waitAbortController = new AbortController();
    const automaticRedeliveries = new Map<string, number>();
    const scheduledRedeliveries = new Map<string, ScheduledRedelivery>();

    const sendError = (message: string): void => {
        session.sendAgentMessage('antigravity', { type: 'message', message, isError: true });
    };

    const cancelScheduledRedelivery = (deliveryId: string): void => {
        const scheduled = scheduledRedeliveries.get(deliveryId);
        if (!scheduled) return;
        scheduled.cancelled = true;
        if (scheduled.timer) clearTimeout(scheduled.timer);
        scheduledRedeliveries.delete(deliveryId);
    };

    const schedulePendingRedelivery = (delivery: ActiveDelivery): void => {
        const { deliveryId, sourceSession } = delivery;
        if (!deliveryId || shouldExit || scheduledRedeliveries.has(deliveryId)) return;
        if ((automaticRedeliveries.get(deliveryId) ?? 0) >= MAX_AUTOMATIC_REDELIVERIES_PER_DELIVERY) {
            logger.debug('[Antigravity] Automatic redelivery limit reached.');
            return;
        }

        const scheduled: ScheduledRedelivery = { cancelled: false, timer: null };
        scheduledRedeliveries.set(deliveryId, scheduled);
        let attempt = 0;
        const request = (): void => {
            if (scheduled.cancelled || shouldExit) {
                scheduledRedeliveries.delete(deliveryId);
                return;
            }

            let requested = false;
            try {
                requested = sourceSession.requestPendingUserMessageRedelivery();
            } catch (error) {
                logger.debug(
                    '[Antigravity] Pending user message redelivery request failed.',
                    safeDiagnostic(error, 'redelivery request failed'),
                );
            }
            if (requested) {
                automaticRedeliveries.set(deliveryId, (automaticRedeliveries.get(deliveryId) ?? 0) + 1);
                scheduledRedeliveries.delete(deliveryId);
                return;
            }

            attempt += 1;
            if (attempt >= REDELIVERY_REQUEST_DELAYS_MS.length) {
                scheduledRedeliveries.delete(deliveryId);
                return;
            }
            scheduled.timer = setTimeout(request, REDELIVERY_REQUEST_DELAYS_MS[attempt]);
            scheduled.timer.unref?.();
        };

        scheduled.timer = setTimeout(request, REDELIVERY_REQUEST_DELAYS_MS[0]);
        scheduled.timer.unref?.();
    };

    const acceptDelivery = (): void => {
        const delivery = activeDelivery;
        if (!delivery || delivery.accepted) return;
        delivery.accepted = true;
        if (delivery.deliveryId) {
            cancelScheduledRedelivery(delivery.deliveryId);
            automaticRedeliveries.delete(delivery.deliveryId);
        }
        delivery.acknowledge();
    };

    const emitTurnTerminal = (kind: 'complete' | 'aborted'): void => {
        const turn = activeTurn;
        if (!turn || turn.terminalEventSent) return;
        turn.terminalEventSent = true;
        session.sendAgentMessage('antigravity', {
            type: kind === 'complete' ? 'task_complete' : 'turn_aborted',
            id: randomUUID(),
        });
    };

    const onProviderEvent = (event: AntigravityStreamEvent): void => {
        if (event.event === 'init' || !activeTurn) return;
        acceptDelivery();
        if (event.event !== 'step_update') return;

        const step = event.step_update;
        if (step.step_type === 'agent_response' && step.text_delta) {
            activeTurn.responseDeltaSeen = true;
            session.sendAgentMessage('antigravity', {
                type: 'message',
                message: step.text_delta,
                isError: false,
                messageId: activeTurn.messageId,
                streamState: 'delta',
            });
            return;
        }
        if (!step.tool_name && !step.tool_info) return;

        const callId = `antigravity-${activeTurn.turnNumber}-${step.step_index}`;
        const name = step.tool_name
            ?? activeTurn.toolNames.get(step.step_index)
            ?? 'Antigravity tool';
        activeTurn.toolNames.set(step.step_index, name);
        if (step.state === 'ACTIVE') {
            session.sendAgentMessage('antigravity', {
                type: 'tool-call',
                callId,
                name,
                input: safeToolInfo(step.tool_info),
                id: randomUUID(),
            });
        } else if (step.state === 'DONE' || step.state === 'ERROR') {
            session.sendAgentMessage('antigravity', {
                type: 'tool-result',
                callId,
                output: safeToolInfo(step.tool_info) ?? { name, state: step.state },
                id: randomUUID(),
                ...(step.state === 'ERROR' ? { isError: true } : {}),
            });
        }
    };

    const teardownNativeClient = (
        candidate: AntigravityStreamClient,
        mode: 'abort' | 'stop',
    ): Promise<void> => {
        if (nativeTeardownOperation?.client === candidate) return nativeTeardownOperation.promise;

        const teardown = (async () => {
            try {
                if (mode === 'abort') await candidate.abort();
                else await candidate.stop();
            } catch (error) {
                unconfirmedNativeCleanupError = error;
                throw error;
            }

            if (stream === candidate) {
                stream = null;
                nativeConversationId = null;
                nativeMetadataPublished = false;
                nativeMetadataSession = null;
            }
        })();
        nativeTeardownOperation = { client: candidate, promise: teardown };
        return teardown;
    };

    const ensureNativeStreamAndBinding = (): Promise<void> => {
        if (stream && nativeConversationId) return Promise.resolve();
        if (nativeSetupPromise) return nativeSetupPromise;
        if (shouldExit) return Promise.reject(new AntigravityRunnerStoppingError());
        if (stream) return Promise.reject(new Error('Antigravity native setup state is inconsistent.'));

        const launchConversationId = nextNativeConversationId;
        const candidate = new AntigravityStreamClient({
            cwd: process.cwd(),
            ...(launchConversationId !== undefined
                ? { conversationId: launchConversationId }
                : {}),
            ...(execution
                ? {
                    model: execution.model,
                    ...(execution.reasoningEffort ? { effort: execution.reasoningEffort } : {}),
                }
                : {}),
            ...(launchControls ?? {}),
            onEvent: onProviderEvent,
            onStderr: (diagnostic) => {
                if (!activeTurn) return;
                sendError(`Antigravity stderr: ${boundedRedacted(diagnostic, MAX_VISIBLE_DIAGNOSTIC_BYTES)}`);
            },
        });

        stream = candidate;
        nativeMetadataPublished = false;
        nativeMetadataSession = null;
        const setup = (async () => {
            try {
                const initializedConversationId = await candidate.start(launchConversationId);
                if (launchConversationId !== undefined
                    && initializedConversationId !== launchConversationId) {
                    throw new Error('Antigravity resumed a different native conversation.');
                }
                nextNativeConversationId = initializedConversationId;
                if (shouldExit || stream !== candidate) throw new AntigravityRunnerStoppingError();
                if (daemonOwned) {
                    const binding = await bindDaemonAntigravityConversation({
                        agent: 'antigravity',
                        nativeConversationId: initializedConversationId,
                        remcliSessionId: session.sessionId,
                    });
                    if (!binding.ok || (binding.data.type !== 'bound' && binding.data.type !== 'already-bound')) {
                        throw new Error(`Antigravity conversation binding failed: ${binding.ok ? binding.data.type : binding.error}`);
                    }
                }
                if (shouldExit || stream !== candidate) throw new AntigravityRunnerStoppingError();
                nativeConversationId = initializedConversationId;
                nativeMetadataPublished = false;
                nativeMetadataSession = null;
                resumeVerified = true;
            } catch (startError) {
                try {
                    await teardownNativeClient(candidate, 'stop');
                } catch (cleanupError) {
                    const combinedError = new AggregateError(
                        [startError, cleanupError],
                        'Antigravity startup failed and native cleanup could not be confirmed.',
                    );
                    unconfirmedNativeCleanupError = combinedError;
                    throw combinedError;
                }
                throw startError;
            }
        })();
        nativeSetupPromise = setup;
        void setup.then(
            () => {
                if (nativeSetupPromise === setup) nativeSetupPromise = null;
            },
            () => {
                if (nativeSetupPromise === setup) nativeSetupPromise = null;
            },
        );
        return setup;
    };

    const reconcileNativeMetadata = async (): Promise<void> => {
        if (nativeMetadataPublished && nativeMetadataSession === session) return;
        if (!nativeConversationId) throw new Error('Antigravity native conversation is not initialized.');
        const targetSession = session;
        await targetSession.updateMetadata((metadata) => ({
            ...metadata,
            agentSessionId: nativeConversationId!,
            antigravitySessionId: nativeConversationId!,
            ...executionProjection,
            ...(verifiedParentRemcliSessionId && resumeVerified
                ? { resumedFromRemcliSessionId: verifiedParentRemcliSessionId }
                : {}),
        }), METADATA_UPDATE_OPTIONS);
        if (session === targetSession) {
            nativeMetadataPublished = true;
            nativeMetadataSession = targetSession;
        }
    };

    const rollbackUnverifiedResumeParent = async (): Promise<void> => {
        if (!verifiedParentRemcliSessionId || resumeVerified) return;
        delete reconnectMetadata.resumedFromRemcliSessionId;
        await session.updateMetadata(withoutResumeParent, METADATA_UPDATE_OPTIONS);
    };

    handleSessionSwap = () => {
        nativeMetadataPublished = false;
        nativeMetadataSession = null;
    };

    const publishCleanupFailure = (
        target: ApiSessionClient,
        operation: string,
        error: unknown,
    ): void => {
        const detail = errorText(error, 'cleanup failed');
        logger.debug(`[Antigravity] ${operation} failed.`, { error: detail });
        try {
            target.sendAgentMessage('antigravity', {
                type: 'message',
                message: `Antigravity ${operation} failed: ${detail}`,
                isError: true,
            });
        } catch (notificationError) {
            logger.debug(
                '[Antigravity] Could not publish the cleanup failure.',
                safeDiagnostic(notificationError, 'notification failed'),
            );
        }
    };

    const cleanup = (): Promise<void> => {
        if (cleanupPromise) return cleanupPromise;
        cleanupPromise = (async () => {
            shouldExit = true;
            waitAbortController.abort();
            const targetSession = session;
            const deliveryAtCleanup = activeDelivery;
            const setupAtCleanup = nativeSetupPromise;
            const activeStream = stream;
            const cleanupFailures: unknown[] = [];
            const stoppingReport = daemonOwned
                ? reportDaemonRunnerStopping(targetSession.sessionId).catch(() => null)
                : null;

            for (const deliveryId of Array.from(scheduledRedeliveries.keys())) {
                cancelScheduledRedelivery(deliveryId);
            }
            automaticRedeliveries.clear();
            queue.close();
            emitTurnTerminal('aborted');

            let reconnectionCleanupError: Error | null = null;
            try {
                offline.reconnectionHandle?.cancel();
            } catch (error) {
                publishCleanupFailure(targetSession, 'reconnection cancellation', error);
                reconnectionCleanupError = new Error('Antigravity reconnection cancellation could not be confirmed.');
            }

            let nativeCleanupError = unconfirmedNativeCleanupError;
            let nativeCleanup: Promise<void> | null = null;
            if (activeStream && !nativeCleanupError) {
                nativeCleanup = teardownNativeClient(activeStream, 'abort');
            }

            if (stoppingReport) {
                const stopping = await stoppingReport;
                if (!stopping?.ok || !stopping.data.accepted) {
                    logger.debug('[Antigravity] Daemon did not accept runner stopping signal.');
                }
            }

            if (nativeCleanup) {
                try {
                    await nativeCleanup;
                } catch (error) {
                    nativeCleanupError = error;
                }
            }
            if (setupAtCleanup) await setupAtCleanup.catch(() => undefined);
            await activeProviderTurn?.catch(() => undefined);
            nativeCleanupError ??= unconfirmedNativeCleanupError;
            if (nativeCleanupError) {
                publishCleanupFailure(targetSession, 'native cleanup', nativeCleanupError);
                cleanupFailures.push(nativeCleanupError);
            }
            if (reconnectionCleanupError) cleanupFailures.push(reconnectionCleanupError);

            if (deliveryAtCleanup && !deliveryAtCleanup.settled) {
                if (nativeCleanupError) {
                    deliveryAtCleanup.reject(new RetryableUserMessageDeliveryError(nativeCleanupError));
                } else {
                    if (deliveryAtCleanup.deliveryId) {
                        deliveryAtCleanup.sourceSession.cancelPendingUserMessageDelivery(deliveryAtCleanup.deliveryId);
                    }
                    deliveryAtCleanup.acknowledge();
                }
            }

            try {
                await closeP2PSession(targetSession, {
                    archiveReason: 'User terminated',
                    removeResumeParent: Boolean(verifiedParentRemcliSessionId && !resumeVerified),
                });
            } catch (error) {
                cleanupFailures.push(error);
            }

            if (cleanupFailures.length === 1) throw cleanupFailures[0];
            if (cleanupFailures.length > 1) {
                throw new AggregateError(cleanupFailures, 'Antigravity cleanup could not be confirmed.');
            }
            if (daemonOwned) {
                const stopped = await reportDaemonRunnerStopped(targetSession.sessionId).catch(() => null);
                if (!stopped?.ok || !stopped.data.accepted) {
                    logger.debug('[Antigravity] Daemon could not confirm runner cleanup; tracking remains fail-closed.');
                }
            }
        })();
        return cleanupPromise;
    };

    const attachedSessions = new WeakSet<ApiSessionClient>();
    bindSessionHandlers = (target) => {
        if (attachedSessions.has(target)) return;
        attachedSessions.add(target);
        target.onUserMessage(async (message: DeliveredUserMessage) => {
            if (Object.prototype.hasOwnProperty.call(message.meta ?? {}, 'model')
                || Object.prototype.hasOwnProperty.call(message.meta ?? {}, 'permissionMode')) {
                logger.debug('[Antigravity] Ignoring per-message model/permission controls.');
            }
            const mode: QueuedMessageMode = {
                sourceSession: target,
                ...(message.deliveryId ? { deliveryId: message.deliveryId } : {}),
            };
            if (message.deliveryId) {
                await queue.pushWithAcceptance(message.content.text, mode);
            } else {
                queue.push(message.content.text, mode);
            }
        });
        target.rpcHandlerManager.registerHandler('abort', cleanup);
        registerKillSessionHandler(target.rpcHandlerManager, cleanup);
    };

    const signals = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
    const signalHandler = (): void => {
        void cleanup().catch((error) => {
            logger.debug('[Antigravity] Signal cleanup failed.', safeDiagnostic(error, 'cleanup failed'));
        });
    };
    signals.forEach((signal) => process.on(signal, signalHandler));
    const keepAliveInterval = setInterval(() => session.keepAlive(Boolean(activeTurn), 'remote'), 2_000);
    session.keepAlive(false, 'remote');
    const autoSetTitle = createAutoTitleSetter(() => session);

    try {
        if (requestedResumeConversationId !== undefined) {
            try {
                await ensureNativeStreamAndBinding();
                try {
                    await reconcileNativeMetadata();
                } catch (error) {
                    sendError(errorText(error, 'Antigravity native metadata update failed.'));
                }
            } catch (error) {
                if (!shouldExit) {
                    shouldExit = true;
                    try {
                        await rollbackUnverifiedResumeParent();
                    } catch (rollbackError) {
                        logger.debug(
                            '[Antigravity] Resume parent rollback failed.',
                            safeDiagnostic(rollbackError, 'rollback failed'),
                        );
                    }
                    sendError(`Antigravity session could not be resumed: ${errorText(error, 'resume failed')}`);
                }
            }
        }

        if (!shouldExit) {
            bindSessionHandlers(session);
            session.sendSessionEvent({ type: 'ready' });
        }

        while (!shouldExit) {
            const batch = await queue.waitForMessagesAndGetAsString(waitAbortController.signal);
            if (!batch) break;

            const delivery: ActiveDelivery = {
                deliveryId: batch.mode.deliveryId,
                sourceSession: batch.mode.sourceSession,
                accepted: false,
                settled: false,
                acknowledge: () => {
                    if (delivery.settled) return;
                    delivery.settled = true;
                    batch.acknowledge();
                },
                reject: (error) => {
                    if (delivery.settled) return;
                    delivery.settled = true;
                    batch.reject(error);
                },
            };
            activeDelivery = delivery;
            let providerTurnStarted = false;

            try {
                await ensureNativeStreamAndBinding();
                if (shouldExit) throw new AntigravityRunnerStoppingError();
                try {
                    await reconcileNativeMetadata();
                } catch (error) {
                    throw new RetryableUserMessageDeliveryError(error);
                }
                if (shouldExit) throw new AntigravityRunnerStoppingError();

                activeTurn = {
                    messageId: randomUUID(),
                    turnNumber: ++turnNumber,
                    responseDeltaSeen: false,
                    terminalEventSent: false,
                    toolNames: new Map(),
                };
                session.sendAgentMessage('antigravity', { type: 'task_started', id: randomUUID() });
                providerTurnStarted = true;
                activeProviderTurn = stream!.sendTurn(batch.message);
                const result = await activeProviderTurn;
                activeProviderTurn = null;
                if (shouldExit) continue;
                acceptDelivery();

                if (result.status === 'SUCCESS') {
                    if (result.response.trim() || activeTurn.responseDeltaSeen) {
                        session.sendAgentMessage('antigravity', {
                            type: 'message',
                            message: result.response,
                            isError: false,
                            messageId: activeTurn.messageId,
                            streamState: 'final',
                        });
                    }
                    emitTurnTerminal('complete');
                    autoSetTitle(batch.message);
                } else {
                    sendError(result.error
                        ? boundedRedacted(result.error, MAX_VISIBLE_DIAGNOSTIC_BYTES)
                        : `Antigravity turn ended with status ${result.status}.`);
                    emitTurnTerminal(result.status === 'CANCELED' || result.status === 'INTERRUPTED'
                        ? 'aborted'
                        : 'complete');
                }
            } catch (error) {
                activeProviderTurn = null;
                if (shouldExit) {
                    if (providerTurnStarted) emitTurnTerminal('aborted');
                } else {
                    const retryable = error instanceof RetryableUserMessageDeliveryError
                        ? error
                        : new RetryableUserMessageDeliveryError(error);
                    if (providerTurnStarted) emitTurnTerminal('aborted');
                    sendError(errorText(error, 'Antigravity could not complete this turn.'));

                    let recoveryCleanupError: unknown;
                    const failedStream = stream;
                    if (providerTurnStarted && !delivery.accepted && failedStream) {
                        try {
                            await teardownNativeClient(failedStream, 'stop');
                        } catch (cleanupError) {
                            recoveryCleanupError = new AggregateError(
                                [error, cleanupError],
                                'Antigravity provider failed and native cleanup could not be confirmed.',
                            );
                            unconfirmedNativeCleanupError = recoveryCleanupError;
                        }
                    }

                    if (!shouldExit) {
                        if (!delivery.accepted) {
                            delivery.reject(new RetryableUserMessageDeliveryError(recoveryCleanupError ?? retryable));
                            if (recoveryCleanupError) shouldExit = true;
                            else schedulePendingRedelivery(delivery);
                        } else {
                            shouldExit = true;
                        }
                    }
                    if (unconfirmedNativeCleanupError) shouldExit = true;
                }
            } finally {
                activeProviderTurn = null;
                activeTurn = null;
                activeDelivery = null;
                session.keepAlive(false, 'remote');
                if (!shouldExit) session.sendSessionEvent({ type: 'ready' });
            }
        }
    } finally {
        signals.forEach((signal) => process.off(signal, signalHandler));
        clearInterval(keepAliveInterval);
        await cleanup();
    }
}
