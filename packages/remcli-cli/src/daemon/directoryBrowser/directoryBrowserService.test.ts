import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { listDirectoryForBrowser } from './directoryBrowserService';

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

        const result = await listDirectoryForBrowser({}, {
            getHomeDirectory: () => testDir,
        });

        expect(result).toEqual({
            path: testDir,
            parent: dirname(testDir),
            entries: [
                { name: 'alpha', path: join(testDir, 'alpha'), type: 'directory', hidden: false },
                { name: 'beta', path: join(testDir, 'beta'), type: 'directory', hidden: false },
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
            { name: 'alpha', path: join(testDir, 'alpha'), type: 'directory', hidden: false },
            { name: 'beta', path: join(testDir, 'beta'), type: 'directory', hidden: false },
            { name: '.config', path: join(testDir, '.config'), type: 'directory', hidden: true },
            { name: '.zsh', path: join(testDir, '.zsh'), type: 'directory', hidden: true },
        ]);
    });

    it('should resolve the requested path and expose its parent', async () => {
        const nestedDir = join(testDir, 'nested');
        mkdirSync(nestedDir);

        const result = await listDirectoryForBrowser({ path: `${nestedDir}/` });

        expect(result.path).toBe(resolve(nestedDir));
        expect(result.parent).toBe(testDir);
        expect(result.entries).toEqual([]);
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
