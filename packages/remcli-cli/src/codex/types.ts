/**
 * Type definitions for Codex MCP integration
 */

export type CodexApprovalPolicy = 'untrusted' | 'on-request' | 'never';
export type CodexApprovalsReviewer = 'user' | 'auto_review';
export type CodexSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface CodexSessionConfigOverrides {
    approvals_reviewer?: CodexApprovalsReviewer;
}

export interface CodexSessionConfig {
    prompt: string;
    'approval-policy'?: CodexApprovalPolicy;
    'base-instructions'?: string;
    config?: CodexSessionConfigOverrides & Record<string, unknown>;
    cwd?: string;
    'include-plan-tool'?: boolean;
    model?: string;
    profile?: string;
    sandbox?: CodexSandbox;
}

export interface CodexToolResponse {
    content: Array<{
        type: 'text' | 'image' | 'resource';
        text?: string;
        data?: any;
        mimeType?: string;
    }>;
    isError?: boolean;
}
