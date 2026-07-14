import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiSessionClient } from './apiSession';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import type { Metadata, Session } from './types';

const { mockGetEffectiveServerUrl, mockIo } = vi.hoisted(() => ({
    mockGetEffectiveServerUrl: vi.fn(() => 'https://api.example.com'),
    mockIo: vi.fn(),
}));

vi.mock('socket.io-client', () => ({
    io: mockIo,
}));

vi.mock('@/daemon/p2p/p2pSession', () => ({
    getEffectiveServerUrl: mockGetEffectiveServerUrl,
}));

vi.mock('@/utils/time', () => ({
    backoff: async (callback: () => Promise<unknown>): Promise<unknown> => {
        while (true) {
            try {
                return await callback();
            } catch {
                continue;
            }
        }
    },
}));

interface MetadataUpdateRequest {
    expectedVersion: number;
    metadata: string;
    sid: string;
}

interface MetadataUpdateAnswer {
    metadata: string;
    result: 'error' | 'success' | 'version-mismatch';
    version: number;
}

interface MockSocket {
    close: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    connected: boolean;
    disconnect: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    emitWithAck: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    volatile: {
        emit: ReturnType<typeof vi.fn>;
    };
}

const SESSION_ENCRYPTION_KEY = new Uint8Array(32);
const ERROR_OCCURRED_AT = 1_750_000_000_000;

function createMetadata(overrides: Partial<Metadata> = {}): Metadata {
    return {
        path: '/tmp',
        host: 'localhost',
        homeDir: '/home/user',
        remcliHomeDir: '/home/user/.remcli',
        remcliLibDir: '/home/user/.remcli/lib',
        remcliToolsDir: '/home/user/.remcli/tools',
        ...overrides,
    };
}

function createSession(metadata: Metadata): Session {
    return {
        id: 'test-session-id',
        seq: 0,
        metadata,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        encryptionKey: SESSION_ENCRYPTION_KEY,
        encryptionVariant: 'legacy',
    };
}

function encryptMetadata(metadata: Metadata): string {
    return encodeBase64(encrypt(SESSION_ENCRYPTION_KEY, 'legacy', metadata));
}

function decryptMetadata(request: MetadataUpdateRequest): Metadata {
    return decrypt(
        SESSION_ENCRYPTION_KEY,
        'legacy',
        decodeBase64(request.metadata),
    );
}

function createMockSocket(): MockSocket {
    let metadataVersion = 0;

    return {
        close: vi.fn(),
        connect: vi.fn(),
        connected: true,
        disconnect: vi.fn(),
        emit: vi.fn(),
        emitWithAck: vi.fn(async (_event: string, request: MetadataUpdateRequest): Promise<MetadataUpdateAnswer> => ({
            result: 'success',
            version: ++metadataVersion,
            metadata: request.metadata,
        })),
        off: vi.fn(),
        on: vi.fn(),
        volatile: {
            emit: vi.fn(),
        },
    };
}

async function waitForMetadataUpdates(mockSocket: MockSocket, count: number): Promise<void> {
    await vi.waitFor(() => {
        expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(count);
    });
}

