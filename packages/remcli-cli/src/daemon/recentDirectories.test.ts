import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    MAX_RECENT_DIRECTORIES,
    createRecentDirectoriesStore,
} from './recentDirectories';

let testDirectory: string;
let homeDirectory: string;
let storeFilePath: string;

function createStore(machineId: string, now: () => number = Date.now) {
    return createRecentDirectoriesStore({
        machineId,
        filePath: storeFilePath,
        getHomeDirectory: () => homeDirectory,
        now,
    });
}

beforeEach(() => {
    testDirectory = mkdtempSync(join(tmpdir(), 'remcli-recent-directories-'));
    homeDirectory = join(testDirectory, 'home');
    storeFilePath = join(testDirectory, 'state', 'recent-directories.json');
    mkdirSync(homeDirectory);
});

afterEach(() => {
    rmSync(testDirectory, { recursive: true, force: true });
});

describe('recentDirectories', () => {
    it('returns an empty list when no MRU has been persisted', () => {
        expect(createStore('machine-a').list()).toEqual({ directories: [] });
    });

    it('records a successful spawn with canonical and display paths', () => {
        const workspace = join(homeDirectory, 'workspace');
        mkdirSync(workspace);

        const store = createStore('machine-a', () => 100);
        store.recordSuccessfulSpawn(workspace);
        const canonicalWorkspace = realpathSync(workspace);

        expect(store.list()).toEqual({
            directories: [{
                canonicalPath: canonicalWorkspace,
                displayPath: '~/workspace',
                lastUsedAt: 100,
            }],
        });
    });

    it('deduplicates canonical paths and sorts the newest record first', () => {
        const alpha = join(homeDirectory, 'alpha');
        const beta = join(homeDirectory, 'beta');
        mkdirSync(alpha);
        mkdirSync(beta);
        const timestamps = [100, 200, 300];
        const store = createStore('machine-a', () => {
            const timestamp = timestamps.shift();
            if (timestamp === undefined) {
                throw new Error('Unexpected MRU timestamp request');
            }
            return timestamp;
        });

        store.recordSuccessfulSpawn(join(alpha, '..', 'alpha'));
        store.recordSuccessfulSpawn(beta);
        store.recordSuccessfulSpawn(alpha);
        const canonicalAlpha = realpathSync(alpha);
        const canonicalBeta = realpathSync(beta);

        expect(store.list()).toEqual({
            directories: [
                { canonicalPath: canonicalAlpha, displayPath: '~/alpha', lastUsedAt: 300 },
                { canonicalPath: canonicalBeta, displayPath: '~/beta', lastUsedAt: 200 },
            ],
        });
    });

    it('persists records across a daemon restart', () => {
        const workspace = join(homeDirectory, 'workspace');
        mkdirSync(workspace);

        createStore('machine-a', () => 100).recordSuccessfulSpawn(workspace);
        const canonicalWorkspace = realpathSync(workspace);

        expect(createStore('machine-a').list().directories).toEqual([
            { canonicalPath: canonicalWorkspace, displayPath: '~/workspace', lastUsedAt: 100 },
        ]);
    });

    it('treats malformed or corrupt on-disk data as an empty cache and safely replaces it', () => {
        mkdirSync(join(testDirectory, 'state'));
        writeFileSync(storeFilePath, '{not valid json', 'utf-8');
        const workspace = join(homeDirectory, 'workspace');
        mkdirSync(workspace);
        const store = createStore('machine-a', () => 100);

        expect(store.list()).toEqual({ directories: [] });

        store.recordSuccessfulSpawn(workspace);

        expect(store.list().directories).toHaveLength(1);

        writeFileSync(storeFilePath, JSON.stringify({ v: 1, machines: { 'machine-a': 'corrupt' } }), 'utf-8');
        expect(store.list()).toEqual({ directories: [] });
    });

    it('keeps machine-scoped records isolated in a shared persistent file', () => {
        const alpha = join(homeDirectory, 'alpha');
        const beta = join(homeDirectory, 'beta');
        mkdirSync(alpha);
        mkdirSync(beta);
        const firstMachineStore = createStore('machine-a', () => 100);
        const secondMachineStore = createStore('machine-b', () => 200);

        firstMachineStore.recordSuccessfulSpawn(alpha);
        secondMachineStore.recordSuccessfulSpawn(beta);

        expect(firstMachineStore.list().directories.map((item) => item.canonicalPath)).toEqual([realpathSync(alpha)]);
        expect(secondMachineStore.list().directories.map((item) => item.canonicalPath)).toEqual([realpathSync(beta)]);
    });

    it('limits each machine MRU to the explicit maximum size', () => {
        const store = createStore('machine-a');
        for (let index = 0; index < MAX_RECENT_DIRECTORIES + 1; index += 1) {
            const workspace = join(homeDirectory, `workspace-${index}`);
            mkdirSync(workspace);
            store.recordSuccessfulSpawn(workspace);
        }

        expect(store.list().directories).toHaveLength(MAX_RECENT_DIRECTORIES);
    });
});
