/**
 * Message content schema + normalization for daemon message payloads.
 *
 * Decrypted message payloads (RawRecord) come from Claude/Codex/Gemini/Cursor
 * via the daemon; normalizeRawMessage() converts them to a uniform shape for
 * rendering: user text / agent content blocks (text, thinking, tool-call,
 * tool-result with permissions) / lifecycle events.
 */

import { z } from 'zod';

const permissionModeSchema = z.enum([
    'manual',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'auto',
    'dontAsk',
    'read-only',
    'workspace-write',
    'danger-full-access',
    'auto_edit',
]);

// ─── Message meta ────────────────────────────────────────────────

export const MessageMetaSchema = z.object({
    sentFrom: z.string().optional(),
    permissionMode: permissionModeSchema.optional(),
    model: z.string().nullable().optional(),
    fallbackModel: z.string().nullable().optional(),
    customSystemPrompt: z.string().nullable().optional(),
    appendSystemPrompt: z.string().nullable().optional(),
    allowedTools: z.array(z.string()).nullable().optional(),
    disallowedTools: z.array(z.string()).nullable().optional(),
    displayText: z.string().optional()
});

export type MessageMeta = z.infer<typeof MessageMetaSchema>;

export type TrustedSessionFlavor = 'claude' | 'codex' | 'cursor' | 'gemini';

const trustedSessionFlavors = new Set<TrustedSessionFlavor>(['claude', 'codex', 'cursor', 'gemini']);

const harmlessMessageMetaFields = ['sentFrom', 'displayText'] as const;

const legacyNativeMessageMetaFields: Record<TrustedSessionFlavor, readonly (keyof MessageMeta)[]> = {
    claude: [
        'permissionMode',
        'model',
        'fallbackModel',
        'customSystemPrompt',
        'appendSystemPrompt',
        'allowedTools',
        'disallowedTools',
    ],
    gemini: ['permissionMode', 'model', 'appendSystemPrompt'],
    codex: [],
    cursor: [],
};

const nativePermissionModes: Partial<Record<TrustedSessionFlavor, ReadonlySet<string>>> = {
    claude: new Set(['manual', 'acceptEdits', 'bypassPermissions', 'plan', 'auto', 'dontAsk']),
    gemini: new Set(['manual', 'auto_edit', 'plan']),
};

/**
 * Session metadata is the provider authority. Historical message payloads are
 * untrusted input and may contain controls left by a different provider.
 */
export function getTrustedSessionFlavor(flavor: unknown): TrustedSessionFlavor | null {
    return typeof flavor === 'string' && trustedSessionFlavors.has(flavor as TrustedSessionFlavor)
        ? flavor as TrustedSessionFlavor
        : null;
}

export function isNativeTurnPermissionMode(
    sessionFlavor: TrustedSessionFlavor | null | undefined,
    permissionMode: string | undefined,
): boolean {
    const trustedFlavor = getTrustedSessionFlavor(sessionFlavor);
    return Boolean(
        trustedFlavor
        && nativePermissionModes[trustedFlavor]?.has(permissionMode ?? ''),
    );
}

function normalizeMessageMeta(
    meta: MessageMeta | undefined,
    sessionFlavor: TrustedSessionFlavor | null | undefined,
): MessageMeta | undefined {
    if (!meta) return undefined;

    const normalized: Record<string, unknown> = {};
    const trustedFlavor = getTrustedSessionFlavor(sessionFlavor);
    const allowedFields = [
        ...harmlessMessageMetaFields,
        ...(trustedFlavor ? legacyNativeMessageMetaFields[trustedFlavor] : []),
    ];

    for (const field of allowedFields) {
        if (field === 'permissionMode' && !isNativeTurnPermissionMode(trustedFlavor, meta.permissionMode)) {
            continue;
        }
        if (meta[field] !== undefined) {
            normalized[field] = meta[field];
        }
    }

    return Object.keys(normalized).length > 0 ? normalized as MessageMeta : undefined;
}

// ─── Raw content schemas ─────────────────────────────────────────

const usageDataSchema = z.object({
    input_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    output_tokens: z.number(),
    service_tier: z.string().optional(),
});

export type UsageData = z.infer<typeof usageDataSchema>;

