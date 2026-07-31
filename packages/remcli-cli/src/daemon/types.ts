/**
 * Daemon-specific types (not related to API/server communication)
 */

import {
  Metadata,
  SessionExecutionConsumeResponse,
  SessionExecutionSelection,
  SessionExecutionSnapshot,
} from '@/api/types';
import { ChildProcess } from 'child_process';
import type { CodexSandbox } from '@/codex/types';
import type { CursorRunnerIdentity } from '@/cursor/cursorCapabilities';

/** Private state retained only by the daemon for a daemon-owned wrapper. */
export interface DaemonSessionExecutionState {
  snapshot: SessionExecutionSnapshot;
  codexPermissionMode?: CodexSandbox;
  cursorRunner?: CursorRunnerIdentity;
}

export interface DaemonSessionExecutionSeed {
  provider: 'codex' | 'cursor';
  current: SessionExecutionSelection;
  codexPermissionMode?: CodexSandbox;
  cursorRunner?: CursorRunnerIdentity;
}

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
  /** Opaque daemon-issued capability for a pre-acquired headless writer lease. */
  writerLeaseId?: string;
}

export interface NativeCursorSessionWrapper {
  agent: 'cursor';
  nativeSessionId: string;
  remcliSessionId: string;
}

/** Cursor has no attach transport: exactly one native process may write a session at a time. */
export type CursorNativeWriterOwner = 'headless' | 'interactive';

/** Opaque daemon-issued capability; it is never derived from a native session ID. */
export interface CursorNativeWriterLease {
  agent: 'cursor';
  leaseId: string;
  nativeSessionId: string;
  remcliSessionId: string;
  owner: CursorNativeWriterOwner;
}

/** Authenticated daemon-runner request before a known native Cursor resume starts. */
export interface CursorHeadlessWriterLeaseAcquireRequest {
  agent: 'cursor';
  nativeSessionId: string;
  remcliSessionId: string;
}

/** Exact capability required to release a headless writer after its native turn exits. */
export interface CursorNativeWriterLeaseReleaseRequest {
  agent: 'cursor';
  leaseId: string;
  nativeSessionId: string;
  remcliSessionId: string;
}

export interface CursorNativeWriterLeaseReleaseResult {
  released: boolean;
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

/** Capability-bound report from Cursor before it has created any P2P metadata. */
export interface CursorRunnerBootstrapFailureRequest {
  agent: 'cursor';
  pid: number;
  runnerToken: string;
}

/** The daemon only acknowledges a report after exact owned-runner validation. */
export interface CursorRunnerBootstrapFailureResult {
  accepted: boolean;
}

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
  | { type: 'bound'; wrapper: NativeCursorSessionWrapper; writerLease: CursorNativeWriterLease }
  | { type: 'already-bound'; wrapper: NativeCursorSessionWrapper; writerLease: CursorNativeWriterLease }
  | { type: 'reuse-active-wrapper'; wrapper: NativeCursorSessionWrapper }
  | { type: 'wrapper-not-tracked'; binding: NativeCursorSessionBinding }
  | {
    type: 'native-session-mismatch';
    binding: NativeCursorSessionBinding;
    expectedNativeSessionId: string;
  }
  | { type: 'writer-busy'; binding: NativeCursorSessionBinding; owner: CursorNativeWriterOwner }
  | { type: 'writer-lease-mismatch'; binding: NativeCursorSessionBinding }
  | {
    type: 'agent-mismatch';
    binding: NativeCursorSessionBinding;
    trackedAgent: 'claude' | 'codex' | 'cursor' | 'gemini';
  };

export type CursorHeadlessWriterLeaseAcquireResult =
  | { type: 'acquired'; writerLease: CursorNativeWriterLease }
  | { type: 'writer-busy'; request: CursorHeadlessWriterLeaseAcquireRequest; owner: CursorNativeWriterOwner }
  | { type: 'wrapper-not-tracked'; request: CursorHeadlessWriterLeaseAcquireRequest }
  | {
    type: 'agent-mismatch';
    request: CursorHeadlessWriterLeaseAcquireRequest;
    trackedAgent: 'claude' | 'codex' | 'cursor' | 'gemini';
  }
  | {
    type: 'native-session-mismatch';
    request: CursorHeadlessWriterLeaseAcquireRequest;
    trackedNativeSessionId?: string;
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
  | { type: 'writer-busy'; request: CursorInteractiveTuiOpenRequest; owner: CursorNativeWriterOwner }
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

export type SessionExecutionLookupResult =
  | { type: 'found'; snapshot: SessionExecutionSnapshot }
  | { type: 'unavailable' }
  | { type: 'provider-mismatch'; provider: 'codex' | 'cursor' };

export type SessionExecutionSetResult =
  | { type: 'updated'; snapshot: SessionExecutionSnapshot }
  | { type: 'revision-mismatch'; snapshot: SessionExecutionSnapshot }
  | { type: 'unavailable' }
  | { type: 'provider-mismatch'; provider: 'codex' | 'cursor' };

export type SessionExecutionConsumeResult =
  | { type: 'consumed'; response: SessionExecutionConsumeResponse }
  | { type: 'unavailable' }
  | { type: 'provider-mismatch'; provider: 'codex' | 'cursor' };

/** A daemon-owned runner acknowledged a graceful local shutdown transition. */
export interface DaemonRunnerLifecycleResult {
  accepted: boolean;
}

/** Terminal.app is optional for a daemon runner, but its launch outcome is explicit. */
export type DaemonTerminalLaunchResult =
  | { type: 'opened' }
  | { type: 'unavailable'; error: 'terminal-unavailable' }
  | { type: 'not-requested' };

/** Spawn outcome separates daemon-runner readiness from optional Terminal.app availability. */
export type DaemonSpawnSessionResult =
  | { type: 'success'; sessionId: string; terminal: DaemonTerminalLaunchResult }
  | { type: 'requestToApproveDirectoryCreation'; directory: string }
  | { type: 'error'; errorMessage: string };

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
  /** Private daemon-only state created from validated spawn options. */
  executionSeed?: DaemonSessionExecutionSeed;
  /** Private daemon-only state attached after the wrapper reports its P2P session ID. */
  executionState?: DaemonSessionExecutionState;
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
  /** macOS Terminal.app launch state for the daemon-owned runner, when attempted. */
  terminalLaunch?: DaemonTerminalLaunchResult;
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
