import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    sessionSyncClient: vi.fn(),
    createDaemonRunnerSessionConsumer: vi.fn(async () => null),
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            getOrCreateSession: vi.fn(async () => ({
                id: 'claude-session',
                seq: 1,
                metadata: {},
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 1,
                encryptionKey: new Uint8Array(32),
                encryptionVariant: 'legacy',
            })),
            sessionSyncClient: testState.sessionSyncClient,
        })),
    },
}));

vi.mock('@/persistence', () => ({
    readSettings: vi.fn(async () => ({ machineId: 'test-machine' })),
}));

vi.mock('@/utils/daemonRunnerCredentialBootstrap', () => ({
    createDaemonRunnerSessionConsumer: testState.createDaemonRunnerSessionConsumer,
    reportTerminalSessionStarted: vi.fn(),
}));

vi.mock('@/ui/doctor', () => ({
    getEnvironmentInfo: () => ({}),
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
    connectionState: { setBackend: vi.fn() },
}));

import { runClaude } from './runClaude';

describe('runClaude daemon bootstrap', () => {
    beforeEach(() => {
        testState.sessionSyncClient.mockReset();
        testState.createDaemonRunnerSessionConsumer.mockClear();
        testState.createDaemonRunnerSessionConsumer.mockResolvedValue(null);
    });

    it('does not construct a session consumer when the daemon credential gate fails', async () => {
        await runClaude({
            token: 'test-token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        }, {
            startedBy: 'daemon',
            startingMode: 'remote',
        });

        expect(testState.createDaemonRunnerSessionConsumer).toHaveBeenCalledWith(expect.objectContaining({
            agentName: 'Claude',
            sessionId: 'claude-session',
        }));
        expect(testState.sessionSyncClient).not.toHaveBeenCalled();
    });
});