async function flushQueuedMetadataWork(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('ApiSessionClient execution outcome', () => {
    let mockSocket: MockSocket;

    beforeEach(() => {
        mockSocket = createMockSocket();
        mockIo.mockReturnValue(mockSocket);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        mockIo.mockReset();
    });

    it('persists a typed error outcome for an error SessionEvent without the error text', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(ERROR_OCCURRED_AT);
        const client = new ApiSessionClient('fake-token', createSession(createMetadata()));
        const errorMessage = 'Authentication failed for secret-token';

        client.sendSessionEvent({ type: 'message', message: errorMessage, isError: true });

        await waitForMetadataUpdates(mockSocket, 1);

        const request = mockSocket.emitWithAck.mock.calls[0][1] as MetadataUpdateRequest;
        const metadata = decryptMetadata(request);
        expect(metadata.executionOutcome).toEqual({
            kind: 'error',
            occurredAt: ERROR_OCCURRED_AT,
        });
        expect(JSON.stringify(metadata)).not.toContain(errorMessage);
    });

    it('replaces an error outcome with a success watermark only for an explicit successful ACP message', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(ERROR_OCCURRED_AT + 1);
        const client = new ApiSessionClient('fake-token', createSession(createMetadata({
            executionOutcome: {
                kind: 'error',
                occurredAt: ERROR_OCCURRED_AT,
            },
        })));

        client.sendAgentMessage('gemini', {
            type: 'message',
            message: 'The operation completed successfully.',
            isError: false,
        });

        await waitForMetadataUpdates(mockSocket, 1);

        const request = mockSocket.emitWithAck.mock.calls[0][1] as MetadataUpdateRequest;
        expect(decryptMetadata(request).executionOutcome).toEqual({
            kind: 'success',
            occurredAt: ERROR_OCCURRED_AT + 1,
        });
    });

    it('persists a typed error outcome for an explicit ACP error message', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(ERROR_OCCURRED_AT);
        const client = new ApiSessionClient('fake-token', createSession(createMetadata()));
        const errorMessage = 'Gemini returned a provider error.';

        client.sendAgentMessage('gemini', {
            type: 'message',
            message: errorMessage,
            isError: true,
        });

        await waitForMetadataUpdates(mockSocket, 1);

        const request = mockSocket.emitWithAck.mock.calls[0][1] as MetadataUpdateRequest;
        const metadata = decryptMetadata(request);
        expect(metadata.executionOutcome).toEqual({
            kind: 'error',
            occurredAt: ERROR_OCCURRED_AT,
        });
        expect(JSON.stringify(metadata)).not.toContain(errorMessage);
    });

    it('does not clear an error outcome for an unclassified ACP message or a summary', async () => {
        const initialMetadata = createMetadata({
            executionOutcome: {
                kind: 'error',
                occurredAt: ERROR_OCCURRED_AT,
            },
        });
        const client = new ApiSessionClient('fake-token', createSession(initialMetadata));

        client.sendUserTextMessage('Please retry this task.');
        client.keepAlive(false, 'remote');
        client.sendSessionEvent({ type: 'ready' });
        client.sendAgentMessage('gemini', {
            type: 'message',
            message: 'Error output without an explicit signal.',
        });

        await flushQueuedMetadataWork();
        expect(mockSocket.emitWithAck).not.toHaveBeenCalled();

        client.sendClaudeSessionMessage({
            type: 'summary',
            summary: 'A generated title, not a successful agent output.',
            leafUuid: 'summary-id',
        });

        await waitForMetadataUpdates(mockSocket, 1);

        const request = mockSocket.emitWithAck.mock.calls[0][1] as MetadataUpdateRequest;
        expect(decryptMetadata(request).executionOutcome).toEqual(initialMetadata.executionOutcome);
    });

    it('merges the latest metadata and retries after an OCC version conflict', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(ERROR_OCCURRED_AT);
        const peerMetadata = createMetadata({ name: 'Updated by another client' });
        const client = new ApiSessionClient('fake-token', createSession(createMetadata()));

        mockSocket.emitWithAck
            .mockResolvedValueOnce({
                result: 'version-mismatch',
                version: 1,
                metadata: encryptMetadata(peerMetadata),
            } satisfies MetadataUpdateAnswer)
            .mockImplementationOnce(async (_event: string, request: MetadataUpdateRequest): Promise<MetadataUpdateAnswer> => ({
                result: 'success',
                version: 2,
                metadata: request.metadata,
            }));

        client.sendSessionEvent({ type: 'message', message: 'Runner failed.', isError: true });

        await waitForMetadataUpdates(mockSocket, 2);

        const firstRequest = mockSocket.emitWithAck.mock.calls[0][1] as MetadataUpdateRequest;
        const retryRequest = mockSocket.emitWithAck.mock.calls[1][1] as MetadataUpdateRequest;
        expect(firstRequest.expectedVersion).toBe(0);
        expect(retryRequest.expectedVersion).toBe(1);
        expect(decryptMetadata(retryRequest)).toMatchObject({
            name: peerMetadata.name,
            executionOutcome: {
                kind: 'error',
                occurredAt: ERROR_OCCURRED_AT,
            },
        });
    });

    it('does not let a stale success or a terminal session overwrite the current outcome', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(ERROR_OCCURRED_AT - 1);
        const client = new ApiSessionClient('fake-token', createSession(createMetadata({
            executionOutcome: {
                kind: 'error',
                occurredAt: ERROR_OCCURRED_AT,
            },
        })));

        client.sendAgentMessage('cursor', {
            type: 'message',
            message: 'An older output arrived late.',
            isError: false,
        });

        await flushQueuedMetadataWork();
        expect(mockSocket.emitWithAck).not.toHaveBeenCalled();

        client.sendSessionDeath();
        client.sendSessionEvent({ type: 'message', message: 'Late runner error.', isError: true });
        client.sendAgentMessage('cursor', {
            type: 'message',
            message: 'Late successful output.',
            isError: false,
        });

        await flushQueuedMetadataWork();
        expect(mockSocket.emitWithAck).not.toHaveBeenCalled();
    });

    it('does not let an older error replace a recorded success watermark', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(ERROR_OCCURRED_AT - 1);
        const client = new ApiSessionClient('fake-token', createSession(createMetadata({
            executionOutcome: {
                kind: 'success',
                occurredAt: ERROR_OCCURRED_AT,
            },
        })));

        client.sendSessionEvent({ type: 'message', message: 'A late failure arrived.', isError: true });

        await flushQueuedMetadataWork();
        expect(mockSocket.emitWithAck).not.toHaveBeenCalled();
    });

    it('does not mutate execution outcome when metadata already marks the session as archived', async () => {
        const client = new ApiSessionClient('fake-token', createSession(createMetadata({
            lifecycleState: 'archived',
        })));

        client.sendSessionEvent({ type: 'message', message: 'Late runner error.', isError: true });

        await flushQueuedMetadataWork();
        expect(mockSocket.emitWithAck).not.toHaveBeenCalled();
    });
});
