/**
 * TTS (Text-to-Speech) for the web client.
 *
 * useTts state machine: idle -> synthesizing -> playing -> idle.
 * - Generation counter: stale callbacks of cancelled requests cannot
 *   overwrite state of a newer synthesize() call.
 * - AbortController: stop / switching messages aborts the HTTP request,
 *   so the daemon stops generating.
 * - In-memory LRU cache (20 entries) keyed by messageId (or text).
 * - `lang` = current UI language, `voice` = user pick from SettingsPage.
 *
 * Also exposes useTtsAvailability (GET /v1/tts/status) and the persisted
 * voice / auto-speak settings shared with SettingsPage.
 */

import * as React from 'react';
import { getCurrentLanguage } from '@/lib/i18n';
import { fetchTtsStatus, getRestConfig, synthesizeSpeech, type TtsStatus } from '@/lib/protocol';

export type TtsState = 'idle' | 'synthesizing' | 'playing';

const TTS_CACHE_MAX_ENTRIES = 20;
const VOICE_STORAGE_KEY = 'remcli-tts-voice';
const AUTO_SPEAK_STORAGE_KEY = 'remcli-tts-autospeak';

// ─── Persisted voice settings (SettingsPage <-> chat) ────────────

export function getStoredTtsVoice(): string | null {
    return localStorage.getItem(VOICE_STORAGE_KEY);
}

export function setStoredTtsVoice(voice: string | null): void {
    if (voice) {
        localStorage.setItem(VOICE_STORAGE_KEY, voice);
    } else {
        localStorage.removeItem(VOICE_STORAGE_KEY);
    }
}

export function getAutoSpeakEnabled(): boolean {
    return localStorage.getItem(AUTO_SPEAK_STORAGE_KEY) === '1';
}

export function setAutoSpeakEnabled(isEnabled: boolean): void {
    if (isEnabled) {
        localStorage.setItem(AUTO_SPEAK_STORAGE_KEY, '1');
    } else {
        localStorage.removeItem(AUTO_SPEAK_STORAGE_KEY);
    }
}

// ─── useTts ──────────────────────────────────────────────────────

interface AudioHandle {
    stop: () => void;
}

export interface UseTtsResult {
    ttsState: TtsState;
    /** messageId (или текст) активного synthesize() — для подсветки нужной кнопки. */
    activeId: string | null;
    synthesize: (text: string, messageId?: string) => Promise<void>;
    stop: () => void;
}

export function useTts(): UseTtsResult {
    const [ttsState, setTtsState] = React.useState<TtsState>('idle');
    const [activeId, setActiveId] = React.useState<string | null>(null);
    const stateRef = React.useRef<TtsState>('idle');
    const audioHandleRef = React.useRef<AudioHandle | null>(null);
    const abortRef = React.useRef<AbortController | null>(null);
    const generationRef = React.useRef(0);
    const cacheRef = React.useRef<Map<string, ArrayBuffer>>(new Map());

    const updateState = React.useCallback((state: TtsState, id: string | null) => {
        stateRef.current = state;
        setTtsState(state);
        setActiveId(id);
    }, []);

    const stop = React.useCallback(() => {
        // Increment generation so any in-flight synthesize() becomes stale
        generationRef.current++;
        // Abort any in-flight HTTP synthesis request
        if (abortRef.current) {
            abortRef.current.abort();
            abortRef.current = null;
        }
        // Stop audio playback
        if (audioHandleRef.current) {
            try {
                audioHandleRef.current.stop();
            } catch { /* ignore cleanup errors */ }
            audioHandleRef.current = null;
        }
        updateState('idle', null);
    }, [updateState]);

    const play = React.useCallback(async (audioData: ArrayBuffer, gen: number) => {
        const blob = new Blob([audioData], { type: 'audio/ogg' });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);

        const cleanup = () => {
            audio.onended = null;
            audio.onerror = null;
            audio.pause();
            audio.currentTime = 0;
            URL.revokeObjectURL(url);
        };

        audioHandleRef.current = { stop: cleanup };

        const finish = () => {
            cleanup();
            audioHandleRef.current = null;
            if (generationRef.current === gen) updateState('idle', null);
        };
        audio.onended = finish;
        audio.onerror = finish;

        await audio.play();
    }, [updateState]);

    const synthesize = React.useCallback(async (text: string, messageId?: string) => {
        if (stateRef.current !== 'idle') {
            stop();
        }

        const config = getRestConfig();
        if (!config) {
            throw new Error('Not connected to the daemon');
        }

        const cacheKey = messageId || text;
        const gen = ++generationRef.current;
        updateState('synthesizing', cacheKey);

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            let audioData = cacheRef.current.get(cacheKey);

            if (!audioData) {
                audioData = await synthesizeSpeech(config, text, {
                    voice: getStoredTtsVoice() ?? undefined,
                    lang: getCurrentLanguage(),
                    signal: controller.signal
                });
                // LRU eviction
                if (cacheRef.current.size >= TTS_CACHE_MAX_ENTRIES) {
                    const firstKey = cacheRef.current.keys().next().value;
                    if (firstKey !== undefined) cacheRef.current.delete(firstKey);
                }
                cacheRef.current.set(cacheKey, audioData);
            }

            // Stale check: another synthesize()/stop() happened while fetching
            if (generationRef.current !== gen) return;

            abortRef.current = null;
            updateState('playing', cacheKey);
            await play(audioData, gen);
        } catch (error) {
            // Stale: don't touch state if a newer request is already running
            if (generationRef.current !== gen) return;
            abortRef.current = null;
            if (audioHandleRef.current) {
                try { audioHandleRef.current.stop(); } catch { /* ignore */ }
                audioHandleRef.current = null;
            }
            updateState('idle', null);
            // AbortError is intentional cancellation — don't rethrow
            if (error instanceof DOMException && error.name === 'AbortError') {
                return;
            }
            throw error;
        }
    }, [stop, updateState, play]);

    // Cleanup on unmount
    React.useEffect(() => {
        return () => {
            generationRef.current++;
            if (abortRef.current) abortRef.current.abort();
            if (audioHandleRef.current) {
                try { audioHandleRef.current.stop(); } catch { /* ignore */ }
            }
        };
    }, []);

    return { ttsState, activeId, synthesize, stop };
}

// ─── useTtsAvailability ──────────────────────────────────────────

export interface TtsAvailability {
    /** null пока статус не загружен (или нет подключения). */
    status: TtsStatus | null;
    isChecking: boolean;
    refresh: () => void;
}

/** Проверяет GET /v1/tts/status при монтировании (только при активном подключении). */
export function useTtsAvailability(): TtsAvailability {
    const [status, setStatus] = React.useState<TtsStatus | null>(null);
    const [isChecking, setIsChecking] = React.useState(false);
    const [refreshToken, setRefreshToken] = React.useState(0);

    React.useEffect(() => {
        const config = getRestConfig();
        if (!config) {
            setStatus(null);
            return;
        }
        let isCancelled = false;
        setIsChecking(true);
        fetchTtsStatus(config)
            .then((next) => { if (!isCancelled) setStatus(next); })
            .catch(() => { if (!isCancelled) setStatus(null); })
            .finally(() => { if (!isCancelled) setIsChecking(false); });
        return () => { isCancelled = true; };
    }, [refreshToken]);

    const refresh = React.useCallback(() => setRefreshToken((token) => token + 1), []);

    return { status, isChecking, refresh };
}
