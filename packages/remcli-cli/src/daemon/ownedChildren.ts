import type { TrackedSession } from './types';

/**
 * Returns only current daemon-created tmux runners with immutable ownership
 * evidence. The values are diagnostic hints; cleanup always rechecks tmux.
 */
export function collectConfirmedOwnedChildPids(sessions: TrackedSession[]): number[] {
    return Array.from(new Set(
        sessions.flatMap((session) => (
            session.startedBy === 'daemon'
            && session.tmuxRunner?.panePid === session.pid
                ? [session.pid]
                : []
        )),
    )).sort((left, right) => left - right);
}
