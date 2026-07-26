import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient } from './api';
import axios from 'axios';
import { connectionState } from '@/utils/serverConnectionErrors';
import { calculateRequestProofMac, type JsonValue } from '@/daemon/p2p/p2pRequestProof';

// Use vi.hoisted to ensure mock functions are available when vi.mock factory runs
const { mockPost, mockIsAxiosError, mockGetEffectiveServerUrl } = vi.hoisted(() => ({
    mockPost: vi.fn(),
    mockIsAxiosError: vi.fn(() => true),
    mockGetEffectiveServerUrl: vi.fn(() => 'https://api.example.com')
}));

vi.mock('axios', () => ({
    default: {
        post: mockPost,
        isAxiosError: mockIsAxiosError
    },
    isAxiosError: mockIsAxiosError
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

vi.mock('@/daemon/p2p/p2pSession', () => ({
    getEffectiveServerUrl: mockGetEffectiveServerUrl
}));

// Mock encryption utilities
vi.mock('./encryption', () => ({
    decodeBase64: vi.fn((data: string) => data),
    encodeBase64: vi.fn(() => 'encoded-payload'),
    decrypt: vi.fn((data: unknown) => data),
    encrypt: vi.fn((data: unknown) => data)
}));

// Mock libsodium encryption
vi.mock('./libsodiumEncryption', () => ({
    libsodiumEncryptForPublicKey: vi.fn((_data: Uint8Array) => new Uint8Array(32))
}));

// Global test metadata
const testMetadata = {
    path: '/tmp',
    host: 'localhost',
    homeDir: '/home/user',
    remcliHomeDir: '/home/user/.remcli',
    remcliLibDir: '/home/user/.remcli/lib',
    remcliToolsDir: '/home/user/.remcli/tools'
};

function createSessionResponse() {
    return {
        data: {
            session: {
                id: 'session-1',
                seq: 1,
                metadata: testMetadata,
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
            },
        },
    };
}

describe('Api server error handling', () => {
    let api: ApiClient;

    beforeEach(async () => {
        vi.clearAllMocks();
        connectionState.reset(); // Reset offline state between tests

        // Create a mock credential
        const mockCredential = {
            token: 'fake-token',
            encryption: {
                type: 'legacy' as const,
                secret: new Uint8Array(32)
            }
        };

        api = await ApiClient.create(mockCredential);
    });

    describe('getOrCreateSession', () => {
        it('signs the final P2P session body with the v1 HTTP request proof', async () => {
            const p2pAuthSecret = new Uint8Array(32).fill(7);
            const p2pApi = await ApiClient.create({
                token: 'p2p-bearer-token',
                p2pAuthSecret,
                encryption: {
                    type: 'legacy',
                    secret: new Uint8Array(32),
                },
            });
            mockPost.mockResolvedValue(createSessionResponse());

            await p2pApi.getOrCreateSession({ tag: 'test-tag', metadata: testMetadata, state: null });

            const [, requestBody, requestConfig] = mockPost.mock.calls[0] as [
                string,
                Record<string, unknown>,
                { headers: Record<string, string> },
            ];
            const headers = requestConfig.headers;
            const requestId = headers['X-Remcli-Request-Proof-Id'];

            expect(headers).toMatchObject({
                Authorization: 'Bearer p2p-bearer-token',
                'X-Remcli-Request-Proof-Version': '1',
                'X-Remcli-Request-Proof-Id': expect.any(String),
            });
            expect(headers['X-Remcli-Request-Proof-Mac']).toBe(calculateRequestProofMac(p2pAuthSecret, {
                v: 1,
                transport: 'http',
                operation: 'POST /v1/sessions',
                requestId,
                payload: requestBody as JsonValue,
            }));
        });

        it('does not add P2P proof headers to non-P2P credentials', async () => {
            mockPost.mockResolvedValue(createSessionResponse());

            await api.getOrCreateSession({ tag: 'test-tag', metadata: testMetadata, state: null });

            const [, , requestConfig] = mockPost.mock.calls[0] as [
                string,
                Record<string, unknown>,
                { headers: Record<string, string> },
            ];
            expect(requestConfig.headers).toEqual({
                Authorization: 'Bearer fake-token',
                'Content-Type': 'application/json',
            });
        });

        it('should return null when Remcli server is unreachable (ECONNREFUSED)', async () => {
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw connection refused error
            mockPost.mockRejectedValue({ code: 'ECONNREFUSED' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Remcli server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when Remcli server cannot be found (ENOTFOUND)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw DNS resolution error
            mockPost.mockRejectedValue({ code: 'ENOTFOUND' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Remcli server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when Remcli server times out (ETIMEDOUT)', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to throw timeout error
            mockPost.mockRejectedValue({ code: 'ETIMEDOUT' });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Remcli server unreachable')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when session endpoint returns 404', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 404
            mockPost.mockRejectedValue({
                response: { status: 404 },
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            // New unified format via connectionState.fail()
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Remcli server unreachable')
            );
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('Session creation failed: 404')
            );

            consoleSpy.mockRestore();
        });

        it('should return null when server returns 500 Internal Server Error', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 500 error
            mockPost.mockRejectedValue({
                response: { status: 500 },
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Remcli server unreachable')
            );
            consoleSpy.mockRestore();
        });

        it('should return null when server returns 503 Service Unavailable', async () => {
            connectionState.reset();
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

            // Mock axios to return 503 error
            mockPost.mockRejectedValue({
                response: { status: 503 },
                isAxiosError: true
            });

            const result = await api.getOrCreateSession({
                tag: 'test-tag',
                metadata: testMetadata,
                state: null
            });

            expect(result).toBeNull();
            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Remcli server unreachable')
            );
            consoleSpy.mockRestore();
        });

        it('should re-throw non-connection errors', async () => {
            // Mock axios to throw a different type of error (e.g., authentication error)
            const authError = Object.assign(new Error('Invalid API key'), { code: 'UNAUTHORIZED' });
            mockPost.mockRejectedValue(authError);

            await expect(
                api.getOrCreateSession({ tag: 'test-tag', metadata: testMetadata, state: null })
            ).rejects.toThrow('Failed to get or create session: Invalid API key');

            // Should not show the offline mode message
            const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
            expect(consoleSpy).not.toHaveBeenCalledWith(
                expect.stringContaining('⚠️  Remcli server unreachable')
            );
            consoleSpy.mockRestore();
        });
    });
});