const agentEventSchema = z.discriminatedUnion('type', [z.object({
    type: z.literal('switch'),
    mode: z.enum(['local', 'remote'])
}), z.object({
    type: z.literal('message'),
    message: z.string(),
    isError: z.boolean().optional(),
}), z.object({
    type: z.literal('limit-reached'),
    endsAt: z.number(),
}), z.object({
    type: z.literal('ready'),
})]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

const rawTextContentSchema = z.object({
    type: z.literal('text'),
    text: z.string(),
}).passthrough();

const rawToolUseContentSchema = z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.any(),
}).passthrough();

const rawToolResultContentSchema = z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.array(z.object({ type: z.literal('text'), text: z.string() })), z.string()]),
    is_error: z.boolean().optional(),
    permissions: z.object({
        date: z.number(),
        result: z.enum(['approved', 'denied']),
        mode: permissionModeSchema.optional(),
        allowedTools: z.array(z.string()).optional(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).optional(),
    }).optional(),
}).passthrough();

const rawThinkingContentSchema = z.object({
    type: z.literal('thinking'),
    thinking: z.string(),
}).passthrough();

// Hyphenated formats (Codex/Gemini) — normalized to canonical in preprocess
const rawHyphenatedToolCallSchema = z.object({
    type: z.literal('tool-call'),
    callId: z.string(),
    id: z.string().optional(),
    name: z.string(),
    input: z.any(),
}).passthrough();
type RawHyphenatedToolCall = z.infer<typeof rawHyphenatedToolCallSchema>;

const rawHyphenatedToolResultSchema = z.object({
    type: z.literal('tool-call-result'),
    callId: z.string(),
    tool_use_id: z.string().optional(),
    output: z.any(),
    content: z.any().optional(),
    is_error: z.boolean().optional(),
}).passthrough();
type RawHyphenatedToolResult = z.infer<typeof rawHyphenatedToolResultSchema>;

function normalizeToToolUse(input: RawHyphenatedToolCall) {
    return {
        ...input,
        type: 'tool_use' as const,
        id: input.callId,
    };
}

function normalizeToToolResult(input: RawHyphenatedToolResult) {
    return {
        ...input,
        type: 'tool_result' as const,
        tool_use_id: input.callId,
        content: input.output ?? input.content ?? '',
        is_error: input.is_error ?? false,
    };
}

const rawAgentContentSchema = z.union([
    rawTextContentSchema,
    rawToolUseContentSchema,
    rawToolResultContentSchema,
    rawThinkingContentSchema,
    rawHyphenatedToolCallSchema,
    rawHyphenatedToolResultSchema,
]);
export type RawAgentContent = z.infer<typeof rawAgentContentSchema>;

