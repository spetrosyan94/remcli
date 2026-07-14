import { describe, expect, it } from 'vitest';
import { hasNonEmptyAssistantText } from './hasAssistantText';

describe('hasNonEmptyAssistantText', () => {
    it('recognizes a non-empty assistant text block', () => {
        expect(hasNonEmptyAssistantText([
            { type: 'tool_use', name: 'Read' },
            { type: 'text', text: 'Completed the requested change.' },
        ])).toBe(true);
    });

    it('rejects empty text, tool-only payloads, and invalid content', () => {
        expect(hasNonEmptyAssistantText([{ type: 'text', text: '   ' }])).toBe(false);
        expect(hasNonEmptyAssistantText([{ type: 'tool_use', name: 'Read' }])).toBe(false);
        expect(hasNonEmptyAssistantText('assistant output')).toBe(false);
    });
});
