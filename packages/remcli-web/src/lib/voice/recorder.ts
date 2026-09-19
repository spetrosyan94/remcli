/**
 * Voice recorder (Whisper STT) for the web client.
 *
 * MediaRecorder records webm/opus (daemon converts for Whisper), the blob is
 * sent to POST /v1/voice/transcribe. Microphone requires a secure context
 * (HTTPS/localhost) — on plain-HTTP LAN getUserMedia is unavailable and the
 * hook reports the 'error' state (VoiceRecordBar "микрофон недоступен").
 *
 * useVoiceRecorder states: idle -> recording -> transcribing -> idle | error.
 * stopAndTranscribe() resolves with the cleaned text (Whisper hallucination
 * markers like [BLANK_AUDIO] stripped) or null when nothing was recognized.
 */

import * as React from 'react';
import { getRestConfig, transcribeAudio } from '@/lib/protocol';

// ─── MediaRecorder (module-level, one recording at a time) ───────

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let isRecordingActive = false;
let isRecordingStartPending = false;
let recordingStartGeneration = 0;
let audioContext: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let audioSource: MediaStreamAudioSourceNode | null = null;

/** Converts analyser time-domain samples into a bounded RMS level. */
export function normalizeAnalyserLevel(samples: Uint8Array): number {
    if (samples.length === 0) return 0;

    let squaredTotal = 0;
    for (const sample of samples) {
        const centered = (sample - 128) / 128;
        squaredTotal += centered * centered;
    }
    return Math.min(1, Math.sqrt(squaredTotal / samples.length));
}

function disconnectAudioGraph(): void {
    try { audioSource?.disconnect(); } catch { /* already disconnected */ }
    try { analyser?.disconnect(); } catch { /* already disconnected */ }
    const context = audioContext;
    audioSource = null;
    analyser = null;
    audioContext = null;
    if (context) void context.close().catch(() => undefined);
}

function readRecordingLevel(): number {
    if (!analyser) return 0;
    const samples = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(samples);
    return normalizeAnalyserLevel(samples);
}

function connectAnalyser(stream: MediaStream): void {
    const AudioContextConstructor = window.AudioContext
        ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;

    try {
        audioContext = new AudioContextConstructor();
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        audioSource = audioContext.createMediaStreamSource(stream);
        audioSource.connect(analyser);
    } catch {
        disconnectAudioGraph();
    }
}

function cleanupRecorder(): void {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        try { mediaRecorder.stop(); } catch { /* already stopped */ }
    }
    mediaRecorder?.stream.getTracks().forEach((track) => track.stop());
    mediaRecorder = null;
    audioChunks = [];
    isRecordingActive = false;
    disconnectAudioGraph();
}

export async function startRecording(): Promise<boolean> {
    if (isRecordingActive || isRecordingStartPending) return false;
    if (!navigator.mediaDevices?.getUserMedia) return false; // insecure context

    const startGeneration = ++recordingStartGeneration;
    isRecordingStartPending = true;
    let stream: MediaStream | null = null;

    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (startGeneration !== recordingStartGeneration) {
            stream.getTracks().forEach((track) => track.stop());
            return false;
        }
        audioChunks = [];

        // Prefer webm/opus, fall back to whatever the browser supports
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
            ? 'audio/webm;codecs=opus'
            : MediaRecorder.isTypeSupported('audio/webm')
                ? 'audio/webm'
                : '';

        mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        connectAnalyser(stream);
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            }
        };
        mediaRecorder.start(250); // Collect data every 250ms
        isRecordingActive = true;
        return true;
    } catch {
        if (!mediaRecorder) stream?.getTracks().forEach((track) => track.stop());
        if (startGeneration === recordingStartGeneration) cleanupRecorder();
        return false;
    } finally {
        if (startGeneration === recordingStartGeneration) isRecordingStartPending = false;
    }
}

/** Stops recording and returns the recorded audio blob (null if not recording). */
export async function stopRecording(): Promise<Blob | null> {
    if (!isRecordingActive || !mediaRecorder) return null;

    const recorder = mediaRecorder;
    try {
        const blob = await new Promise<Blob>((resolve) => {
            recorder.onstop = () => {
                resolve(new Blob(audioChunks, { type: recorder.mimeType || 'audio/webm' }));
            };
            recorder.stop();
        });
        cleanupRecorder();
        return blob;
    } catch {
        cleanupRecorder();
        return null;
    }
}

export function cancelRecording(): void {
    recordingStartGeneration += 1;
    isRecordingStartPending = false;
    cleanupRecorder();
}

