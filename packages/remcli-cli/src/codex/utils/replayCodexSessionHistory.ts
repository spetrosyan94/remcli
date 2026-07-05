import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { logger } from '@/ui/logger';

interface CodexReplayMessage {
    role: 'user' | 'assistant';
    text: string;
}

function walkJsonlFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];

    const files: string[] = [];
    for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        let stat;
        try {
            stat = statSync(path);
        } catch {
            continue;
        }
        if (stat.isDirectory()) {
            files.push(...walkJsonlFiles(path));
        } else if (stat.isFile() && entry.endsWith('.jsonl')) {
            files.push(path);
        }
    }
    return files;
}

function safeJsonParse(line: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function textFromContentParts(content: unknown, textTypes: readonly string[]): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';

    const parts: string[] = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const part = item as Record<string, unknown>;
        if (typeof part.text === 'string' && typeof part.type === 'string' && textTypes.includes(part.type)) {
            parts.push(part.text);
        }
    }
    return parts.join('\n').trim();
}

function extractCodexReplayMessage(record: Record<string, unknown>): CodexReplayMessage | null {
    if (record.type === 'event_msg') {
        const payload = record.payload;
        if (!payload || typeof payload !== 'object') return null;
        const event = payload as Record<string, unknown>;
        if (event.type !== 'user_message') return null;

        const text = typeof event.message === 'string'
            ? event.message
            : textFromContentParts(event.content, ['input_text', 'text']);
        return text.trim() ? { role: 'user', text: text.trim() } : null;
    }

    if (record.type !== 'response_item') return null;

    const payload = record.payload;
    if (!payload || typeof payload !== 'object') return null;
    const item = payload as Record<string, unknown>;
    if (item.type !== 'message' || item.role !== 'assistant') return null;

    const text = textFromContentParts(item.content, ['output_text', 'text']);
    return text.trim() ? { role: 'assistant', text: text.trim() } : null;
}

export function parseCodexReplayMessages(lines: readonly string[]): CodexReplayMessage[] {
    const messages: CodexReplayMessage[] = [];
    for (const line of lines) {
        const record = safeJsonParse(line);
        if (!record) continue;

        const message = extractCodexReplayMessage(record);
        if (message) messages.push(message);
    }
    return messages;
}

function isCodexSessionFile(lines: string[], threadId: string, workingDirectory: string): boolean {
    for (const line of lines.slice(0, 60)) {
        const record = safeJsonParse(line);
        if (!record || record.type !== 'session_meta') continue;

        const payload = record.payload;
        if (!payload || typeof payload !== 'object') continue;
        const meta = payload as Record<string, unknown>;
        const id = typeof meta.id === 'string' ? meta.id
            : typeof meta.session_id === 'string' ? meta.session_id
                : null;
        if (id !== threadId) continue;

        const cwd = typeof meta.cwd === 'string' ? meta.cwd : null;
        return !cwd || cwd === workingDirectory;
    }
    return false;
}

function findCodexSessionFile(threadId: string, workingDirectory: string): string | null {
    const sessionsDir = join(os.homedir(), '.codex', 'sessions');
    for (const file of walkJsonlFiles(sessionsDir)) {
        let lines: string[];
        try {
            lines = readFileSync(file, 'utf-8').split('\n').filter((line) => line.trim().length > 0);
        } catch {
            continue;
        }
        if (isCodexSessionFile(lines, threadId, workingDirectory)) return file;
    }
    return null;
}

export async function replayCodexSessionHistory(
    threadId: string,
    workingDirectory: string,
    sendUserMessage: (text: string) => void,
    sendAssistantMessage: (text: string) => void,
): Promise<number> {
    try {
        const sessionFile = findCodexSessionFile(threadId, workingDirectory);
        if (!sessionFile) {
            logger.debug(`[RESUME] Codex session file not found for thread ${threadId}`);
            return 0;
        }

        const lines = readFileSync(sessionFile, 'utf-8')
            .split('\n')
            .filter((line) => line.trim().length > 0);

        const messages = parseCodexReplayMessages(lines);
        for (const message of messages) {
            if (message.role === 'user') {
                sendUserMessage(message.text);
            } else {
                sendAssistantMessage(message.text);
            }
        }

        logger.debug(`[RESUME] Replayed ${messages.length} Codex messages from ${sessionFile}`);
        return messages.length;
    } catch (error) {
        logger.debug('[RESUME] Failed to replay Codex session history:', error);
        return 0;
    }
}
