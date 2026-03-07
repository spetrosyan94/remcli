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
    const stateRef = React.useRef<WhisperState>('idle');

    const setWhisperState = React.useCallback((newState: WhisperState) => {
        stateRef.current = newState;
        setState(newState);
    }, []);

    const start = React.useCallback(async () => {
        if (stateRef.current !== 'idle') return;

        const started = await startRecording();
        if (started) {
            setWhisperState('recording');
        }
    }, [setWhisperState]);

    const stop = React.useCallback(async (sessionId: string) => {
        if (stateRef.current !== 'recording') return;

        setWhisperState('transcribing');

        try {
            const uri = await stopRecording();
            if (!uri) {
                setWhisperState('idle');
                return;
            }

            const result = await transcribeAudio(uri);

            if (!result.text.trim()) {
                Modal.alert(t('common.error'), t('whisper.emptyTranscription'));
                setWhisperState('idle');
                return;
            }

            sync.sendMessage(sessionId, result.text, `🎤 ${result.text}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : t('whisper.transcriptionFailed');
            Modal.alert(t('common.error'), message);
        } finally {
            setWhisperState('idle');
        }
    }, [setWhisperState]);

    const cancel = React.useCallback(async () => {
        if (stateRef.current === 'recording') {
            await stopRecording();
        }
        setWhisperState('idle');
    }, [setWhisperState]);

    return { whisperState: state, startWhisper: start, stopWhisper: stop, cancelWhisper: cancel };
}
