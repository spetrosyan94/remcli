import { describe, expect, it } from 'vitest';

import { collectConfirmedOwnedChildPids } from './ownedChildren';
import type { TrackedSession } from './types';

function createSession(overrides: Partial<TrackedSession>): TrackedSession {
    return {
        startedBy: 'daemon',
        pid: 100,
        ...overrides,
    };
}

describe('collectConfirmedOwnedChildPids', () => {
    it('keeps only daemon-created sessions with a matching immutable pane PID', () => {
        const pids = collectConfirmedOwnedChildPids([
            createSession({
                pid: 301,
                tmuxRunner: {
                    sessionName: 'remcli-a',
                    windowId: '@1',
                    paneId: '%1',
                    panePid: 301,
                    ownerMarker: 'owner-a',
                },
            }),
            createSession({
                pid: 302,
                tmuxRunner: {
                    sessionName: 'remcli-b',
                    windowId: '@2',
                    paneId: '%2',
                    panePid: 303,
                    ownerMarker: 'owner-b',
                },
            }),
            createSession({
                pid: 304,
                startedBy: 'terminal',
                tmuxRunner: {
                    sessionName: 'remcli-c',
                    windowId: '@3',
                    paneId: '%3',
                    panePid: 304,
                    ownerMarker: 'owner-c',
                },
            }),
            createSession({
                pid: 301,
                tmuxRunner: {
                    sessionName: 'remcli-a-duplicate',
                    windowId: '@4',
                    paneId: '%4',
                    panePid: 301,
                    ownerMarker: 'owner-d',
                },
            }),
        ]);

        expect(pids).toEqual([301]);
    });
});
