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

export interface CodexRemoteTuiOpenRequest {
  agent: 'codex';
  nativeThreadId: string;
  remcliSessionId: string;
  endpoint: string;
  reasoningEffort?: string;
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

export interface DaemonSessionWebhookResult {
  accepted: boolean;
  daemonOwned: boolean;
  shouldIssueRunnerCredential?: boolean;
  /** Internal-only owner proof used by the daemon control server to mint a runner credential. */
  runnerCredentialOwner?: string;
  error?: string;
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
  nativeCodexThreadId?: string;
  runnerControlToken?: string;
  runnerControlTokenSessionId?: string;
  /** Immutable ownership proof for the daemon-created wrapper process. */
  tmuxRunner?: TmuxPaneOwnership;
  /** Immutable ownership proof for the optional interactive Codex TUI. */
  managedCodexRemoteTui?: TmuxPaneOwnership;
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
