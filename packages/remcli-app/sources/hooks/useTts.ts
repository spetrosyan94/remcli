/**
 * useTts hook — Text-to-Speech playback
 *
 * State machine: idle -> synthesizing -> playing -> idle
 *
 * Uses a generation counter to prevent race conditions when switching
 * between messages (press A, then B while A is still synthesizing).
 * Each synthesize() call increments the generation — stale callbacks
 * from cancelled requests cannot overwrite state of newer requests.
 *
 * Platform-specific audio playback:
 * - Web: HTMLAudioElement with blob URL
 * - Native (iOS/Android): expo-audio AudioPlayer with temp file via expo-file-system
 *
 * Includes an in-memory cache keyed by messageId (or text) to avoid re-synthesizing.
 * Cache is LRU-evicted at 20 entries.
 */

import * as React from 'react';
import { Platform } from 'react-native';
import { synthesizeSpeech } from '@/sync/apiTts';

export type TtsState = 'idle' | 'synthesizing' | 'playing';

interface AudioHandle {
    stop: () => void;
}

const TTS_CACHE_MAX_ENTRIES = 20;

export function useTts() {
    const [ttsState, setTtsState] = React.useState<TtsState>('idle');
    const stateRef = React.useRef<TtsState>('idle');
    const audioHandleRef = React.useRef<AudioHandle | null>(null);
    const abortRef = React.useRef<AbortController | null>(null);
    const generationRef = React.useRef(0);
    const cacheRef = React.useRef<Map<string, ArrayBuffer>>(new Map());

    const updateState = React.useCallback((state: TtsState) => {
        stateRef.current = state;
        setTtsState(state);
    }, []);

    const stop = React.useCallback(async () => {
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
        updateState('idle');
    }, [updateState]);

    // ─── Web playback via HTMLAudioElement ───────────────────────
    const playOnWeb = React.useCallback(async (audioData: ArrayBuffer, gen: number) => {
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

        audio.onended = () => {
            cleanup();
            audioHandleRef.current = null;
            if (generationRef.current === gen) updateState('idle');
        };
        audio.onerror = () => {
            cleanup();
            audioHandleRef.current = null;
            if (generationRef.current === gen) updateState('idle');
        };

        await audio.play();
    }, [updateState]);

    // ─── Native playback via expo-audio + expo-file-system ──────
    const playOnNative = React.useCallback(async (audioData: ArrayBuffer, gen: number) => {
        const { File, Paths } = await import('expo-file-system');
        const { AudioModule } = await import('expo-audio');

        const bytes = new Uint8Array(audioData);
        const tempFile = new File(Paths.cache, `tts-${Date.now()}.ogg`);
        tempFile.create({ overwrite: true });
        tempFile.write(bytes);

        await AudioModule.setAudioModeAsync({ playsInSilentMode: true });

        const player = new AudioModule.AudioPlayer({ uri: tempFile.uri }, 500, false);

        audioHandleRef.current = {
            stop: () => {
                player.pause();
                player.remove();
                try { tempFile.delete(); } catch { /* ignore */ }
            },
        };

        player.addListener('playbackStatusUpdate', (status: { playing: boolean; currentTime: number; duration: number }) => {
            if (!status.playing && status.currentTime > 0 && status.duration > 0 && status.currentTime >= status.duration - 0.1) {
                player.remove();
                audioHandleRef.current = null;
                if (generationRef.current === gen) updateState('idle');
                try { tempFile.delete(); } catch { /* ignore */ }
            }
        });

        player.play();
    }, [updateState]);

    const synthesize = React.useCallback(async (text: string, messageId?: string) => {
        if (stateRef.current !== 'idle') {
            await stop();
        }

        const gen = ++generationRef.current;
        updateState('synthesizing');

        const controller = new AbortController();
        abortRef.current = controller;

        try {
            // Check cache
            const cacheKey = messageId || text;
            let audioData = cacheRef.current.get(cacheKey);

            if (!audioData) {
                audioData = await synthesizeSpeech(text, { signal: controller.signal });
                // LRU eviction
                if (cacheRef.current.size >= TTS_CACHE_MAX_ENTRIES) {
                    const firstKey = cacheRef.current.keys().next().value;
                    if (firstKey !== undefined) cacheRef.current.delete(firstKey);
                }
                cacheRef.current.set(cacheKey, audioData);
            }

            // Stale check: another synthesize() was called while we were fetching
            if (generationRef.current !== gen) return;

            abortRef.current = null;
            updateState('playing');

            if (Platform.OS === 'web') {
                await playOnWeb(audioData, gen);
            } else {
                await playOnNative(audioData, gen);
            }
        } catch (error) {
            // Stale: don't touch state if a newer request is already running
            if (generationRef.current !== gen) return;
            abortRef.current = null;
            // Stop audio player if it was created before the error
            if (audioHandleRef.current) {
                try { audioHandleRef.current.stop(); } catch { /* ignore */ }
            }
            audioHandleRef.current = null;
            // AbortError is intentional cancellation — don't rethrow
            if (error instanceof DOMException && error.name === 'AbortError') {
                updateState('idle');
                return;
            }
            updateState('idle');
            throw error;
        }
    }, [stop, updateState, playOnWeb, playOnNative]);

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

    return { ttsState, synthesize, stop };
}
