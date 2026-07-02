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

// ─── Health / latency ────────────────────────────────────────────

/**
 * Daemon round-trip time: GET /health (no auth, lightweight) measured with
 * performance.now(). Returns whole milliseconds (min 1), null on failure —
 * the caller shows the connection pill without a latency suffix then.
 */
export async function measureHealthLatency(endpoint: string): Promise<number | null> {
    const startedAt = performance.now();
    try {
        const response = await fetch(`${endpoint}/health`, { cache: 'no-store' });
        if (!response.ok) return null;
        return Math.max(1, Math.round(performance.now() - startedAt));
    } catch {
        return null;
    }
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

export type DeleteMachineResult =
    | { ok: true }
    | { ok: false; status: number; error: string };

/**
 * Delete a machine on the daemon. 200 {ok:true} on success, 403 when the
 * machine is the daemon's own machine, 404 when unknown — 403/404 come back
 * as a typed result instead of throwing so the UI can explain each case.
 */
export async function deleteMachine(config: RestConfig, machineId: string): Promise<DeleteMachineResult> {
    const response = await request(config, `/v1/machines/${encodeURIComponent(machineId)}`, {
        method: 'DELETE'
    });
    if (response.ok) {
        return { ok: true };
    }
    const body = await response.json().catch(() => ({})) as { error?: string };
    return { ok: false, status: response.status, error: body.error || `Delete failed: ${response.status}` };
}

// ─── KV store ────────────────────────────────────────────────────
// Wire format mirrors remcli-app sources/sync/apiKv.ts (the daemon implements
// the same /v1/kv* contract): values are opaque strings, OCC via version
// numbers (-1 creates a key, mismatch → 409 with the current value).

export interface KvItem {
    key: string;
    value: string;
    version: number;
}

export interface KvMutation {
    key: string;
    value: string | null; // null deletes the key
    version: number;      // -1 for new keys
}

export interface KvMutateSuccess {
    success: true;
    results: Array<{ key: string; version: number }>;
}

export interface KvMutateConflict {
    success: false;
    errors: Array<{ key: string; error: 'version-mismatch'; version: number; value: string | null }>;
}

export type KvMutateResponse = KvMutateSuccess | KvMutateConflict;

/** Single KV value; null when the key does not exist (404). */
export async function kvGet(config: RestConfig, key: string): Promise<KvItem | null> {
    const response = await request(config, `/v1/kv/${encodeURIComponent(key)}`);
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `KV get failed: ${response.status} ${key}`);
    }
    return await response.json() as KvItem;
}

/** OCC mutate: a 409 returns `{ success: false, errors }` instead of throwing. */
export async function kvMutate(config: RestConfig, mutations: KvMutation[]): Promise<KvMutateResponse> {
    const response = await request(config, '/v1/kv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mutations })
    });
    if (response.status === 409) {
        return await response.json() as KvMutateConflict;
    }
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `KV mutate failed: ${response.status}`);
    }
    return await response.json() as KvMutateSuccess;
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
    options?: { lang?: string; signal?: AbortSignal }
): Promise<ConciergeChatResponse> {
    return requestJson<ConciergeChatResponse>(config, '/v1/concierge/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, lang: options?.lang }),
        signal: options?.signal
    });
}
