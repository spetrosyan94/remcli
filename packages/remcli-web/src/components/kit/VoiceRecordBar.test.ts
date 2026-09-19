import { describe, expect, it } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceRecordBar, VOICE_STOP_FADE_MS, voiceBarScale } from '@/components/kit/VoiceRecordBar';

describe('VoiceRecordBar motion contract', () => {
    it('derives stable bar scales from the live level', () => {
        const quiet = voiceBarScale(0, 2);
        const loud = voiceBarScale(1, 2);

        expect(quiet).toBeGreaterThan(0);
        expect(loud).toBeGreaterThan(quiet);
        expect(voiceBarScale(0.4, 2)).toBe(voiceBarScale(0.4, 2));
        expect(voiceBarScale(-1, 2)).toBe(voiceBarScale(0, 2));
        expect(voiceBarScale(2, 2)).toBe(voiceBarScale(1, 2));
    });

    it('keeps the stopping phase bounded to the canonical 150ms delay', () => {
        expect(VOICE_STOP_FADE_MS).toBe(150);
        const markup = renderToStaticMarkup(React.createElement(VoiceRecordBar, { level: 0.6 }));
        expect(markup).toContain('scaleY(');
        expect(markup).not.toContain('animate-bar');
    });
});
