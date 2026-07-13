import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
    sessionSyncClient: vi.fn(),
    acquireDaemonRunnerCredential: vi.fn(async () => false),
}));

vi.mock('@/api/api', () => ({
    ApiClient: {
        create: vi.fn(async () => ({
            getOrCreateSession: vi.fn(async () => ({
                id: 'cursor-session',
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

vi.mock('@/utils/createSessionMetadata', () => ({
    createSessionMetadata: vi.fn(() => ({
        state: {},
        metadata: {
            path: '/workspace',
            host: 'test-host',
            homeDir: '/home/test',
            remcliHomeDir: '/home/test/.remcli',
            remcliLibDir: '/workspace/remcli',
            remcliToolsDir: '/workspace/remcli/tools',
        },
    })),
}));

vi.mock('@/utils/daemonRunnerCredentialBootstrap', () => ({
    acquireDaemonRunnerCredential: testState.acquireDaemonRunnerCredential,
    reportTerminalSessionStarted: vi.fn(),
}));

vi.mock('@/utils/serverConnectionErrors', () => ({
    connectionState: { setBackend: vi.fn() },
}));

import { runCursor } from './runCursor';

describe('runCursor daemon bootstrap', () => {
    beforeEach(() => {
        testState.sessionSyncClient.mockReset();
        testState.acquireDaemonRunnerCredential.mockClear();
        testState.acquireDaemonRunnerCredential.mockResolvedValue(false);
    });

    it('does not construct a session consumer when the daemon credential gate fails', async () => {
        await runCursor({
            credentials: {
                token: 'test-token',
                encryption: { type: 'legacy', secret: new Uint8Array(32) },
            },
            startedBy: 'daemon',
        });

        expect(testState.acquireDaemonRunnerCredential).toHaveBeenCalledWith(expect.objectContaining({
            agentName: 'Cursor',
            sessionId: 'cursor-session',
        }));
        expect(testState.sessionSyncClient).not.toHaveBeenCalled();
    });
});
