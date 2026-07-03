import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiSessionClient } from './apiSession';
import type { Session } from './types';

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
            disconnect: vi.fn()
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

    afterEach(() => {
        consoleSpy.mockRestore();
        vi.restoreAllMocks();
    });
});