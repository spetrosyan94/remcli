/**
 * Unit tests for P2PStore: persisted KV store (OCC + disk roundtrip)
 * and machine deletion (own-machine protection + no auto-resurrection).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { P2PStore } from './p2pStore';

let tempDir: string;

beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'remcli-kv-test-'));
});

afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
});

function kvPath(): string {
    return join(tempDir, 'kv-store.json');
}

describe('P2PStore KV — basic operations', () => {
    it('creates, reads, lists and deletes keys', () => {
        const store = new P2PStore({ kvFilePath: null });

        const created = store.kvMutate([{ key: 'todo.1', value: '{"a":1}', version: -1 }]);
        expect(created).toEqual({
            success: true,
            results: [{ key: 'todo.1', version: 1 }],
            changes: [{ key: 'todo.1', value: '{"a":1}', version: 1 }]
        });

        expect(store.kvGet('todo.1')).toEqual({ key: 'todo.1', value: '{"a":1}', version: 1 });
        expect(store.kvGet('missing')).toBeUndefined();

        store.kvMutate([{ key: 'zen.x', value: 'z', version: -1 }]);
        expect(store.kvList('todo.')).toHaveLength(1);
        expect(store.kvList()).toHaveLength(2);
        expect(store.kvList(undefined, 1)).toHaveLength(1);
        expect(store.kvBulkGet(['todo.1', 'missing', 'zen.x']).map(i => i.key)).toEqual(['todo.1', 'zen.x']);

        const deleted = store.kvMutate([{ key: 'todo.1', value: null, version: 1 }]);
        expect(deleted.success).toBe(true);
        expect(store.kvGet('todo.1')).toBeUndefined();
    });

    it('increments the version on update', () => {
        const store = new P2PStore({ kvFilePath: null });
        store.kvMutate([{ key: 'k', value: 'v1', version: -1 }]);
        const updated = store.kvMutate([{ key: 'k', value: 'v2', version: 1 }]);
        expect(updated.success).toBe(true);
        expect(store.kvGet('k')).toEqual({ key: 'k', value: 'v2', version: 2 });
    });
});

describe('P2PStore KV — optimistic concurrency control', () => {
    it('rejects a stale version with the current version and value, applying nothing', () => {
        const store = new P2PStore({ kvFilePath: null });
        store.kvMutate([{ key: 'k', value: 'current', version: -1 }]);

        const result = store.kvMutate([{ key: 'k', value: 'stale-write', version: 0 }]);
        expect(result).toEqual({
            success: false,
            errors: [{ key: 'k', error: 'version-mismatch', version: 1, value: 'current' }]
        });
        // Nothing was applied.
        expect(store.kvGet('k')).toEqual({ key: 'k', value: 'current', version: 1 });
    });

    it('rejects creating an already-existing key with version -1', () => {
        const store = new P2PStore({ kvFilePath: null });
        store.kvMutate([{ key: 'k', value: 'v', version: -1 }]);
        const result = store.kvMutate([{ key: 'k', value: 'other', version: -1 }]);
        expect(result.success).toBe(false);
    });

    it('fails the whole batch atomically when a single mutation conflicts', () => {
        const store = new P2PStore({ kvFilePath: null });
        store.kvMutate([{ key: 'a', value: '1', version: -1 }]);

        const result = store.kvMutate([
            { key: 'b', value: 'new', version: -1 },     // valid
            { key: 'a', value: 'conflict', version: 5 }  // conflict
        ]);
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(result.errors).toEqual([{ key: 'a', error: 'version-mismatch', version: 1, value: '1' }]);
        }
        // The valid mutation must NOT have been applied.
        expect(store.kvGet('b')).toBeUndefined();
    });

    it('reports version -1 and value null for a mutation against a missing key', () => {
        const store = new P2PStore({ kvFilePath: null });
        const result = store.kvMutate([{ key: 'ghost', value: 'v', version: 3 }]);
        expect(result).toEqual({
            success: false,
            errors: [{ key: 'ghost', error: 'version-mismatch', version: -1, value: null }]
        });
    });
});

describe('P2PStore KV — disk persistence', () => {
    it('roundtrips through the file: flush then load in a new store', () => {
        const storeA = new P2PStore({ kvFilePath: kvPath() });
        storeA.kvMutate([
            { key: 'todo.index', value: '["1"]', version: -1 },
            { key: 'todo.1', value: '{"title":"t"}', version: -1 }
        ]);
        storeA.flushKvToDisk();
        expect(existsSync(kvPath())).toBe(true);

        const storeB = new P2PStore({ kvFilePath: kvPath() });
        expect(storeB.kvGet('todo.index')).toEqual({ key: 'todo.index', value: '["1"]', version: 1 });
        expect(storeB.kvGet('todo.1')).toEqual({ key: 'todo.1', value: '{"title":"t"}', version: 1 });
        expect(storeB.kvList()).toHaveLength(2);
    });

    it('writes to disk automatically after the debounce window', async () => {
        const store = new P2PStore({ kvFilePath: kvPath() });
        store.kvMutate([{ key: 'k', value: 'v', version: -1 }]);
        expect(existsSync(kvPath())).toBe(false);

        await new Promise(resolve => setTimeout(resolve, 700));
        expect(existsSync(kvPath())).toBe(true);
        const parsed = JSON.parse(readFileSync(kvPath(), 'utf-8')) as { items: unknown[] };
        expect(parsed.items).toEqual([{ key: 'k', value: 'v', version: 1 }]);
    });

    it('starts empty when the file is missing', () => {
        const store = new P2PStore({ kvFilePath: kvPath() });
        expect(store.kvList()).toEqual([]);
    });

    it('starts empty when the file is corrupted or has a wrong shape', () => {
        writeFileSync(kvPath(), 'not-json{{{', 'utf-8');
        expect(new P2PStore({ kvFilePath: kvPath() }).kvList()).toEqual([]);

        writeFileSync(kvPath(), JSON.stringify({ items: [{ key: 1, value: 2 }] }), 'utf-8');
        expect(new P2PStore({ kvFilePath: kvPath() }).kvList()).toEqual([]);
    });
});

describe('P2PStore machines — deletion', () => {
    it('deletes a machine and refuses to auto-recreate it', () => {
        const store = new P2PStore({ kvFilePath: null });
        store.getOrCreateMachine('m1', '{}', null, null);
        expect(store.getMachine('m1')).toBeDefined();

        expect(store.deleteMachine('m1')).toBe(true);
        expect(store.getMachine('m1')).toBeUndefined();
        expect(store.deleteMachine('m1')).toBe(false);

        // A deleted machine must not silently reappear.
        expect(store.getOrCreateMachine('m1', '{}', null, null)).toBeNull();
        expect(store.getMachine('m1')).toBeUndefined();
    });

    it('tracks the daemon own machine', () => {
        const store = new P2PStore({ kvFilePath: null });
        store.getOrCreateMachine('own', '{}', null, null);
        store.markOwnMachine('own');
        expect(store.isOwnMachine('own')).toBe(true);
        expect(store.isOwnMachine('other')).toBe(false);
    });
});

describe('P2PStore sessions — terminal lifecycle', () => {
    it('rejects late metadata writes after an explicit terminal stop', () => {
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('terminal-session', 'initial-metadata', null);

        expect(store.markSessionStopped(session.id, session.activeAt + 1)).toBe(true);

        expect(store.updateSessionMetadata(session.id, 'late-metadata', session.metadataVersion)).toEqual({
            result: 'error',
            version: session.metadataVersion,
            metadata: 'initial-metadata',
        });
        expect(store.getSession(session.id)?.metadata).toBe('initial-metadata');
    });
});
