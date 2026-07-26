import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonLifecycleState } from '@/persistence';

const readDaemonState = vi.hoisted(() => vi.fn());

vi.mock('@/persistence', () => ({
    readDaemonState,
}));

import { setupP2PForSession } from './p2pSession';

afterEach(() => {
    readDaemonState.mockReset();
});

describe('setupP2PForSession lifecycle gate', () => {
    it.each([
        'starting',
        'stopping',
        'stopped',
        'failed',
    ] as const)('does not connect while daemon state is %s', async (state: DaemonLifecycleState) => {
        readDaemonState.mockResolvedValue({
            state,
            p2pPort: 50123,
        });

        await expect(setupP2PForSession()).rejects.toThrow(
            'Daemon is not running. Start the daemon first with: remcli daemon start',
        );
    });
});
