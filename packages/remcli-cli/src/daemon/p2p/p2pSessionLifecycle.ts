/**
 * Shared helpers for publishing P2P session lifecycle state.
 *
 * These helpers keep the REST source of truth (P2PStore) and Socket.IO
 * ephemeral activity notifications in sync for all lifecycle entry points.
 */

import type { P2PEventRouter } from './p2pEventRouter';
import type { P2PStore } from './p2pStore';

export interface PublishSessionActivityOptions {
    sessionId: string;
    active: boolean;
    activeAt?: number;
    thinking?: boolean;
    terminal?: boolean;
}

export interface PublishSessionActivityResult {
    sessionExists: boolean;
    activeAt: number;
}

export function publishSessionActivity(
    store: P2PStore,
    router: P2PEventRouter,
    options: PublishSessionActivityOptions
): PublishSessionActivityResult {
    const activeAt = options.activeAt ?? Date.now();
    const thinking = options.active ? options.thinking ?? false : false;
    const sessionExists = store.getSession(options.sessionId) !== undefined;

    const wasApplied = options.terminal
        ? store.markSessionStopped(options.sessionId, activeAt)
        : store.setSessionActive(options.sessionId, options.active, activeAt);
    if (!wasApplied) {
        return {
            sessionExists,
            activeAt
        };
    }
    router.emitEphemeral({
        type: 'activity',
        id: options.sessionId,
        active: options.active,
        activeAt,
        thinking
    }, { type: 'user-scoped-only' });

    return {
        sessionExists,
        activeAt
    };
}
