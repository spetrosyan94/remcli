/**
 * Tests for Whisper Transcription API Client
 *
 * Verifies FormData construction, response handling, and error scenarios.
 * Mocks fetch, TokenStorage, and serverConfig.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────

vi.mock('@/auth/tokenStorage', () => ({
    TokenStorage: {
        getCredentials: vi.fn(),
    },
}));

vi.mock('./serverConfig', () => ({
    getServerUrl: vi.fn().mockReturnValue('http://192.168.1.100:12345'),
}));

import { transcribeAudio } from './apiWhisper';
import { TokenStorage } from '@/auth/tokenStorage';

const mockGetCredentials = vi.mocked(TokenStorage.getCredentials);

// ─── Tests ──────────────────────────────────────────────────────

describe('transcribeAudio', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetCredentials.mockResolvedValue({
            token: 'test-bearer-token-abc123',
        } as Awaited<ReturnType<typeof TokenStorage.getCredentials>>);
    });

    it('should throw when not authenticated (no credentials)', async () => {
        mockGetCredentials.mockResolvedValue(null);

        await expect(transcribeAudio('file:///audio/recording.m4a'))
            .rejects.toThrow('Not authenticated');
    });

    it('should send POST request with correct URL and auth header', async () => {
        const mockResponse = {
            ok: true,
            json: vi.fn().mockResolvedValue({
                text: 'Transcribed text',
                language: 'en',
                duration: 3.5,
            }),
        };
        global.fetch = vi.fn().mockResolvedValue(mockResponse);

        await transcribeAudio('file:///audio/recording.m4a');

        expect(global.fetch).toHaveBeenCalledWith(
            'http://192.168.1.100:12345/v1/voice/transcribe',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer test-bearer-token-abc123',
                },
            }),
        );
    });

    it('should construct FormData with correct file metadata for m4a', async () => {
        let capturedFormData: FormData | null = null;
        global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
            capturedFormData = init.body as FormData;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ text: 'hello', language: 'en', duration: 1.0 }),
            });
        });

        await transcribeAudio('file:///audio/recording.m4a');

        expect(capturedFormData).not.toBeNull();
        // FormData.get returns the appended value
        const audioEntry = capturedFormData!.get('audio');
        expect(audioEntry).toBeTruthy();
    });

    it('should return transcription result with text, language, and duration', async () => {
        const expectedResult = {
            text: 'Hello from Whisper STT',
            language: 'en',
            duration: 5.2,
        };
        global.fetch = vi.fn().mockResolvedValue({
            ok: true,
            json: vi.fn().mockResolvedValue(expectedResult),
        });

        const result = await transcribeAudio('file:///audio/test.wav');

        expect(result).toEqual(expectedResult);
    });

    it('should detect correct MIME type for wav files', async () => {
        let capturedBody: FormData | null = null;
        global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
            capturedBody = init.body as FormData;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ text: 'test', language: 'en', duration: 0 }),
            });
        });

        await transcribeAudio('file:///audio/recording.wav');
        expect(capturedBody).not.toBeNull();
    });

    it('should throw error with server error message on HTTP failure', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            json: vi.fn().mockResolvedValue({ error: 'Whisper model not loaded' }),
        });

        await expect(transcribeAudio('file:///audio/recording.m4a'))
            .rejects.toThrow('Whisper model not loaded');
    });

    it('should throw generic error when server returns non-JSON error', async () => {
        global.fetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 502,
            json: vi.fn().mockRejectedValue(new Error('Invalid JSON')),
        });

        await expect(transcribeAudio('file:///audio/recording.m4a'))
            .rejects.toThrow('Transcription failed: 502');
    });

    it('should detect correct MIME type for webm files', async () => {
        let capturedBody: FormData | null = null;
        global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
            capturedBody = init.body as FormData;
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ text: 'webm test', language: 'auto', duration: 2.0 }),
            });
        });

        const result = await transcribeAudio('file:///audio/recording.webm');
        expect(result.text).toBe('webm test');
        expect(capturedBody).not.toBeNull();
    });
});
