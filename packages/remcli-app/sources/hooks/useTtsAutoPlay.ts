/**
 * useTtsAutoPlay hook — auto-reads new agent messages via TTS
 *
 * Maintains a FIFO queue of text to synthesize. When TTS becomes idle
 * and the queue has items, automatically synthesizes the next one.
 * Only active when `enabled` is true.
 */

import * as React from 'react';
import { useTts, TtsState } from './useTts';

interface QueueItem {
    text: string;
    messageId: string;
}

export function useTtsAutoPlay(enabled: boolean) {
    const tts = useTts();
    const queueRef = React.useRef<QueueItem[]>([]);
    const processingRef = React.useRef(false);

    const processQueue = React.useCallback(async () => {
        if (processingRef.current || tts.ttsState !== 'idle') return;
        const next = queueRef.current.shift();
        if (!next) return;

        processingRef.current = true;
        try {
            await tts.synthesize(next.text, next.messageId);
        } catch { /* ignore synthesis errors in auto-play */ }
        processingRef.current = false;
    }, [tts.ttsState, tts.synthesize]);

    const enqueue = React.useCallback((text: string, messageId: string) => {
        if (!enabled) return;
        queueRef.current.push({ text, messageId });
        processQueue();
    }, [enabled, processQueue]);

    // Process queue when tts becomes idle
    React.useEffect(() => {
        if (tts.ttsState === 'idle' && queueRef.current.length > 0) {
            processQueue();
        }
    }, [tts.ttsState, processQueue]);

    // Clear queue when disabled
    React.useEffect(() => {
        if (!enabled) {
            queueRef.current = [];
        }
    }, [enabled]);

    return { ...tts, enqueue };
}
