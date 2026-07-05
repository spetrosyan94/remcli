/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

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
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
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
