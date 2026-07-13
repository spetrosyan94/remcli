/**
 * P2P in-memory data store
 * Replaces PostgreSQL for local P2P mode
 * Stores sessions, messages, machines with sequence numbering
 * Sessions/messages/machines live only in memory — each daemon session generates
 * a new shared secret. The KV store is the exception: it survives daemon restarts
 * via a debounced, atomically-written JSON file (~/.remcli/kv-store.json).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

// ─── Types ───────────────────────────────────────────────────────

export interface P2PSession {
    id: string;
    tag: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: string | null;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
}

export interface P2PMessage {
    id: string;
    sessionId: string;
    seq: number;
    content: { t: 'encrypted'; c: string };
    localId: string | null;
    isSessionDelivery: boolean;
    createdAt: number;
    updatedAt: number;
}

export interface P2PMachine {
    id: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    daemonState: string | null;
    daemonStateVersion: number;
    dataEncryptionKey: string | null;
    active: boolean;
    activeAt: number;
    createdAt: number;
    updatedAt: number;
}

export interface P2PKvItem {
    key: string;
    value: string;
    version: number;
}

export interface KvMutation {
    key: string;
    value: string | null;  // null deletes the key
    version: number;       // -1 for new keys (key must not exist)
}

export interface KvChange {
    key: string;
    value: string | null;
    version: number;
}

export type KvMutateResult =
    | { success: true; results: Array<{ key: string; version: number }>; changes: KvChange[] }
    | { success: false; errors: Array<{ key: string; error: 'version-mismatch'; version: number; value: string | null }> };

/** Version reported for keys that do not exist — matches the client's "new key" sentinel. */
const KV_MISSING_VERSION = -1;
/** Debounce window for KV disk persistence. */
const KV_PERSIST_DEBOUNCE_MS = 500;

const KvFileSchema = z.object({
    items: z.array(z.object({
        key: z.string(),
        value: z.string(),
        version: z.number().int()
    }))
});

// ─── Store ───────────────────────────────────────────────────────

export class P2PStore {
    private sessions = new Map<string, P2PSession>();
    private sessionMessages = new Map<string, P2PMessage[]>();
    private machines = new Map<string, P2PMachine>();
    private userSeq = 0;
    private sessionSeqs = new Map<string, number>();
    private sessionDeletedListeners: Array<(sessionId: string) => void> = [];
    private kvItems = new Map<string, P2PKvItem>();
    private readonly kvFilePath: string | null;
    private kvPersistTimer: NodeJS.Timeout | null = null;
    /** The daemon's own machine — protected from deletion via REST. */
    private ownMachineId: string | null = null;
    /** Machines explicitly deleted by the user — must not silently reappear. */
    private deletedMachineIds = new Set<string>();
    /** Sessions stopped by an explicit user action — stale keep-alives must not revive them. */
    private terminalStoppedSessionIds = new Set<string>();

    /**
     * @param options.kvFilePath Where to persist the KV store.
     *   `undefined` (default) → `<remcliHomeDir>/kv-store.json`; `null` → in-memory only (tests).
     */
    constructor(options?: { kvFilePath?: string | null }) {
        this.kvFilePath = options?.kvFilePath === undefined
            ? join(configuration.remcliHomeDir, 'kv-store.json')
            : options.kvFilePath;
        this.loadKvFromDisk();
    }

    /**
     * Register a listener invoked whenever a session is deleted.
     * Used by the P2P server to drop per-session bookkeeping (e.g. replay tracking)
     * so it does not leak memory as sessions come and go.
     */
    onSessionDeleted(listener: (sessionId: string) => void): void {
        this.sessionDeletedListeners.push(listener);
    }

    // ─── Sequences ───────────────────────────────────────────────

    allocateUserSeq(): number {
        return ++this.userSeq;
    }

    allocateSessionSeq(sessionId: string): number {
        const current = this.sessionSeqs.get(sessionId) || 0;
        const next = current + 1;
        this.sessionSeqs.set(sessionId, next);
        return next;
    }

    // ─── Sessions ────────────────────────────────────────────────

