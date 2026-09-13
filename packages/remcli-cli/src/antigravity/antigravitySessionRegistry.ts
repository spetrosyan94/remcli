import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REGISTRY_FILE_NAME = 'antigravity-sessions.json';
const MAX_REGISTRY_BYTES = 512 * 1024;
const MAX_REGISTRY_ENTRIES = 2_000;
const MAX_FIELD_LENGTH = 4_096;

export interface AntigravitySessionRegistryEntry {
    conversationId: string;
    workspace: string;
    updatedAt: number;
}

export interface AntigravitySessionRegistry {
    list: (workspace?: string) => AntigravitySessionRegistryEntry[];
    record: (entry: AntigravitySessionRegistryEntry) => void;
}

export interface AntigravityRegistryFileSystem {
    open: (path: string) => number;
    fstat: (fd: number) => { size: number; isFile: () => boolean };
    read: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
    close: (fd: number) => void;
}

const defaultFileSystem: AntigravityRegistryFileSystem = {
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

function isEntry(value: unknown): value is AntigravitySessionRegistryEntry {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const entry = value as Record<string, unknown>;
    const keys = Object.keys(entry).sort();
    return keys.length === 3
        && keys[0] === 'conversationId'
        && keys[1] === 'updatedAt'
        && keys[2] === 'workspace'
        && isBoundedNonEmptyString(entry.conversationId)
        && isBoundedNonEmptyString(entry.workspace)
        && typeof entry.updatedAt === 'number'
        && Number.isSafeInteger(entry.updatedAt)
        && entry.updatedAt >= 0;
}

function validateWorkspace(workspace: string | undefined): void {
    if (workspace !== undefined && !isBoundedNonEmptyString(workspace)) {
        throw new TypeError('Antigravity workspace filter must be a non-empty string.');
    }
}

function registryPath(remcliHomeDir: string): string {
    return join(remcliHomeDir, REGISTRY_FILE_NAME);
}

function readBoundedFile(path: string, fileSystem: AntigravityRegistryFileSystem): string | null {
    const fd = fileSystem.open(path);
    try {
        const stats = fileSystem.fstat(fd);
        if (!stats.isFile()
            || !Number.isSafeInteger(stats.size)
            || stats.size < 0
            || stats.size > MAX_REGISTRY_BYTES) return null;
        const buffer = Buffer.alloc(stats.size);
        let bytesRead = 0;
        while (bytesRead < stats.size) {
            const chunkSize = fileSystem.read(fd, buffer, bytesRead, stats.size - bytesRead, bytesRead);
            if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0 || chunkSize > stats.size - bytesRead) return null;
            bytesRead += chunkSize;
        }
        return buffer.toString('utf8');
    } finally {
        fileSystem.close(fd);
    }
}

function readEntries(path: string, fileSystem: AntigravityRegistryFileSystem): AntigravitySessionRegistryEntry[] {
    try {
        const content = readBoundedFile(path, fileSystem);
        if (content === null) return [];
        const parsed: unknown = JSON.parse(content);
        if (!Array.isArray(parsed) || parsed.length > MAX_REGISTRY_ENTRIES || !parsed.every(isEntry)) return [];
        return parsed;
    } catch {
        return [];
    }
}

function sortEntries(entries: AntigravitySessionRegistryEntry[]): AntigravitySessionRegistryEntry[] {
    return entries.sort((left, right) => {
        const timestampOrder = right.updatedAt - left.updatedAt;
        if (timestampOrder !== 0) return timestampOrder;
        return left.conversationId < right.conversationId ? -1 : left.conversationId > right.conversationId ? 1 : 0;
    });
}

function serializeBoundedEntries(entries: AntigravitySessionRegistryEntry[]): string {
    let low = 0;
    let high = entries.length;
    let largestValidPrefix = 0;
    while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = JSON.stringify(entries.slice(0, middle));
        if (Buffer.byteLength(candidate, 'utf8') <= MAX_REGISTRY_BYTES) {
            largestValidPrefix = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    const serialized = JSON.stringify(entries.slice(0, largestValidPrefix));
    if (largestValidPrefix === 0 && Buffer.byteLength(serialized, 'utf8') > MAX_REGISTRY_BYTES) {
        throw new RangeError('Antigravity session registry entry exceeds the file size bound.');
    }
    return serialized;
}

export function createAntigravitySessionRegistry(
    remcliHomeDir: string,
    fileSystem: AntigravityRegistryFileSystem = defaultFileSystem,
): AntigravitySessionRegistry {
    if (!isBoundedNonEmptyString(remcliHomeDir)) {
        throw new TypeError('Antigravity registry home must be a non-empty string.');
    }

    const list = (workspace?: string): AntigravitySessionRegistryEntry[] => {
        validateWorkspace(workspace);
        return sortEntries(readEntries(registryPath(remcliHomeDir), fileSystem)
            .filter((entry) => workspace === undefined || entry.workspace === workspace));
    };

    const record = (entry: AntigravitySessionRegistryEntry): void => {
        if (!isEntry(entry)) throw new TypeError('Invalid Antigravity session registry entry.');

        const entries = readEntries(registryPath(remcliHomeDir), fileSystem);
        const existingIndex = entries.findIndex((candidate) => candidate.conversationId === entry.conversationId);
        if (existingIndex >= 0) entries.splice(existingIndex, 1);
        entries.push(entry);
        const boundedEntries = sortEntries(entries).slice(0, MAX_REGISTRY_ENTRIES);

        mkdirSync(remcliHomeDir, { recursive: true });
        const path = registryPath(remcliHomeDir);
        const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
        try {
            writeFileSync(temporaryPath, serializeBoundedEntries(boundedEntries), { encoding: 'utf8', mode: 0o600 });
            renameSync(temporaryPath, path);
            chmodSync(path, 0o600);
        } catch (error) {
            try {
                // Best-effort cleanup; the previous registry remains authoritative.
                unlinkSync(temporaryPath);
            } catch {
                // Ignore cleanup failures and preserve the original error.
            }
            throw error;
        }
    };

    return { list, record };
}

export const getAntigravitySessionRegistryPath = (remcliHomeDir: string): string => registryPath(remcliHomeDir);
