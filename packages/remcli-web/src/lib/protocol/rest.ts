/**
 * Typed REST client for the daemon's P2P HTTP API — see docs/protocol.md and
 * packages/remcli-cli/src/daemon/p2p/p2pRestRoutes.ts. All endpoints require
 * `Authorization: Bearer <token>` (same token as the Socket.IO handshake).
 */

import type {
    ApiMachine,
    ApiMessage,
    ApiSession,
    ConciergeChatMessage,
    ConciergeChatResponse,
    ConciergeStatus,
    TtsStatus,
    WhisperStatus,
    WhisperTranscription
} from '@/lib/protocol/types';

export interface RestConfig {
    endpoint: string;
    token: string;
}

async function request(config: RestConfig, path: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(`${config.endpoint}${path}`, {
        ...init,
        headers: {
            'Authorization': `Bearer ${config.token}`,
            ...init?.headers
        }
    });
    return response;
}

async function requestJson<T>(config: RestConfig, path: string, init?: RequestInit): Promise<T> {
    const response = await request(config, path, init);
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `Request failed: ${response.status} ${path}`);
    }
    return await response.json() as T;
}

// ─── Sessions ────────────────────────────────────────────────────

export async function fetchSessions(config: RestConfig): Promise<ApiSession[]> {
    const data = await requestJson<{ sessions: ApiSession[] }>(config, '/v1/sessions');
    return data.sessions;
}

export async function fetchActiveSessions(config: RestConfig, limit = 150): Promise<ApiSession[]> {
    const data = await requestJson<{ sessions: ApiSession[] }>(config, `/v2/sessions/active?limit=${limit}`);
    return data.sessions;
}

export interface MessagesPage {
    messages: ApiMessage[];
    total: number;
    hasMore: boolean;
}

/** Messages are returned newest-first; offset skips the newest N. */
export async function fetchMessages(
    config: RestConfig,
    sessionId: string,
    options?: { limit?: number; offset?: number }
): Promise<MessagesPage> {
    const limit = options?.limit ?? 150;
    const offset = options?.offset ?? 0;
    return requestJson<MessagesPage>(
        config,
        `/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}&offset=${offset}`
    );
}

export async function deleteSession(config: RestConfig, sessionId: string): Promise<{ success: boolean }> {
    return requestJson<{ success: boolean }>(config, `/v1/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE'
    });
}

// ─── Machines ────────────────────────────────────────────────────

export async function fetchMachines(config: RestConfig): Promise<ApiMachine[]> {
    return requestJson<ApiMachine[]>(config, '/v1/machines');
}

export async function fetchMachine(config: RestConfig, machineId: string): Promise<ApiMachine> {
    const data = await requestJson<{ machine: ApiMachine }>(config, `/v1/machines/${encodeURIComponent(machineId)}`);
    return data.machine;
}

// ─── TTS ─────────────────────────────────────────────────────────

export async function fetchTtsStatus(config: RestConfig): Promise<TtsStatus> {
    return requestJson<TtsStatus>(config, '/v1/tts/status');
}

/**
 * Synthesize speech for a text. Returns OGG Opus audio bytes.
 * Pass an AbortSignal to cancel generation on the daemon side.
 */
export async function synthesizeSpeech(
    config: RestConfig,
    text: string,
    options?: { voice?: string; lang?: string; signal?: AbortSignal }
): Promise<ArrayBuffer> {
    const response = await request(config, '/v1/voice/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            text,
            voice: options?.voice,
            lang: options?.lang
        }),
        signal: options?.signal
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `Synthesis failed: ${response.status}`);
    }
    return response.arrayBuffer();
}

// ─── Whisper (STT) ───────────────────────────────────────────────

export async function fetchWhisperStatus(config: RestConfig): Promise<WhisperStatus> {
    return requestJson<WhisperStatus>(config, '/v1/whisper/status');
}

/** Transcribe a recorded audio blob (multipart field "audio"). */
export async function transcribeAudio(config: RestConfig, audio: Blob): Promise<WhisperTranscription> {
    const ext = audio.type.includes('webm') ? 'webm' : audio.type.includes('wav') ? 'wav' : 'mp4';
    const formData = new FormData();
    formData.append('audio', audio, `recording.${ext}`);

    const response = await request(config, '/v1/voice/transcribe', {
        method: 'POST',
        body: formData
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `Transcription failed: ${response.status}`);
    }
    return await response.json() as WhisperTranscription;
}

// ─── Concierge ───────────────────────────────────────────────────

export async function fetchConciergeStatus(config: RestConfig): Promise<ConciergeStatus> {
    return requestJson<ConciergeStatus>(config, '/v1/concierge/status');
}

export async function conciergeChat(
    config: RestConfig,
    messages: ConciergeChatMessage[],
    options?: { signal?: AbortSignal }
): Promise<ConciergeChatResponse> {
    return requestJson<ConciergeChatResponse>(config, '/v1/concierge/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: options?.signal
    });
}
