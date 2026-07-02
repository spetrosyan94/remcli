/**
 * Agent Module - Universal agent backend abstraction
 *
 * This module provides the core abstraction layer for different AI agents
 * (Claude, Codex, Gemini, OpenCode, etc.) that can be controlled through
 * the Remcli and mobile app.
 */

// Core types, interfaces, and registry - re-export from core/
export type {
  AgentMessage,
  AgentMessageHandler,
  AgentBackend,
  McpServerConfig,
  AgentId,
  SessionId,
  ToolCallId,
  StartSessionResult,
  AgentFactoryOptions,
} from './core';

// ACP backend (low-level)
export * from './acp';

// Agent factories (high-level, recommended)
export * from './factories';
