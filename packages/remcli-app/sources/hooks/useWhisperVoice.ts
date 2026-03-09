/**
 * useWhisperVoice hook
 *
 * Combines audio recording, Whisper transcription, and message sending into one flow.
 * States: idle -> recording -> transcribing -> idle.
 * On success, sends the transcribed text as a message to the active Claude session.
 * On error, shows a modal alert. Does not throw.
 * Uses ref for state guards to avoid stale closure issues.
 */

import * as React from 'react';
import { startRecording, stopRecording } from '@/voice/whisperRecorder';
import { transcribeAudio } from '@/sync/apiWhisper';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { t } from '@/text';

export type WhisperState = 'idle' | 'recording' | 'transcribing';

export function useWhisperVoice() {
    const [state, setState] = React.useState<WhisperState>('idle');
    const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
    const stateRef = React.useRef<WhisperState>('idle');
    const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);

    const clearTimer = React.useCallback(() => {
        if (timerRef.current !== null) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        setElapsedSeconds(0);
    }, []);

    const setWhisperState = React.useCallback((newState: WhisperState) => {
        stateRef.current = newState;
        setState(newState);
    }, []);

    const start = React.useCallback(async () => {
        if (stateRef.current !== 'idle') return;

        const started = await startRecording();
        if (started) {
            setWhisperState('recording');
            setElapsedSeconds(0);
            timerRef.current = setInterval(() => {
                setElapsedSeconds(prev => prev + 1);
            }, 1000);
        }
    }, [setWhisperState]);

    const stop = React.useCallback(async (sessionId: string) => {
        if (stateRef.current !== 'recording') return;

        clearTimer();
        setWhisperState('transcribing');

        try {
            const uri = await stopRecording();
            if (!uri) {
                setWhisperState('idle');
                return;
            }

            const result = await transcribeAudio(uri);

            // Filter blank/empty transcriptions — Whisper outputs these on silence
            const cleaned = result.text
                .replace(/\[BLANK_AUDIO\]/gi, '')
                .replace(/\[[^\]]*\]/g, '')
                .trim();

            if (!cleaned) {
                Modal.alert(t('whisper.noSpeechTitle'), t('whisper.noSpeechDetected'));
                setWhisperState('idle');
                return;
            }

            sync.sendMessage(sessionId, cleaned, `🎤 ${cleaned}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : t('whisper.transcriptionFailed');
            Modal.alert(t('common.error'), message);
        } finally {
            setWhisperState('idle');
        }
    }, [setWhisperState, clearTimer]);

    const cancel = React.useCallback(async () => {
        clearTimer();
        if (stateRef.current === 'recording') {
            await stopRecording();
        }
        setWhisperState('idle');
    }, [setWhisperState, clearTimer]);

    // Cleanup timer on unmount
    React.useEffect(() => {
        return () => {
            if (timerRef.current !== null) {
                clearInterval(timerRef.current);
            }
        };
    }, []);

    return { whisperState: state, elapsedSeconds, startWhisper: start, stopWhisper: stop, cancelWhisper: cancel };
}
