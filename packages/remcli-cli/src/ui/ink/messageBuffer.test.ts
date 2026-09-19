import { describe, expect, it } from 'vitest'

import { MessageBuffer } from './messageBuffer'

describe('MessageBuffer', () => {
    it('replaces streamed content with the authoritative final message', () => {
        const buffer = new MessageBuffer()

        buffer.addMessage('Первая часть', 'assistant')
        buffer.updateLastMessage(' вторая часть', 'assistant')
        buffer.replaceLastMessage('Авторитетный финал', 'assistant')

        expect(buffer.getMessages()).toHaveLength(1)
        expect(buffer.getMessages()[0].content).toBe('Авторитетный финал')
    })

    it('updates assistant messages by stable message id across tool events', () => {
        const buffer = new MessageBuffer()

        buffer.replaceMessage('assistant-a', 'A', 'assistant')
        buffer.addMessage('tool event', 'tool')
        buffer.replaceMessage('assistant-b', 'B', 'assistant')

        expect(buffer.getMessages().map(({ content, type, messageId }) => ({ content, type, messageId }))).toEqual([
            { content: 'A', type: 'assistant', messageId: 'assistant-a' },
            { content: 'tool event', type: 'tool', messageId: undefined },
            { content: 'B', type: 'assistant', messageId: 'assistant-b' },
        ])
    })

    it('keeps live delta and final replacement on the same stable message id', () => {
        const buffer = new MessageBuffer()

        buffer.updateMessage('assistant-live', 'first', 'assistant')
        buffer.addMessage('tool event', 'tool')
        buffer.updateMessage('assistant-live', ' second', 'assistant')
        buffer.replaceMessage('assistant-live', 'authoritative final', 'assistant')

        expect(buffer.getMessages()).toHaveLength(2)
        expect(buffer.getMessages()[0]).toMatchObject({
            messageId: 'assistant-live',
            content: 'authoritative final',
            type: 'assistant',
        })
    })
})
