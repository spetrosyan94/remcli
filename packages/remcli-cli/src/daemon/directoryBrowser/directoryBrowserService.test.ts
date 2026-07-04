import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';

import { listDirectoryForBrowser } from './directoryBrowserService';

function createDirent(name: string, isDirectory = true): Dirent {
    return {
        name,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isDirectory: () => isDirectory,
        isFIFO: () => false,
        isFile: () => !isDirectory,
        isSocket: () => false,
        isSymbolicLink: () => false,
    } as Dirent;
}

describe('directoryBrowserService', () => {
    let testDir: string;

    beforeEach(() => {
        testDir = mkdtempSync(join(tmpdir(), 'remcli-directory-browser-'));
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    it('should list home directory when path is omitted', async () => {
        mkdirSync(join(testDir, 'beta'));
        mkdirSync(join(testDir, 'alpha'));
        writeFileSync(join(testDir, 'notes.txt'), 'not a directory');
        const homePath = resolve(testDir);

        const result = await listDirectoryForBrowser({}, {
            getHomeDirectory: () => testDir,
        });

        expect(result).toEqual({
            path: homePath,
            displayPath: '~',
            parent: dirname(homePath),
            parentDisplayPath: dirname(homePath),
            style: 'posix',
            separator: '/',
            home: {
                path: homePath,
                displayPath: '~',
            },
            entries: [
                { name: 'alpha', path: join(homePath, 'alpha'), displayPath: '~/alpha', type: 'directory', hidden: false },
                { name: 'beta', path: join(homePath, 'beta'), displayPath: '~/beta', type: 'directory', hidden: false },
            ],
        });
    });

    it('should return only directories sorted by hidden flag and name', async () => {
        mkdirSync(join(testDir, '.zsh'));
        mkdirSync(join(testDir, 'beta'));
        mkdirSync(join(testDir, '.config'));
        mkdirSync(join(testDir, 'alpha'));
        writeFileSync(join(testDir, 'visible-file.txt'), 'ignored');
        writeFileSync(join(testDir, '.hidden-file'), 'ignored');

        const result = await listDirectoryForBrowser({ path: testDir });

        expect(result.entries).toEqual([
            { name: 'alpha', path: join(testDir, 'alpha'), displayPath: join(testDir, 'alpha'), type: 'directory', hidden: false },
            { name: 'beta', path: join(testDir, 'beta'), displayPath: join(testDir, 'beta'), type: 'directory', hidden: false },
            { name: '.config', path: join(testDir, '.config'), displayPath: join(testDir, '.config'), type: 'directory', hidden: true },
            { name: '.zsh', path: join(testDir, '.zsh'), displayPath: join(testDir, '.zsh'), type: 'directory', hidden: true },
        ]);
    });

    it('should resolve the requested path and expose parent display path', async () => {
        const nestedDir = join(testDir, 'nested');
        mkdirSync(nestedDir);

        const result = await listDirectoryForBrowser({ path: `${nestedDir}/` }, {
            getHomeDirectory: () => testDir,
        });

        expect(result.path).toBe(resolve(nestedDir));
        expect(result.displayPath).toBe('~/nested');
        expect(result.parent).toBe(resolve(testDir));
        expect(result.parentDisplayPath).toBe('~');
        expect(result.entries).toEqual([]);
    });

    it('should normalize and list Windows-style paths with injected path tools', async () => {
        const homePath = 'C:\\Users\\Alice';
        const projectsPath = 'C:\\Users\\Alice\\Projects';
        const readPaths: string[] = [];
        const deps = {
            getHomeDirectory: () => homePath,
            pathStyle: 'win32' as const,
            pathTools: win32,
        };

        const result = await listDirectoryForBrowser({ path: 'C:/Users/Alice/Projects' }, {
            ...deps,
            readDirectory: async (path) => {
                readPaths.push(path);
                return [
                    createDirent('remcli'),
                    createDirent('notes.txt', false),
                    createDirent('.cache'),
                ];
            },
        });

        expect(readPaths).toEqual([projectsPath]);
        expect(result).toEqual({
            path: projectsPath,
            displayPath: '~\\Projects',
            parent: homePath,
            parentDisplayPath: '~',
            style: 'win32',
            separator: '\\',
            home: {
                path: homePath,
                displayPath: '~',
            },
            entries: [
                {
                    name: 'remcli',
                    path: 'C:\\Users\\Alice\\Projects\\remcli',
                    displayPath: '~\\Projects\\remcli',
                    type: 'directory',
                    hidden: false,
                },
                {
                    name: '.cache',
                    path: 'C:\\Users\\Alice\\Projects\\.cache',
                    displayPath: '~\\Projects\\.cache',
                    type: 'directory',
                    hidden: true,
                },
            ],
        });
    });

    it('should throw a clear permission denied error when the directory cannot be read', async () => {
        const permissionError = Object.assign(new Error('EACCES: permission denied, scandir'), {
            code: 'EACCES',
        });

        await expect(listDirectoryForBrowser({ path: testDir }, {
            readDirectory: async () => {
                throw permissionError;
            },
        })).rejects.toThrow(`Unable to list directory "${testDir}": permission denied.`);
    });

    it('should reject invalid params before reading the filesystem', async () => {
        await expect(listDirectoryForBrowser({ path: '' })).rejects.toThrow('Path must be a non-empty string');
        await expect(listDirectoryForBrowser('invalid')).rejects.toThrow('Params must be an object with optional path');
    });
});
