/**
 * Types for the local concierge service: configuration, deterministic daemon
 * capabilities (deps), and the OpenAI-compatible chat wire format.
 */

import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { CONCIERGE_TOOLS } from '@/daemon/concierge/constants';

export interface ConciergeConfig {
    /** Base URL of the OpenAI-compatible server, e.g. http://127.0.0.1:1234/v1 */
    url: string;
    /** Model id, or empty string to auto-select the first available model. */
    model: string;
}

export interface ConciergeSessionInfo {
    id: string;
    agent: string;
    directory: string;
    status: string;
}

export interface ConciergeDaemonStatus {
    version: string;
    uptimeSec: number;
    port: number;
    tunnelUrl: string | null;
}

/** Deterministic daemon capabilities the concierge is allowed to use. */
export interface ConciergeDeps {
    listSessions: () => ConciergeSessionInfo[];
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    getDaemonStatus: () => ConciergeDaemonStatus;
}

/** A message from the client history (only user/assistant turns). */
export interface ConciergeInputMessage {
    role: 'user' | 'assistant';
    content: string;
}

/** What the concierge actually did, surfaced to the UI. */
export interface ConciergeAction {
    tool: string;
    result: unknown;
}

export interface AssistantToolCall {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
}

export type ConciergeChatMessage =
    | { role: 'system' | 'user'; content: string }
    | { role: 'assistant'; content: string; tool_calls?: AssistantToolCall[] }
    | { role: 'tool'; tool_call_id: string; content: string };

export interface ConciergeRequestBody {
    model: string;
    messages: ConciergeChatMessage[];
    tools?: typeof CONCIERGE_TOOLS;
    tool_choice?: 'auto';
    temperature: number;
    stream: false;
}

export interface ConciergeResponse {
    choices?: Array<{
        message?: {
            content?: string | null;
            tool_calls?: AssistantToolCall[];
        };
    }>;
}
