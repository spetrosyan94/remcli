/**
 * Auto Session Title
 *
 * Sets session title from the first user message when the AI agent
 * doesn't have access to the change_title MCP tool (e.g. Cursor)
 * or as a fallback if the AI doesn't call it.
 */

import { logger } from '@/ui/logger';
import type { ApiSessionClient } from '@/api/apiSession';

const MAX_TITLE_LENGTH = 60;

/**
 * Creates a one-shot function that sets the session title from the first user message.
 * Subsequent calls are no-ops.
 */
export function createAutoTitleSetter(session: ApiSessionClient) {
    let done = false;

    return (userMessage: string) => {
        if (done) return;
        done = true;

        const title = userMessage.length > MAX_TITLE_LENGTH
            ? userMessage.substring(0, MAX_TITLE_LENGTH - 3) + '...'
            : userMessage;

        session.updateMetadata((current) => ({
            ...current,
            summary: { text: title, updatedAt: Date.now() },
        }));
        logger.debug(`[autoTitle] Set session title: ${title}`);
    };
}
