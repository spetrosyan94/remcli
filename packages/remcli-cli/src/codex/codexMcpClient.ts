/**
 * Codex MCP Client - Simple wrapper for Codex tools
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { logger } from '@/ui/logger';
import type { CodexSessionConfig, CodexToolResponse } from './types';
import { z } from 'zod';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { CodexPermissionHandler } from './utils/permissionHandler';
import type { PermissionResult } from '@/utils/BasePermissionHandler';
import { execSync } from 'child_process';

const DEFAULT_TIMEOUT = 14 * 24 * 60 * 60 * 1000; // 14 days, which is the half of the maximum possible timeout (~28 days for int32 value in NodeJS)

interface CodexElicitationMeta {
    codex_approval_kind?: string;
    tool_title?: string;
    tool_params?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface CodexElicitationParams {
    _meta?: CodexElicitationMeta;
    message?: string;
    codex_mcp_tool_call_id?: string;
    codex_call_id?: string;
    codex_command?: string[];
    codex_cwd?: string;
}

export function isRemcliChangeTitleElicitation(params: CodexElicitationParams): boolean {
    const meta = params._meta;
    const title = meta?.tool_params?.title;
    const message = params.message ?? '';

    return meta?.codex_approval_kind === 'mcp_tool_call'
        && meta.tool_title === 'Change Chat Title'
        && typeof title === 'string'
        && message.includes('remcli MCP server')
        && message.includes('"change_title"');
}

export function permissionResultToElicitResult(result: PermissionResult): ElicitResult {
    if (result.decision === 'approved' || result.decision === 'approved_for_session') {
        return { action: 'accept', content: {} };
    }

    if (result.decision === 'denied') {
        return { action: 'decline' };
    }

    return { action: 'cancel' };
}

export interface CodexReplyArguments extends Record<string, unknown> {
    threadId: string;
    prompt: string;
}

export function createCodexReplyArguments(threadId: string, prompt: string): CodexReplyArguments {
    return { threadId, prompt };
}

/**
 * Get the correct MCP subcommand based on installed codex version
 * Versions >= 0.43.0-alpha.5 use 'mcp-server', older versions use 'mcp'
 * Returns null if codex is not installed or version cannot be determined
 */
function getCodexMcpCommand(): string | null {
    try {
        const version = execSync('codex --version', { encoding: 'utf8' }).trim();
        const match = version.match(/codex-cli\s+(\d+\.\d+\.\d+(?:-alpha\.\d+)?)/);
        if (!match) {
            logger.debug('[CodexMCP] Could not parse codex version:', version);
            return null;
        }

        const versionStr = match[1];
        const [major, minor, patch] = versionStr.split(/[-.]/).map(Number);

        // Version >= 0.43.0-alpha.5 has mcp-server
        if (major > 0 || minor > 43) return 'mcp-server';
        if (minor === 43 && patch === 0) {
            // Check for alpha version
            if (versionStr.includes('-alpha.')) {
                const alphaNum = parseInt(versionStr.split('-alpha.')[1]);
                return alphaNum >= 5 ? 'mcp-server' : 'mcp';
            }
            return 'mcp-server'; // 0.43.0 stable has mcp-server
        }
        return 'mcp'; // Older versions use mcp
    } catch (error) {
        logger.debug('[CodexMCP] Codex CLI not found or not executable:', error);
        return null;
    }
}

export class CodexMcpClient {
    private client: Client;
    private transport: StdioClientTransport | null = null;
    private connected: boolean = false;
    private threadId: string | null = null;
    private sessionId: string | null = null;
    private conversationId: string | null = null;
    private handler: ((event: any) => void) | null = null;
    private threadIdChangeHandler: ((threadId: string) => void) | null = null;
    private permissionHandler: CodexPermissionHandler | null = null;

    constructor() {
        this.client = new Client(
            { name: 'remcli-codex-client', version: '1.0.0' },
            { capabilities: { elicitation: {} } }
        );

        this.client.setNotificationHandler(z.object({
            method: z.literal('codex/event'),
            params: z.object({
                msg: z.any()
            })
        }).passthrough(), (data) => {
            const msg = data.params.msg;
            this.updateIdentifiersFromEvent(msg);
            this.handler?.(msg);
        });
    }

    setHandler(handler: ((event: any) => void) | null): void {
        this.handler = handler;
    }

    setThreadIdChangeHandler(handler: ((threadId: string) => void) | null): void {
        this.threadIdChangeHandler = handler;
    }

    /**
     * Set the permission handler for tool approval
     */
    setPermissionHandler(handler: CodexPermissionHandler): void {
        this.permissionHandler = handler;
    }

    setThreadId(threadId: string): void {
        this.threadId = threadId;
        this.sessionId = threadId;
        this.conversationId = threadId;
        logger.debug('[CodexMCP] Thread ID set for resume:', threadId);
    }

