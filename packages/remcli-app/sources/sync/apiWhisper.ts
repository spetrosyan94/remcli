/**
 * Whisper Transcription API Client
 *
 * Uploads audio to daemon's /v1/voice/transcribe endpoint for local Whisper STT.
 */

import { Platform } from 'react-native';
import { TokenStorage } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';

export interface WhisperTranscriptionResult {
    text: string;
    language: string;
    duration: number;
}

export async function transcribeAudio(audioUri: string): Promise<WhisperTranscriptionResult> {
    const serverUrl = getServerUrl();
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) {
        throw new Error('Not authenticated');
    }

    const formData = new FormData();

    if (Platform.OS === 'web') {
        // On web, audioUri is a blob URL (blob:https://...) — fetch the actual Blob
        const response = await fetch(audioUri);
        const blob = await response.blob();
        URL.revokeObjectURL(audioUri);
        const ext = blob.type.includes('webm') ? 'webm' : blob.type.includes('wav') ? 'wav' : 'mp4';
        formData.append('audio', blob, `recording.${ext}`);
    } else {
        // React Native fetch handles file:// URIs natively via FormData
        const fileExtension = audioUri.split('.').pop() || 'm4a';
        const mimeType = fileExtension === 'wav' ? 'audio/wav'
            : fileExtension === 'webm' ? 'audio/webm'
            : 'audio/mp4';

        formData.append('audio', {
            uri: audioUri,
            name: `recording.${fileExtension}`,
            type: mimeType,
        } as unknown as Blob);
    }

    const result = await fetch(`${serverUrl}/v1/voice/transcribe`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
        },
        body: formData,
    });

    if (!result.ok) {
        const body = await result.json().catch(() => ({}));
        throw new Error(body.error || `Transcription failed: ${result.status}`);
    }

    return await result.json();
}
