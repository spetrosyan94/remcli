import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    createAntigravitySessionRegistry,
    getAntigravitySessionRegistryPath,
} from './antigravitySessionRegistry';

const temporaryDirectories: string[] = [];

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createHome(): string {
    const directory = mkdtempSync(join(tmpdir(), 'remcli-antigravity-registry-'));
    temporaryDirectories.push(directory);
    return directory;
}

describe('Antigravity session registry', () => {
    it('records only bounded fields atomically with mode 0600 and lists newest first', () => {
        const homeDir = createHome();
        const registry = createAntigravitySessionRegistry(homeDir);

        registry.record({ conversationId: 'old', workspace: '/repo', updatedAt: 10 });
        registry.record({ conversationId: 'new', workspace: '/repo', updatedAt: 20 });
        registry.record({ conversationId: 'old', workspace: '/repo', updatedAt: 30 });

        const path = getAntigravitySessionRegistryPath(homeDir);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
            { conversationId: 'old', workspace: '/repo', updatedAt: 30 },
            { conversationId: 'new', workspace: '/repo', updatedAt: 20 },
        ]);
        expect(registry.list()).toEqual([
            { conversationId: 'old', workspace: '/repo', updatedAt: 30 },
            { conversationId: 'new', workspace: '/repo', updatedAt: 20 },
        ]);
    });

    it('treats malformed, oversized, and extra-field files as empty', () => {
        const homeDir = createHome();
        const path = getAntigravitySessionRegistryPath(homeDir);
        const registry = createAntigravitySessionRegistry(homeDir);

        for (const content of [
            '{malformed',
            JSON.stringify([{ conversationId: 'id', workspace: '/repo', updatedAt: 1, prompt: 'secret' }]),
            'x'.repeat(512 * 1024 + 1),
        ]) {
            writeFileSync(path, content, { mode: 0o600 });
            expect(registry.list()).toEqual([]);
        }
    });

    it('bounds serialized output before writing long valid entries', () => {
        const homeDir = createHome();
        const registry = createAntigravitySessionRegistry(homeDir);
        const longWorkspace = 'w'.repeat(4_096);

        for (let index = 0; index < 70; index += 1) {
            registry.record({
                conversationId: `${index.toString().padStart(2, '0')}-${'c'.repeat(4_090)}`,
                workspace: longWorkspace,
                updatedAt: index,
            });
        }

        const path = getAntigravitySessionRegistryPath(homeDir);
        expect(statSync(path).size).toBeLessThanOrEqual(512 * 1024);
        const listed = registry.list();
        expect(listed).not.toEqual([]);
        expect(listed[0]?.updatedAt).toBe(69);
        expect(listed.every((entry) => entry.updatedAt >= 69 - listed.length + 1)).toBe(true);
    });

    it('reads through a bounded descriptor and always closes it', () => {
        const homeDir = createHome();
        const path = getAntigravitySessionRegistryPath(homeDir);
        const content = JSON.stringify([{ conversationId: 'descriptor', workspace: '/repo', updatedAt: 1 }]);
        const source = Buffer.from(content, 'utf8');
        const fileSystem = {
            open: () => 7,
            fstat: () => ({ size: source.length, isFile: () => true }),
            read: (_fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
                const count = Math.min(length, source.length - position);
                source.copy(buffer, offset, position, position + count);
                return count;
            },
            close: (fd: number) => { expect(fd).toBe(7); },
        };

        expect(createAntigravitySessionRegistry(homeDir, fileSystem).list()).toEqual([
            { conversationId: 'descriptor', workspace: '/repo', updatedAt: 1 },
        ]);
    });

    it('filters by exact workspace and rejects invalid records at the write boundary', () => {
        const registry = createAntigravitySessionRegistry(createHome());
        registry.record({ conversationId: 'one', workspace: '/repo', updatedAt: 1 });
        registry.record({ conversationId: 'two', workspace: '/repo-other', updatedAt: 2 });

        expect(registry.list('/repo')).toEqual([{ conversationId: 'one', workspace: '/repo', updatedAt: 1 }]);
        expect(() => registry.list('/repo/')).not.toThrow();
        expect(registry.list('/repo/')).toEqual([]);
        expect(() => registry.record({ conversationId: '', workspace: '/repo', updatedAt: 1 })).toThrow(TypeError);
    });
});