    async connect(): Promise<void> {
        if (this.connected) return;

        const mcpCommand = getCodexMcpCommand();

        if (mcpCommand === null) {
            throw new Error(
                'Codex CLI not found or not executable.\n' +
                '\n' +
                'To install codex:\n' +
                '  npm install -g @openai/codex\n' +
                '\n' +
                'Alternatively, use Claude:\n' +
                '  remcli claude'
            );
        }

        logger.debug(`[CodexMCP] Connecting to Codex MCP server using command: codex ${mcpCommand}`);

        this.transport = new StdioClientTransport({
            command: 'codex',
            args: [mcpCommand],
            env: Object.keys(process.env).reduce((acc, key) => {
                const value = process.env[key];
                if (typeof value === 'string') acc[key] = value;
                return acc;
            }, {} as Record<string, string>)
        });

        // Register request handlers for Codex permission methods
        this.registerPermissionHandlers();

        await this.client.connect(this.transport);
        this.connected = true;

        logger.debug('[CodexMCP] Connected to Codex');
    }

    private registerPermissionHandlers(): void {
        // Register handler for exec command approval requests
        this.client.setRequestHandler(
            ElicitRequestSchema,
            async (request) => {
                logger.debug('[CodexMCP] Received elicitation request:', request.params);

                const params = request.params as unknown as CodexElicitationParams;

                if (isRemcliChangeTitleElicitation(params)) {
                    logger.debug('[CodexMCP] Auto-approving remcli change_title elicitation');
                    return { action: 'accept', content: {} } satisfies ElicitResult;
                }

                const toolName = 'CodexBash';
                const toolCallId = params.codex_call_id ?? params.codex_mcp_tool_call_id;

                // If no permission handler set, deny by default
                if (!this.permissionHandler) {
                    logger.debug('[CodexMCP] No permission handler set, denying by default');
                    return { action: 'decline' } satisfies ElicitResult;
                }

                if (!toolCallId || !Array.isArray(params.codex_command)) {
                    logger.debug('[CodexMCP] Unsupported elicitation request shape, declining');
                    return { action: 'decline' } satisfies ElicitResult;
                }

                try {
                    // Request permission through the handler
                    const result = await this.permissionHandler.handleToolCall(
                        toolCallId,
                        toolName,
                        {
                            command: params.codex_command,
                            cwd: params.codex_cwd
                        }
                    );

                    logger.debug('[CodexMCP] Permission result:', result);
                    return permissionResultToElicitResult(result);
                } catch (error) {
                    logger.debug('[CodexMCP] Error handling permission request:', error);
                    return { action: 'decline' } satisfies ElicitResult;
                }
            }
        );

        logger.debug('[CodexMCP] Permission handlers registered');
    }

    async startSession(config: CodexSessionConfig, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        logger.debug('[CodexMCP] Starting Codex session:', config);

        const response = await this.client.callTool({
            name: 'codex',
            arguments: config as any
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT,
            // maxTotalTimeout: 10000000000 
        });

        logger.debug('[CodexMCP] startSession response:', response);

        // Extract session / conversation identifiers from response if present
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }

    async continueSession(prompt: string, options?: { signal?: AbortSignal }): Promise<CodexToolResponse> {
        if (!this.connected) await this.connect();

        const threadId = this.getActiveThreadId();
        if (!threadId) {
            throw new Error('No active session. Call startSession first.');
        }

        const args = createCodexReplyArguments(threadId, prompt);
        logger.debug('[CodexMCP] Continuing Codex session:', args);

        const response = await this.client.callTool({
            name: 'codex-reply',
            arguments: args
        }, undefined, {
            signal: options?.signal,
            timeout: DEFAULT_TIMEOUT
        });

        logger.debug('[CodexMCP] continueSession response:', response);
        this.extractIdentifiers(response);

        return response as CodexToolResponse;
    }


