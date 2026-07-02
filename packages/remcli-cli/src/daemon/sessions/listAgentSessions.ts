import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
        return null;
    } catch {
        return null;
    }
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

/**
 * Recursively collect files matching a predicate.
 */
function walkFiles(dir: string, predicate: (name: string) => boolean): string[] {
    const results: string[] = [];
    if (!existsSync(dir)) return results;

    function recurse(current: string): void {
        let entries: string[];
        try {
            entries = readdirSync(current);
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = join(current, entry);
            try {
                const st = statSync(full);
                if (st.isDirectory()) {
                    recurse(full);
                } else if (st.isFile() && predicate(entry)) {
                    results.push(full);
                }
            } catch {
                // skip inaccessible entries
            }
        }
    }

    recurse(dir);
    return results;
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
        const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
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
        const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
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

/**
 * List Codex sessions from ~/.codex/sessions/ (recursive YYYY/MM/DD/*.jsonl).
 */
export function listCodexSessions(): AgentSessionInfo[] {
    const sessions: AgentSessionInfo[] = [];

    try {
        const sessionsDir = join(homedir(), '.codex', 'sessions');
        const files = walkFiles(sessionsDir, name => name.endsWith('.jsonl'));

        for (const filePath of files) {
            let st: ReturnType<typeof statSync>;
            try {
                st = statSync(filePath);
            } catch {
                continue;
            }

            const headLines = readHeadLines(filePath);
            if (headLines.length === 0) continue;

            let sessionId = '';
            let projectPath = '';
            let createdAt: number | null = null;
            let firstUserMessage: string | null = null;

            for (const line of headLines) {
                const obj = safeJsonParse(line);
                if (!obj) continue;

                // session_meta line
                if (obj.type === 'session_meta') {
                    const payload = obj.payload as Record<string, unknown> | undefined;
                    if (payload && typeof payload === 'object') {
                        if (typeof payload.id === 'string') sessionId = payload.id as string;
                        if (typeof payload.cwd === 'string') projectPath = payload.cwd as string;
                        if (typeof payload.timestamp === 'string') {
                            const ts = Date.parse(payload.timestamp as string);
                            if (!isNaN(ts)) createdAt = ts;
                        } else if (typeof payload.timestamp === 'number') {
                            createdAt = payload.timestamp as number;
                        }
                    }
                }

                // First user message
                if (firstUserMessage === null && obj.type === 'event_msg') {
                    const payload = obj.payload as Record<string, unknown> | undefined;
                    if (payload && typeof payload === 'object') {
                        if (payload.type === 'user_message' || payload.role === 'developer' || payload.role === 'user') {
                            const content = payload.content ?? payload.text ?? payload.message;
                            if (typeof content === 'string') {
                                firstUserMessage = truncate(content, 200);
                            }
                        }
                    }
                }
            }

            // Fallback session ID from filename
            if (!sessionId) {
                const baseName = filePath.split('/').pop()?.replace('.jsonl', '') ?? '';
                sessionId = baseName;
            }

            sessions.push({
                sessionId,
                agent: 'codex',
                projectPath,
                lastModified: st.mtimeMs,
                firstMessage: firstUserMessage,
                messageCount: countLines(filePath),
                createdAt,
                sessionName: null,
            });
        }
    } catch (e) {
        logger.debug(`[LIST_SESSIONS] Error listing Codex sessions: ${e}`);
    }

    return sessions;
}

// ─── Cursor ──────────────────────────────────────────────────────────────────

/**
 * List Cursor sessions from ~/.cursor/chats/<workspace-id>/<session-id>/store.db.
 * Minimal support: just ID + date (no SQLite parsing).
 */
export function listCursorSessions(): AgentSessionInfo[] {
    const sessions: AgentSessionInfo[] = [];

    try {
        const chatsDir = join(homedir(), '.cursor', 'chats');
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
        const tmpDir = join(homedir(), '.gemini', 'tmp');
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
