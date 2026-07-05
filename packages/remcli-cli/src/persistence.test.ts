/**
 * Tests for local persistence helpers that are sensitive to process-level
 * configuration resolved at import time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface PersistenceModule {
    readDaemonState: typeof import('./persistence').readDaemonState;
    writeDaemonState: typeof import('./persistence').writeDaemonState;
}

let homeDir: string;
const originalHomeDir = process.env.REMCLI_HOME_DIR;

async function importPersistenceModule(): Promise<PersistenceModule> {
    vi.resetModules();
    return await import('./persistence');
}

beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'remcli-persistence-test-'));
    process.env.REMCLI_HOME_DIR = homeDir;
});

afterEach(() => {
    if (originalHomeDir === undefined) {
        delete process.env.REMCLI_HOME_DIR;
    } else {
        process.env.REMCLI_HOME_DIR = originalHomeDir;
    }
    rmSync(homeDir, { recursive: true, force: true });
});

describe('daemon state persistence', () => {
    it('writes daemon state atomically without leaving temp files behind', async () => {
        const persistence = await importPersistenceModule();
        const state = {
            pid: 12345,
            httpPort: 50097,
            p2pPort: 23456,
            p2pHost: '127.0.0.1',
            p2pSharedSecret: 'test-secret',
            startTime: '2026-07-04T00:00:00.000Z',
            startedWithCliVersion: '0.0.1',
            lastHeartbeat: '2026-07-04T00:00:01.000Z',
            daemonLogPath: join(homeDir, 'logs', 'daemon.log'),
            codexAppServerEndpoint: 'ws://127.0.0.1:45123',
            codexAppServerPid: 12345,
        };

        persistence.writeDaemonState(state);

        const statePath = join(homeDir, 'daemon.state.json');
        expect(existsSync(statePath)).toBe(true);
        expect(statSync(statePath).mode & 0o777).toBe(0o600);
        await expect(persistence.readDaemonState()).resolves.toEqual(state);
        expect(readdirSync(homeDir).filter((fileName) => fileName.includes('daemon.state.json') && fileName.endsWith('.tmp'))).toEqual([]);
    });
});