    private updateIdentifiersFromEvent(event: any): void {
        if (!event || typeof event !== 'object') {
            return;
        }

        const candidates: any[] = [event];
        if (event.data && typeof event.data === 'object') {
            candidates.push(event.data);
        }
        if (event.structuredContent && typeof event.structuredContent === 'object') {
            candidates.push(event.structuredContent);
        }

        for (const candidate of candidates) {
            const threadId = candidate.thread_id ?? candidate.threadId;
            if (typeof threadId === 'string') {
                this.rememberThreadId(threadId, 'event');
            }

            const sessionId = candidate.session_id ?? candidate.sessionId;
            if (typeof sessionId === 'string') {
                this.sessionId = sessionId;
                logger.debug('[CodexMCP] Session ID extracted from event:', this.sessionId);
                if (!this.threadId) {
                    this.rememberThreadId(sessionId, 'event session ID');
                }
            }

            const conversationId = candidate.conversation_id ?? candidate.conversationId;
            if (typeof conversationId === 'string') {
                this.conversationId = conversationId;
                logger.debug('[CodexMCP] Conversation ID extracted from event:', this.conversationId);
                if (!this.threadId) {
                    this.rememberThreadId(conversationId, 'event conversation ID');
                }
            }
        }
    }
    private extractIdentifiers(response: any): void {
        const meta = response?.meta || {};
        if (typeof response?.structuredContent?.threadId === 'string') {
            this.rememberThreadId(response.structuredContent.threadId, 'structuredContent');
        }

        if (typeof meta.threadId === 'string') {
            this.rememberThreadId(meta.threadId, 'metadata');
        } else if (typeof response?.threadId === 'string') {
            this.rememberThreadId(response.threadId, 'response');
        }

        if (typeof meta.sessionId === 'string') {
            this.sessionId = meta.sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
            if (!this.threadId) {
                this.rememberThreadId(meta.sessionId, 'metadata session ID');
            }
        } else if (typeof response?.sessionId === 'string') {
            this.sessionId = response.sessionId;
            logger.debug('[CodexMCP] Session ID extracted:', this.sessionId);
            if (!this.threadId) {
                this.rememberThreadId(response.sessionId, 'response session ID');
            }
        }

        if (typeof meta.conversationId === 'string') {
            this.conversationId = meta.conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
            if (!this.threadId) {
                this.rememberThreadId(meta.conversationId, 'metadata conversation ID');
            }
        } else if (typeof response?.conversationId === 'string') {
            this.conversationId = response.conversationId;
            logger.debug('[CodexMCP] Conversation ID extracted:', this.conversationId);
            if (!this.threadId) {
                this.rememberThreadId(response.conversationId, 'response conversation ID');
            }
        }

        const content = response?.content;
        if (Array.isArray(content)) {
            for (const item of content) {
                if (typeof item?.structuredContent?.threadId === 'string') {
                    this.rememberThreadId(item.structuredContent.threadId, 'content structuredContent');
                }
                if (typeof item?.threadId === 'string') {
                    this.rememberThreadId(item.threadId, 'content');
                }
                if (!this.sessionId && typeof item?.sessionId === 'string') {
                    this.sessionId = item.sessionId;
                    logger.debug('[CodexMCP] Session ID extracted from content:', this.sessionId);
                    if (!this.threadId) {
                        this.rememberThreadId(item.sessionId, 'content session ID');
                    }
                }
                if (!this.conversationId && item && typeof item === 'object' && 'conversationId' in item && typeof item.conversationId === 'string') {
                    this.conversationId = item.conversationId;
                    logger.debug('[CodexMCP] Conversation ID extracted from content:', this.conversationId);
                    if (!this.threadId) {
                        this.rememberThreadId(item.conversationId, 'content conversation ID');
                    }
                }
            }
        }
    }

    private getActiveThreadId(): string | null {
        return this.threadId ?? this.conversationId ?? this.sessionId;
    }

    private rememberThreadId(threadId: string, source: string): void {
        const previousThreadId = this.threadId;
        this.threadId = threadId;
        if (!this.sessionId) {
            this.sessionId = threadId;
        }
        if (!this.conversationId) {
            this.conversationId = threadId;
        }
        logger.debug(`[CodexMCP] Thread ID extracted from ${source}:`, threadId);
        if (previousThreadId !== threadId) {
            this.threadIdChangeHandler?.(threadId);
        }
    }

    hasActiveSession(): boolean {
        return this.getActiveThreadId() !== null;
    }

    clearSession(): void {
        // Store the previous thread ID before clearing for diagnostics.
        const previousThreadId = this.getActiveThreadId();
        this.threadId = null;
        this.sessionId = null;
        this.conversationId = null;
        logger.debug('[CodexMCP] Session cleared, previous threadId:', previousThreadId);
    }

    /**
     * Force close the Codex MCP transport and clear all session identifiers.
     * Use this for permanent shutdown (e.g. kill/exit). Prefer `disconnect()` for
     * transient connection resets where you may want to keep the session id.
     */
    async forceCloseSession(): Promise<void> {
        logger.debug('[CodexMCP] Force closing session');
        try {
            await this.disconnect();
        } finally {
            this.clearSession();
        }
        logger.debug('[CodexMCP] Session force-closed');
    }

    async disconnect(): Promise<void> {
        if (!this.connected) return;

        // Capture pid in case we need to force-kill
        const pid = this.transport?.pid ?? null;
        logger.debug(`[CodexMCP] Disconnecting; child pid=${pid ?? 'none'}`);

        try {
            // Ask client to close the transport
            logger.debug('[CodexMCP] client.close begin');
            await this.client.close();
            logger.debug('[CodexMCP] client.close done');
        } catch (e) {
            logger.debug('[CodexMCP] Error closing client, attempting transport close directly', e);
            try { 
                logger.debug('[CodexMCP] transport.close begin');
                await this.transport?.close?.(); 
                logger.debug('[CodexMCP] transport.close done');
            } catch {}
        }

        // As a last resort, if child still exists, send SIGKILL
        if (pid) {
            try {
                process.kill(pid, 0); // check if alive
                logger.debug('[CodexMCP] Child still alive, sending SIGKILL');
                try { process.kill(pid, 'SIGKILL'); } catch {}
            } catch { /* not running */ }
        }

        this.transport = null;
        this.connected = false;
        // Preserve session/conversation identifiers for potential reconnection / recovery flows.
        logger.debug(`[CodexMCP] Disconnected; thread ${this.getActiveThreadId() ?? 'none'} preserved`);
    }
}
