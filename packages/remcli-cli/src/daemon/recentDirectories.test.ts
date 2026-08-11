import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    MAX_DIRECTORY_PROJECTS,
    createDirectoryProjectsStore,
} from './recentDirectories';

let testDirectory: string;
let homeDirectory: string;
let storeFilePath: string;

function createStore(machineId: string, now: () => number = Date.now) {
    return createDirectoryProjectsStore({
        machineId,
        filePath: storeFilePath,
        getHomeDirectory: () => homeDirectory,
        now,
    });
}

beforeEach(() => {
    testDirectory = mkdtempSync(join(tmpdir(), 'remcli-directory-projects-'));
    homeDirectory = join(testDirectory, 'home');
    storeFilePath = join(testDirectory, 'state', 'recent-directories.json');
    mkdirSync(homeDirectory);
});

afterEach(() => {
    rmSync(testDirectory, { recursive: true, force: true });
});

describe('directoryProjects', () => {
    it('returns an empty list when no project has been persisted', () => {
        expect(createStore('machine-a').listProjects()).toEqual({ projects: [] });
    });

    it('records the safe launch snapshot after a successful spawn', () => {
        const workspace = join(homeDirectory, 'workspace');
        mkdirSync(workspace);

        const store = createStore('machine-a', () => 100);
        store.recordSuccessfulSpawn(workspace, { agent: 'codex', branchAtLastLaunch: 'main' });
        const canonicalWorkspace = realpathSync(workspace);

        expect(store.listProjects()).toEqual({
            projects: [{
                canonicalPath: canonicalWorkspace,
                displayPath: '~/workspace',
                lastUsedAt: 100,
                isPinned: false,
                lastAgent: 'codex',
                branchAtLastLaunch: 'main',
            }],
        });
    });

    it('keeps a user pin while refreshing the last launch snapshot', () => {
        const workspace = join(homeDirectory, 'workspace');
        mkdirSync(workspace);
        const timestamps = [100, 200, 300];
        const store = createStore('machine-a', () => timestamps.shift() ?? 400);

        store.recordSuccessfulSpawn(workspace, { agent: 'codex', branchAtLastLaunch: 'main' });
        store.setProjectPinned(workspace, true);
        store.recordSuccessfulSpawn(join(workspace, '..', 'workspace'), {
            agent: 'cursor',
            branchAtLastLaunch: 'feature/mobile',
        });

        expect(store.listProjects().projects).toEqual([{
            canonicalPath: realpathSync(workspace),
            displayPath: '~/workspace',
            lastUsedAt: 300,
            isPinned: true,
            lastAgent: 'cursor',
            branchAtLastLaunch: 'feature/mobile',
        }]);
    });

    it('migrates the v1 MRU cache without inventing launch metadata', () => {
        const workspace = join(homeDirectory, 'workspace');
        mkdirSync(workspace);
        mkdirSync(join(testDirectory, 'state'));
        writeFileSync(storeFilePath, JSON.stringify({
            v: 1,
            machines: {
                'machine-a': [{
                    canonicalPath: realpathSync(workspace),
                    displayPath: '~/workspace',
                    lastUsedAt: 100,
                }],
            },
        }), 'utf-8');

        const store = createStore('machine-a', () => 200);
        expect(store.listProjects().projects).toEqual([{
            canonicalPath: realpathSync(workspace),
            displayPath: '~/workspace',
            lastUsedAt: 100,
            isPinned: false,
            lastAgent: null,
            branchAtLastLaunch: null,
        }]);

        store.setProjectPinned(workspace, true);
        expect(JSON.parse(readFileSync(storeFilePath, 'utf-8'))).toMatchObject({ v: 2 });
    });

    it('does not surface stale paths and rejects arbitrary missing pin targets', () => {
        const workspace = join(homeDirectory, 'workspace');
        mkdirSync(workspace);
        const store = createStore('machine-a', () => 100);
        store.recordSuccessfulSpawn(workspace, { agent: 'codex', branchAtLastLaunch: null });
        rmSync(workspace, { recursive: true });

        expect(store.listProjects()).toEqual({ projects: [] });
        expect(() => store.setProjectPinned(workspace, true)).toThrow('directory project is unavailable');
    });

    it('prunes stale pinned projects before a new successful spawn is limited', () => {
        const staleRoot = join(homeDirectory, 'stale-projects');
        mkdirSync(staleRoot);
        const store = createStore('machine-a', () => 100);
        for (let index = 0; index < MAX_DIRECTORY_PROJECTS; index += 1) {
            const staleProject = join(staleRoot, `project-${index}`);
            mkdirSync(staleProject);
            store.recordSuccessfulSpawn(staleProject, { agent: 'codex', branchAtLastLaunch: null });
            store.setProjectPinned(staleProject, true);
        }
        rmSync(staleRoot, { recursive: true });
        const freshProject = join(homeDirectory, 'fresh-project');
        mkdirSync(freshProject);

        store.recordSuccessfulSpawn(freshProject, { agent: 'cursor', branchAtLastLaunch: 'main' });

        expect(store.listProjects().projects).toEqual([expect.objectContaining({
            canonicalPath: realpathSync(freshProject),
            lastAgent: 'cursor',
        })]);
    });

    it('keeps projects machine-scoped and bounds the persisted list', () => {
        const firstMachineStore = createStore('machine-a', () => 100);
        const secondMachineStore = createStore('machine-b', () => 200);
        const alpha = join(homeDirectory, 'alpha');
        const beta = join(homeDirectory, 'beta');
        mkdirSync(alpha);
        mkdirSync(beta);

        firstMachineStore.recordSuccessfulSpawn(alpha, { agent: 'codex', branchAtLastLaunch: 'main' });
        secondMachineStore.recordSuccessfulSpawn(beta, { agent: 'cursor', branchAtLastLaunch: null });
        for (let index = 0; index < MAX_DIRECTORY_PROJECTS; index += 1) {
            const workspace = join(homeDirectory, `workspace-${index}`);
            mkdirSync(workspace);
            firstMachineStore.recordSuccessfulSpawn(workspace, { agent: 'codex', branchAtLastLaunch: null });
        }

        expect(firstMachineStore.listProjects().projects).toHaveLength(MAX_DIRECTORY_PROJECTS);
        expect(secondMachineStore.listProjects().projects).toEqual([expect.objectContaining({
            canonicalPath: realpathSync(beta),
            lastAgent: 'cursor',
        })]);
    });
});