    createSession(tag: string, metadata: string, dataEncryptionKey: string | null): P2PSession {
        // Check if session with this tag already exists
        for (const session of this.sessions.values()) {
            if (session.tag === tag) {
                // Update metadata if re-creating with same tag
                session.metadata = metadata;
                session.metadataVersion++;
                session.active = true;
                session.activeAt = Date.now();
                session.updatedAt = Date.now();
                this.terminalStoppedSessionIds.delete(session.id);
                if (dataEncryptionKey !== null) {
                    session.dataEncryptionKey = dataEncryptionKey;
                }
                return session;
            }
        }

        const now = Date.now();
        const session: P2PSession = {
            id: randomUUID(),
            tag,
            seq: this.allocateUserSeq(),
            metadata,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 1,
            dataEncryptionKey,
            active: true,
            activeAt: now,
            createdAt: now,
            updatedAt: now
        };

        this.sessions.set(session.id, session);
        this.sessionMessages.set(session.id, []);
        return session;
    }

    getSession(id: string): P2PSession | undefined {
        return this.sessions.get(id);
    }

    getSessionByTag(tag: string): P2PSession | undefined {
        for (const session of this.sessions.values()) {
            if (session.tag === tag) return session;
        }
        return undefined;
    }

    getSessions(): P2PSession[] {
        return Array.from(this.sessions.values())
            .sort((a, b) => b.updatedAt - a.updatedAt);
    }

    getActiveSessions(limit: number = 150): P2PSession[] {
        const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
        return this.getSessions()
            .filter(s => s.active && s.activeAt > fifteenMinutesAgo)
            .slice(0, limit);
    }

    deleteSession(id: string): boolean {
        const existed = this.sessions.delete(id);
        this.sessionMessages.delete(id);
        this.sessionSeqs.delete(id);
        this.terminalStoppedSessionIds.delete(id);
        if (existed) {
            for (const listener of this.sessionDeletedListeners) {
                listener(id);
            }
        }
        return existed;
    }

    /**
     * Update session metadata with optimistic concurrency control
     * Returns null on version mismatch (caller should retry)
     */
    updateSessionMetadata(sessionId: string, metadata: string, expectedVersion: number): {
        result: 'success' | 'version-mismatch' | 'error';
        version: number;
        metadata: string;
    } {
        const session = this.sessions.get(sessionId);
        if (!session) return { result: 'error', version: 0, metadata: '' };

        if (session.metadataVersion !== expectedVersion) {
            return {
                result: 'version-mismatch',
                version: session.metadataVersion,
                metadata: session.metadata
            };
        }

        session.metadata = metadata;
        session.metadataVersion++;
        session.updatedAt = Date.now();

        return {
            result: 'success',
            version: session.metadataVersion,
            metadata: session.metadata
        };
    }

    /**
     * Update session agent state with optimistic concurrency control
     */
    updateSessionState(sessionId: string, agentState: string | null, expectedVersion: number): {
        result: 'success' | 'version-mismatch' | 'error';
        version: number;
        agentState: string | null;
    } {
        const session = this.sessions.get(sessionId);
        if (!session) return { result: 'error', version: 0, agentState: null };

        if (session.agentStateVersion !== expectedVersion) {
            return {
                result: 'version-mismatch',
                version: session.agentStateVersion,
                agentState: session.agentState
            };
        }

        session.agentState = agentState;
        session.agentStateVersion++;
        session.updatedAt = Date.now();

        return {
            result: 'success',
            version: session.agentStateVersion,
            agentState: session.agentState
        };
    }

