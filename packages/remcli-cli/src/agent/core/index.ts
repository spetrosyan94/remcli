/**
 * Core Agent Types and Interfaces
 *
 * Re-exports all core agent abstractions.
 *
 * @module core
 */

// ============================================================================
// AgentBackend - Core interface and types
// ============================================================================

export type {
  SessionId,
  ToolCallId,
  AgentMessage,
  AgentMessageHandler,
  AgentBackend,
  McpServerConfig,
  AgentId,
  AgentFactoryOptions,
  StartSessionResult,
} from './AgentBackend';

// ============================================================================
// AgentMessage - Detailed message types with type guards
// ============================================================================

export type {
  AgentStatus,
  ModelOutputMessage,
  StatusMessage,
  ToolCallMessage,
  ToolResultMessage,
  PermissionRequestMessage,
  PermissionResponseMessage,
  FsEditMessage,
  TerminalOutputMessage,
  EventMessage,
  TokenCountMessage,
  ExecApprovalRequestMessage,
  PatchApplyBeginMessage,
  PatchApplyEndMessage,
} from './AgentMessage';

export {
  isPermissionRequestMessage,
  getMessageText,
} from './AgentMessage';
