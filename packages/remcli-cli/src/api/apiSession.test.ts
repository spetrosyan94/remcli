import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiSessionClient } from './apiSession';
import {
    RetryableUserMessageDeliveryError,
    type DeliveredUserMessage,
    type Session,
} from './types';
import {
    forgetSessionRunnerCredential,
    rememberSessionRunnerCredential,
    SESSION_MESSAGE_ACK_VERSION,
} from '@/daemon/p2p/p2pRunnerCredentials';
import { encodeBase64, encrypt } from './encryption';

// Use vi.hoisted to ensure mock function is available when vi.mock factory runs
const { mockIo, mockGetEffectiveServerUrl } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    mockGetEffectiveServerUrl: vi.fn(() => 'https://api.example.com')
}));

vi.mock('socket.io-client', () => ({
    io: mockIo
}));

vi.mock('@/daemon/p2p/p2pSession', () => ({
    getEffectiveServerUrl: mockGetEffectiveServerUrl
}));

interface MockSocket {
    connect: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    emit: ReturnType<typeof vi.fn>;
    emitWithAck: ReturnType<typeof vi.fn>;
    connected: boolean;
}

interface ApiSessionClientInternals {
    enqueuePendingUserMessage(message: DeliveredUserMessage, sequence: number): void;
    metadata: Session['metadata'];
}

interface SocketIoOptions {
    auth: (callback: (auth: Record<string, unknown>) => void) => void;
}

type SocketUpdateHandler = (data: {
    body: {
        message: {
            content: {
                c: string;
                t: 'encrypted';
            };
            id: string;
            seq: number;
        };
        sid: string;
        t: 'new-message';
    };
    createdAt: number;
    id: string;
    seq: number;
}) => void;

