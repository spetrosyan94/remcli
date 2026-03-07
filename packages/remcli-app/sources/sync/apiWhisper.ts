/**
 * Whisper Transcription API Client
 *
 * Uploads audio to daemon's /v1/voice/transcribe endpoint for local Whisper STT.
 */

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

    const response = await fetch(`${serverUrl}/v1/voice/transcribe`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
        },
        body: formData,
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Transcription failed: ${response.status}`);
    }

    return await response.json();
}
