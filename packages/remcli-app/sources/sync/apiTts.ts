/**
 * TTS API client for daemon communication
 *
 * Provides methods to check TTS availability and synthesize speech.
 * Only works in P2P mode — daemon must have TTS configured.
 */

import { TokenStorage } from '@/auth/tokenStorage';
import { getServerUrl } from './serverConfig';

export interface TtsStatusResponse {
    available: boolean;
    provider: string;
    voices: string[];
}

export async function getTtsStatus(): Promise<TtsStatusResponse> {
    const serverUrl = getServerUrl();
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) throw new Error('Not authenticated');

    const response = await fetch(`${serverUrl}/v1/tts/status`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
        },
    });

    if (!response.ok) {
        throw new Error(`TTS status check failed: ${response.status}`);
    }

    return response.json();
}

export async function synthesizeSpeech(
    text: string,
    options?: { voice?: string; lang?: string; signal?: AbortSignal }
): Promise<ArrayBuffer> {
    const serverUrl = getServerUrl();
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) throw new Error('Not authenticated');

    const response = await fetch(`${serverUrl}/v1/voice/synthesize`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${credentials.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            text,
            voice: options?.voice,
            lang: options?.lang,
        }),
        signal: options?.signal,
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as Record<string, string>).error || `Synthesis failed: ${response.status}`);
    }

    return response.arrayBuffer();
}
