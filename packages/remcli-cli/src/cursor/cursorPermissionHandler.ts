import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import { logger } from '@/ui/logger';
import { ApiSessionClient } from '@/api/apiSession';
import { redactDiagnosticData } from '@/utils/redaction';
import {
    BasePermissionHandler,
    type PermissionResult,
} from '@/utils/BasePermissionHandler';

/**
 * Permission option kinds advertised by Cursor ACP.
 *
 * This is deliberately a closed set. The bridge must never invent an option
 * id or silently approve a request when Cursor did not advertise the choice.
 */
export type CursorPermissionDecision = 'allow_once' | 'allow_always' | 'reject_once';

type CursorPermissionInput = {
    kind?: RequestPermissionRequest['toolCall']['kind'];
    rawInput?: unknown;
};

function redactCursorInput(input: CursorPermissionInput): CursorPermissionInput {
    const redacted = redactDiagnosticData(input);
    if (!redacted || typeof redacted !== 'object' || Array.isArray(redacted)) {
        return {};
    }
    return redacted as CursorPermissionInput;
}

function toCursorDecision(decision: PermissionResult['decision']): CursorPermissionDecision {
    switch (decision) {
        case 'approved':
            return 'allow_once';
        case 'approved_for_session':
            return 'allow_always';
        case 'denied':
        case 'abort':
            return 'reject_once';
    }
}

/**
 * Cursor-specific bridge between ACP permission requests and Remcli's
 * existing mobile permission state machine.
 *
 * ACP supplies the native tool-call id, title, kind and raw input. Remcli's
 * UI answers through the BasePermissionHandler `permission` RPC. The bridge
 * keeps the provider's decision vocabulary at the boundary and exposes only
 * the exact ACP option kind to CursorAcpClient.
 */
export class CursorPermissionHandler extends BasePermissionHandler {
    constructor(session: ApiSessionClient) {
        super(session);
    }

    protected getLogPrefix(): string {
        return '[Cursor]';
    }

    /**
     * Receive the exact ACP request shape used by Cursor.
     *
     * The request id used by Remcli is the ACP toolCallId, not a generated
     * wrapper id, so responses remain correlated across reconnects.
     */
    async handleRequest(request: RequestPermissionRequest): Promise<CursorPermissionDecision> {
        const { toolCallId, title, kind, rawInput } = request.toolCall;
        if (!title) {
            logger.debug(`${this.getLogPrefix()} Permission request has no tool title`);
            return 'reject_once';
        }
        const input: CursorPermissionInput = {
            ...(kind === undefined ? {} : { kind }),
            ...(rawInput === undefined ? {} : { rawInput: redactDiagnosticData(rawInput) }),
        };

        return this.handleToolCall(toolCallId, title, input);
    }

    /**
     * Wait for the mobile UI decision and convert it to the exact Cursor ACP
     * permission kind. No decision is auto-approved.
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: CursorPermissionInput,
    ): Promise<CursorPermissionDecision> {
        const safeInput = redactCursorInput(input);
        const result = await new Promise<PermissionResult>((resolve, reject) => {
            this.pendingRequests.set(toolCallId, {
                resolve,
                reject,
                toolName,
                input: safeInput,
            });

            // Keep the state payload useful to the UI while ensuring the
            // inherited debug state logger cannot receive provider raw input.
            this.addPendingRequestToState(toolCallId, toolName, safeInput);
            logger.debug(`${this.getLogPrefix()} Permission request is pending for ${toolName}`);
        }).catch((error: unknown) => {
            // BasePermissionHandler rejects pending requests on reset. A
            // single rejection is safer for Cursor than leaving its RPC open;
            // CursorAcpClient may still turn this into ACP `cancelled`.
            logger.debug(`${this.getLogPrefix()} Permission request was cancelled`);
            return { decision: 'abort' as const, error };
        });

        return toCursorDecision(result.decision);
    }

    /**
     * Re-publish unresolved requests after ApiSessionClient is replaced by a
     * reconnect. The pending promises remain provider-owned and are resolved
     * by the new session's registered permission RPC handler.
     */
    override updateSession(newSession: ApiSessionClient): void {
        super.updateSession(newSession);

        for (const [toolCallId, pending] of this.pendingRequests) {
            this.addPendingRequestToState(toolCallId, pending.toolName, pending.input);
        }
    }

    /** Cancel is an explicit alias for the idempotent base reset operation. */
    cancel(): void {
        this.reset();
    }
}
