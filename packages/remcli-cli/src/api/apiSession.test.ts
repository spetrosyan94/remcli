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
    connected: boolean;
}

interface ApiSessionClientInternals {
    enqueuePendingUserMessage(message: DeliveredUserMessage, sequence: number): void;
}

interface SocketIoOptions {
    auth: (callback: (auth: Record<string, unknown>) => void) => void;
}

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

    afterEach(() => {
        forgetSessionRunnerCredential(mockSession.id);
        consoleSpy.mockRestore();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });
});
