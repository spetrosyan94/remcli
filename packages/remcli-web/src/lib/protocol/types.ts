/**
 * Protocol types — port of remcli-app sources/sync/apiTypes.ts + storageTypes.ts
 * (only the parts needed by the web client). Wire shapes must match
 * packages/remcli-cli/src/daemon/p2p/ (docs/protocol.md).
 */

import { z } from 'zod';

// ─── Encrypted message ───────────────────────────────────────────

export const ApiMessageSchema = z.object({
    id: z.string(),
    seq: z.number(),
    localId: z.string().nullish(),
    content: z.object({
        t: z.literal('encrypted'),
        c: z.string(), // Base64 encoded encrypted content
    }),
    createdAt: z.number(),
});

export type ApiMessage = z.infer<typeof ApiMessageSchema>;

// ─── Update events (Socket.IO `update`) ──────────────────────────

export const ApiUpdateNewMessageSchema = z.object({
    t: z.literal('new-message'),
    sid: z.string(), // Session ID
    message: ApiMessageSchema
});

export const ApiUpdateNewSessionSchema = z.object({
    t: z.literal('new-session'),
    // NOTE: P2P daemon emits `sessionId`, legacy server emitted `id` —
    // clients refetch the session list on this event anyway.
}).passthrough();

export const ApiDeleteSessionSchema = z.object({
    t: z.literal('delete-session'),
    sid: z.string().optional(),
    sessionId: z.string().optional(), // P2P daemon uses `sessionId`
});

export const ApiUpdateSessionStateSchema = z.object({
    t: z.literal('update-session'),
    id: z.string(),
    agentState: z.object({
        version: z.number(),
        value: z.string()
    }).nullish(),
    metadata: z.object({
        version: z.number(),
        value: z.string()
    }).nullish(),
});

export const ApiUpdateMachineStateSchema = z.object({
    t: z.literal('update-machine'),
    machineId: z.string(),
    metadata: z.object({
        version: z.number(),
        value: z.string() // Encrypted, client decrypts
    }).nullish(),
    daemonState: z.object({
        version: z.number(),
        value: z.string() // Encrypted, client decrypts
    }).nullish(),
    active: z.boolean().optional(),
    activeAt: z.number().optional()
});

export const ApiUpdateNewMachineSchema = z.object({
    t: z.literal('new-machine'),
    machineId: z.string(),
    seq: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    daemonState: z.string().nullish(),
    daemonStateVersion: z.number(),
    dataEncryptionKey: z.string().nullish(),
    active: z.boolean(),
    activeAt: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

export const ApiDeleteMachineSchema = z.object({
    t: z.literal('delete-machine'),
    machineId: z.string(),
});

// KV live updates (mirror of remcli-app apiTypes.ts ApiKvBatchUpdateSchema)
export const ApiKvBatchUpdateSchema = z.object({
    t: z.literal('kv-batch-update'),
    changes: z.array(z.object({
        key: z.string(),
        value: z.string().nullable(),
        version: z.number()
    }))
});

export type KvChange = z.infer<typeof ApiKvBatchUpdateSchema>['changes'][number];

export const ApiUpdateSchema = z.discriminatedUnion('t', [
    ApiUpdateNewMessageSchema,
    ApiUpdateNewSessionSchema,
    ApiDeleteSessionSchema,
    ApiUpdateSessionStateSchema,
    ApiUpdateMachineStateSchema,
    ApiUpdateNewMachineSchema,
    ApiDeleteMachineSchema,
    ApiKvBatchUpdateSchema,
]);

export type ApiUpdateNewMessage = z.infer<typeof ApiUpdateNewMessageSchema>;
export type ApiUpdate = z.infer<typeof ApiUpdateSchema>;

// ─── API update container ────────────────────────────────────────

export const ApiUpdateContainerSchema = z.object({
    id: z.string(),
    seq: z.number(),
    body: ApiUpdateSchema,
    createdAt: z.number(),
});

export type ApiUpdateContainer = z.infer<typeof ApiUpdateContainerSchema>;

// ─── Ephemeral events (Socket.IO `ephemeral`) ────────────────────

export const ApiEphemeralActivityUpdateSchema = z.object({
    type: z.literal('activity'),
    id: z.string(),
    active: z.boolean(),
    activeAt: z.number(),
    thinking: z.boolean(),
});

export const ApiEphemeralUsageUpdateSchema = z.object({
    type: z.literal('usage'),
    id: z.string(),
    key: z.string(),
    timestamp: z.number(),
    tokens: z.record(z.string(), z.number()),
    cost: z.record(z.string(), z.number()),
});

export const ApiEphemeralMachineActivityUpdateSchema = z.object({
    type: z.literal('machine-activity'),
    id: z.string(), // machine id
    active: z.boolean(),
    activeAt: z.number(),
});

export const ApiEphemeralUpdateSchema = z.discriminatedUnion('type', [
    ApiEphemeralActivityUpdateSchema,
    ApiEphemeralUsageUpdateSchema,
    ApiEphemeralMachineActivityUpdateSchema,
]);

export type ApiEphemeralActivityUpdate = z.infer<typeof ApiEphemeralActivityUpdateSchema>;
export type ApiEphemeralUpdate = z.infer<typeof ApiEphemeralUpdateSchema>;

// ─── Session metadata / agent state (decrypted payloads) ─────────

export const MetadataSchema = z.object({
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(), // Claude Code session ID
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    homeDir: z.string().optional(),
    remcliHomeDir: z.string().optional(),
    hostPid: z.number().optional(),
    flavor: z.string().nullish() // Session flavor / agent identifier
});

export type SessionMetadata = z.infer<typeof MetadataSchema>;

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish()
    })).nullish(),
    completedRequests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        completedAt: z.number().nullish(),
        status: z.enum(['canceled', 'denied', 'approved']),
        reason: z.string().nullish(),
        mode: z.string().nullish(),
        allowedTools: z.array(z.string()).nullish(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).nullish()
    })).nullish()
});