const rawAgentRecordSchema = z.discriminatedUnion('type', [z.object({
    type: z.literal('output'),
    data: z.intersection(z.discriminatedUnion('type', [
        z.object({ type: z.literal('system') }),
        z.object({ type: z.literal('result') }),
        z.object({ type: z.literal('summary'), summary: z.string() }),
        z.object({ type: z.literal('assistant'), message: z.object({ role: z.literal('assistant'), model: z.string(), content: z.array(rawAgentContentSchema), usage: usageDataSchema.optional() }), parent_tool_use_id: z.string().nullable().optional() }),
        z.object({ type: z.literal('user'), message: z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(rawAgentContentSchema)]) }), parent_tool_use_id: z.string().nullable().optional(), toolUseResult: z.any().nullable().optional() }),
    ]), z.object({
        isSidechain: z.boolean().nullish(),
        isCompactSummary: z.boolean().nullish(),
        isMeta: z.boolean().nullish(),
        uuid: z.string().nullish(),
        parentUuid: z.string().nullish(),
    }).passthrough()),
}), z.object({
    type: z.literal('event'),
    id: z.string(),
    data: agentEventSchema
}), z.object({
    type: z.literal('codex'),
    data: z.discriminatedUnion('type', [
        z.object({ type: z.literal('reasoning'), message: z.string() }),
        z.object({ type: z.literal('message'), message: z.string(), isError: z.boolean().optional() }),
        z.object({
            type: z.literal('tool-call'),
            callId: z.string(),
            input: z.any(),
            name: z.string(),
            id: z.string()
        }),
        z.object({
            type: z.literal('tool-call-result'),
            callId: z.string(),
            output: z.any(),
            id: z.string()
        })
    ])
}), z.object({
    // ACP (Agent Communication Protocol) — unified format for all agent providers
    type: z.literal('acp'),
    provider: z.enum(['gemini', 'codex', 'cursor', 'claude', 'opencode']),
    data: z.discriminatedUnion('type', [
        z.object({ type: z.literal('reasoning'), message: z.string() }),
        z.object({ type: z.literal('message'), message: z.string(), isError: z.boolean().optional() }),
        z.object({ type: z.literal('thinking'), text: z.string() }),
        z.object({
            type: z.literal('tool-call'),
            callId: z.string(),
            input: z.any(),
            name: z.string(),
            id: z.string()
        }),
        z.object({
            type: z.literal('tool-result'),
            callId: z.string(),
            output: z.any(),
            id: z.string(),
            isError: z.boolean().optional()
        }),
        z.object({
            type: z.literal('tool-call-result'),
            callId: z.string(),
            output: z.any(),
            id: z.string()
        }),
        z.object({
            type: z.literal('file-edit'),
            description: z.string(),
            filePath: z.string(),
            diff: z.string().optional(),
            oldContent: z.string().optional(),
            newContent: z.string().optional(),
            id: z.string()
        }),
        z.object({
            type: z.literal('terminal-output'),
            data: z.string(),
            callId: z.string()
        }),
        z.object({ type: z.literal('task_started'), id: z.string() }),
        z.object({ type: z.literal('task_complete'), id: z.string() }),
        z.object({ type: z.literal('turn_aborted'), id: z.string() }),
        z.object({
            type: z.literal('permission-request'),
            permissionId: z.string(),
            toolName: z.string(),
            description: z.string(),
            options: z.any().optional()
        }),
        z.object({ type: z.literal('token_count') }).passthrough()
    ])
})]);

/**
 * Preprocessor: normalizes hyphenated content types to canonical before validation.
 */
function stripUnsupportedPermissionValue(value: unknown, key: 'mode' | 'permissionMode'): unknown {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const record = value as Record<string, unknown>;
        if (!Object.prototype.hasOwnProperty.call(record, key)
            || permissionModeSchema.safeParse(record[key]).success) {
            return value;
        }

        const normalized = { ...record };
        delete normalized[key];
        return normalized;
    } catch {
        return value;
    }
}

function preprocessMessageContent(data: unknown): unknown {
    if (!data || typeof data !== 'object') return data;
    const record = data as {
        role?: string;
        meta?: unknown;
        content?: { type?: string; data?: { type?: string; message?: { content?: unknown } } };
    };

    const normalizeContent = (item: unknown): unknown => {
        if (!item || typeof item !== 'object') return item;
        const typed = item as { type?: string };
        let normalizedItem = item;
        if (typed.type === 'tool-call') {
            normalizedItem = normalizeToToolUse(item as RawHyphenatedToolCall);
        } else if (typed.type === 'tool-call-result') {
            normalizedItem = normalizeToToolResult(item as RawHyphenatedToolResult);
        }

        if (!normalizedItem || typeof normalizedItem !== 'object' || Array.isArray(normalizedItem)) {
            return normalizedItem;
        }
        const normalizedRecord = normalizedItem as { type?: string; permissions?: unknown };
        if (normalizedRecord.type !== 'tool_result') return normalizedItem;

        const permissions = stripUnsupportedPermissionValue(normalizedRecord.permissions, 'mode');
        return permissions === normalizedRecord.permissions
            ? normalizedItem
            : { ...normalizedRecord, permissions };
    };

    const meta = stripUnsupportedPermissionValue(record.meta, 'permissionMode');

    if (record.role === 'agent' && record.content?.type === 'output' && record.content.data?.message
        && Array.isArray(record.content.data.message.content)) {
        return {
            ...record,
            meta,
            content: {
                ...record.content,
                data: {
                    ...record.content.data,
                    message: {
                        ...record.content.data.message,
                        content: record.content.data.message.content.map(normalizeContent),
                    },
                },
            },
        };
    }

    return meta === record.meta ? data : { ...record, meta };
}

const rawRecordSchema = z.preprocess(
    preprocessMessageContent,
    z.discriminatedUnion('role', [
        z.object({
            role: z.literal('agent'),
            content: rawAgentRecordSchema,
            meta: MessageMetaSchema.optional()
        }),
        z.object({
            role: z.literal('user'),
            content: z.object({
                type: z.literal('text'),
                text: z.string()
            }),
            meta: MessageMetaSchema.optional()
        })
    ])
);

