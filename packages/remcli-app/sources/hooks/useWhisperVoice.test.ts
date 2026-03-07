/**
 * Tests for useWhisperVoice hook
 *
 * Validates the state machine: idle -> recording -> transcribing -> idle.
 * Tests startWhisper, stopWhisper, cancelWhisper flows including
 * error handling, empty transcription, and displayText with voice emoji.
 *
 * Uses a minimal renderHook with proper async act support.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { act, create } from 'react-test-renderer';

// ─── Mocks ──────────────────────────────────────────────────────

const mockStartRecording = vi.fn();
const mockStopRecording = vi.fn();
const mockTranscribeAudio = vi.fn();
const mockSendMessage = vi.fn();
const mockAlert = vi.fn();

vi.mock('@/voice/whisperRecorder', () => ({
    startRecording: (...args: unknown[]) => mockStartRecording(...args),
    stopRecording: (...args: unknown[]) => mockStopRecording(...args),
}));

vi.mock('@/sync/apiWhisper', () => ({
    transcribeAudio: (...args: unknown[]) => mockTranscribeAudio(...args),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    },
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: (...args: unknown[]) => mockAlert(...args),
    },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

// ─── Import after mocks ─────────────────────────────────────────

import { useWhisperVoice, WhisperState } from './useWhisperVoice';

// ─── Helpers ────────────────────────────────────────────────────

interface HookResult {
    whisperState: WhisperState;
    startWhisper: () => Promise<void>;
    stopWhisper: (sessionId: string) => Promise<void>;
    cancelWhisper: () => Promise<void>;
}

function renderHook() {
    const ref: { current: HookResult | null } = { current: null };

    function TestComponent() {
        const hook = useWhisperVoice();
        ref.current = hook;
        return null;
    }

    let renderer: ReturnType<typeof create>;
    act(() => {
        renderer = create(React.createElement(TestComponent));
    });

    return {
        get result() { return ref as { current: HookResult }; },
        unmount() { act(() => { renderer.unmount(); }); },
    };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('useWhisperVoice', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockStartRecording.mockResolvedValue(true);
        mockStopRecording.mockResolvedValue('file:///audio/recording.m4a');
        mockTranscribeAudio.mockResolvedValue({
            text: 'Transcribed speech',
            language: 'en',
            duration: 2.5,
        });
    });

    it('should start in idle state', () => {
        const { result } = renderHook();
        expect(result.current.whisperState).toBe('idle');
    });

    it('should transition to recording state after startWhisper', async () => {
        const { result } = renderHook();

        await act(async () => {
            await result.current.startWhisper();
        });

        expect(result.current.whisperState).toBe('recording');
        expect(mockStartRecording).toHaveBeenCalledOnce();
    });

    it('should stay idle if startRecording returns false', async () => {
        mockStartRecording.mockResolvedValue(false);
        const { result } = renderHook();

        await act(async () => {
            await result.current.startWhisper();
        });

        expect(result.current.whisperState).toBe('idle');
    });

    it('should not start recording if already recording', async () => {
        const { result } = renderHook();

        await act(async () => {
            await result.current.startWhisper();
        });
        expect(result.current.whisperState).toBe('recording');

        await act(async () => {
            await result.current.startWhisper();
        });

        expect(mockStartRecording).toHaveBeenCalledOnce();
    });

    it('should complete full flow: recording -> transcribing -> idle with sendMessage', async () => {
        const { result } = renderHook();

        await act(async () => {
            await result.current.startWhisper();
        });
        expect(result.current.whisperState).toBe('recording');

        await act(async () => {
            await result.current.stopWhisper('session-123');
        });

        expect(result.current.whisperState).toBe('idle');
        expect(mockStopRecording).toHaveBeenCalledOnce();
        expect(mockTranscribeAudio).toHaveBeenCalledWith('file:///audio/recording.m4a');
        expect(mockSendMessage).toHaveBeenCalledWith(
            'session-123',
            'Transcribed speech',
            '🎤 Transcribed speech',
        );
    });

    it('should show alert and return to idle when transcription is empty', async () => {
        mockTranscribeAudio.mockResolvedValue({
            text: '   ',
            language: 'en',
            duration: 1.0,
        });

        const { result } = renderHook();

        await act(async () => {
            await result.current.startWhisper();
        });

        await act(async () => {
            await result.current.stopWhisper('session-456');
        });

        expect(result.current.whisperState).toBe('idle');
        expect(mockAlert).toHaveBeenCalledWith('common.error', 'whisper.emptyTranscription');
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('should show alert and return to idle on transcription error', async () => {
        mockTranscribeAudio.mockRejectedValue(new Error('Whisper model not loaded'));

        const { result } = renderHook();

        await act(async () => {
            await result.current.startWhisper();
        });

        await act(async () => {
            await result.current.stopWhisper('session-789');
        });

        expect(result.current.whisperState).toBe('idle');
        expect(mockAlert).toHaveBeenCalledWith('common.error', 'Whisper model not loaded');
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('should show generic error message for non-Error exceptions', async () => {
        mockTranscribeAudio.mockRejectedValue('unexpected string error');

        const { result } = renderHook();

        await act(async () => {
            await result.current.startWhisper();
        });

        await act(async () => {
            await result.current.stopWhisper('session-abc');
        });

        expect(result.current.whisperState).toBe('idle');
        expect(mockAlert).toHaveBeenCalledWith('common.error', 'whisper.transcriptionFailed');
    });

    it('should return to idle when stopRecording returns null', async () => {
        mockStopRecording.mockResolvedValue(null);

        const { result } = renderHook();

        await act(async () => {
            await result.current.startWhisper();
        });

        await act(async () => {
            await result.current.stopWhisper('session-null');
        });

        expect(result.current.whisperState).toBe('idle');
        expect(mockTranscribeAudio).not.toHaveBeenCalled();
        expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('should cancel recording and return to idle', async () => {
        const { result } = renderHook();

        await act(async () => {
            await result.current.startWhisper();
        });
        expect(result.current.whisperState).toBe('recording');

        await act(async () => {
            await result.current.cancelWhisper();
        });

        expect(result.current.whisperState).toBe('idle');
        expect(mockStopRecording).toHaveBeenCalledOnce();
    });

    it('should handle cancel when already idle (no-op for stopRecording)', async () => {
        const { result } = renderHook();

        await act(async () => {
            await result.current.cancelWhisper();
        });

        expect(result.current.whisperState).toBe('idle');
        expect(mockStopRecording).not.toHaveBeenCalled();
    });

    it('should not call stopWhisper if state is not recording', async () => {
        const { result } = renderHook();

        await act(async () => {
            await result.current.stopWhisper('session-noop');
        });

        expect(mockStopRecording).not.toHaveBeenCalled();
        expect(mockTranscribeAudio).not.toHaveBeenCalled();
    });

    it('should pass displayText with microphone emoji to sendMessage', async () => {
        mockTranscribeAudio.mockResolvedValue({
            text: 'Voice command here',
            language: 'auto',
            duration: 4.0,
        });

        const { result } = renderHook();

        await act(async () => {
            await result.current.startWhisper();
        });

        await act(async () => {
            await result.current.stopWhisper('session-display');
        });

        expect(mockSendMessage).toHaveBeenCalledWith(
            'session-display',
            'Voice command here',
            '🎤 Voice command here',
        );
    });
});
