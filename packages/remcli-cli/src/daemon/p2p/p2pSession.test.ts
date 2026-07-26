import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonLifecycleState } from '@/persistence';
import { configuration } from '@/configuration';

const { readDaemonState, updateSettings, loadPairing } = vi.hoisted(() => ({
    readDaemonState: vi.fn(),
    updateSettings: vi.fn(),
    loadPairing: vi.fn(),
}));
const originalP2PServerUrl = configuration.p2pServerUrl;

vi.mock('@/persistence', () => ({
    readDaemonState,
    updateSettings,
}));

vi.mock('./p2pPairing', () => ({
    loadPairing,
}));

import { setupP2PForSession } from './p2pSession';

afterEach(() => {
    readDaemonState.mockReset();
    updateSettings.mockReset();
    loadPairing.mockReset();
    configuration.p2pServerUrl = originalP2PServerUrl;
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

    it('keeps the pairing auth secret only in runtime P2P credentials', async () => {
        const authSecret = new Uint8Array(32).fill(4);
        const contentSecret = new Uint8Array(32).fill(9);
        readDaemonState.mockResolvedValue({ state: 'running', p2pPort: 50123 });
        loadPairing.mockReturnValue({ authSecret, contentSecret });
        updateSettings.mockImplementation(async (updater: (settings: { machineId?: string }) => unknown) => {
            return await updater({ machineId: 'machine-1' });
        });

        const { credentials } = await setupP2PForSession();

        expect(credentials.p2pAuthSecret).toBe(authSecret);
        expect(credentials.encryption).toEqual({ type: 'legacy', secret: contentSecret });
    });
});
