import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    listAntigravitySessions,
    readAntigravitySessions,
    type AntigravityHistoryFileSystem,
} from './antigravitySessions';
import type { AntigravitySessionRegistry } from './antigravitySessionRegistry';

function row(value: Record<string, unknown>): string {
    return JSON.stringify(value);
}

function createFileSystem(content: string, reportedSize = Buffer.byteLength(content, 'utf8')): AntigravityHistoryFileSystem {
    const source = Buffer.from(content, 'utf8');
    return {
        open: vi.fn(() => 42),
        fstat: vi.fn(() => ({ size: reportedSize, isFile: () => true })),
        read: vi.fn((_fd, buffer, offset, length, position) => {
            const bytes = Math.min(length, Math.max(0, source.length - position));
            source.copy(buffer, offset, position, position + bytes);
            return bytes;
        }),
        close: vi.fn(),
    };
}

const emptyRegistry: AntigravitySessionRegistry = {
    list: vi.fn(() => []),
    record: vi.fn(),
};

describe('Antigravity native session history', () => {
    it('merges the Remcli registry with provider history, dedupes, filters exactly, and sorts newest first', () => {
        const registry: AntigravitySessionRegistry = {
            list: vi.fn(() => [
                { conversationId: 'headless', workspace: '/repo', updatedAt: 300 },
                { conversationId: 'shared', workspace: '/repo', updatedAt: 400 },
                { conversationId: 'other', workspace: '/other', updatedAt: 500 },
            ]),
            record: vi.fn(),
        };
        const history = createFileSystem([
            row({ conversationId: 'shared', workspace: '/repo', display: 'Native title', timestamp: 450 }),
            row({ conversationId: 'provider-only', workspace: '/repo', display: 'Provider title', timestamp: 350 }),
        ].join('\n'));

        expect(listAntigravitySessions({ workspace: '/repo', fileSystem: history, registry })).toEqual([
            { provider: 'antigravity', conversationId: 'shared', workspace: '/repo', display: 'Native title', updatedAt: 450, messageCount: 1 },
            { provider: 'antigravity', conversationId: 'provider-only', workspace: '/repo', display: 'Provider title', updatedAt: 350, messageCount: 1 },
            { provider: 'antigravity', conversationId: 'headless', workspace: '/repo', display: '', updatedAt: 300, messageCount: 0 },
        ]);
        expect(registry.list).toHaveBeenCalledWith('/repo');
    });

    it('reads the official path through the injected home/path/read boundaries', () => {
        const fileSystem = createFileSystem(row({ conversationId: 'conv-1', workspace: '/repo', display: 'Fix the bug', timestamp: 100 }));
        const sessions = readAntigravitySessions({
            homeDir: '/home/tester',
            fileSystem,
        });

        expect(fileSystem.open).toHaveBeenCalledWith(join('/home/tester', '.gemini', 'antigravity-cli', 'history.jsonl'));
        expect(fileSystem.close).toHaveBeenCalledWith(42);
        expect(sessions).toEqual([{
            provider: 'antigravity', conversationId: 'conv-1', workspace: '/repo', display: 'Fix the bug', updatedAt: 100, messageCount: 1,
        }]);
    });

    it('aggregates duplicate conversations, skips slash commands and sorts by latest timestamp', () => {
        const content = [
            row({ conversationId: 'old', workspace: '/repo', display: 'First old', timestamp: 10, type: 'prompt' }),
            row({ conversationId: 'new', workspace: '/repo', display: 'First new', timestamp: 20, type: 'prompt' }),
            row({ conversationId: 'old', workspace: '/repo', display: 'Second old', timestamp: 30, type: 'prompt' }),
            row({ conversationId: 'new', workspace: '/repo', display: '/help', timestamp: 40, type: 'slash_command' }),
            row({ conversationId: 'new', workspace: '/repo', display: 'Second new', timestamp: 25, type: 'prompt' }),
        ].join('\n');

        expect(listAntigravitySessions({ homeDir: '/home/tester', fileSystem: createFileSystem(content), registry: emptyRegistry })).toEqual([
            { provider: 'antigravity', conversationId: 'old', workspace: '/repo', display: 'First old', updatedAt: 30, messageCount: 2 },
            { provider: 'antigravity', conversationId: 'new', workspace: '/repo', display: 'First new', updatedAt: 25, messageCount: 2 },
        ]);
    });

    it('keeps provider display and message count when a newer registry timestamp wins', () => {
        const registry: AntigravitySessionRegistry = {
            list: () => [{ conversationId: 'shared', workspace: '/repo', updatedAt: 200 }],
            record: vi.fn(),
        };
        const sessions = listAntigravitySessions({
            workspace: '/repo',
            fileSystem: createFileSystem(row({ conversationId: 'shared', workspace: '/repo', display: 'Provider title', timestamp: 100 })),
            registry,
        });

        expect(sessions).toEqual([{
            provider: 'antigravity',
            conversationId: 'shared',
            workspace: '/repo',
            display: 'Provider title',
            updatedAt: 200,
            messageCount: 1,
        }]);
    });

    it('uses an exact workspace filter and fails closed per malformed row', () => {
        const secret = 'authorization=secret-token';
        const content = [
            '{malformed}',
            row({ conversationId: 'missing-display', workspace: '/repo', timestamp: 100 }),
            row({ conversationId: 'wrong-workspace', workspace: '/other', display: secret, timestamp: 200 }),
            row({ conversationId: 'kept', workspace: '/repo', display: 'Useful prompt', timestamp: 300 }),
            row({ conversationId: 'bad-timestamp', workspace: '/repo', display: 'ignored', timestamp: '300' }),
        ].join('\n');

        expect(readAntigravitySessions({ homeDir: '/home/tester', workspace: '/repo', fileSystem: createFileSystem(content) })).toEqual([
            { provider: 'antigravity', conversationId: 'kept', workspace: '/repo', display: 'Useful prompt', updatedAt: 300, messageCount: 1 },
        ]);
    });

    it('refuses an oversized fstat before reading and still closes the descriptor', () => {
        const fileSystem = createFileSystem('', 4 * 1024 * 1024 + 1);

        expect(readAntigravitySessions({ homeDir: '/home/tester', fileSystem })).toEqual([]);
        expect(fileSystem.read).not.toHaveBeenCalled();
        expect(fileSystem.close).toHaveBeenCalledWith(42);
    });

    it('refuses a file that grows past the read bound after fstat', () => {
        const fileSystem = createFileSystem('', 0);
        fileSystem.read = vi.fn((_fd, buffer, offset, length) => {
            buffer.fill(120, offset, offset + length);
            return length;
        });

        expect(readAntigravitySessions({ homeDir: '/home/tester', fileSystem })).toEqual([]);
        expect(fileSystem.read).toHaveBeenCalledWith(42, expect.any(Buffer), 0, 4 * 1024 * 1024 + 1, 0);
        expect(fileSystem.close).toHaveBeenCalledWith(42);
    });

    it('returns no sessions when the fixed history file cannot be opened', () => {
        const fileSystem = createFileSystem('');
        fileSystem.open = vi.fn(() => { throw new Error('secret path failure'); });

        expect(readAntigravitySessions({ homeDir: '/home/tester', fileSystem })).toEqual([]);
        expect(fileSystem.fstat).not.toHaveBeenCalled();
        expect(fileSystem.close).not.toHaveBeenCalled();
    });

    it('processes the newest row window with a deterministic first title and bounded count', () => {
        const content = [
            row({ conversationId: 'target', workspace: '/repo', display: 'Outside window', timestamp: 1 }),
            ...Array.from({ length: 19_998 }, (_, index) => row({
                conversationId: 'filler', workspace: '/repo', display: `Filler ${index}`, timestamp: index + 2,
            })),
            row({ conversationId: 'target', workspace: '/repo', display: 'First title in window', timestamp: 30_000 }),
            row({ conversationId: 'target', workspace: '/repo', display: 'Later title in window', timestamp: 40_000 }),
        ].join('\n');

        const sessions = readAntigravitySessions({ homeDir: '/home/tester', fileSystem: createFileSystem(content) });

        expect(sessions[0]).toEqual({
            provider: 'antigravity', conversationId: 'target', workspace: '/repo', display: 'First title in window', updatedAt: 40_000, messageCount: 2,
        });
    });

    it('rejects an invalid workspace filter at the boundary', () => {
        expect(() => readAntigravitySessions({ workspace: ' ' })).toThrow(TypeError);
    });

    it('does not open a relative injected home directory', () => {
        const fileSystem = createFileSystem('');

        expect(readAntigravitySessions({ homeDir: 'relative-home', fileSystem })).toEqual([]);
        expect(fileSystem.open).not.toHaveBeenCalled();
    });
});
