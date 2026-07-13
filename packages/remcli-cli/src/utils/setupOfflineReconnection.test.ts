import { beforeEach, describe, expect, it, vi } from 'vitest';

interface ReconnectionTestState {
    onReconnected: (() => Promise<unknown>) | null;
}

const testState = vi.hoisted(() => {
    const state: ReconnectionTestState = { onReconnected: null };
    return {
        state,
        reset(): void {
            state.onReconnected = null;
        },
    };
});

vi.mock('@/utils/serverConnectionErrors', () => ({
    startOfflineReconnection: vi.fn((config: { onReconnected: () => Promise<unknown> }) => {
        testState.state.onReconnected = config.onReconnected;
        return {
            cancel: vi.fn(),
            getSession: () => null,
            isReconnected: () => false,
        };
    }),
}));

vi.mock('@/daemon/p2p/p2pSession', () => ({
    getEffectiveServerUrl: () => 'http://127.0.0.1:3000',
}));

import { setupOfflineReconnection } from './setupOfflineReconnection';

const sessionResponse = {
    id: 'reconnected-session',
    seq: 1,
    metadata: {},
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    encryptionKey: new Uint8Array(32),
    encryptionVariant: 'legacy' as const,
};

const metadata = {
    path: '/workspace',
    host: 'test-host',
    homeDir: '/home/test',
    remcliHomeDir: '/home/test/.remcli',
    remcliLibDir: '/workspace/remcli',
    remcliToolsDir: '/workspace/remcli/tools',
};

describe('setupOfflineReconnection', () => {
    beforeEach(() => {
        testState.reset();
    });

    it('does not create a reconnected session client when the daemon lease gate rejects it', async () => {
        const sessionSyncClient = vi.fn(() => ({ sessionId: sessionResponse.id }));
        const canCreateReconnectedSessionConsumer = vi.fn(async () => false);

        setupOfflineReconnection({
            api: {
                getOrCreateSession: vi.fn(async () => sessionResponse),
                sessionSyncClient,
            } as never,
            sessionTag: 'offline-session',
            metadata,
            state: {},
            response: null,
            canCreateReconnectedSessionConsumer,
            onSessionSwap: vi.fn(),
        });

        if (!testState.state.onReconnected) {
            throw new Error('Expected offline reconnection callback');
        }

        await expect(testState.state.onReconnected()).rejects.toThrow('Daemon runner credential handoff failed');
        expect(canCreateReconnectedSessionConsumer).toHaveBeenCalledWith(sessionResponse);
        expect(sessionSyncClient).not.toHaveBeenCalled();
    });
});
