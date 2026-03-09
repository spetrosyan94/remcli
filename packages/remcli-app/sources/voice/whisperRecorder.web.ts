/**
 * Whisper Audio Recorder — Web implementation
 *
 * Uses native browser MediaRecorder API instead of expo-audio (which exposes
 * AudioRecorderWeb, not AudioRecorder, on the web platform).
 * Records as webm/opus — daemon handles conversion for Whisper.
 */

import { requestMicrophonePermission, showMicrophonePermissionDeniedAlert } from '@/utils/microphonePermissions';

// ─── State ──────────────────────────────────────────────────────

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
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
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioChunks = [];

        // Prefer webm/opus, fall back to whatever the browser supports
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : MediaRecorder.isTypeSupported('audio/webm')
                ? 'audio/webm'
                : '';

        mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };
        mediaRecorder.start(250); // Collect data every 250ms
        recording = true;
        return true;
    } catch (error) {
        console.error('[WhisperRecorder.web] Failed to start recording:', error);
        cleanup();
        return false;
    }
}

/**
 * Stops recording and returns a blob URL of the recorded audio.
 * Returns null if no recording was active.
 */
export async function stopRecording(): Promise<string | null> {
    if (!recording || !mediaRecorder) return null;

    try {
        const blob = await new Promise<Blob>((resolve) => {
            mediaRecorder!.onstop = () => {
                const mimeType = mediaRecorder!.mimeType || 'audio/webm';
                resolve(new Blob(audioChunks, { type: mimeType }));
            };
            mediaRecorder!.stop();
        });

        // Stop all tracks to release the microphone
        mediaRecorder.stream.getTracks().forEach(track => track.stop());

        const url = URL.createObjectURL(blob);
        cleanup();
        return url;
    } catch (error) {
        console.error('[WhisperRecorder.web] Failed to stop recording:', error);
        cleanup();
        return null;
    }
}

function cleanup() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.stop(); } catch { /* already stopped */ }
        mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
    mediaRecorder = null;
    audioChunks = [];
    recording = false;
}