export type RawRecord = z.infer<typeof rawRecordSchema>;
export const RawRecordSchema = rawRecordSchema;

// ─── Normalized types ────────────────────────────────────────────

export interface NormalizedPermissions {
    date: number;
    result: 'approved' | 'denied';
    mode?: string;
    allowedTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}

export type NormalizedAgentContent =
    {
        type: 'text';
        text: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'thinking';
        thinking: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-call';
        id: string;
        name: string;
        input: unknown;
        description: string | null;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-result';
        tool_use_id: string;
        content: unknown;
        is_error: boolean;
        uuid: string;
        parentUUID: string | null;
        permissions?: NormalizedPermissions;
    } | {
        type: 'summary';
        summary: string;
    } | {
        type: 'sidechain';
        uuid: string;
        prompt: string;
    };

export type NormalizedMessage = ({
    role: 'user';
    content: {
        type: 'text';
        text: string;
    };
} | {
    role: 'agent';
    content: NormalizedAgentContent[];
} | {
    role: 'event';
    content: AgentEvent;
}) & {
    id: string;
    localId: string | null;
    createdAt: number;
    /** Session sequence number; null for locally-echoed (not yet acked) messages. */
    seq: number | null;
    isSidechain: boolean;
    meta?: MessageMeta;
    usage?: UsageData;
};

// ─── Normalization ───────────────────────────────────────────────

