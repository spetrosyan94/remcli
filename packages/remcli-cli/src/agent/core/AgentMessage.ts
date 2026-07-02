/**
 * AgentMessage - Universal message types for agent communication
 *
 * This module defines the message types that flow between:
 * - Agent backends (Gemini, Codex, Claude, etc.)
 * - Remcli
 * - Mobile app (via Remcli server)
 *
 * These types are backend-agnostic and work with any agent that
 * implements the AgentBackend interface.
 *
 * @module AgentMessage
 */

/** Unique identifier for an agent session */
export type SessionId = string;

/** Unique identifier for a tool call */
export type ToolCallId = string;

/**
 * Agent status values
 */
export type AgentStatus = 'starting' | 'running' | 'idle' | 'stopped' | 'error';

/**
 * Model output message - text chunks from the agent
 */
export interface ModelOutputMessage {
  type: 'model-output';
  /** Incremental text delta (streaming) */
  textDelta?: string;
  /** Full text (when not streaming) */
  fullText?: string;
}

/**
 * Status message - agent lifecycle state
 */
export interface StatusMessage {
  type: 'status';
  status: AgentStatus;
  /** Additional details (e.g., error message) */
  detail?: string;
}

/**
 * Tool call message - agent is calling a tool
 */
export interface ToolCallMessage {
  type: 'tool-call';
  toolName: string;
  args: Record<string, unknown>;
  callId: ToolCallId;
}

/**
 * Tool result message - result from a tool call
 */
export interface ToolResultMessage {
  type: 'tool-result';
  toolName: string;
  result: unknown;
  callId: ToolCallId;
}

/**
 * Permission request message - agent needs user approval
 */
export interface PermissionRequestMessage {
  type: 'permission-request';
  id: string;
  reason: string;
  payload: unknown;
}

/**
 * Permission response message - user's decision
 */
export interface PermissionResponseMessage {
  type: 'permission-response';
  id: string;
  approved: boolean;
}

/**
 * File system edit message - agent modified a file
 */
export interface FsEditMessage {
  type: 'fs-edit';
  description: string;
  diff?: string;
  path?: string;
}

/**
 * Terminal output message - output from terminal commands
 */
export interface TerminalOutputMessage {
  type: 'terminal-output';
  data: string;
}

/**
 * Generic event message - extensible for agent-specific events
 */
export interface EventMessage {
  type: 'event';
  name: string;
  payload: unknown;
}

/**
 * Token count message - usage information
 */
export interface TokenCountMessage {
  type: 'token-count';
  [key: string]: unknown;
}

/**
 * Exec approval request message (Codex-style)
 */
export interface ExecApprovalRequestMessage {
  type: 'exec-approval-request';
  call_id: string;
  [key: string]: unknown;
}

/**
 * Patch apply begin message (Codex-style)
 */
export interface PatchApplyBeginMessage {
  type: 'patch-apply-begin';
  call_id: string;
  auto_approved?: boolean;
  changes: Record<string, unknown>;
}

/**
 * Patch apply end message (Codex-style)
 */
export interface PatchApplyEndMessage {
  type: 'patch-apply-end';
  call_id: string;
  stdout?: string;
  stderr?: string;
  success: boolean;
}

/**
 * Union type of all agent messages.
 *
 * These messages are emitted by agent backends and forwarded
 * to the Remcli server and mobile app.
 */
export type AgentMessage =
  | ModelOutputMessage
  | StatusMessage
  | ToolCallMessage
  | ToolResultMessage
  | PermissionRequestMessage
  | PermissionResponseMessage
  | FsEditMessage
  | TerminalOutputMessage
  | EventMessage
  | TokenCountMessage
  | ExecApprovalRequestMessage
  | PatchApplyBeginMessage
  | PatchApplyEndMessage;

/**
 * Type guard for permission request messages
 */
export function isPermissionRequestMessage(msg: AgentMessage): msg is PermissionRequestMessage {
  return msg.type === 'permission-request';
}

/**
 * Extract text content from a model output message
 */
export function getMessageText(msg: ModelOutputMessage): string {
  return msg.textDelta ?? msg.fullText ?? '';
}