export type AgentState = z.infer<typeof AgentStateSchema>;

// ─── Machine metadata (decrypted payload) ────────────────────────

export const MachineMetadataSchema = z.object({
    host: z.string(),
    platform: z.string(),
    remcliCliVersion: z.string(),
    remcliHomeDir: z.string(),
    homeDir: z.string(),
    username: z.string().optional(),
    arch: z.string().optional(),
    displayName: z.string().optional(),
    daemonLastKnownStatus: z.enum(['running', 'shutting-down']).optional(),
    daemonLastKnownPid: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.enum(['remcli-app', 'remcli-cli', 'os-signal', 'unknown']).optional()
});

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>;

// ─── REST entities (raw, encrypted) ──────────────────────────────

export const ApiSessionSchema = z.object({
    id: z.string(),
    tag: z.string().nullish(),
    seq: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    agentState: z.string().nullable(),
    agentStateVersion: z.number(),
    dataEncryptionKey: z.string().nullable(),
    active: z.boolean(),
    activeAt: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    lastMessage: ApiMessageSchema.nullish(),
});

export type ApiSession = z.infer<typeof ApiSessionSchema>;

export const ApiMachineSchema = z.object({
    id: z.string(),
    seq: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    daemonState: z.string().nullable(),
    daemonStateVersion: z.number(),
    dataEncryptionKey: z.string().nullable(),
    active: z.boolean(),
    activeAt: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

export type ApiMachine = z.infer<typeof ApiMachineSchema>;

// ─── Decrypted client-side entities ──────────────────────────────

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'read-only' | 'safe-yolo' | 'yolo';

export interface Session {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: SessionMetadata | null;
    metadataVersion: number;
    agentState: AgentState | null;
    agentStateVersion: number;
    thinking: boolean;
    thinkingAt: number;
    presence: 'online' | number; // "online" when active, timestamp when last seen
}

export interface Machine {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    metadata: MachineMetadata | null;
    metadataVersion: number;
    daemonState: unknown | null;
    daemonStateVersion: number;
}

export interface DecryptedMessage {
    id: string;
    seq: number | null;
    localId: string | null;
    content: unknown;
    createdAt: number;
}

// ─── TTS / Whisper / Concierge ───────────────────────────────────

export interface TtsStatus {
    available: boolean;
    provider: string;
    voices: string[];
}

export interface WhisperStatus {
    available: boolean;
    model: string | null;
    modelDownloaded: boolean;
}

export interface WhisperTranscription {
    text: string;
    language: string;
    duration: number;
}

export interface ConciergeStatus {
    enabled: boolean;
    available: boolean;
    model: string | null;
}

export interface ConciergeChatMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface ConciergeChatResponse {
    reply: string;
    actions: Array<{ tool: string; result: unknown }>;
}

// ─── Agent session listing (resume feature) ──────────────────────

export type AgentKind = 'claude' | 'codex' | 'cursor' | 'gemini';

export interface AgentSessionInfo {
    sessionId: string;
    agent: AgentKind;
    projectPath: string;
    lastModified: number;
    firstMessage: string | null;
    messageCount: number;
    createdAt: number | null;
    sessionName: string | null;
}
