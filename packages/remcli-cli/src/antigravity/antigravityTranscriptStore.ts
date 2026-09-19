import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

import type { Credentials } from '@/persistence';
import { decrypt, encrypt } from '@/api/encryption';

const STORE_DIRECTORY = 'antigravity-transcripts';
const FILE_MODE = 0o600;
const MAX_TURNS = 500;
const MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024;
const MAX_ID_BYTES = 256;
const MAX_WORKSPACE_BYTES = 4 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_MESSAGES_PER_TURN = 256;
const MAX_TURN_BYTES = 512 * 1024;

const boundedString = (maxBytes: number) => z.string().min(1).superRefine((value, context) => {
    if (byteLength(value) > maxBytes) context.addIssue({ code: z.ZodIssueCode.too_big, maximum: maxBytes, type: 'string', inclusive: true });
});
const UserMessageSchema = z.object({ type: z.literal('user'), text: boundedString(MAX_TEXT_BYTES) }).strict();
const AssistantMessageSchema = z.object({
    type: z.literal('assistant'),
    text: boundedString(MAX_TEXT_BYTES),
    isError: z.boolean(),
}).strict();
const ToolCallMessageSchema = z.object({
    type: z.literal('tool-call'),
    callId: boundedString(MAX_ID_BYTES),
    name: boundedString(MAX_ID_BYTES),
    input: z.unknown(),
}).strict();
const ToolResultMessageSchema = z.object({
    type: z.literal('tool-result'),
    callId: boundedString(MAX_ID_BYTES),
    output: z.unknown(),
    isError: z.boolean(),
}).strict();

const MessageSchema = z.discriminatedUnion('type', [
    UserMessageSchema,
    AssistantMessageSchema,
    ToolCallMessageSchema,
    ToolResultMessageSchema,
]);

const TurnSchema = z.object({
    id: boundedString(MAX_ID_BYTES),
    createdAt: z.number().int().nonnegative().safe(),
    messages: z.array(MessageSchema).min(1).max(MAX_MESSAGES_PER_TURN),
}).strict();

const FileSchema = z.object({
    version: z.literal(1),
    conversationId: boundedString(MAX_ID_BYTES),
    workspace: boundedString(MAX_WORKSPACE_BYTES),
    turns: z.array(TurnSchema).max(MAX_TURNS),
}).strict();

export type AntigravityTranscriptMessage = z.infer<typeof MessageSchema>;
export type AntigravityTranscriptTurn = z.infer<typeof TurnSchema>;

export interface AntigravityTranscriptStore {
    load: (conversationId: string, workspace: string) => AntigravityTranscriptTurn[];
    record: (conversationId: string, workspace: string, turn: AntigravityTranscriptTurn) => void;
}

function byteLength(value: string): number {
    return Buffer.byteLength(value, 'utf8');
}

function boundedIdentity(value: string, maxBytes: number, label: string): string {
    if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0 || value.includes('\u0000') || byteLength(value) > maxBytes) {
        throw new TypeError(`Invalid Antigravity transcript ${label}.`);
    }
    return value;
}

function isJsonValue(value: unknown, depth = 0): boolean {
    if (depth > 8 || value === null) return value === null;
    if (typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 256 && value.every((item) => isJsonValue(item, depth + 1));
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return Object.keys(record).length <= 256
            && Object.keys(record).every((key) => byteLength(key) <= MAX_ID_BYTES && isJsonValue(record[key], depth + 1));
    }
    return false;
}

function validateTurn(turn: AntigravityTranscriptTurn): AntigravityTranscriptTurn {
    const parsed = TurnSchema.parse(turn);
    for (const message of parsed.messages) {
        if ((message.type === 'tool-call' && !isJsonValue(message.input))
            || (message.type === 'tool-result' && !isJsonValue(message.output))) {
            throw new TypeError('Invalid Antigravity transcript tool payload.');
        }
    }
    const serialized = JSON.stringify(parsed);
    if (serialized === undefined || byteLength(serialized) > MAX_TURN_BYTES) {
        throw new RangeError('Antigravity transcript turn exceeds the size bound.');
    }
    return parsed;
}

function encryptionFor(credentials: Credentials): { key: Uint8Array; variant: 'legacy' | 'dataKey' } {
    if (credentials.encryption.type === 'legacy') {
        if (credentials.encryption.secret.length !== 32) throw new TypeError('Invalid legacy transcript encryption key.');
        return { key: credentials.encryption.secret, variant: 'legacy' };
    }
    if (credentials.encryption.machineKey.length !== 32) throw new TypeError('Invalid transcript data key.');
    return { key: credentials.encryption.machineKey, variant: 'dataKey' };
}

