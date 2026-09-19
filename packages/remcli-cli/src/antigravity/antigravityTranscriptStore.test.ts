import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { encrypt } from '@/api/encryption';
import {
    createAntigravityTranscriptStore,
    getAntigravityTranscriptPath,
    type AntigravityTranscriptTurn,
} from './antigravityTranscriptStore';
import type { Credentials } from '@/persistence';

const temporaryDirectories: string[] = [];
const workspace = '/repo';
const conversationId = 'conversation-1';

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createHome(): string {
    const directory = mkdtempSync(join(tmpdir(), 'remcli-antigravity-transcript-'));
    temporaryDirectories.push(directory);
    return directory;
}

function credentials(type: 'legacy' | 'dataKey', fill: number): Credentials {
    const key = new Uint8Array(32).fill(fill);
    return type === 'legacy'
        ? { token: 'test', encryption: { type: 'legacy', secret: key } }
        : { token: 'test', encryption: { type: 'dataKey', publicKey: key, machineKey: key } };
}

function turn(id: string, createdAt: number, text = id): AntigravityTranscriptTurn {
    return {
        id,
        createdAt,
        messages: [
            { type: 'user', text },
            { type: 'assistant', text: `answer-${text}`, isError: false },
            { type: 'tool-call', callId: `call-${id}`, name: 'read_file', input: { path: 'src/index.ts' } },
            { type: 'tool-result', callId: `call-${id}`, output: { content: 'ok' }, isError: false },
        ],
    };
}

describe('Antigravity transcript store', () => {
    it.each(['legacy', 'dataKey'] as const)('round-trips encrypted transcripts in %s mode', (type) => {
        const homeDir = createHome();
        const store = createAntigravityTranscriptStore(homeDir, credentials(type, 7));
        const expected = turn(conversationId, 10, 'private prompt');

        store.record(conversationId, workspace, expected);

        expect(store.load(conversationId, workspace)).toEqual([expected]);
        expect(statSync(join(homeDir, 'antigravity-transcripts')).mode & 0o777).toBe(0o700);
        expect(statSync(getAntigravityTranscriptPath(homeDir, conversationId)).mode & 0o777).toBe(0o600);
        expect(readFileSync(getAntigravityTranscriptPath(homeDir, conversationId), 'utf8')).not.toContain('private prompt');
        expect(readFileSync(getAntigravityTranscriptPath(homeDir, conversationId), 'utf8')).not.toContain(conversationId);
    });

    it('replaces by turn id and returns oldest first while retaining only 500 turns', () => {
        const store = createAntigravityTranscriptStore(createHome(), credentials('legacy', 1));
        store.record(conversationId, workspace, turn('newer', 30, 'new'));
        store.record(conversationId, workspace, turn('older', 10, 'old'));
        store.record(conversationId, workspace, turn('newer', 20, 'replacement'));

        expect(store.load(conversationId, workspace).map((entry) => entry.id)).toEqual(['older', 'newer']);
        expect(store.load(conversationId, workspace)[1]?.messages[0]).toEqual({ type: 'user', text: 'replacement' });

        const boundedStore = createAntigravityTranscriptStore(createHome(), credentials('legacy', 5));
        for (let index = 0; index < 501; index += 1) {
            boundedStore.record(conversationId, workspace, turn(`turn-${index}`, index));
        }
        const turns = boundedStore.load(conversationId, workspace);
        expect(turns).toHaveLength(500);
        expect(turns[0]?.id).toBe('turn-1');
        expect(turns.at(-1)?.id).toBe('turn-500');
    });

    it('fails open for corrupt, oversized, wrong-key, and wrong-identity files', () => {
        const homeDir = createHome();
        const store = createAntigravityTranscriptStore(homeDir, credentials('legacy', 2));
        const path = getAntigravityTranscriptPath(homeDir, conversationId);
        mkdirSync(join(homeDir, 'antigravity-transcripts'), { recursive: true });

        writeFileSync(path, '{not-json', { mode: 0o600 });
        expect(store.load(conversationId, workspace)).toEqual([]);

        writeFileSync(path, Buffer.alloc(4 * 1024 * 1024 + 1), { mode: 0o600 });
        expect(store.load(conversationId, workspace)).toEqual([]);

        store.record(conversationId, workspace, turn('valid', 1));
        expect(createAntigravityTranscriptStore(homeDir, credentials('legacy', 3)).load(conversationId, workspace)).toEqual([]);
        expect(store.load(conversationId, '/other-repo')).toEqual([]);
    });

    it('rejects invalid input at the write boundary', () => {
        const store = createAntigravityTranscriptStore(createHome(), credentials('legacy', 4));

        expect(() => store.record('', workspace, turn('id', 1))).toThrow(TypeError);
        expect(() => store.record(conversationId, workspace, {
            ...turn('id', 1),
            messages: [{ type: 'assistant', text: 'missing isError' } as never],
        })).toThrow();
    });

    it('enforces transcript field limits by UTF-8 byte length', () => {
        const store = createAntigravityTranscriptStore(createHome(), credentials('legacy', 6));

        expect(() => store.record(conversationId, workspace, turn('é'.repeat(256), 1))).toThrow();
        expect(() => store.record(conversationId, workspace, {
            id: 'id',
            createdAt: 1,
            messages: [{ type: 'user', text: '😀'.repeat(131_073) }],
        })).toThrow();
    });

    it('evicts oldest turns until the encrypted file fits the ciphertext bound', () => {
        const homeDir = createHome();
        const store = createAntigravityTranscriptStore(homeDir, credentials('legacy', 8));
        const largeText = 'x'.repeat(200_000);

        for (let index = 0; index < 12; index += 1) {
            store.record(conversationId, workspace, {
                id: `large-${index}`,
                createdAt: index,
                messages: [{ type: 'user', text: largeText }, { type: 'assistant', text: largeText, isError: false }],
            });
        }

        const turns = store.load(conversationId, workspace);
        expect(turns.length).toBeLessThan(12);
        expect(turns[0]?.id).toBe('large-2');
        expect(statSync(getAntigravityTranscriptPath(homeDir, conversationId)).size).toBeLessThanOrEqual(4 * 1024 * 1024);
    });

    it('reads a versioned body only when exact identity matches', () => {
        const homeDir = createHome();
        const key = new Uint8Array(32).fill(9);
        const body = { version: 1 as const, conversationId, workspace: '/different', turns: [turn('id', 1)] };
        const ciphertext = encrypt(key, 'legacy', body);
        const path = getAntigravityTranscriptPath(homeDir, conversationId);
        const directory = join(homeDir, 'antigravity-transcripts');
        mkdirSync(directory, { recursive: true });
        writeFileSync(path, ciphertext, { mode: 0o600 });

        expect(createAntigravityTranscriptStore(homeDir, credentials('legacy', 9)).load(conversationId, workspace)).toEqual([]);
    });
});
