import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { getProjectPath } from '@/claude/utils/path';
import { logger } from '@/ui/logger';
import type { RawJSONLines } from '@/claude/types';

/**
 * Replays historical messages from a Claude session .jsonl file into the P2P store.
 * Called when a session is resumed, BEFORE the Claude SDK starts.
 * Messages are sent through sendClaudeSessionMessage() which handles encryption.
 *
 * Only replays user and assistant messages — skips system, summary, and other types.
 * Errors are caught and logged but never thrown (replay failure must not block session start).
 */
export async function replaySessionHistory(
    sessionId: string,
    workingDirectory: string,
    sendMessage: (message: RawJSONLines) => void,
): Promise<number> {
    try {
        const projectDir = getProjectPath(workingDirectory);
        const jsonlPath = join(projectDir, `${sessionId}.jsonl`);

        if (!existsSync(jsonlPath)) {
            logger.debug(`[RESUME] Session file not found: ${jsonlPath}`);
            return 0;
        }

        const fileContent = readFileSync(jsonlPath, 'utf-8');
        const lines = fileContent.split('\n').filter(line => line.trim().length > 0);

        let replayedCount = 0;

        for (const line of lines) {
            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(line);
            } catch {
                logger.debug(`[RESUME] Skipping unparseable line`);
                continue;
            }

            const type = parsed.type;

            // Only replay user questions and assistant responses
            if (type !== 'user' && type !== 'assistant') {
                continue;
            }

            sendMessage(parsed as RawJSONLines);
            replayedCount++;
        }

        logger.debug(`[RESUME] Replayed ${replayedCount} messages from ${jsonlPath}`);
        return replayedCount;
    } catch (error) {
        logger.debug(`[RESUME] Failed to replay session history:`, error);
        return 0;
    }
}

/**
 * Extracts the resume session ID from claudeArgs array.
 * Looks for `--resume <id>` pattern where id is a UUID-like string.
 * Returns null if --resume is not found or has no valid ID.
 */
export function extractResumeIdFromArgs(claudeArgs: string[] | undefined): string | null {
    if (!claudeArgs) return null;

    for (let i = 0; i < claudeArgs.length; i++) {
        if (claudeArgs[i] === '--resume' && i + 1 < claudeArgs.length) {
            const nextArg = claudeArgs[i + 1];
            // UUID-like: contains dashes and doesn't start with a dash (not another flag)
            if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                return nextArg;
            }
        }
    }

    return null;
}
