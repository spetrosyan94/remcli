import { z } from 'zod';

const SafeUserSentFromSchema = z.enum(['web', 'phone']);

const UserTextContentSchema = z.object({
    type: z.literal('text'),
    text: z.string(),
}).strict();

const ClaudePermissionModeSchema = z.enum([
    'manual',
    'acceptEdits',
    'bypassPermissions',
    'plan',
    'auto',
    'dontAsk',
]);

const GeminiPermissionModeSchema = z.enum([
    'manual',
    'auto_edit',
    'plan',
]);

const SafeUserMessageMetaSchema = z.object({
    sentFrom: SafeUserSentFromSchema.optional(),
    displayText: z.string().optional(),
}).strict();

const ClaudeUserMessageMetaSchema = SafeUserMessageMetaSchema.extend({
    permissionMode: ClaudePermissionModeSchema.optional(),
    model: z.string().nullable().optional(),
    fallbackModel: z.string().nullable().optional(),
    customSystemPrompt: z.string().nullable().optional(),
    appendSystemPrompt: z.string().nullable().optional(),
    allowedTools: z.array(z.string()).nullable().optional(),
    disallowedTools: z.array(z.string()).nullable().optional(),
}).strict();

const GeminiUserMessageMetaSchema = SafeUserMessageMetaSchema.extend({
    permissionMode: GeminiPermissionModeSchema.optional(),
    model: z.string().nullable().optional(),
    appendSystemPrompt: z.string().nullable().optional(),
}).strict();

function createProviderUserMessageSchema(metaSchema: z.ZodType<unknown>) {
    return z.object({
        role: z.literal('user'),
        content: UserTextContentSchema,
        localKey: z.string().optional(),
        meta: metaSchema.optional(),
    }).strict();
}

const CodexUserMessageSchema = createProviderUserMessageSchema(SafeUserMessageMetaSchema);
const CursorUserMessageSchema = createProviderUserMessageSchema(SafeUserMessageMetaSchema);
const ClaudeUserMessageSchema = createProviderUserMessageSchema(ClaudeUserMessageMetaSchema);
const GeminiUserMessageSchema = createProviderUserMessageSchema(GeminiUserMessageMetaSchema);
const UnscopedUserMessageSchema = createProviderUserMessageSchema(SafeUserMessageMetaSchema);

export type ProviderFlavor = 'claude' | 'codex' | 'cursor' | 'gemini';

export interface ProviderUserMessage {
    role: 'user';
    content: {
        type: 'text';
        text: string;
    };
    localKey?: string;
    meta?: {
        sentFrom?: 'web' | 'phone';
        displayText?: string;
        permissionMode?: 'manual' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' | 'dontAsk' | 'auto_edit';
        model?: string | null;
        fallbackModel?: string | null;
        customSystemPrompt?: string | null;
        appendSystemPrompt?: string | null;
        allowedTools?: string[] | null;
        disallowedTools?: string[] | null;
    };
}

interface ProviderUserMessageParseSuccess {
    success: true;
    data: ProviderUserMessage;
}

interface ProviderUserMessageParseFailure {
    success: false;
}

export type ProviderUserMessageParseResult = ProviderUserMessageParseSuccess | ProviderUserMessageParseFailure;

const providerUserMessageSchemas: Record<ProviderFlavor, z.ZodType<unknown>> = {
    claude: ClaudeUserMessageSchema,
    codex: CodexUserMessageSchema,
    cursor: CursorUserMessageSchema,
    gemini: GeminiUserMessageSchema,
};

export function resolveProviderFlavor(flavor: unknown): ProviderFlavor | null {
    if (
        typeof flavor !== 'string'
        || !Object.prototype.hasOwnProperty.call(providerUserMessageSchemas, flavor)
    ) {
        return null;
    }

    return flavor as ProviderFlavor;
}

export function parseProviderUserMessage(
    flavor: unknown,
    payload: unknown,
): ProviderUserMessageParseResult {
    const providerFlavor = resolveProviderFlavor(flavor);
    // Generic transport sessions predate provider metadata. They may carry a
    // plain phone/web prompt, but never provider-specific launch controls.
    const schema = providerFlavor
        ? providerUserMessageSchemas[providerFlavor]
        : UnscopedUserMessageSchema;
    const result = schema.safeParse(payload);
    if (!result.success) {
        return { success: false };
    }

    return {
        success: true,
        data: result.data as ProviderUserMessage,
    };
}

export function isLiveUserMessagePayload(payload: unknown): boolean {
    return typeof payload === 'object'
        && payload !== null
        && 'role' in payload
        && payload.role === 'user';
}