// ─── Transcription cleanup ───────────────────────────────────────

/** Strips Whisper silence hallucinations ([BLANK_AUDIO] и подобные маркеры). */
export function cleanTranscription(text: string): string {
    return text
        .replace(/\[BLANK_AUDIO\]/gi, '')
        .replace(/\[[^\]]*\]/g, '')
        .trim();
}

// ─── useVoiceRecorder ────────────────────────────────────────────

export type VoiceRecorderState = 'idle' | 'recording' | 'transcribing' | 'error';

export interface UseVoiceRecorderResult {
    recorderState: VoiceRecorderState;
    /** Секунды с начала записи (для таймера VoiceRecordBar). */
    elapsedSeconds: number;
    /** Нормализованный RMS-уровень микрофона (0..1) во время записи. */
    level: number;
    /** Запуск записи; 'error' если микрофон недоступен. */
    start: () => Promise<void>;
    /** Стоп + POST /v1/voice/transcribe; текст или null (тишина/ошибка → 'error'). */
    stopAndTranscribe: () => Promise<string | null>;
    /** Отмена записи/распознавания без результата. */
    cancel: () => void;
    /** Сброс 'error' → 'idle' (кнопка «повторить»). */
    reset: () => void;
}

export function useVoiceRecorder(): UseVoiceRecorderResult {
    const [recorderState, setRecorderState] = React.useState<VoiceRecorderState>('idle');
    const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
    const [level, setLevel] = React.useState(0);
    const stateRef = React.useRef<VoiceRecorderState>('idle');
    const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
    const levelFrameRef = React.useRef<number | null>(null);

    const updateState = React.useCallback((state: VoiceRecorderState) => {
        stateRef.current = state;
        setRecorderState(state);
    }, []);

    // Отдельный getter: TS сужает stateRef.current после ранних return,
    // не зная что updateState() его мутирует
    const readState = React.useCallback((): VoiceRecorderState => stateRef.current, []);

    const clearTimer = React.useCallback(() => {
        if (timerRef.current !== null) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        setElapsedSeconds(0);
    }, []);

    const start = React.useCallback(async () => {
        if (stateRef.current !== 'idle') return;

        const isStarted = await startRecording();
        if (!isStarted) {
            updateState('error');
            return;
        }
        updateState('recording');
        setElapsedSeconds(0);
        setLevel(0);
        timerRef.current = setInterval(() => {
            setElapsedSeconds((previous) => previous + 1);
        }, 1000);
    }, [updateState]);

    const stopAndTranscribe = React.useCallback(async (): Promise<string | null> => {
        if (stateRef.current !== 'recording') return null;

        clearTimer();
        setLevel(0);
        updateState('transcribing');

        try {
            const blob = await stopRecording();
            if (!blob) {
                updateState('idle');
                return null;
            }

            const config = getRestConfig();
            if (!config) {
                throw new Error('Not connected to the daemon');
            }

            const result = await transcribeAudio(config, blob);
            // Cancelled while transcribing — drop the result
            if (readState() !== 'transcribing') return null;

            updateState('idle');
            const cleaned = cleanTranscription(result.text);
            return cleaned || null;
        } catch {
            if (readState() === 'transcribing') updateState('error');
            return null;
        }
    }, [updateState, clearTimer, readState]);

    const cancel = React.useCallback(() => {
        clearTimer();
        setLevel(0);
        cancelRecording();
        updateState('idle');
    }, [updateState, clearTimer]);

    const reset = React.useCallback(() => {
        if (stateRef.current === 'error') updateState('idle');
    }, [updateState]);

    React.useEffect(() => {
        if (recorderState !== 'recording' || typeof window === 'undefined') return;

        const updateLevel = () => {
            setLevel(readRecordingLevel());
            levelFrameRef.current = window.requestAnimationFrame(updateLevel);
        };
        levelFrameRef.current = window.requestAnimationFrame(updateLevel);

        return () => {
            if (levelFrameRef.current !== null) {
                window.cancelAnimationFrame(levelFrameRef.current);
                levelFrameRef.current = null;
            }
        };
    }, [recorderState]);

    // Cleanup on unmount
    React.useEffect(() => {
        return () => {
            if (timerRef.current !== null) clearInterval(timerRef.current);
            if (levelFrameRef.current !== null) window.cancelAnimationFrame(levelFrameRef.current);
            cancelRecording();
        };
    }, []);

    return { recorderState, elapsedSeconds, level, start, stopAndTranscribe, cancel, reset };
}
