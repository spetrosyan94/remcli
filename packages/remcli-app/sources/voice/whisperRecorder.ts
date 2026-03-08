/**
 * Whisper Audio Recorder
 *
 * Records audio using expo-audio for later upload to daemon's Whisper STT endpoint.
 * Module-level state (not a hook) so it can be called from anywhere.
 * Format: m4a/AAC on native, webm on web — daemon handles conversion.
 */

import { Platform } from 'react-native';
import { AudioModule, RecordingPresets } from 'expo-audio';
import type { AudioRecorder } from 'expo-audio';
import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';

// ─── State ──────────────────────────────────────────────────────

let currentRecorder: AudioRecorder | null = null;
let recording = false;

// ─── Public API ─────────────────────────────────────────────────

export function isRecording(): boolean {
    return recording;
}

export async function startRecording(): Promise<boolean> {
    if (recording) return false;

    const permission = await requestMicrophonePermission();
    if (!permission.granted) {
        showMicrophonePermissionDeniedAlert(permission.canAskAgain, permission.insecureContext);
        return false;
    }

    try {
        if (Platform.OS !== 'web') {
            await AudioModule.setAudioModeAsync({
                allowsRecording: true,
                playsInSilentMode: true,
            });
        }

        const recorder = new AudioModule.AudioRecorder(RecordingPresets.HIGH_QUALITY);
        await recorder.prepareToRecordAsync();
        recorder.record();
        currentRecorder = recorder;
        recording = true;
        return true;
    } catch (error) {
        console.error('[WhisperRecorder] Failed to start recording:', error);
        currentRecorder = null;
        recording = false;
        return false;
    }
}

/**
 * Stops recording and returns the URI of the recorded audio file.
 * Returns null if no recording was active.
 */
export async function stopRecording(): Promise<string | null> {
    if (!recording || !currentRecorder) return null;

    try {
        await currentRecorder.stop();
        const uri = currentRecorder.uri;
        recording = false;
        currentRecorder = null;
        return uri;
    } catch (error) {
        console.error('[WhisperRecorder] Failed to stop recording:', error);
        recording = false;
        currentRecorder = null;
        return null;
    }
}
