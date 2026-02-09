/**
 * Cursor CLI Stream-JSON Types
 *
 * Type definitions for events emitted by `agent --output-format stream-json`.
 * The format is NDJSON with events very similar to Claude Code SDK.
 */

/** A single event from cursor's stream-json output */
export interface CursorStreamEvent {
    type: 'system' | 'user' | 'assistant' | 'tool_call' | 'result' | 'thinking';
    subtype?: 'init' | 'started' | 'completed' | 'success' | 'delta';
    session_id?: string;
    model?: string;
    permissionMode?: string;
    apiKeySource?: string;
    message?: { role: string; content: ContentPart[] };
    call_id?: string;
    /** Tool call data — Cursor format: { readToolCall: { args: {...}, result?: {...} } } */
    tool_call?: Record<string, unknown>;
    result?: string;
    duration_ms?: number;
    duration_api_ms?: number;
    is_error?: boolean;
    request_id?: string;
    timestamp_ms?: number;
    /** Text content (for thinking deltas) */
    text?: string;
    /** Text content delta for streaming */
    text_delta?: string;
}

export type ContentPart =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

/** Mode config for MessageQueue2 hashing */
export interface CursorMode {
    permissionMode: import('@/api/types').PermissionMode;
    model?: string;
}
