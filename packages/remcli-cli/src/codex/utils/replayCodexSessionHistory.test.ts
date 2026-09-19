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
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'task_complete' },
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

    it('replays only structurally completed turns and excludes the active JSONL tail', () => {
        const messages = parseCodexReplayMessages([
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'user_message', message: 'Завершённый prompt' },
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Завершённый ответ' }],
                },
            }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'user_message', message: 'Активный prompt' },
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'Активный snapshot overlap' }],
                },
            }),
        ]);

        expect(messages).toEqual([
            { role: 'user', text: 'Завершённый prompt' },
            { role: 'assistant', text: 'Завершённый ответ' },
        ]);
    });

    it('discards an unfinished turn when the next user message starts', () => {
        const messages = parseCodexReplayMessages([
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'user_message', message: 'U1' },
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'A1 partial' }],
                },
            }),
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'user_message', message: 'U2' },
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'A2' }],
                },
            }),
            JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
        ]);

        expect(messages).toEqual([
            { role: 'user', text: 'U2' },
            { role: 'assistant', text: 'A2' },
        ]);
    });

    it('discards an aborted turn before replaying the next structurally started turn', () => {
        const messages = parseCodexReplayMessages([
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'A1 aborted' }],
                },
            }),
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'turn_aborted' },
            }),
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'task_started' },
            }),
            JSON.stringify({
                type: 'response_item',
                payload: {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 'A2 replayed' }],
                },
            }),
            JSON.stringify({
                type: 'event_msg',
                payload: { type: 'task_complete' },
            }),
        ]);

        expect(messages).toEqual([
            { role: 'assistant', text: 'A2 replayed' },
        ]);
    });
});
