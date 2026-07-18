/**
 * Tests for persistent P2P pairing storage
 *
 * Uses REMCLI_HOME_DIR (resolved by configuration at import time) pointed at a
 * temp directory, so each test gets a fresh isolated pairing file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type PairingModule = typeof import('./p2pPairing');

let homeDir: string;
const originalHomeDir = process.env.REMCLI_HOME_DIR;

async function importPairingModule(): Promise<PairingModule> {
    // configuration is a singleton resolved at import time — reset modules so it
    // re-reads REMCLI_HOME_DIR pointing at the temp dir
    vi.resetModules();
    return await import('./p2pPairing');
}

beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'remcli-pairing-test-'));
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

describe('p2pPairing', () => {
    it('creates a pairing file on first load and reads the same secret back', async () => {
        const pairing = await importPairingModule();

        const created = pairing.loadOrCreatePairing();
        expect(created.authSecret.length).toBe(32);
        expect(created.contentSecret.length).toBe(32);
        expect(created.port).toBe(0);
        expect(existsSync(pairing.getPairingFilePath())).toBe(true);

        // File permissions must be 0600
        const mode = statSync(pairing.getPairingFilePath()).mode & 0o777;
        expect(mode).toBe(0o600);

        // File format: { v: 2, authSecret, contentSecret, port, createdAt }
        const raw = JSON.parse(readFileSync(pairing.getPairingFilePath(), 'utf-8'));
        expect(raw.v).toBe(2);
        expect(raw.authSecret).toBe(Buffer.from(created.authSecret).toString('base64'));
        expect(raw.contentSecret).toBe(Buffer.from(created.contentSecret).toString('base64'));
        expect(raw.port).toBe(0);
        expect(new Date(raw.createdAt).toString()).not.toBe('Invalid Date');

        // Roundtrip: second load returns the exact same secret
        const loaded = pairing.loadOrCreatePairing();
        expect(Buffer.from(loaded.authSecret).toString('base64')).toBe(raw.authSecret);
        expect(Buffer.from(loaded.contentSecret).toString('base64')).toBe(raw.contentSecret);
        expect(loaded.createdAt).toBe(created.createdAt);
    });

    it('persists the bound port and keeps the secret unchanged', async () => {
        const pairing = await importPairingModule();

        const created = pairing.loadOrCreatePairing();
        pairing.updatePairingPort(created, 34567);

        const loaded = pairing.loadOrCreatePairing();
        expect(loaded.port).toBe(34567);
        expect(Buffer.from(loaded.authSecret).toString('base64'))
            .toBe(Buffer.from(created.authSecret).toString('base64'));
        expect(Buffer.from(loaded.contentSecret).toString('base64'))
            .toBe(Buffer.from(created.contentSecret).toString('base64'));

        // Permissions preserved after update
        const mode = statSync(pairing.getPairingFilePath()).mode & 0o777;
        expect(mode).toBe(0o600);
    });

    it('regenerates the pairing when the file is corrupted', async () => {
        const pairing = await importPairingModule();

        writeFileSync(pairing.getPairingFilePath(), 'not a json at all', 'utf-8');

        const regenerated = pairing.loadOrCreatePairing();
        expect(regenerated.authSecret.length).toBe(32);
        expect(regenerated.contentSecret.length).toBe(32);
        expect(regenerated.port).toBe(0);

        // File was rewritten with a valid payload
        const raw = JSON.parse(readFileSync(pairing.getPairingFilePath(), 'utf-8'));
        expect(raw.authSecret).toBe(Buffer.from(regenerated.authSecret).toString('base64'));
        expect(raw.contentSecret).toBe(Buffer.from(regenerated.contentSecret).toString('base64'));
    });

    it('regenerates the pairing when the secret has a wrong length', async () => {
        const pairing = await importPairingModule();

        writeFileSync(pairing.getPairingFilePath(), JSON.stringify({
            secret: Buffer.from('too-short').toString('base64'),
            port: 1234,
            createdAt: new Date().toISOString()
        }), 'utf-8');

        const regenerated = pairing.loadOrCreatePairing();
        expect(regenerated.authSecret.length).toBe(32);
        expect(regenerated.contentSecret.length).toBe(32);
        expect(regenerated.port).toBe(0);
    });

    it('migrates a legacy pairing into split v2 secrets without revoking existing clients', async () => {
        const pairing = await importPairingModule();
        const legacySecret = Buffer.alloc(32, 7).toString('base64');
        const createdAt = '2026-07-18T00:00:00.000Z';

        writeFileSync(pairing.getPairingFilePath(), JSON.stringify({
            secret: legacySecret,
            port: 34567,
            createdAt,
        }), 'utf-8');

        const migrated = pairing.loadOrCreatePairing();
        expect(migrated.port).toBe(34567);
        expect(migrated.createdAt).toBe(createdAt);
        expect(Buffer.from(migrated.authSecret).toString('base64')).toBe(legacySecret);
        expect(Buffer.from(migrated.contentSecret).toString('base64')).toBe(legacySecret);

        const raw = JSON.parse(readFileSync(pairing.getPairingFilePath(), 'utf-8'));
        expect(raw).toMatchObject({
            v: 2,
            authSecret: legacySecret,
            contentSecret: legacySecret,
            port: 34567,
            createdAt,
        });
    });

    it('atomically replaces the revocable auth secret while preserving the content secret', async () => {
        const pairing = await importPairingModule();
        const created = pairing.loadOrCreatePairing();
        const nextAuthSecret = new Uint8Array(32).fill(9);

        const replaced = pairing.replacePairing({
            ...created,
            authSecret: nextAuthSecret,
        });

        expect(Buffer.from(replaced.authSecret).toString('base64')).toBe(Buffer.from(nextAuthSecret).toString('base64'));
        expect(Buffer.from(replaced.contentSecret).toString('base64'))
            .toBe(Buffer.from(created.contentSecret).toString('base64'));
        expect(replaced.port).toBe(created.port);

        const loaded = pairing.loadOrCreatePairing();
        expect(Buffer.from(loaded.authSecret).toString('base64')).toBe(Buffer.from(nextAuthSecret).toString('base64'));
        expect(Buffer.from(loaded.contentSecret).toString('base64'))
            .toBe(Buffer.from(created.contentSecret).toString('base64'));
    });

    it('clearPairing removes the file and reports whether it existed', async () => {
        const pairing = await importPairingModule();

        expect(pairing.clearPairing()).toBe(false);

        pairing.loadOrCreatePairing();
        expect(pairing.clearPairing()).toBe(true);
        expect(existsSync(pairing.getPairingFilePath())).toBe(false);

        // Next load generates a brand new secret
        const fresh = pairing.loadOrCreatePairing();
        expect(fresh.authSecret.length).toBe(32);
        expect(fresh.contentSecret.length).toBe(32);
    });
});
