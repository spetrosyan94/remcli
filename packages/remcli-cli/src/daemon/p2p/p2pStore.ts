/**
 * P2P in-memory data store
 * Replaces PostgreSQL for local P2P mode
 * Stores sessions, messages, machines with sequence numbering
 * Data lives only in memory — each daemon session generates a new shared secret
 */

import { randomUUID } from 'node:crypto';

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

export interface P2PArtifact {
    id: string;
    seq: number;
    header: string;
    headerVersion: number;
    body: string;
    bodyVersion: number;
    dataEncryptionKey: string;
    createdAt: number;
    updatedAt: number;
}

// ─── Store ───────────────────────────────────────────────────────

export class P2PStore {
    private sessions = new Map<string, P2PSession>();
    private sessionMessages = new Map<string, P2PMessage[]>();
    private machines = new Map<string, P2PMachine>();
    private artifacts = new Map<string, P2PArtifact>();
    private userSeq = 0;
    private sessionSeqs = new Map<string, number>();

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

    setSessionActive(sessionId: string, active: boolean): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        session.active = active;
        session.activeAt = Date.now();
        session.updatedAt = Date.now();
    }

    // ─── Messages ────────────────────────────────────────────────

    addMessage(sessionId: string, content: string, localId: string | null): P2PMessage | null {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        const now = Date.now();
        const message: P2PMessage = {
            id: randomUUID(),
            sessionId,
            seq: this.allocateSessionSeq(sessionId),
            content: { t: 'encrypted', c: content },
            localId,
            createdAt: now,
            updatedAt: now
        };

        let messages = this.sessionMessages.get(sessionId);
        if (!messages) {
            messages = [];
            this.sessionMessages.set(sessionId, messages);
        }
        messages.push(message);

        // Update session activity
        session.activeAt = now;
        session.updatedAt = now;
        session.active = true;

        return message;
    }

    getMessages(sessionId: string, limit: number = 150): P2PMessage[] {
        const messages = this.sessionMessages.get(sessionId) || [];
        // Return last N messages, sorted by createdAt desc (newest first, as server does)
        return messages.slice(-limit).reverse();
    }

    // ─── Machines ────────────────────────────────────────────────

    getOrCreateMachine(
        id: string,
        metadata: string,
        daemonState: string | null,
        dataEncryptionKey: string | null
    ): P2PMachine {
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

    // ─── Artifacts ───────────────────────────────────────────────

    createArtifact(id: string, header: string, body: string, dataEncryptionKey: string): P2PArtifact {
        const now = Date.now();
        const artifact: P2PArtifact = {
            id,
            seq: this.allocateUserSeq(),
            header,
            headerVersion: 1,
            body,
            bodyVersion: 1,
            dataEncryptionKey,
            createdAt: now,
            updatedAt: now
        };
        this.artifacts.set(id, artifact);
        return artifact;
    }

    getArtifact(id: string): P2PArtifact | undefined {
        return this.artifacts.get(id);
    }

    updateArtifactHeader(artifactId: string, header: string, expectedVersion: number): {
        result: 'success' | 'version-mismatch' | 'error';
        version: number;
        data: string;
    } {
        const artifact = this.artifacts.get(artifactId);
        if (!artifact) return { result: 'error', version: 0, data: '' };

        if (artifact.headerVersion !== expectedVersion) {
            return { result: 'version-mismatch', version: artifact.headerVersion, data: artifact.header };
        }

        artifact.header = header;
        artifact.headerVersion++;
        artifact.updatedAt = Date.now();

        return { result: 'success', version: artifact.headerVersion, data: artifact.header };
    }

    updateArtifactBody(artifactId: string, body: string, expectedVersion: number): {
        result: 'success' | 'version-mismatch' | 'error';
        version: number;
        data: string;
    } {
        const artifact = this.artifacts.get(artifactId);
        if (!artifact) return { result: 'error', version: 0, data: '' };

        if (artifact.bodyVersion !== expectedVersion) {
            return { result: 'version-mismatch', version: artifact.bodyVersion, data: artifact.body };
        }

        artifact.body = body;
        artifact.bodyVersion++;
        artifact.updatedAt = Date.now();

        return { result: 'success', version: artifact.bodyVersion, data: artifact.body };
    }

    deleteArtifact(id: string): boolean {
        const existed = this.artifacts.delete(id);
        return existed;
    }

}
