import { describe, expect, it } from 'vitest';
import { stripConciergeSpeakerPrefix } from '@/components/app/conciergeText';

describe('stripConciergeSpeakerPrefix', () => {
    it('removes Russian Jarvis speaker prefixes from assistant replies', () => {
        expect(stripConciergeSpeakerPrefix('Джарвис: Проверил сессии.'))
            .toBe('Проверил сессии.');
        expect(stripConciergeSpeakerPrefix('  Джарвис — готов открыть seeded чат.'))
            .toBe('готов открыть seeded чат.');
    });

    it('removes English concierge-style speaker prefixes from assistant replies', () => {
        expect(stripConciergeSpeakerPrefix('Jarvis: Ready.'))
            .toBe('Ready.');
        expect(stripConciergeSpeakerPrefix('Concierge - I can start a session.'))
            .toBe('I can start a session.');
    });

    it('keeps regular assistant text intact', () => {
        expect(stripConciergeSpeakerPrefix('Готов открыть сессию.'))
            .toBe('Готов открыть сессию.');
        expect(stripConciergeSpeakerPrefix('AI-инструменты уже запущены.'))
            .toBe('AI-инструменты уже запущены.');
    });
});
