import { describe, expect, it } from 'vitest';

import { parseCodexReplayMessages } from './replayCodexSessionHistory';

describe('parseCodexReplayMessages', () => {
    it('extracts user and assistant text from Codex JSONL records', () => {
        const messages = parseCodexReplayMessages([
            JSON.stringify({
                type: 'event_msg',
                payload: {
                    type: 'user_message',
                    message: 'Привет',
                },
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [
                        { type: 'output_text', text: 'На связи.' },
                    ],
                },
            }),
        ]);

        expect(messages).toEqual([
            { role: 'user', text: 'Привет' },
            { role: 'assistant', text: 'На связи.' },
        ]);
    });

    it('ignores tool calls and malformed records', () => {
        const messages = parseCodexReplayMessages([
            '{bad json',
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'function_call',
                    name: 'shell',
                },
            }),
            JSON.stringify({
                type: 'event_msg',
                payload: {
                    type: 'task_started',
                },
            }),
        ]);

        expect(messages).toEqual([]);
    });
});
