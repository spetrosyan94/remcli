/**
 * Auto Session Title
 *
 * Sets session title from the first user message when the AI agent
 * doesn't have access to the change_title MCP tool (e.g. Cursor)
 * or as a fallback if the AI doesn't call it.
 */

import type { ApiSessionClient } from '@/api/apiSession';

const MAX_TITLE_LENGTH = 60;

type SessionSource = ApiSessionClient | (() => ApiSessionClient);

/**
 * Creates a one-shot function that sets the session title from the first user message.
 * Subsequent calls are no-ops.
 */
export function createAutoTitleSetter(sessionSource: SessionSource): (userMessage: string) => void {
    let done = false;

    return (userMessage: string) => {
        if (done) return;
        done = true;

        const session = typeof sessionSource === 'function' ? sessionSource() : sessionSource;

        const title = userMessage.length > MAX_TITLE_LENGTH
            ? userMessage.substring(0, MAX_TITLE_LENGTH - 3) + '...'
            : userMessage;

        session.updateMetadata((current) => ({
            ...current,
            summary: { text: title, updatedAt: Date.now() },
        }));
    };
}