describe('ApiSessionClient connection handling', () => {
    let mockSocket: MockSocket;
    let consoleSpy: ReturnType<typeof vi.spyOn>;
    let mockSession: Session;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Mock socket.io client
        mockSocket = {
            connect: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            disconnect: vi.fn(),
            close: vi.fn(),
            emit: vi.fn(),
            emitWithAck: vi.fn(),
            connected: true,
        };

        mockIo.mockReturnValue(mockSocket);

        // Create a proper mock session with metadata
        mockSession = {
            id: 'test-session-id',
            seq: 0,
            metadata: {
                path: '/tmp',
                host: 'localhost',
                homeDir: '/home/user',
                remcliHomeDir: '/home/user/.remcli',
                remcliLibDir: '/home/user/.remcli/lib',
                remcliToolsDir: '/home/user/.remcli/tools'
            },
            metadataVersion: 0,
            agentState: null,
            agentStateVersion: 0,
            encryptionKey: new Uint8Array(32),
            encryptionVariant: 'legacy' as const
        };
    });

    it('should handle socket connection failure gracefully', async () => {
        // Should not throw during client creation
        // Note: socket is created with autoConnect: false, so connection happens later
        expect(() => {
            new ApiSessionClient('fake-token', mockSession);
        }).not.toThrow();
    });

    it('should emit correct events on socket connection', () => {
        const client = new ApiSessionClient('fake-token', mockSession);

        // Should have set up event listeners
        expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
        expect(mockSocket.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('uses a daemon runner credential during the initial socket handshake', () => {
        const runnerCredential = 'runner-credential';
        rememberSessionRunnerCredential(mockSession.id, runnerCredential);

        const client = new ApiSessionClient('fake-token', mockSession);

        const socketOptions = mockIo.mock.calls[0][1] as SocketIoOptions;
        client.onUserMessage(vi.fn());

        expect(mockSocket.connect).toHaveBeenCalledOnce();
        expect(mockSocket.disconnect).not.toHaveBeenCalled();

        const callback = vi.fn();
        socketOptions.auth(callback);

        expect(callback).toHaveBeenCalledWith({
            token: 'fake-token',
            clientType: 'session-scoped',
            sessionId: mockSession.id,
            messageAckVersion: SESSION_MESSAGE_ACK_VERSION,
            runnerCredential,
        });
    });

    it('reoffers only the blocked head after explicit recovery and acknowledges messages in order', async () => {
        const deliveryOne: DeliveredUserMessage = {
            role: 'user',
            content: { type: 'text', text: 'first prompt' },
            deliveryId: 'p2p:test-session-id:1',
        };
        const deliveryTwo: DeliveredUserMessage = {
            role: 'user',
            content: { type: 'text', text: 'second prompt' },
            deliveryId: 'p2p:test-session-id:2',
        };
        rememberSessionRunnerCredential(mockSession.id, 'runner-credential');
        const client = new ApiSessionClient('fake-token', mockSession);
        const internals = client as unknown as ApiSessionClientInternals;
        const receivedDeliveryIds: string[] = [];

        client.onUserMessage(async (message) => {
            receivedDeliveryIds.push(message.deliveryId ?? '');
            if (receivedDeliveryIds.length === 1) {
                throw new RetryableUserMessageDeliveryError(new Error('recover app-server first'));
            }
        });
        internals.enqueuePendingUserMessage(deliveryOne, 1);
        internals.enqueuePendingUserMessage(deliveryTwo, 2);

        await vi.waitFor(() => {
            expect(receivedDeliveryIds).toEqual([deliveryOne.deliveryId]);
        });
        expect(mockSocket.emit).not.toHaveBeenCalledWith('message-ack', expect.anything());

        expect(client.requestPendingUserMessageRedelivery()).toBe(true);

        await vi.waitFor(() => {
            expect(receivedDeliveryIds).toEqual([
                deliveryOne.deliveryId,
                deliveryOne.deliveryId,
                deliveryTwo.deliveryId,
            ]);
        });
        expect(mockSocket.emit).toHaveBeenNthCalledWith(1, 'message-ack', {
            sid: mockSession.id,
            seq: 1,
        });
        expect(mockSocket.emit).toHaveBeenNthCalledWith(2, 'message-ack', {
            sid: mockSession.id,
            seq: 2,
        });
    });

    it('acknowledges an in-flight cancelled delivery only after its callback unwinds', async () => {
        const delivery: DeliveredUserMessage = {
            role: 'user',
            content: { type: 'text', text: 'cancel me' },
            deliveryId: 'p2p:test-session-id:1',
        };
        rememberSessionRunnerCredential(mockSession.id, 'runner-credential');
        const client = new ApiSessionClient('fake-token', mockSession);
        const internals = client as unknown as ApiSessionClientInternals;
        let resolveDelivery: (() => void) | null = null;

        client.onUserMessage(async () => {
            await new Promise<void>((resolve) => {
                resolveDelivery = resolve;
            });
        });
        internals.enqueuePendingUserMessage(delivery, 1);

        await vi.waitFor(() => {
            expect(resolveDelivery).not.toBeNull();
        });
        expect(client.cancelPendingUserMessageDelivery(delivery.deliveryId!)).toBe(true);
        expect(mockSocket.emit).not.toHaveBeenCalledWith('message-ack', expect.anything());

        const resolveInFlightDelivery = resolveDelivery as (() => void) | null;
        resolveInFlightDelivery?.();

        await vi.waitFor(() => {
            expect(mockSocket.emit).toHaveBeenCalledWith('message-ack', {
                sid: mockSession.id,
                seq: 1,
            });
        });
        expect(client.requestPendingUserMessageRedelivery()).toBe(false);
    });

    it('drops an invalid live message and continues with the next valid delivery in order', async () => {
        mockSession.metadata.flavor = 'codex';
        rememberSessionRunnerCredential(mockSession.id, 'runner-credential');
        const client = new ApiSessionClient('fake-token', mockSession);
        const receiveGenericMessage = vi.fn();
        const receivedTexts: string[] = [];
        client.on('message', receiveGenericMessage);
        client.onUserMessage((message) => {
            receivedTexts.push(message.content.text);
        });

        const updateHandler = mockSocket.on.mock.calls.find(([event]) => event === 'update')?.[1] as SocketUpdateHandler;
        const emitEncryptedUserMessage = (sequence: number, payload: Record<string, unknown>): void => {
            updateHandler({
                id: `update-${sequence}`,
                seq: sequence,
                createdAt: sequence,
                body: {
                    t: 'new-message',
                    sid: mockSession.id,
                    message: {
                        id: `message-${sequence}`,
                        seq: sequence,
                        content: {
                            t: 'encrypted',
                            c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, payload)),
                        },
                    },
                },
            });
        };

        emitEncryptedUserMessage(1, {
            role: 'user',
            content: { type: 'text', text: 'forged' },
            meta: { permissionMode: 'danger-full-access' },
        });
        emitEncryptedUserMessage(2, {
            role: 'user',
            content: { type: 'text', text: 'valid' },
            meta: { sentFrom: 'web' },
        });

        await vi.waitFor(() => {
            expect(receivedTexts).toEqual(['valid']);
        });
        expect(receiveGenericMessage).not.toHaveBeenCalled();
        expect(mockSocket.emit).toHaveBeenNthCalledWith(1, 'message-ack', {
            sid: mockSession.id,
            seq: 1,
        });
        expect(mockSocket.emit).toHaveBeenNthCalledWith(2, 'message-ack', {
            sid: mockSession.id,
            seq: 2,
        });
    });

    it('allows only a safe phone prompt when the transport session has no provider flavor', async () => {
        rememberSessionRunnerCredential(mockSession.id, 'runner-credential');
        const client = new ApiSessionClient('fake-token', mockSession);
        const receivedTexts: string[] = [];
        client.onUserMessage((message) => {
            receivedTexts.push(message.content.text);
        });

        const updateHandler = mockSocket.on.mock.calls.find(([event]) => event === 'update')?.[1] as SocketUpdateHandler;
        const emitEncryptedUserMessage = (sequence: number, payload: Record<string, unknown>): void => {
            updateHandler({
                id: `update-${sequence}`,
                seq: sequence,
                createdAt: sequence,
                body: {
                    t: 'new-message',
                    sid: mockSession.id,
                    message: {
                        id: `message-${sequence}`,
                        seq: sequence,
                        content: {
                            t: 'encrypted',
                            c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, payload)),
                        },
                    },
                },
            });
        };

        emitEncryptedUserMessage(1, {
            role: 'user',
            content: { type: 'text', text: 'safe phone prompt' },
            meta: { sentFrom: 'phone' },
        });
        emitEncryptedUserMessage(2, {
            role: 'user',
            content: { type: 'text', text: 'forged control prompt' },
            meta: { model: 'forged-model' },
        });

        await vi.waitFor(() => {
            expect(receivedTexts).toEqual(['safe phone prompt']);
        });
        await vi.waitFor(() => {
            // ACK is a cumulative watermark: once the safe first delivery and
            // rejected second delivery are both terminal, acknowledge seq 2.
            expect(mockSocket.emit).toHaveBeenCalledWith('message-ack', {
                sid: mockSession.id,
                seq: 2,
            });
        });
    });

    it('keeps the original provider ingress schema after mutable metadata changes', async () => {
        mockSession.metadata.flavor = 'codex';
        rememberSessionRunnerCredential(mockSession.id, 'runner-credential');
        const client = new ApiSessionClient('fake-token', mockSession);
        const internals = client as unknown as ApiSessionClientInternals;
        const receivedTexts: string[] = [];
        client.onUserMessage((message) => {
            receivedTexts.push(message.content.text);
        });
        internals.metadata = { ...internals.metadata, flavor: 'claude' };

        const updateHandler = mockSocket.on.mock.calls.find(([event]) => event === 'update')?.[1] as SocketUpdateHandler;
        updateHandler({
            id: 'update-forged-flavor',
            seq: 1,
            createdAt: 1,
            body: {
                t: 'new-message',
                sid: mockSession.id,
                message: {
                    id: 'message-forged-flavor',
                    seq: 1,
                    content: {
                        t: 'encrypted',
                        c: encodeBase64(encrypt(mockSession.encryptionKey, mockSession.encryptionVariant, {
                            role: 'user',
                            content: { type: 'text', text: 'forged via metadata flavor' },
                            meta: { permissionMode: 'manual' },
                        })),
                    },
                },
            },
        });

        await vi.waitFor(() => {
            expect(mockSocket.emit).toHaveBeenCalledWith('message-ack', {
                sid: mockSession.id,
                seq: 1,
            });
        });
        expect(receivedTexts).toEqual([]);
    });

    it('rejects a bounded metadata update when the server returns error', async () => {
        mockSocket.emitWithAck.mockResolvedValue({ result: 'error' });
        const client = new ApiSessionClient('fake-token', mockSession);

        await expect(client.updateMetadata((metadata) => ({
            ...metadata,
            path: '/tmp/updated',
        }), {
            maxAttempts: 2,
            timeoutMs: 1,
        })).rejects.toThrow('Session metadata update was rejected by the server');

        expect(mockSocket.emitWithAck).toHaveBeenCalledOnce();
    });

    it('rejects a default metadata update immediately when the server returns error', async () => {
        mockSocket.emitWithAck.mockResolvedValue({ result: 'error' });
        const client = new ApiSessionClient('fake-token', mockSession);

        await expect(client.updateMetadata((metadata) => ({
            ...metadata,
            path: '/tmp/rejected',
        }))).rejects.toThrow('Session metadata update was rejected by the server');

        expect(mockSocket.emitWithAck).toHaveBeenCalledOnce();
    });

    it('bounds pending metadata transport retries instead of waiting indefinitely', async () => {
        mockSocket.emitWithAck.mockImplementation(() => new Promise<never>(() => {}));
        const client = new ApiSessionClient('fake-token', mockSession);

        await expect(client.updateMetadata((metadata) => ({
            ...metadata,
            path: '/tmp/updated',
        }), {
            maxAttempts: 2,
            timeoutMs: 10,
        })).rejects.toThrow('Metadata update timed out');

        expect(mockSocket.emitWithAck).toHaveBeenCalledTimes(2);
    });

    it('bounds a lifecycle metadata update queued behind a pending retry', async () => {
        mockSocket.emitWithAck.mockImplementation(() => new Promise<never>(() => {}));
        const client = new ApiSessionClient('fake-token', mockSession);

        void client.updateMetadata((metadata) => ({
            ...metadata,
            path: '/tmp/pending',
        }));
        await vi.waitFor(() => expect(mockSocket.emitWithAck).toHaveBeenCalledOnce());

        await expect(client.updateMetadata((metadata) => ({
            ...metadata,
            lifecycleState: 'archived',
        }), {
            maxAttempts: 1,
            timeoutMs: 1,
        })).rejects.toThrow('Metadata update timed out after 1ms');

        expect(mockSocket.emitWithAck).toHaveBeenCalledOnce();
    });

    afterEach(() => {
        forgetSessionRunnerCredential(mockSession.id);
        consoleSpy.mockRestore();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });
});
