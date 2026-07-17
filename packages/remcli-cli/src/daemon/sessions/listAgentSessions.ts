import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, type Stats } from 'node:fs';
import { basename, join, sep } from 'node:path';
import * as os from 'node:os';
import { getProjectPath } from '@/claude/utils/path';
import { logger } from '@/ui/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentSessionInfo {
    sessionId: string;
    agent: 'claude' | 'codex' | 'cursor' | 'gemini';
    projectPath: string;
    lastModified: number;
    firstMessage: string | null;
    messageCount: number;
    createdAt: number | null;
    /** Session name: from /rename command (priority) or slug field. Null for non-Claude agents. */
    sessionName: string | null;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HEAD_LINES = 15;
const DEFAULT_LIMIT = 200;
const CODEX_SESSION_CACHE_MAX_DIRECTORIES = 4;
const CODEX_SESSION_REVALIDATION_INTERVAL_MS = 500;
const CODEX_SESSION_DIRECTORY_REINDEX_INTERVAL_MS = 5_000;
const CODEX_METADATA_PREFIX_BYTES = 64 * 1024;
const CODEX_ACTIVITY_TAIL_BYTES = 32 * 1024;
const CODEX_METADATA_MAX_LINES = 64;
const CODEX_CHILD_METADATA_FIELDS = [
    'parent_thread_id',
    'agent_nickname',
    'agent_role',
    'agent_path',
] as const;
const CODEX_LEGACY_SUBAGENT_SOURCE_RE = /(^|[-_:/\s])(subagent|sub-agent|automation)(?=$|[-_:/\s])/i;

type CodexDirectoryEntryKind = 'directory' | 'file' | 'other';

interface CodexSessionFileCacheEntry {
    mtimeMs: number;
    ctimeMs: number;
    size: number;
    session: AgentSessionInfo | null;
    retryOnNextRefresh: boolean;
}

interface CodexDirectoryCacheEntry {
    mtimeMs: number;
    entries: Map<string, CodexDirectoryEntryKind>;
}

interface CodexSessionCache {
    files: Map<string, CodexSessionFileCacheEntry>;
    directories: Map<string, CodexDirectoryCacheEntry>;
    lastRevalidationAt: number;
    lastDirectoryReindexAt: number;
}

interface BoundedJsonlSegment {
    bytesRead: number;
    isComplete: boolean;
    lines: string[];
}

const codexSessionCaches = new Map<string, CodexSessionCache>();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Read first N lines of a JSONL file (UTF-8).
 * Uses line-based reading to avoid truncating long JSON lines
 * (e.g., Codex session_meta can be 12KB+ due to base_instructions).
 */
function readHeadLines(filePath: string, maxLines: number = MAX_HEAD_LINES): string[] {
    const content = readFileSync(filePath, 'utf-8');
    const lines: string[] = [];
    let start = 0;
    while (start < content.length && lines.length < maxLines) {
        const end = content.indexOf('\n', start);
        if (end === -1) {
            const remaining = content.slice(start).trim();
            if (remaining) lines.push(remaining);
            break;
        }
        const line = content.slice(start, end).trim();
        if (line) lines.push(line);
        start = end + 1;
    }
    return lines;
}

/**
 * Read the last N bytes of a file (UTF-8).
 * Used for efficiently scanning the tail of large JSONL files (e.g., for /rename commands).
 */
/**
 * Count non-empty lines in a file (approximate message count).
 */
function countLines(filePath: string): number {
    const content = readFileSync(filePath, 'utf-8');
    let count = 0;
    let start = 0;
    while (start < content.length) {
        const end = content.indexOf('\n', start);
        if (end === -1) {
            // last line without trailing newline
            if (start < content.length) count++;
            break;
        }
        if (end > start) count++; // non-empty line
        start = end + 1;
    }
    return count;
}

/**
 * Truncate a string to maxLen characters, appending "..." if truncated.
 */
function truncate(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + '...';
}

/**
 * Safely parse a JSON line, returning null on failure.
 */
