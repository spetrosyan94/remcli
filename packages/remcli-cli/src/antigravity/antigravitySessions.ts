import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { configuration } from '@/configuration';
import { createAntigravitySessionRegistry, type AntigravitySessionRegistry, type AntigravitySessionRegistryEntry } from './antigravitySessionRegistry';

export const ANTIGRAVITY_PROVIDER = 'antigravity' as const;

const ANTIGRAVITY_HISTORY_PATH = ['.gemini', 'antigravity-cli', 'history.jsonl'] as const;
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const MAX_HISTORY_LINE_BYTES = 256 * 1024;
const MAX_HISTORY_ROWS = 20_000;
const MAX_FIELD_LENGTH = 4_096;

export interface AntigravitySession {
    provider: typeof ANTIGRAVITY_PROVIDER;
    conversationId: string;
    workspace: string;
    display: string;
    updatedAt: number;
    messageCount: number;
}

export interface AntigravitySessionReaderOptions {
    homeDir?: string;
    workspace?: string;
    fileSystem?: AntigravityHistoryFileSystem;
    registry?: AntigravitySessionRegistry;
}

export interface AntigravityHistoryFileSystem {
    open: (path: string) => number;
    fstat: (fd: number) => { size: number; isFile: () => boolean };
    read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
    close: (fd: number) => void;
}

interface HistoryRow {
    conversationId: string;
    workspace: string;
    display: string;
    timestamp: number;
}

const defaultFileSystem: AntigravityHistoryFileSystem = {
    open: (path) => openSync(path, 'r'),
    fstat: (fd) => fstatSync(fd),
    read: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
    close: (fd) => closeSync(fd),
};

function isBoundedNonEmptyString(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_FIELD_LENGTH
        && value.trim().length > 0
        && !value.includes('\u0000');
}

function parseHistoryRow(value: unknown): HistoryRow | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (row.type !== undefined && typeof row.type !== 'string') return null;
    if (row.type === 'slash_command') return null;
    if (!isBoundedNonEmptyString(row.conversationId)
        || !isBoundedNonEmptyString(row.workspace)
        || !isBoundedNonEmptyString(row.display)
        || typeof row.timestamp !== 'number'
        || !Number.isSafeInteger(row.timestamp)
        || row.timestamp < 0) {
        return null;
    }
    return {
        conversationId: row.conversationId,
        workspace: row.workspace,
        display: row.display,
        timestamp: row.timestamp,
    };
}

function validateWorkspaceFilter(workspace: string | undefined): void {
    if (workspace !== undefined && !isBoundedNonEmptyString(workspace)) {
        throw new TypeError('Antigravity workspace filter must be a non-empty string.');
    }
}

function readBoundedHistory(path: string, fileSystem: AntigravityHistoryFileSystem): string | null {
    const fd = fileSystem.open(path);
    try {
        const stats = fileSystem.fstat(fd);
        if (!stats.isFile()
            || !Number.isSafeInteger(stats.size)
            || stats.size < 0
            || stats.size > MAX_HISTORY_BYTES) {
            return null;
        }

        const buffer = Buffer.allocUnsafe(MAX_HISTORY_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const chunkSize = fileSystem.read(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (!Number.isSafeInteger(chunkSize) || chunkSize < 0 || chunkSize > buffer.length - bytesRead) return null;
            if (chunkSize === 0) break;
            bytesRead += chunkSize;
        }
        if (bytesRead > MAX_HISTORY_BYTES) return null;
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        fileSystem.close(fd);
    }
}

function newestBoundedRows(content: string): string[] {
    const lines = content.split('\n');
    const rows: string[] = [];
    for (let index = lines.length - 1; index >= 0 && rows.length < MAX_HISTORY_ROWS; index -= 1) {
        const line = lines[index]!.replace(/\r$/, '');
        if (line.trim() !== '') rows.push(line);
    }
    return rows.reverse();
}

export function readAntigravitySessions(options: AntigravitySessionReaderOptions = {}): AntigravitySession[] {
    validateWorkspaceFilter(options.workspace);
    const homeDir = options.homeDir ?? homedir();
    if (!isBoundedNonEmptyString(homeDir) || !isAbsolute(homeDir)) return [];
    const historyPath = join(homeDir, ...ANTIGRAVITY_HISTORY_PATH);
    if (!isBoundedNonEmptyString(historyPath)) return [];

    let content: string;
    try {
        const boundedContent = readBoundedHistory(historyPath, options.fileSystem ?? defaultFileSystem);
        if (boundedContent === null) return [];
        content = boundedContent;
    } catch {
        return [];
    }

    const sessions = new Map<string, AntigravitySession>();
    for (const line of newestBoundedRows(content)) {
        if (Buffer.byteLength(line, 'utf8') > MAX_HISTORY_LINE_BYTES) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(line);
        } catch {
            continue;
        }
        const row = parseHistoryRow(parsed);
        if (row === null || options.workspace !== undefined && row.workspace !== options.workspace) continue;

        const existing = sessions.get(row.conversationId);
        if (existing === undefined) {
            sessions.set(row.conversationId, {
                provider: ANTIGRAVITY_PROVIDER,
                conversationId: row.conversationId,
                workspace: row.workspace,
                display: row.display,
                updatedAt: row.timestamp,
                messageCount: 1,
            });
            continue;
        }
        existing.updatedAt = Math.max(existing.updatedAt, row.timestamp);
        existing.messageCount += 1;
    }

    return [...sessions.values()].sort((left, right) => {
        const timestampOrder = right.updatedAt - left.updatedAt;
        if (timestampOrder !== 0) return timestampOrder;
        return left.conversationId < right.conversationId ? -1 : left.conversationId > right.conversationId ? 1 : 0;
    });
}

function registrySession(entry: AntigravitySessionRegistryEntry): AntigravitySession {
    return {
        provider: ANTIGRAVITY_PROVIDER,
        conversationId: entry.conversationId,
        workspace: entry.workspace,
        display: '',
        updatedAt: entry.updatedAt,
        messageCount: 0,
    };
}

export function listAntigravitySessions(options: AntigravitySessionReaderOptions = {}): AntigravitySession[] {
    const providerSessions = readAntigravitySessions(options);
    const registry = options.registry ?? createAntigravitySessionRegistry(configuration.remcliHomeDir);
    const merged = new Map<string, AntigravitySession>();

    for (const session of providerSessions) {
        merged.set(session.conversationId, session);
    }
    for (const session of registry.list(options.workspace)) {
        if (options.workspace !== undefined && session.workspace !== options.workspace) continue;
        const existing = merged.get(session.conversationId);
        if (existing) {
            existing.updatedAt = Math.max(existing.updatedAt, session.updatedAt);
        } else {
            merged.set(session.conversationId, registrySession(session));
        }
    }

    return [...merged.values()].sort((left, right) => {
        const timestampOrder = right.updatedAt - left.updatedAt;
        if (timestampOrder !== 0) return timestampOrder;
        return left.conversationId < right.conversationId ? -1 : left.conversationId > right.conversationId ? 1 : 0;
    });
}
