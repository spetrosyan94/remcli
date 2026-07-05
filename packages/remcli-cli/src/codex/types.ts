/**
 * Type definitions for Codex MCP integration
 */

export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexToolResponse {
    content: Array<{
        type: 'text' | 'image' | 'resource';
        text?: string;
        data?: any;
        mimeType?: string;
    }>;
    isError?: boolean;
}
