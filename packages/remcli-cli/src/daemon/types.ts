/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

export interface NativeCodexThreadBinding {
  agent: 'codex';
  nativeThreadId: string;
  remcliSessionId: string;
}

export interface NativeCodexThreadWrapper {
  agent: 'codex';
  nativeThreadId: string;
  remcliSessionId: string;
}

/** A daemon-owned Cursor wrapper may bind one currently active native session. */
export interface NativeCursorSessionBinding {
  agent: 'cursor';
  nativeSessionId: string;
  remcliSessionId: string;
}

export interface NativeCursorSessionWrapper {
  agent: 'cursor';
  nativeSessionId: string;
  remcliSessionId: string;
}

/** Internal daemon request to prepare the one native Cursor TUI for a bound wrapper. */
export interface CursorInteractiveTuiOpenRequest {
  agent: 'cursor';
  nativeSessionId: string;
  remcliSessionId: string;
}

/** Capability-bound request made by a daemon-spawned Cursor runner before it creates P2P metadata. */
export interface CursorRunnerPreflightRequest {
  agent: 'claude' | 'codex' | 'cursor' | 'gemini';
  nativeResumeSessionId?: string;
  pid: number;
  runnerToken: string;
}

/** Public loopback response after a valid daemon runner preflight. */
export interface CursorRunnerPreflightResponse {
  type: 'verified';
  parentRemcliSessionId?: string;
}

/** Internal result; rejected requests must not receive private daemon data. */
export type CursorRunnerPreflightResult =
  | CursorRunnerPreflightResponse
  | { type: 'rejected' };

/** Parent relation captured only after daemon-owned native Cursor binding and workspace validation. */
export interface CursorResumeLineage {
  nativeResumeSessionId: string;
  parentRemcliSessionId: string;
}

export interface CodexRemoteTuiOpenRequest {
  agent: 'codex';
  nativeThreadId: string;
  remcliSessionId: string;
  endpoint: string;
  /** `null` explicitly omits an unsupported reasoning option from the native TUI command. */
  reasoningEffort: string | null;
  model?: string;
}

/** Immutable tmux identity captured when the daemon creates a pane. */
export interface TmuxPaneOwnership {
  windowId: string;
  sessionName: string;
  paneId: string;
  panePid: number;
  ownerMarker: string;
}

export type NativeCodexThreadBindingResult =
  | { type: 'bound'; wrapper: NativeCodexThreadWrapper }
  | { type: 'already-bound'; wrapper: NativeCodexThreadWrapper }
  | { type: 'reuse-active-wrapper'; wrapper: NativeCodexThreadWrapper }
  | { type: 'wrapper-not-tracked'; binding: NativeCodexThreadBinding }
  | {
    type: 'agent-mismatch';
    binding: NativeCodexThreadBinding;
    trackedAgent: 'claude' | 'codex' | 'cursor' | 'gemini';
  };

export type NativeCursorSessionBindingResult =
  | { type: 'bound'; wrapper: NativeCursorSessionWrapper }
  | { type: 'already-bound'; wrapper: NativeCursorSessionWrapper }
  | { type: 'reuse-active-wrapper'; wrapper: NativeCursorSessionWrapper }
  | { type: 'wrapper-not-tracked'; binding: NativeCursorSessionBinding }
  | {
    type: 'agent-mismatch';
    binding: NativeCursorSessionBinding;
    trackedAgent: 'claude' | 'codex' | 'cursor' | 'gemini';
  };

export type CodexRemoteTuiOpenResult =
  | { type: 'opened'; wrapper: NativeCodexThreadWrapper; tmuxWindowId: string }
  | { type: 'already-open'; wrapper: NativeCodexThreadWrapper; tmuxWindowId: string }
  | { type: 'wrapper-not-tracked'; request: CodexRemoteTuiOpenRequest }
  | {
    type: 'agent-mismatch';
    request: CodexRemoteTuiOpenRequest;
    trackedAgent: 'claude' | 'codex' | 'cursor' | 'gemini';
  }
  | {
    type: 'native-thread-mismatch';
    request: CodexRemoteTuiOpenRequest;
    trackedNativeThreadId?: string;
  }
  | {
    type: 'wrapper-not-daemon-owned';
    request: CodexRemoteTuiOpenRequest;
  }
  | {
    type: 'host-unavailable';
    request: CodexRemoteTuiOpenRequest;
    error: string;
  };

export type CursorInteractiveTuiOpenResult =
  | { type: 'opened'; wrapper: NativeCursorSessionWrapper; tmuxWindowId: string }
  | { type: 'already-open'; wrapper: NativeCursorSessionWrapper; tmuxWindowId: string }
  | { type: 'wrapper-not-tracked'; request: CursorInteractiveTuiOpenRequest }
  | {
    type: 'agent-mismatch';
    request: CursorInteractiveTuiOpenRequest;
    trackedAgent: 'claude' | 'codex' | 'cursor' | 'gemini';
  }
  | {
    type: 'native-session-mismatch';
    request: CursorInteractiveTuiOpenRequest;
    trackedNativeSessionId?: string;
  }
  | {
    type: 'launch-unavailable';
    request: CursorInteractiveTuiOpenRequest;
    error: string;
  };

export interface DaemonSessionWebhookResult {
  accepted: boolean;
  daemonOwned: boolean;
  shouldIssueRunnerCredential?: boolean;
  /** Internal-only owner proof used by the daemon control server to mint a runner credential. */
  runnerCredentialOwner?: string;
  error?: string;
}

/** A daemon-owned runner acknowledged a graceful local shutdown transition. */
export interface DaemonRunnerLifecycleResult {
  accepted: boolean;
}

export type CodexThreadResumeResult =
  | { type: 'reuse-active-wrapper'; wrapper: NativeCodexThreadWrapper }
  | { type: 'wrapper-starting'; nativeThreadId: string }
  | { type: 'spawn-new-wrapper'; nativeThreadId: string };

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  remcliSessionId?: string;
  remcliSessionMetadataFromLocalWebhook?: Metadata;
  expectedAgent?: 'claude' | 'codex' | 'cursor' | 'gemini';
  expectedResumeSessionId?: string;
  expectedResumeKey?: string;
  /** Daemon-selected working directory before the runner has published metadata. */
  expectedDirectory?: string;
  /** In-memory resume relation eligible only for a capability-bound Cursor preflight. */
  cursorResumeLineage?: CursorResumeLineage;
  nativeCodexThreadId?: string;
  nativeCursorSessionId?: string;
  runnerControlToken?: string;
  runnerControlTokenSessionId?: string;
  /** Immutable ownership proof for the daemon-created wrapper process. */
  tmuxRunner?: TmuxPaneOwnership;
  /** Immutable ownership proof for the optional interactive Codex TUI. */
  managedCodexRemoteTui?: TmuxPaneOwnership;
  /** Immutable ownership proof for the future interactive Cursor TUI bridge. */
  managedCursorInteractiveTui?: TmuxPaneOwnership;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** Display-only tmux identifier (format: session:window); never use it for destructive cleanup. */
  tmuxSessionId?: string;
}

export interface StopSessionSuccess {
  success: true;
  stoppedSessionId: string;
}

export interface StopSessionFailure {
  success: false;
}

export type StopSessionResult = StopSessionSuccess | StopSessionFailure;
