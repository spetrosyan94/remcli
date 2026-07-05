/**
 * Gemini Permission Handler
 *
 * Handles tool permission requests and responses for Gemini ACP sessions.
 * Extends BasePermissionHandler with Gemini-specific permission mode logic.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import type { PermissionMode } from '@/api/types';
import {
    BasePermissionHandler,
    PermissionResult,
    PendingRequest
} from '@/utils/BasePermissionHandler';

// Re-export types for backwards compatibility
export type { PermissionResult, PendingRequest };

const DISPLAY_ONLY_TOOL_NAMES = ['GeminiReasoning', 'CodexReasoning'];
const UI_ONLY_TOOL_NAMES = ['change_title', 'remcli__change_title'];
const UI_ONLY_TOOL_IDS = ['change_title'];
const READ_ONLY_TOOL_NAMES = ['read', 'list', 'ls', 'glob', 'grep', 'search', 'find', 'view', 'cat', 'stat', 'inspect'];
const WRITE_TOOL_NAMES = ['write', 'edit', 'create', 'delete', 'patch', 'replace', 'remove', 'rename', 'move', 'copy', 'fs-edit'];
const WRITE_COMMAND_RE =
    /(?:^|[;&|]\s*)(?:rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|dd|mkfs)\b|(?:^|[;&|]\s*)git\s+(?:commit|push|reset|checkout|merge|rebase|clean|tag)\b|(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|update|upgrade)\b|(?:^|[;&|]\s*)sed\s+-i\b|(?:^|[;&|]\s*)tee\b|>>?[^&]/i;

function normalizedText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return '';
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ['command', 'cmd', 'script', 'path', 'file_path', 'filePath', 'operation']) {
        const part = record[key];
        if (typeof part === 'string') parts.push(part);
    }
    return parts.join('\n');
}

function isDisplayOnlyTool(toolName: string): boolean {
    const lowerName = toolName.toLowerCase();
    return DISPLAY_ONLY_TOOL_NAMES.some((name) => lowerName.includes(name.toLowerCase()));
}

function isUiOnlyTool(toolName: string, toolCallId: string): boolean {
    const lowerName = toolName.toLowerCase();
    const lowerId = toolCallId.toLowerCase();
    return UI_ONLY_TOOL_NAMES.some((name) => lowerName.includes(name.toLowerCase()))
        || UI_ONLY_TOOL_IDS.some((id) => lowerId.includes(id.toLowerCase()));
}

function isWriteOperation(toolName: string, input: unknown): boolean {
    const lowerName = toolName.toLowerCase();
    if (WRITE_TOOL_NAMES.some((name) => lowerName.includes(name))) return true;
    return WRITE_COMMAND_RE.test(normalizedText(input));
}

function isReadOnlyOperation(toolName: string, input: unknown): boolean {
    if (isWriteOperation(toolName, input)) return false;
    const lowerName = toolName.toLowerCase();
    return READ_ONLY_TOOL_NAMES.some((name) => lowerName.includes(name));
}

/**
 * Gemini-specific permission handler with permission mode support.
 */
export class GeminiPermissionHandler extends BasePermissionHandler {
    private currentPermissionMode: PermissionMode = 'default';

    constructor(session: ApiSessionClient) {
        super(session);
    }

    protected getLogPrefix(): string {
        return '[Gemini]';
    }

    /**
     * Update session reference (override for type visibility)
     */
    updateSession(newSession: ApiSessionClient): void {
        super.updateSession(newSession);
    }

    /**
     * Set the current permission mode
     * This affects how tool calls are automatically approved/denied
     */
    setPermissionMode(mode: PermissionMode): void {
        this.currentPermissionMode = mode;
        logger.debug(`${this.getLogPrefix()} Permission mode set to: ${mode}`);
    }

    /**
     * Check if a tool should be auto-approved based on permission mode
     */
    private shouldAutoApprove(toolName: string, toolCallId: string, input: unknown): boolean {
        if (isDisplayOnlyTool(toolName) || isUiOnlyTool(toolName, toolCallId)) {
            return true;
        }

        switch (this.currentPermissionMode) {
            case 'yolo':
                // Auto-approve everything in yolo mode
                return true;
            case 'safe-yolo':
                return isReadOnlyOperation(toolName, input);
            case 'read-only':
                return isReadOnlyOperation(toolName, input);
            case 'default':
                return false;
            default:
                // Unknown modes must ask rather than silently auto-approve.
                return false;
        }
    }

    private denyToolCall(toolCallId: string, toolName: string, input: unknown): PermissionResult {
        logger.debug(`${this.getLogPrefix()} Denying write tool ${toolName} (${toolCallId}) in read-only mode`);

        this.session.updateAgentState((currentState) => ({
            ...currentState,
            completedRequests: {
                ...currentState.completedRequests,
                [toolCallId]: {
                    tool: toolName,
                    arguments: input,
                    createdAt: Date.now(),
                    completedAt: Date.now(),
                    status: 'denied',
                    decision: 'denied'
                }
            }
        }));

        return { decision: 'denied' };
    }

    /**
     * Handle a tool permission request
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown
    ): Promise<PermissionResult> {
        // Check if we should auto-approve based on permission mode
        // Pass toolCallId to check by ID (e.g., change_title-* even if toolName is "other")
        if (this.shouldAutoApprove(toolName, toolCallId, input)) {
            logger.debug(`${this.getLogPrefix()} Auto-approving tool ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);

            // Update agent state with auto-approved request
            this.session.updateAgentState((currentState) => ({
                ...currentState,
                completedRequests: {
                    ...currentState.completedRequests,
                    [toolCallId]: {
                        tool: toolName,
                        arguments: input,
                        createdAt: Date.now(),
                        completedAt: Date.now(),
                        status: 'approved',
                        decision: this.currentPermissionMode === 'yolo' ? 'approved_for_session' : 'approved'
                    }
                }
            }));

            return {
                decision: this.currentPermissionMode === 'yolo' ? 'approved_for_session' : 'approved'
            };
        }

        if (this.currentPermissionMode === 'read-only') {
            return this.denyToolCall(toolCallId, toolName, input);
        }

        // Otherwise, ask for permission
        return new Promise<PermissionResult>((resolve, reject) => {
            // Store the pending request
            this.pendingRequests.set(toolCallId, {
                resolve,
                reject,
                toolName,
                input
            });

            // Update agent state with pending request
            this.addPendingRequestToState(toolCallId, toolName, input);

            logger.debug(`${this.getLogPrefix()} Permission request sent for tool: ${toolName} (${toolCallId}) in ${this.currentPermissionMode} mode`);
        });
    }
}
