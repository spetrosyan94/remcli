/**
 * Tests for local persistence helpers that are sensitive to process-level
 * configuration resolved at import time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface PersistenceModule {
    DAEMON_STATE_SCHEMA_VERSION: typeof import('./persistence').DAEMON_STATE_SCHEMA_VERSION;
    readDaemonState: typeof import('./persistence').readDaemonState;
    readLegacyDaemonStateDiagnostic: typeof import('./persistence').readLegacyDaemonStateDiagnostic;
    writeDaemonState: typeof import('./persistence').writeDaemonState;
    clearDaemonState: typeof import('./persistence').clearDaemonState;
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
            schemaVersion: 1 as const,
            instanceId: '3d8c88c3-e2e4-4b0c-a4e1-5ff1f4bb2e7c',
            state: 'running' as const,
            stateReason: 'ready' as const,
            pid: 12345,
            httpPort: 50097,
            p2pPort: 23456,
            p2pHost: '127.0.0.1',
            startedAtMs: 1_783_120_000_000,
            startedWithCliVersion: '0.0.1',
            lastHeartbeatAtMs: 1_783_120_001_000,
            daemonLogPath: join(homeDir, 'logs', 'daemon.log'),
            codexAppServerEndpoint: 'ws://127.0.0.1:45123',
            codexAppServerPid: 12345,
            ownedChildPids: [12346, 12347],
        };

        persistence.writeDaemonState(state);

        const statePath = join(homeDir, 'daemon.state.json');
        expect(existsSync(statePath)).toBe(true);
        expect(statSync(statePath).mode & 0o777).toBe(0o600);
        await expect(persistence.readDaemonState()).resolves.toEqual(state);
        expect(readdirSync(homeDir).filter((fileName) => fileName.includes('daemon.state.json') && fileName.endsWith('.tmp'))).toEqual([]);
    });

    it('fails closed for malformed, unsupported, or oversized state files', async () => {
        const persistence = await importPersistenceModule();
        const statePath = join(homeDir, 'daemon.state.json');

        writeFileSync(statePath, '{not-json', { mode: 0o600 });
        await expect(persistence.readDaemonState()).resolves.toBeNull();

        writeFileSync(statePath, JSON.stringify({
            schemaVersion: 2,
            instanceId: '3d8c88c3-e2e4-4b0c-a4e1-5ff1f4bb2e7c',
            state: 'running',
            stateReason: 'ready',
            pid: 12345,
            httpPort: 50097,
            startedAtMs: Date.now(),
            startedWithCliVersion: '0.0.1',
            ownedChildPids: [],
        }), { mode: 0o600 });
        await expect(persistence.readDaemonState()).resolves.toBeNull();

        writeFileSync(statePath, JSON.stringify({
            schemaVersion: 1,
            instanceId: '3d8c88c3-e2e4-4b0c-a4e1-5ff1f4bb2e7c',
            state: 'running',
            stateReason: 'ready',
            pid: 12345,
            httpPort: 50097,
            startedAtMs: Date.now(),
            startedWithCliVersion: '0.0.1',
            ownedChildPids: [],
            bearerToken: 'must-not-be-accepted',
        }), { mode: 0o600 });
        await expect(persistence.readDaemonState()).resolves.toBeNull();

        writeFileSync(statePath, JSON.stringify({
            schemaVersion: 1,
            instanceId: '3d8c88c3-e2e4-4b0c-a4e1-5ff1f4bb2e7c',
            state: 'running',
            stateReason: 'Bearer token must not be stored',
            pid: 12345,
            httpPort: 50097,
            startedAtMs: Date.now(),
            startedWithCliVersion: '0.0.1',
            ownedChildPids: [],
        }), { mode: 0o600 });
        await expect(persistence.readDaemonState()).resolves.toBeNull();

        writeFileSync(statePath, 'x'.repeat(64 * 1024 + 1), { mode: 0o600 });
        await expect(persistence.readDaemonState()).resolves.toBeNull();
    });

    it('does not serialize arbitrary runtime fields or delete the daemon lock during state cleanup', async () => {
        const persistence = await importPersistenceModule();
        const state = {
            schemaVersion: 1 as const,
            instanceId: '3d8c88c3-e2e4-4b0c-a4e1-5ff1f4bb2e7c',
            state: 'running' as const,
            stateReason: 'ready' as const,
            pid: 12345,
            httpPort: 50097,
            startedAtMs: 1_783_120_000_000,
            startedWithCliVersion: '0.0.1',
            ownedChildPids: [],
        };
        const statePath = join(homeDir, 'daemon.state.json');
        const lockPath = join(homeDir, 'daemon.state.json.lock');

        for (const secretField of ['runnerCredential', 'bearerToken', 'p2pSharedSecret']) {
            expect(() => persistence.writeDaemonState({
                ...state,
                [secretField]: 'must-never-reach-disk',
            } as unknown as typeof state)).toThrow();
        }
        expect(() => persistence.writeDaemonState({
            ...state,
            tunnelUrl: 'https://user:password@example.test',
        })).toThrow();
        expect(() => persistence.writeDaemonState({
            ...state,
            codexAppServerEndpoint: 'ws://127.0.0.1:45123/?token=must-not-be-stored',
        })).toThrow();

        persistence.writeDaemonState(state);
        writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
        await persistence.clearDaemonState();

        expect(existsSync(statePath)).toBe(false);
        expect(existsSync(lockPath)).toBe(true);
    });

    it('exposes an old unversioned state only as migration diagnostics', async () => {
        const persistence = await importPersistenceModule();
        const statePath = join(homeDir, 'daemon.state.json');
        writeFileSync(statePath, JSON.stringify({
            pid: 12345,
            httpPort: 50097,
            startTime: '2026-07-26T00:00:00.000Z',
            startedWithCliVersion: '0.0.0',
            codexAppServerEndpoint: 'ws://127.0.0.1:45123',
        }), { mode: 0o600 });

        await expect(persistence.readDaemonState()).resolves.toBeNull();
        await expect(persistence.readLegacyDaemonStateDiagnostic()).resolves.toEqual({
            pid: 12345,
            httpPort: 50097,
            startedWithCliVersion: '0.0.0',
        });
    });
});