function safeJsonParse(line: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseTimestamp(value: unknown): number | null {
    if (typeof value === 'number') {
        return Number.isFinite(value) && value > 0 ? value : null;
    }
    if (typeof value !== 'string') return null;

    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * List subdirectories in a directory.
 */
function listSubdirs(dir: string): string[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(name => {
        try {
            return statSync(join(dir, name)).isDirectory();
        } catch {
            return false;
        }
    });
}

// ─── Claude ──────────────────────────────────────────────────────────────────

/**
 * Load Claude Code session name index from ~/.claude/sessions/*.json.
 * These small JSON files contain {sessionId, name, cwd, pid} — set by /rename.
 * Returns Map<sessionId, name> for quick lookup.
 */
function loadClaudeSessionNameIndex(): Map<string, string> {
    const index = new Map<string, string>();
    try {
        const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude');
        const sessionsDir = join(claudeConfigDir, 'sessions');
        if (!existsSync(sessionsDir)) return index;

        for (const entry of readdirSync(sessionsDir)) {
            if (!entry.endsWith('.json')) continue;
            try {
                const data = JSON.parse(readFileSync(join(sessionsDir, entry), 'utf-8')) as Record<string, unknown>;
                const sid = data.sessionId as string | undefined;
                const name = data.name as string | undefined;
                if (sid && name) {
                    index.set(sid, name);
                }
            } catch {
                // Skip invalid files
            }
        }
    } catch {
        // Session index not available
    }
    return index;
}

/**
 * List Claude Code sessions from ~/.claude/projects/.
 *
 * Each subdirectory is a project (encoded path).
 * Each UUID-named .jsonl file is a session.
 */
export function listClaudeSessions(directory?: string): AgentSessionInfo[] {
    const sessions: AgentSessionInfo[] = [];

    try {
        const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude');
        const projectsDir = join(claudeConfigDir, 'projects');

        // Load session name index from ~/.claude/sessions/ (fast, small JSON files)
        const nameIndex = loadClaudeSessionNameIndex();

        // If directory is specified, scope to that project only
        const projectDirs: string[] = [];
        if (directory) {
            const projectDir = getProjectPath(directory);
            if (existsSync(projectDir)) {
                projectDirs.push(projectDir);
            }
        } else {
            if (!existsSync(projectsDir)) return sessions;
            for (const name of listSubdirs(projectsDir)) {
                projectDirs.push(join(projectsDir, name));
            }
        }

        for (const projectDir of projectDirs) {
            let entries: string[];
            try {
                entries = readdirSync(projectDir);
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (!entry.endsWith('.jsonl')) continue;
                const baseName = entry.replace('.jsonl', '');
                if (!UUID_RE.test(baseName)) continue;

                const filePath = join(projectDir, entry);
                let st: ReturnType<typeof statSync>;
                try {
                    st = statSync(filePath);
                } catch {
                    continue;
                }

                // Validate: file must have at least one line with uuid, messageId, or leafUuid
                const headLines = readHeadLines(filePath);
                if (headLines.length === 0) continue;

                let isValid = false;
                let firstUserMessage: string | null = null;
                let projectPath = '';
                let createdAt: number | null = null;
                let slugValue: string | null = null;

                for (const line of headLines) {
                    const obj = safeJsonParse(line);
                    if (!obj) continue;

                    // Validation check
                    if ('uuid' in obj || 'messageId' in obj || 'leafUuid' in obj) {
                        isValid = true;
                    }

                    // Extract slug from any line in the head
                    if (slugValue === null && typeof obj.slug === 'string') {
                        slugValue = obj.slug as string;
                    }

                    // Extract createdAt from first timestamp
                    if (createdAt === null && typeof obj.timestamp === 'string') {
                        const ts = Date.parse(obj.timestamp as string);
                        if (!isNaN(ts)) createdAt = ts;
                    }

                    // Extract first user message and cwd
                    if (firstUserMessage === null && obj.type === 'user') {
                        const msg = obj.message as Record<string, unknown> | undefined;
                        if (msg && typeof msg === 'object') {
                            const content = msg.content;
                            if (typeof content === 'string') {
                                firstUserMessage = truncate(content, 200);
                            } else if (Array.isArray(content)) {
                                for (const part of content) {
                                    if (part && typeof part === 'object' && 'text' in part && typeof (part as Record<string, unknown>).text === 'string') {
                                        firstUserMessage = truncate((part as Record<string, unknown>).text as string, 200);
                                        break;
                                    }
                                }
                            }
                        }
                        if (typeof obj.cwd === 'string') {
                            projectPath = obj.cwd as string;
                        }
                    }
                }

                if (!isValid) continue;

                // Session name priority: name index (from /rename) > slug
                const indexName = nameIndex.get(baseName);

                sessions.push({
                    sessionId: baseName,
                    agent: 'claude',
                    projectPath,
                    lastModified: st.mtimeMs,
                    firstMessage: firstUserMessage,
                    messageCount: countLines(filePath),
                    createdAt,
                    sessionName: indexName || slugValue || null,
                });
            }
        }
    } catch (e) {
        logger.debug(`[LIST_SESSIONS] Error listing Claude sessions: ${e}`);
    }

    return sessions;
}

// ─── Codex ───────────────────────────────────────────────────────────────────

function extractCodexFirstUserMessage(record: Record<string, unknown>): string | null {
    if (record.type !== 'event_msg') {
        return null;
    }

    const payload = record.payload;
    if (!isRecord(payload)) {
        return null;
    }
    if (payload.type !== 'user_message' && payload.role !== 'developer' && payload.role !== 'user') {
        return null;
    }

    const content = payload.content ?? payload.text ?? payload.message;
    return typeof content === 'string' ? truncate(content, 200) : null;
}

function isUserOwnedCodexSession(metadata: Record<string, unknown>): boolean {
    for (const field of CODEX_CHILD_METADATA_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(metadata, field)) {
            return false;
        }
    }
    if (Object.prototype.hasOwnProperty.call(metadata, 'thread_source')) {
        return metadata.thread_source === 'user';
    }

    if (typeof metadata.source === 'string') {
        return !CODEX_LEGACY_SUBAGENT_SOURCE_RE.test(metadata.source);
    }

    // Native root histories use a string source. Any present non-string source
    // fails closed; only records predating the source field use this legacy path.
    return !Object.prototype.hasOwnProperty.call(metadata, 'source');
}

function readBoundedJsonlSegment(
    filePath: string,
    fileSize: number,
    maxBytes: number,
    readFromEnd: boolean,
): BoundedJsonlSegment | null {
    const bytesToRead = Math.min(fileSize, maxBytes);
    if (bytesToRead === 0) {
        return { bytesRead: 0, isComplete: true, lines: [] };
    }

    let fileDescriptor: number | null = null;
    try {
        fileDescriptor = openSync(filePath, 'r');
        const buffer = Buffer.alloc(bytesToRead);
        const position = readFromEnd ? Math.max(0, fileSize - bytesToRead) : 0;
        const bytesRead = readSync(fileDescriptor, buffer, 0, bytesToRead, position);
        const content = buffer.toString('utf-8', 0, bytesRead);
        const isComplete = bytesRead >= fileSize;
        const lines = content.split('\n');

        if (readFromEnd && !isComplete) {
            lines.shift();
        }
        if (!readFromEnd && !isComplete && !content.endsWith('\n')) {
            lines.pop();
        }

        return {
            bytesRead,
            isComplete,
            lines: lines.map(line => line.trim()).filter(Boolean),
        };
    } catch {
        return null;
    } finally {
        if (fileDescriptor !== null) {
            try {
                closeSync(fileDescriptor);
            } catch {
                // A successful bounded read remains usable even if close reports an error.
            }
        }
    }
}

function estimateCodexMessageCount(
    prefix: BoundedJsonlSegment,
    tail: BoundedJsonlSegment,
    fileSize: number,
): number {
    if (prefix.isComplete) return prefix.lines.length;
    if (tail.isComplete) return tail.lines.length;

    const sampledLines = prefix.lines.length + tail.lines.length;
    const sampledBytes = prefix.bytesRead + tail.bytesRead;
    if (sampledLines === 0 || sampledBytes === 0) return 0;

    // The resume picker only needs an approximate count. Estimate it from bounded
    // samples rather than reading a multi-gigabyte history on the RPC path.
    return Math.max(sampledLines, Math.round((sampledLines * fileSize) / sampledBytes));
}

function getLatestCodexEventTimestamp(tail: BoundedJsonlSegment): number | null | undefined {
    let latestTimestamp: number | null = null;

    for (const line of tail.lines) {
        const record = safeJsonParse(line);
        if (!record || typeof record.type !== 'string') {
            return undefined;
        }
        if (record.type === 'session_meta') {
            continue;
        }
        if (record.type === 'event_msg' && !isRecord(record.payload)) {
            return undefined;
        }

        const payload = isRecord(record.payload) ? record.payload : null;
        const timestamp = parseTimestamp(record.timestamp) ?? parseTimestamp(payload?.timestamp);
        if (timestamp === null) {
            return undefined;
        }
        latestTimestamp = latestTimestamp === null ? timestamp : Math.max(latestTimestamp, timestamp);
    }

    return latestTimestamp;
}

function parseCodexSessionFile(
    filePath: string,
    fileStats: Stats,
): AgentSessionInfo | null | undefined {
    const prefix = readBoundedJsonlSegment(
        filePath,
        fileStats.size,
        CODEX_METADATA_PREFIX_BYTES,
        false,
    );
    if (!prefix) return undefined;

    let sessionMetadata: Record<string, unknown> | null = null;
    let sessionMetaTimestamp: number | null = null;
    let firstUserMessage: string | null = null;

    for (const line of prefix.lines.slice(0, CODEX_METADATA_MAX_LINES)) {
        const record = safeJsonParse(line);
        if (!record || typeof record.type !== 'string') {
            return null;
        }

        if (record.type === 'session_meta') {
            if (sessionMetadata !== null
                || !isRecord(record.payload)
                || !isUserOwnedCodexSession(record.payload)) {
                return null;
            }
            sessionMetadata = record.payload;
            sessionMetaTimestamp = parseTimestamp(record.timestamp)
                ?? parseTimestamp(sessionMetadata.timestamp);
        }

        if (record.type === 'event_msg' && !isRecord(record.payload)) {
            return null;
        }

        if (firstUserMessage === null) {
            firstUserMessage = extractCodexFirstUserMessage(record);
        }
    }

    if (!sessionMetadata) {
        return null;
    }

    const tail = prefix.isComplete
        ? prefix
        : readBoundedJsonlSegment(
            filePath,
            fileStats.size,
            CODEX_ACTIVITY_TAIL_BYTES,
            true,
        );
    if (!tail) return undefined;

    const latestEventTimestamp = getLatestCodexEventTimestamp(tail);
    if (latestEventTimestamp === undefined) {
        return null;
    }

    const metadataId = typeof sessionMetadata.id === 'string'
        ? sessionMetadata.id
        : typeof sessionMetadata.session_id === 'string'
            ? sessionMetadata.session_id
            : '';
    const sessionId = metadataId || basename(filePath, '.jsonl');

    return {
        sessionId,
        agent: 'codex',
        projectPath: typeof sessionMetadata.cwd === 'string' ? sessionMetadata.cwd : '',
        lastModified: latestEventTimestamp ?? fileStats.mtimeMs,
        firstMessage: firstUserMessage,
        messageCount: estimateCodexMessageCount(prefix, tail, fileStats.size),
        createdAt: parseTimestamp(sessionMetadata.timestamp) ?? sessionMetaTimestamp,
        sessionName: null,
    };
}

function isSameFileVersion(
    cacheEntry: CodexSessionFileCacheEntry,
    fileStats: Stats,
): boolean {
    return cacheEntry.mtimeMs === fileStats.mtimeMs
        && cacheEntry.ctimeMs === fileStats.ctimeMs
        && cacheEntry.size === fileStats.size;
}

function cacheCodexSessionFile(
    cache: CodexSessionCache,
    filePath: string,
    fileStats: Stats,
): void {
    const current = cache.files.get(filePath);
    if (current && !current.retryOnNextRefresh && isSameFileVersion(current, fileStats)) {
        return;
    }

    const parsedSession = parseCodexSessionFile(filePath, fileStats);
    const shouldRetry = parsedSession === undefined;
    cache.files.set(filePath, {
        mtimeMs: fileStats.mtimeMs,
        ctimeMs: fileStats.ctimeMs,
        size: fileStats.size,
        // Keep the last known result only for transient I/O failures; malformed
        // metadata and child threads intentionally replace it with null.
        session: shouldRetry ? current?.session ?? null : parsedSession,
        retryOnNextRefresh: shouldRetry,
    });
}

function readCodexDirectoryCacheEntry(directory: string): CodexDirectoryCacheEntry | null {
    let directoryStats: Stats;
    let names: string[];
    try {
        directoryStats = statSync(directory);
        if (!directoryStats.isDirectory()) {
            return null;
        }
        names = readdirSync(directory);
    } catch {
        return null;
    }

    const entries = new Map<string, CodexDirectoryEntryKind>();
    for (const name of names) {
        try {
            const entryStats = statSync(join(directory, name));
            entries.set(name, entryStats.isDirectory() ? 'directory' : entryStats.isFile() ? 'file' : 'other');
        } catch {
            // Ignore entries that disappear or become inaccessible during the scan.
        }
    }

    return { mtimeMs: directoryStats.mtimeMs, entries };
}

function isPathInsideDirectory(filePath: string, directory: string): boolean {
    const directoryPrefix = directory.endsWith(sep) ? directory : `${directory}${sep}`;
    return filePath === directory || filePath.startsWith(directoryPrefix);
}

function removeCodexDirectoryFromCache(cache: CodexSessionCache, directory: string): void {
    for (const filePath of cache.files.keys()) {
        if (isPathInsideDirectory(filePath, directory)) {
            cache.files.delete(filePath);
        }
    }
    for (const directoryPath of cache.directories.keys()) {
        if (isPathInsideDirectory(directoryPath, directory)) {
            cache.directories.delete(directoryPath);
        }
    }
}

function scanCodexSessionDirectory(directory: string, cache: CodexSessionCache): void {
    const directoryEntry = readCodexDirectoryCacheEntry(directory);
    if (!directoryEntry) {
        return;
    }

    cache.directories.set(directory, directoryEntry);

    for (const [name, kind] of directoryEntry.entries) {
        const entryPath = join(directory, name);
        if (kind === 'directory') {
            scanCodexSessionDirectory(entryPath, cache);
            continue;
        }
        if (kind !== 'file' || !name.endsWith('.jsonl')) {
            continue;
        }

        try {
            const fileStats = statSync(entryPath);
            if (fileStats.isFile()) {
                cacheCodexSessionFile(cache, entryPath, fileStats);
            }
        } catch {
            // Ignore files that disappear while the directory is being scanned.
        }
    }
}

function refreshAllCodexSessionDirectories(sessionsDir: string, cache: CodexSessionCache): void {
    const seenDirectories = new Set<string>();
    const seenFiles = new Set<string>();

    const visitDirectory = (directory: string): void => {
        const directoryEntry = readCodexDirectoryCacheEntry(directory);
        if (!directoryEntry) {
            return;
        }

        seenDirectories.add(directory);
        cache.directories.set(directory, directoryEntry);

        for (const [name, kind] of directoryEntry.entries) {
            const entryPath = join(directory, name);
            if (kind === 'directory') {
                visitDirectory(entryPath);
                continue;
            }
            if (kind !== 'file' || !name.endsWith('.jsonl')) {
                continue;
            }

            seenFiles.add(entryPath);
            try {
                const fileStats = statSync(entryPath);
                if (fileStats.isFile()) {
                    cacheCodexSessionFile(cache, entryPath, fileStats);
                }
            } catch {
                // Ignore files that disappear while the directory index is refreshed.
            }
        }
    };

    visitDirectory(sessionsDir);

    for (const filePath of cache.files.keys()) {
        if (!seenFiles.has(filePath)) {
            cache.files.delete(filePath);
        }
    }
    for (const directory of cache.directories.keys()) {
        if (!seenDirectories.has(directory)) {
            cache.directories.delete(directory);
        }
    }
}

function refreshChangedCodexDirectory(directory: string, cache: CodexSessionCache): void {
    const previousDirectoryEntry = cache.directories.get(directory);
    const currentDirectoryEntry = readCodexDirectoryCacheEntry(directory);
    if (!currentDirectoryEntry) {
        removeCodexDirectoryFromCache(cache, directory);
        return;
    }

    for (const [name, previousKind] of previousDirectoryEntry?.entries ?? []) {
        if (currentDirectoryEntry.entries.has(name)) {
            continue;
        }

        const entryPath = join(directory, name);
        if (previousKind === 'directory') {
            removeCodexDirectoryFromCache(cache, entryPath);
        } else if (previousKind === 'file' && name.endsWith('.jsonl')) {
            cache.files.delete(entryPath);
        }
    }

    cache.directories.set(directory, currentDirectoryEntry);

    for (const [name, currentKind] of currentDirectoryEntry.entries) {
        const entryPath = join(directory, name);
        const previousKind = previousDirectoryEntry?.entries.get(name);

        if (currentKind === 'directory') {
            if (previousKind !== 'directory') {
                if (previousKind === 'file' && name.endsWith('.jsonl')) {
                    cache.files.delete(entryPath);
                }
                scanCodexSessionDirectory(entryPath, cache);
            }
            continue;
        }

        if (previousKind === 'directory') {
            removeCodexDirectoryFromCache(cache, entryPath);
        }
        if (currentKind !== 'file' || !name.endsWith('.jsonl')) {
            continue;
        }

        try {
            const fileStats = statSync(entryPath);
            if (fileStats.isFile()) {
                cacheCodexSessionFile(cache, entryPath, fileStats);
            }
        } catch {
            // Ignore files that disappear while the directory is being refreshed.
        }
    }
}

function refreshKnownCodexSessionFiles(cache: CodexSessionCache): void {
    for (const [filePath, cacheEntry] of Array.from(cache.files.entries())) {
        try {
            const fileStats = statSync(filePath);
            if (!fileStats.isFile()) {
                cache.files.delete(filePath);
                continue;
            }
            if (cacheEntry.retryOnNextRefresh || !isSameFileVersion(cacheEntry, fileStats)) {
                cacheCodexSessionFile(cache, filePath, fileStats);
            }
        } catch {
            cache.files.delete(filePath);
        }
    }
}

function createCodexSessionCache(sessionsDir: string, now: number): CodexSessionCache {
    const cache: CodexSessionCache = {
        files: new Map(),
        directories: new Map(),
        lastRevalidationAt: now,
        lastDirectoryReindexAt: now,
    };
    scanCodexSessionDirectory(sessionsDir, cache);
    return cache;
}

function getCodexSessionCache(sessionsDir: string): CodexSessionCache | undefined {
    const cache = codexSessionCaches.get(sessionsDir);
    if (!cache) {
        return undefined;
    }

    codexSessionCaches.delete(sessionsDir);
    codexSessionCaches.set(sessionsDir, cache);
    return cache;
}

function setCodexSessionCache(sessionsDir: string, cache: CodexSessionCache): void {
    codexSessionCaches.delete(sessionsDir);
    codexSessionCaches.set(sessionsDir, cache);

    while (codexSessionCaches.size > CODEX_SESSION_CACHE_MAX_DIRECTORIES) {
        const oldestSessionsDir = codexSessionCaches.keys().next().value;
        if (typeof oldestSessionsDir !== 'string') {
            break;
        }
        codexSessionCaches.delete(oldestSessionsDir);
    }
}

function getCachedCodexSessions(cache: CodexSessionCache): AgentSessionInfo[] {
    return Array.from(cache.files.values())
        .flatMap(cacheEntry => cacheEntry.session ? [{ ...cacheEntry.session }] : [])
        .sort((first, second) => second.lastModified - first.lastModified);
}

/**
 * List Codex sessions from ~/.codex/sessions/ (recursive YYYY/MM/DD/*.jsonl).
 */
export function listCodexSessions(): AgentSessionInfo[] {
    try {
        const sessionsDir = join(os.homedir(), '.codex', 'sessions');
        if (!existsSync(sessionsDir)) {
            codexSessionCaches.delete(sessionsDir);
            return [];
        }

        const now = Date.now();
        let cache = getCodexSessionCache(sessionsDir);
        if (!cache) {
            cache = createCodexSessionCache(sessionsDir, now);
            setCodexSessionCache(sessionsDir, cache);
            return getCachedCodexSessions(cache);
        }

        const elapsedSinceRevalidation = now - cache.lastRevalidationAt;
        if (elapsedSinceRevalidation >= 0 && elapsedSinceRevalidation < CODEX_SESSION_REVALIDATION_INTERVAL_MS) {
            return getCachedCodexSessions(cache);
        }

        cache.lastRevalidationAt = now;

        refreshKnownCodexSessionFiles(cache);
        for (const [directory, directoryEntry] of Array.from(cache.directories.entries())) {
            try {
                const directoryStats = statSync(directory);
                if (!directoryStats.isDirectory() || directoryStats.mtimeMs !== directoryEntry.mtimeMs) {
                    refreshChangedCodexDirectory(directory, cache);
                }
            } catch {
                removeCodexDirectoryFromCache(cache, directory);
            }
        }

        // Directory mtimes can be coarse on some filesystems. Reindex periodically,
        // while reusing file fingerprints so unchanged JSONL histories are never reread.
        if (now - cache.lastDirectoryReindexAt >= CODEX_SESSION_DIRECTORY_REINDEX_INTERVAL_MS) {
            refreshAllCodexSessionDirectories(sessionsDir, cache);
            cache.lastDirectoryReindexAt = now;
        }

        return getCachedCodexSessions(cache);
    } catch (e) {
        logger.debug(`[LIST_SESSIONS] Error listing Codex sessions: ${e}`);
        return [];
    }
}

// ─── Cursor ──────────────────────────────────────────────────────────────────

/**
 * List Cursor sessions from ~/.cursor/chats/<workspace-id>/<session-id>/store.db.
 * Minimal support: just ID + date (no SQLite parsing).
 */
export function listCursorSessions(): AgentSessionInfo[] {
    const sessions: AgentSessionInfo[] = [];

    try {
        const chatsDir = join(os.homedir(), '.cursor', 'chats');
        if (!existsSync(chatsDir)) return sessions;

        for (const workspaceId of listSubdirs(chatsDir)) {
            const workspaceDir = join(chatsDir, workspaceId);

            for (const sessionDir of listSubdirs(workspaceDir)) {
                if (!UUID_RE.test(sessionDir)) continue;

                const storeDbPath = join(workspaceDir, sessionDir, 'store.db');
                if (!existsSync(storeDbPath)) continue;

                let st: ReturnType<typeof statSync>;
                try {
                    st = statSync(storeDbPath);
                } catch {
                    continue;
                }

                sessions.push({
                    sessionId: sessionDir,
                    agent: 'cursor',
                    projectPath: '',
                    lastModified: st.mtimeMs,
                    firstMessage: null,
                    messageCount: 0,
                    createdAt: null,
                    sessionName: null,
                });
            }
        }
    } catch (e) {
        logger.debug(`[LIST_SESSIONS] Error listing Cursor sessions: ${e}`);
    }

    return sessions;
}

// ─── Gemini ──────────────────────────────────────────────────────────────────

/**
 * List Gemini sessions from ~/.gemini/tmp/<project-hash>/chats/session-*.json.
 */
export function listGeminiSessions(): AgentSessionInfo[] {
    const sessions: AgentSessionInfo[] = [];

    try {
        const tmpDir = join(os.homedir(), '.gemini', 'tmp');
        if (!existsSync(tmpDir)) return sessions;

        for (const projectHash of listSubdirs(tmpDir)) {
            const chatsDir = join(tmpDir, projectHash, 'chats');
            if (!existsSync(chatsDir)) continue;

            let entries: string[];
            try {
                entries = readdirSync(chatsDir);
            } catch {
                continue;
            }

            for (const entry of entries) {
                if (!entry.startsWith('session-') || !entry.endsWith('.json')) continue;

                const filePath = join(chatsDir, entry);
                let st: ReturnType<typeof statSync>;
                try {
                    st = statSync(filePath);
                    if (!st.isFile()) continue;
                } catch {
                    continue;
                }

                try {
                    const raw = readFileSync(filePath, 'utf-8');
                    const data = JSON.parse(raw) as Record<string, unknown>;

                    const sessionId = typeof data.sessionId === 'string'
                        ? data.sessionId as string
                        : entry.replace('.json', '');

                    let createdAt: number | null = null;
                    if (typeof data.startTime === 'number') {
                        createdAt = data.startTime as number;
                    } else if (typeof data.startTime === 'string') {
                        const ts = Date.parse(data.startTime as string);
                        if (!isNaN(ts)) createdAt = ts;
                    }

                    let firstUserMessage: string | null = null;
                    let messageCount = 0;

                    if (Array.isArray(data.messages)) {
                        messageCount = (data.messages as unknown[]).length;

                        for (const msg of data.messages as Record<string, unknown>[]) {
                            if (msg.role !== 'user') continue;

                            if (Array.isArray(msg.content)) {
                                for (const part of msg.content as Record<string, unknown>[]) {
                                    if (part.type === 'text' && typeof part.text === 'string') {
                                        firstUserMessage = truncate(part.text as string, 200);
                                        break;
                                    }
                                }
                            } else if (typeof msg.content === 'string') {
                                firstUserMessage = truncate(msg.content as string, 200);
                            }

                            if (firstUserMessage !== null) break;
                        }
                    }

                    sessions.push({
                        sessionId,
                        agent: 'gemini',
                        projectPath: '',
                        lastModified: st.mtimeMs,
                        firstMessage: firstUserMessage,
                        messageCount,
                        createdAt,
                        sessionName: null,
                    });
                } catch (e) {
                    logger.debug(`[LIST_SESSIONS] Error parsing Gemini session ${filePath}: ${e}`);
                }
            }
        }
    } catch (e) {
        logger.debug(`[LIST_SESSIONS] Error listing Gemini sessions: ${e}`);
    }

    return sessions;
}

// ─── Aggregate ───────────────────────────────────────────────────────────────

/**
 * List sessions across all (or a specific) AI agent.
 *
 * @param agent  - Filter by agent name ('claude' | 'codex' | 'cursor' | 'gemini')
 * @param directory - Filter Claude sessions by working directory
 * @param limit - Max sessions to return (default 50), sorted by lastModified desc
 */
export function listAllAgentSessions(
    agent?: string,
    directory?: string,
    limit: number = DEFAULT_LIMIT,
): AgentSessionInfo[] {
    const all: AgentSessionInfo[] = [];

    const shouldInclude = (a: string): boolean => !agent || agent === a;

    if (shouldInclude('claude')) {
        all.push(...listClaudeSessions(directory));
    }
    if (shouldInclude('codex')) {
        all.push(...listCodexSessions());
    }
    if (shouldInclude('cursor')) {
        all.push(...listCursorSessions());
    }
    if (shouldInclude('gemini')) {
        all.push(...listGeminiSessions());
    }

    // Sort by lastModified descending
    all.sort((a, b) => b.lastModified - a.lastModified);

    return all.slice(0, limit);
}