    setSessionActive(sessionId: string, active: boolean, activeAt: number = Date.now()): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        if (active && this.terminalStoppedSessionIds.has(sessionId)) return false;
        if (activeAt < session.activeAt) return false;
        session.active = active;
        session.activeAt = activeAt;
        session.updatedAt = activeAt;
        return true;
    }

    markSessionStopped(sessionId: string, activeAt: number = Date.now()): boolean {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        this.terminalStoppedSessionIds.add(sessionId);
        session.active = false;
        session.activeAt = activeAt;
        session.updatedAt = activeAt;
        return true;
    }

    // ─── Messages ────────────────────────────────────────────────

    addMessage(
        sessionId: string,
        content: string,
        localId: string | null,
        isSessionDelivery: boolean
    ): P2PMessage | null {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        const now = Date.now();
        const message: P2PMessage = {
            id: randomUUID(),
            sessionId,
            seq: this.allocateSessionSeq(sessionId),
            content: { t: 'encrypted', c: content },
            localId,
            isSessionDelivery,
            createdAt: now,
            updatedAt: now
        };

        let messages = this.sessionMessages.get(sessionId);
        if (!messages) {
            messages = [];
            this.sessionMessages.set(sessionId, messages);
        }
        messages.push(message);

        // Update timestamps but do NOT change session.active —
        // active state is controlled only by session-alive / session-end events from the agent
        session.updatedAt = now;

        return message;
    }

    getMessages(sessionId: string, limit: number = 150, offset: number = 0): P2PMessage[] {
        const messages = this.sessionMessages.get(sessionId) || [];
        const total = messages.length;
        // Messages stored oldest-first in array. We want newest-first for the app.
        // offset=0 → last `limit` messages (newest)
        // offset=50 → skip last 50, then take `limit` messages
        const end = total - offset;
        const start = Math.max(0, end - limit);
        if (end <= 0) return [];
        return messages.slice(start, end).reverse();
    }

    /**
     * Returns runner-directed messages after a session-local delivery cursor.
     * Messages are ordered oldest-first so a reconnect preserves prompt order.
     */
    getSessionDeliveryMessagesAfter(sessionId: string, acknowledgedSequence: number): P2PMessage[] {
        return (this.sessionMessages.get(sessionId) || [])
            .filter((message) => message.isSessionDelivery && message.seq > acknowledgedSequence);
    }

    getMessageCount(sessionId: string): number {
        return (this.sessionMessages.get(sessionId) || []).length;
    }

    // ─── Machines ────────────────────────────────────────────────

    getOrCreateMachine(
        id: string,
        metadata: string,
        daemonState: string | null,
        dataEncryptionKey: string | null
    ): P2PMachine | null {
        // A machine explicitly deleted by the user must not be resurrected automatically.
        if (this.deletedMachineIds.has(id)) {
            return null;
        }
        const existing = this.machines.get(id);
        if (existing) {
            existing.metadata = metadata;
            existing.metadataVersion++;
            if (daemonState !== null) {
                existing.daemonState = daemonState;
                existing.daemonStateVersion++;
            }
            if (dataEncryptionKey !== null) {
                existing.dataEncryptionKey = dataEncryptionKey;
            }
            existing.active = true;
            existing.activeAt = Date.now();
            existing.updatedAt = Date.now();
            return existing;
        }

        const now = Date.now();
        const machine: P2PMachine = {
            id,
            seq: this.allocateUserSeq(),
            metadata,
            metadataVersion: 1,
            daemonState,
            daemonStateVersion: 1,
            dataEncryptionKey,
            active: true,
            activeAt: now,
            createdAt: now,
            updatedAt: now
        };

        this.machines.set(id, machine);
        return machine;
    }

    getMachine(id: string): P2PMachine | undefined {
        return this.machines.get(id);
    }

    getMachines(): P2PMachine[] {
        return Array.from(this.machines.values())
            .sort((a, b) => b.activeAt - a.activeAt);
    }

    updateMachineMetadata(machineId: string, metadata: string, expectedVersion: number): {
        result: 'success' | 'version-mismatch' | 'error';
        version: number;
        metadata: string;
    } {
        const machine = this.machines.get(machineId);
        if (!machine) return { result: 'error', version: 0, metadata: '' };

        if (machine.metadataVersion !== expectedVersion) {
            return {
                result: 'version-mismatch',
                version: machine.metadataVersion,
                metadata: machine.metadata
            };
        }

        machine.metadata = metadata;
        machine.metadataVersion++;
        machine.updatedAt = Date.now();

        return {
            result: 'success',
            version: machine.metadataVersion,
            metadata: machine.metadata
        };
    }

    updateMachineDaemonState(machineId: string, daemonState: string, expectedVersion: number): {
        result: 'success' | 'version-mismatch' | 'error';
        version: number;
        daemonState: string;
    } {
        const machine = this.machines.get(machineId);
        if (!machine) return { result: 'error', version: 0, daemonState: '' };

        if (machine.daemonStateVersion !== expectedVersion) {
            return {
                result: 'version-mismatch',
                version: machine.daemonStateVersion,
                daemonState: machine.daemonState || ''
            };
        }

        machine.daemonState = daemonState;
        machine.daemonStateVersion++;
        machine.active = true;
        machine.activeAt = Date.now();
        machine.updatedAt = Date.now();

        return {
            result: 'success',
            version: machine.daemonStateVersion,
            daemonState: machine.daemonState
        };
    }

    /**
     * Mark a machine as the daemon's own. The only machine-scoped client is the
     * daemon's self-connection (bootstrapMachineSocket), so the P2P server calls
     * this when such a connection arrives. The own machine cannot be deleted.
     */
    markOwnMachine(id: string): void {
        this.ownMachineId = id;
    }

    isOwnMachine(id: string): boolean {
        return this.ownMachineId === id;
    }

    /**
     * Delete a machine and tombstone its id so it is not auto-recreated
     * (tombstones live for the daemon's lifetime — the store is per-run anyway).
     */
    deleteMachine(id: string): boolean {
        const existed = this.machines.delete(id);
        if (existed) {
            this.deletedMachineIds.add(id);
        }
        return existed;
    }

    // ─── Key-Value store (persisted) ─────────────────────────────

    kvGet(key: string): P2PKvItem | undefined {
        return this.kvItems.get(key);
    }

    kvList(prefix?: string, limit?: number): P2PKvItem[] {
        let items = Array.from(this.kvItems.values());
        if (prefix) {
            items = items.filter(item => item.key.startsWith(prefix));
        }
        items.sort((a, b) => a.key.localeCompare(b.key));
        return limit !== undefined ? items.slice(0, limit) : items;
    }

    kvBulkGet(keys: string[]): P2PKvItem[] {
        const values: P2PKvItem[] = [];
        for (const key of keys) {
            const item = this.kvItems.get(key);
            if (item) values.push(item);
        }
        return values;
    }

    /**
     * Atomically apply a batch of KV mutations with optimistic concurrency control.
     * Version semantics match the app client (`apiKv.ts`): `-1` means "key must not
     * exist"; any mismatch fails the WHOLE batch and reports the current version and
     * value for each conflicting key so the client can rebase.
     */
    kvMutate(mutations: KvMutation[]): KvMutateResult {
        const errors: Array<{ key: string; error: 'version-mismatch'; version: number; value: string | null }> = [];
        for (const mutation of mutations) {
            const current = this.kvItems.get(mutation.key);
            const currentVersion = current ? current.version : KV_MISSING_VERSION;
            if (mutation.version !== currentVersion) {
                errors.push({
                    key: mutation.key,
                    error: 'version-mismatch',
                    version: currentVersion,
                    value: current ? current.value : null
                });
            }
        }
        if (errors.length > 0) {
            return { success: false, errors };
        }

        const results: Array<{ key: string; version: number }> = [];
        const changes: KvChange[] = [];
        for (const mutation of mutations) {
            if (mutation.value === null) {
                this.kvItems.delete(mutation.key);
                results.push({ key: mutation.key, version: KV_MISSING_VERSION });
                changes.push({ key: mutation.key, value: null, version: KV_MISSING_VERSION });
            } else {
                const newVersion = mutation.version === KV_MISSING_VERSION ? 1 : mutation.version + 1;
                this.kvItems.set(mutation.key, { key: mutation.key, value: mutation.value, version: newVersion });
                results.push({ key: mutation.key, version: newVersion });
                changes.push({ key: mutation.key, value: mutation.value, version: newVersion });
            }
        }
        this.scheduleKvPersist();
        return { success: true, results, changes };
    }

    /**
     * Write the KV store to disk immediately (atomic temp + rename).
     * Cancels any pending debounced write. Safe to call at any time.
     */
    flushKvToDisk(): void {
        if (!this.kvFilePath) return;
        if (this.kvPersistTimer) {
            clearTimeout(this.kvPersistTimer);
            this.kvPersistTimer = null;
        }
        try {
            mkdirSync(dirname(this.kvFilePath), { recursive: true });
            const tempPath = `${this.kvFilePath}.tmp`;
            writeFileSync(tempPath, JSON.stringify({ items: Array.from(this.kvItems.values()) }, null, 2), 'utf-8');
            renameSync(tempPath, this.kvFilePath);
        } catch (error) {
            logger.debug('[P2P STORE] Failed to persist KV store:', error);
        }
    }

    private scheduleKvPersist(): void {
        if (!this.kvFilePath || this.kvPersistTimer) return;
        this.kvPersistTimer = setTimeout(() => {
            this.kvPersistTimer = null;
            this.flushKvToDisk();
        }, KV_PERSIST_DEBOUNCE_MS);
        // A pending KV write must not keep the daemon process alive on shutdown.
        this.kvPersistTimer.unref();
    }

    private loadKvFromDisk(): void {
        if (!this.kvFilePath) return;
        try {
            const content = readFileSync(this.kvFilePath, 'utf-8');
            const parsed = KvFileSchema.safeParse(JSON.parse(content));
            if (!parsed.success) {
                logger.debug(`[P2P STORE] KV store file has invalid shape, starting empty: ${this.kvFilePath}`);
                return;
            }
            for (const item of parsed.data.items) {
                this.kvItems.set(item.key, item);
            }
        } catch (error) {
            // Missing file is the normal first-run case; corrupted JSON starts empty.
            const isMissing = error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
            if (!isMissing) {
                logger.debug('[P2P STORE] Failed to load KV store, starting empty:', error);
            }
        }
    }
}
