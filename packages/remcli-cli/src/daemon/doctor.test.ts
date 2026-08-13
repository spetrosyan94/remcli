import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const psList = vi.hoisted(() => vi.fn());

vi.mock('ps-list', () => ({ default: psList }));

import { findAllRemcliProcesses, findRunawayRemcliProcesses } from './doctor';

let packageRoot: string;

function createEntrypoint(kind: 'production' | 'development'): string {
    const sourceDirectory = kind === 'production' ? 'dist' : 'src';
    const extension = kind === 'production' ? 'mjs' : 'ts';
    const sourcePath = join(packageRoot, sourceDirectory);
    mkdirSync(sourcePath, { recursive: true });
    writeFileSync(join(sourcePath, `index.${extension}`), '');
    return join(sourcePath, `index.${extension}`);
}

beforeEach(() => {
    packageRoot = mkdtempSync(join(tmpdir(), 'remcli-daemon-doctor-test-'));
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'remcli' }));
});

afterEach(() => {
    psList.mockReset();
    rmSync(packageRoot, { recursive: true, force: true });
});

describe('findAllRemcliProcesses', () => {
    it('does not represent a discovery failure as an empty process list', async () => {
        psList.mockRejectedValue(new Error('ps-list unavailable'));

        await expect(findAllRemcliProcesses()).rejects.toThrow('Failed to discover Remcli processes');
    });

    it('keeps Remcli shell and wrapper commands visible without treating them as runaway daemons', async () => {
        const shellCommand = 'sh -c "npm run build && node packages/remcli-cli/bin/remcli.mjs daemon stop && node packages/remcli-cli/bin/remcli.mjs daemon start-sync --tunnel"';
        const wrapperCommand = 'node packages/remcli-cli/bin/remcli.mjs daemon start-sync --tunnel';
        const unrelatedNpmCommand = 'npm run start:tunnel';

        psList.mockResolvedValue([
            { pid: 41_001, name: 'sh', cmd: shellCommand },
            { pid: 41_002, name: 'node', cmd: wrapperCommand },
            { pid: 41_003, name: 'npm', cmd: unrelatedNpmCommand },
        ]);

        await expect(findAllRemcliProcesses()).resolves.toEqual([
            { pid: 41_001, command: shellCommand, type: 'user-session' },
            { pid: 41_002, command: wrapperCommand, type: 'user-session' },
        ]);
        await expect(findRunawayRemcliProcesses()).resolves.toEqual([]);
    });

    it('classifies the production Node daemon entrypoint as a daemon', async () => {
        const entrypoint = createEntrypoint('production');
        const command = `node --no-warnings --no-deprecation ${entrypoint} daemon start-sync --tunnel`;

        psList.mockResolvedValue([
            { pid: 41_004, name: 'node', cmd: command },
        ]);

        await expect(findAllRemcliProcesses()).resolves.toEqual([
            { pid: 41_004, command, type: 'daemon' },
        ]);
    });

    it('classifies the tsx development daemon entrypoint as a dev daemon', async () => {
        const entrypoint = createEntrypoint('development');
        const command = `node /opt/remcli/node_modules/tsx/dist/cli.mjs ${entrypoint} daemon start-sync`;

        psList.mockResolvedValue([
            { pid: 41_005, name: 'node', cmd: command },
        ]);

        await expect(findAllRemcliProcesses()).resolves.toEqual([
            { pid: 41_005, command, type: 'dev-daemon' },
        ]);
    });

    it('does not classify an arbitrary Node daemon entrypoint as a Remcli process', async () => {
        const foreignRoot = mkdtempSync(join(tmpdir(), 'foreign-daemon-test-'));
        try {
            const foreignEntrypoint = join(foreignRoot, 'dist', 'index.mjs');
            mkdirSync(join(foreignRoot, 'dist'), { recursive: true });
            writeFileSync(foreignEntrypoint, '');
            writeFileSync(join(foreignRoot, 'package.json'), JSON.stringify({ name: 'unrelated-service' }));

            psList.mockResolvedValue([
                { pid: 41_006, name: 'node', cmd: `node ${foreignEntrypoint} daemon start-sync` },
            ]);

            await expect(findAllRemcliProcesses()).resolves.toEqual([]);
            await expect(findRunawayRemcliProcesses()).resolves.toEqual([]);
        } finally {
            rmSync(foreignRoot, { recursive: true, force: true });
        }
    });

    it('keeps an unverifiable Remcli daemon fail-closed and out of cleanup', async () => {
        const entrypoint = join(packageRoot, 'dist', 'index.mjs');
        mkdirSync(join(packageRoot, 'dist'), { recursive: true });
        writeFileSync(entrypoint, '');
        writeFileSync(join(packageRoot, 'package.json'), '{invalid-json');
        const command = `node ${entrypoint} daemon start-sync`;

        psList.mockResolvedValue([
            { pid: 41_007, name: 'node', cmd: command },
        ]);

        await expect(findAllRemcliProcesses()).resolves.toEqual([
            { pid: 41_007, command, type: 'unverified-daemon' },
        ]);
        await expect(findRunawayRemcliProcesses()).resolves.toEqual([]);
    });
});