function transcriptPath(remcliHomeDir: string, conversationId: string): string {
    const digest = createHash('sha256').update(conversationId, 'utf8').digest('hex');
    return join(remcliHomeDir, STORE_DIRECTORY, `${digest}.bin`);
}

function readCiphertext(path: string): Uint8Array | null {
    let fd: number | undefined;
    try {
        fd = openSync(path, 'r');
        const stats = fstatSync(fd);
        if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size <= 0 || stats.size > MAX_CIPHERTEXT_BYTES) return null;
        const buffer = Buffer.alloc(stats.size);
        let offset = 0;
        while (offset < stats.size) {
            const count = readSync(fd, buffer, offset, stats.size - offset, offset);
            if (!Number.isSafeInteger(count) || count <= 0 || count > stats.size - offset) return null;
            offset += count;
        }
        return new Uint8Array(buffer);
    } catch {
        return null;
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function sortTurns(turns: AntigravityTranscriptTurn[]): AntigravityTranscriptTurn[] {
    return turns.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}

export function getAntigravityTranscriptPath(remcliHomeDir: string, conversationId: string): string {
    boundedIdentity(remcliHomeDir, MAX_WORKSPACE_BYTES, 'home directory');
    boundedIdentity(conversationId, MAX_ID_BYTES, 'conversation ID');
    return transcriptPath(remcliHomeDir, conversationId);
}

export function createAntigravityTranscriptStore(remcliHomeDir: string, credentials: Credentials): AntigravityTranscriptStore {
    boundedIdentity(remcliHomeDir, MAX_WORKSPACE_BYTES, 'home directory');
    const encryption = encryptionFor(credentials);

    const load = (conversationId: string, workspace: string): AntigravityTranscriptTurn[] => {
        try {
            boundedIdentity(conversationId, MAX_ID_BYTES, 'conversation ID');
            boundedIdentity(workspace, MAX_WORKSPACE_BYTES, 'workspace');
            const ciphertext = readCiphertext(transcriptPath(remcliHomeDir, conversationId));
            if (!ciphertext) return [];
            const raw = decrypt(encryption.key, encryption.variant, ciphertext);
            const parsed = FileSchema.safeParse(raw);
            if (!parsed.success || parsed.data.conversationId !== conversationId || parsed.data.workspace !== workspace) return [];
            for (const turn of parsed.data.turns) validateTurn(turn);
            return sortTurns(parsed.data.turns);
        } catch {
            return [];
        }
    };

    const record = (conversationId: string, workspace: string, turn: AntigravityTranscriptTurn): void => {
        boundedIdentity(conversationId, MAX_ID_BYTES, 'conversation ID');
        boundedIdentity(workspace, MAX_WORKSPACE_BYTES, 'workspace');
        const validatedTurn = validateTurn(turn);
        const existing = load(conversationId, workspace);
        const withoutExisting = existing.filter((candidate) => candidate.id !== validatedTurn.id);
        const turns = sortTurns([...withoutExisting, validatedTurn]).slice(-MAX_TURNS);
        let fittingTurns = turns;
        let body = FileSchema.parse({ version: 1, conversationId, workspace, turns: fittingTurns });
        let ciphertext = encrypt(encryption.key, encryption.variant, body);
        while (ciphertext.byteLength > MAX_CIPHERTEXT_BYTES && fittingTurns.length > 1) {
            fittingTurns = fittingTurns.slice(1);
            body = FileSchema.parse({ version: 1, conversationId, workspace, turns: fittingTurns });
            ciphertext = encrypt(encryption.key, encryption.variant, body);
        }
        if (ciphertext.byteLength > MAX_CIPHERTEXT_BYTES) {
            throw new RangeError('Antigravity transcript exceeds the file size bound.');
        }

        const directory = join(remcliHomeDir, STORE_DIRECTORY);
        const path = transcriptPath(remcliHomeDir, conversationId);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        chmodSync(directory, 0o700);
        const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
        try {
            writeFileSync(temporaryPath, ciphertext, { mode: FILE_MODE });
            chmodSync(temporaryPath, FILE_MODE);
            renameSync(temporaryPath, path);
            chmodSync(path, FILE_MODE);
        } catch (error) {
            try { unlinkSync(temporaryPath); } catch { /* Preserve the original write error. */ }
            throw error;
        }
    };

    return { load, record };
}