export function normalizeRawMessage(
    id: string,
    localId: string | null,
    seq: number | null,
    createdAt: number,
    rawInput: unknown,
    sessionFlavor?: TrustedSessionFlavor | null,
): NormalizedMessage | null {
    const parsed = rawRecordSchema.safeParse(rawInput);
    if (!parsed.success) {
        return null;
    }
    const raw = parsed.data;
    const base = { id, localId, seq, createdAt };
    const meta = normalizeMessageMeta(raw.meta, sessionFlavor);

    if (raw.role === 'user') {
        return {
            ...base,
            role: 'user',
            content: raw.content,
            isSidechain: false,
            meta,
        };
    }

    // raw.role === 'agent'
    if (raw.content.type === 'output') {
        const data = raw.content.data;

        // Skip meta / compact-summary messages
        if (data.isMeta || data.isCompactSummary) {
            return null;
        }

        if (data.type === 'assistant') {
            if (!data.uuid) {
                return null;
            }
            const content: NormalizedAgentContent[] = [];
            for (const c of data.message.content) {
                if (c.type === 'text') {
                    content.push({
                        ...c,
                        uuid: data.uuid,
                        parentUUID: data.parentUuid ?? null
                    } as NormalizedAgentContent);
                } else if (c.type === 'thinking') {
                    content.push({
                        ...c,
                        uuid: data.uuid,
                        parentUUID: data.parentUuid ?? null
                    } as NormalizedAgentContent);
                } else if (c.type === 'tool_use') {
                    let description: string | null = null;
                    if (typeof c.input === 'object' && c.input !== null && 'description' in c.input && typeof (c.input as { description: unknown }).description === 'string') {
                        description = (c.input as { description: string }).description;
                    }
                    content.push({
                        ...c,
                        type: 'tool-call',
                        description,
                        uuid: data.uuid,
                        parentUUID: data.parentUuid ?? null
                    } as NormalizedAgentContent);
                }
            }
            return {
                ...base,
                role: 'agent',
                isSidechain: data.isSidechain ?? false,
                content,
                meta,
                usage: data.message.usage
            };
        }

        if (data.type === 'user') {
            if (!data.uuid) {
                return null;
            }

            const messageContent = data.message.content;

            // Sidechain user messages
            if (data.isSidechain && typeof messageContent === 'string') {
                return {
                    ...base,
                    role: 'agent',
                    isSidechain: true,
                    content: [{
                        type: 'sidechain',
                        uuid: data.uuid,
                        prompt: messageContent
                    }]
                };
            }

            // Regular user messages
            if (typeof messageContent === 'string') {
                return {
                    ...base,
                    role: 'user',
                    isSidechain: false,
                    content: {
                        type: 'text',
                        text: messageContent
                    }
                };
            }

            // Tool results
            const content: NormalizedAgentContent[] = [];
            for (const c of messageContent) {
                if (c.type === 'tool_result') {
                    content.push({
                        ...c,
                        type: 'tool-result',
                        content: data.toolUseResult
                            ? data.toolUseResult
                            : (typeof c.content === 'string' ? c.content : c.content[0]?.text),
                        is_error: c.is_error || false,
                        uuid: data.uuid,
                        parentUUID: data.parentUuid ?? null,
                        permissions: c.permissions ? {
                            date: c.permissions.date,
                            result: c.permissions.result,
                            mode: c.permissions.mode,
                            allowedTools: c.permissions.allowedTools,
                            decision: c.permissions.decision
                        } : undefined
                    } as NormalizedAgentContent);
                }
            }
            return {
                ...base,
                role: 'agent',
                isSidechain: data.isSidechain ?? false,
                content,
                meta
            };
        }

        return null;
    }

    if (raw.content.type === 'event') {
        return {
            ...base,
            role: 'event',
            content: raw.content.data,
            isSidechain: false,
        };
    }

    if (raw.content.type === 'codex') {
        const data = raw.content.data;
        if (data.type === 'message' || data.type === 'reasoning') {
            return {
                ...base,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: data.message,
                    uuid: id,
                    parentUUID: null
                }],
                meta
            };
        }
        if (data.type === 'tool-call') {
            return {
                ...base,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: data.callId,
                    name: data.name || 'unknown',
                    input: data.input,
                    description: null,
                    uuid: data.id,
                    parentUUID: null
                }],
                meta
            };
        }
        if (data.type === 'tool-call-result') {
            return {
                ...base,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: data.callId,
                    content: data.output,
                    is_error: false,
                    uuid: data.id,
                    parentUUID: null
                }],
                meta
            };
        }
        return null;
    }

    // ACP — unified format for all agent providers
    if (raw.content.type === 'acp') {
        const data = raw.content.data;
        if (data.type === 'message' && data.isError === true) {
            return {
                ...base,
                role: 'event',
                content: {
                    type: 'message',
                    message: data.message,
                    isError: true
                },
                isSidechain: false,
            };
        }
        if (data.type === 'message' || data.type === 'reasoning') {
            return {
                ...base,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'text',
                    text: data.message,
                    uuid: id,
                    parentUUID: null
                }],
                meta
            };
        }
        if (data.type === 'thinking') {
            return {
                ...base,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'thinking',
                    thinking: data.text,
                    uuid: id,
                    parentUUID: null
                }],
                meta
            };
        }
        if (data.type === 'tool-call') {
            return {
                ...base,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: data.callId,
                    name: data.name || 'unknown',
                    input: data.input,
                    description: null,
                    uuid: data.id,
                    parentUUID: null
                }],
                meta
            };
        }
        if (data.type === 'tool-result') {
            return {
                ...base,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: data.callId,
                    content: data.output,
                    is_error: data.isError ?? false,
                    uuid: data.id,
                    parentUUID: null
                }],
                meta
            };
        }
        if (data.type === 'tool-call-result') {
            return {
                ...base,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: data.callId,
                    content: data.output,
                    is_error: false,
                    uuid: data.id,
                    parentUUID: null
                }],
                meta
            };
        }
        if (data.type === 'file-edit') {
            return {
                ...base,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: data.id,
                    name: 'file-edit',
                    input: {
                        filePath: data.filePath,
                        description: data.description,
                        diff: data.diff,
                        oldContent: data.oldContent,
                        newContent: data.newContent
                    },
                    description: data.description,
                    uuid: data.id,
                    parentUUID: null
                }],
                meta
            };
        }
        if (data.type === 'terminal-output') {
            return {
                ...base,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-result',
                    tool_use_id: data.callId,
                    content: data.data,
                    is_error: false,
                    uuid: id,
                    parentUUID: null
                }],
                meta
            };
        }
        if (data.type === 'permission-request') {
            // Map permission-request to tool-call so the UI shows the permission dialog
            return {
                ...base,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: data.permissionId,
                    name: data.toolName,
                    input: data.options ?? {},
                    description: data.description,
                    uuid: id,
                    parentUUID: null
                }],
                meta
            };
        }
        // task_started / task_complete / turn_aborted / token_count — status only, skip
        return null;
    }

    return null;
}
