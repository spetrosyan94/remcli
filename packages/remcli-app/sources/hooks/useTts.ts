/**
 * useTts hook — Text-to-Speech playback
 *
 * State machine: idle -> synthesizing -> playing -> idle
 *
 * Platform-specific audio playback:
 * - Web: HTMLAudioElement with blob URL
 * - Native (iOS/Android): expo-audio AudioPlayer with temp file via expo-file-system
 *
 * Includes an in-memory cache keyed by messageId (or text) to avoid re-synthesizing.
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
    const cacheRef = React.useRef<Map<string, ArrayBuffer>>(new Map());

    const updateState = React.useCallback((state: TtsState) => {
        stateRef.current = state;
        setTtsState(state);
    }, []);

    const stop = React.useCallback(async () => {
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
    const playOnWeb = React.useCallback(async (audioData: ArrayBuffer) => {
        const blob = new Blob([audioData], { type: 'audio/ogg' });
        const url = URL.createObjectURL(blob);

        const audio = new Audio(url);

        audioHandleRef.current = {
            stop: () => {
                audio.pause();
                audio.currentTime = 0;
                URL.revokeObjectURL(url);
            },
        };

        audio.onended = () => {
            URL.revokeObjectURL(url);
            audioHandleRef.current = null;
            updateState('idle');
        };
        audio.onerror = () => {
            URL.revokeObjectURL(url);
            audioHandleRef.current = null;
            updateState('idle');
        };

        await audio.play();
    }, [updateState]);

    // ─── Native playback via expo-audio + expo-file-system ──────
    const playOnNative = React.useCallback(async (audioData: ArrayBuffer) => {
        const { File, Paths } = await import('expo-file-system');
        const { AudioModule } = await import('expo-audio');

        // Write ArrayBuffer to a temp file using new expo-file-system API
        const bytes = new Uint8Array(audioData);
        const tempFile = new File(Paths.cache, `tts-${Date.now()}.ogg`);
        tempFile.create({ overwrite: true });
        tempFile.write(bytes);

        // Set audio mode for playback
        await AudioModule.setAudioModeAsync({
            playsInSilentMode: true,
        });

        // Create player and play
        const player = new AudioModule.AudioPlayer({ uri: tempFile.uri }, 500, false);

        audioHandleRef.current = {
            stop: () => {
                player.pause();
                player.remove();
                try { tempFile.delete(); } catch { /* ignore */ }
            },
        };

        player.addListener('playbackStatusUpdate', (status: { playing: boolean; currentTime: number; duration: number }) => {
            // Player finished when not playing and has progressed past 0
            if (!status.playing && status.currentTime > 0 && status.duration > 0 && status.currentTime >= status.duration - 0.1) {
                player.remove();
                audioHandleRef.current = null;
                updateState('idle');
                try { tempFile.delete(); } catch { /* ignore */ }
            }
        });

        player.play();
    }, [updateState]);

    const synthesize = React.useCallback(async (text: string, messageId?: string) => {
        if (stateRef.current !== 'idle') {
            await stop();
        }

        updateState('synthesizing');

        // Create abort controller for this synthesis request
        const controller = new AbortController();
        abortRef.current = controller;

        try {
            // Check cache
            const cacheKey = messageId || text;
            let audioData = cacheRef.current.get(cacheKey);

            if (!audioData) {
                audioData = await synthesizeSpeech(text, { signal: controller.signal });
                // LRU eviction: remove oldest entries when cache exceeds limit
                if (cacheRef.current.size >= TTS_CACHE_MAX_ENTRIES) {
                    const firstKey = cacheRef.current.keys().next().value;
                    if (firstKey !== undefined) {
                        cacheRef.current.delete(firstKey);
                    }
                }
                cacheRef.current.set(cacheKey, audioData);
            }

            if (stateRef.current !== 'synthesizing') return; // cancelled during fetch

            abortRef.current = null;
            updateState('playing');

            if (Platform.OS === 'web') {
                await playOnWeb(audioData);
            } else {
                await playOnNative(audioData);
            }
        } catch (error) {
            abortRef.current = null;
            audioHandleRef.current = null;
            // Don't throw on abort — it's intentional cancellation
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
            if (abortRef.current) {
                abortRef.current.abort();
            }
            if (audioHandleRef.current) {
                try {
                    audioHandleRef.current.stop();
                } catch { /* ignore */ }
            }
        };
    }, []);

    return { ttsState, synthesize, stop };
}
