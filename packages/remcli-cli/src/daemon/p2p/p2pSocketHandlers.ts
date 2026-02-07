/**
 * P2P Socket.IO event handlers
 * Mirrors the server's socket handlers but uses P2PStore instead of PostgreSQL
 * All event shapes (params, callbacks) are identical to the server
 */

import { Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { P2PStore } from './p2pStore';
import { P2PEventRouter, P2PClientConnection, UpdatePayload } from './p2pEventRouter';
import { logger } from '@/ui/logger';

// ─── RPC Listener Registry ──────────────────────────────────────

interface RPCListener {
    method: string;
    socket: Socket;
}

const rpcListeners = new Map<string, RPCListener>();

// ─── Helper: Build Update Payload ────────────────────────────────

function buildUpdate(store: P2PStore, body: Record<string, unknown>): UpdatePayload {
    return {
        id: randomUUID(),
        seq: store.allocateUserSeq(),
        body,
        createdAt: Date.now()
    };
}

// ─── Register All Handlers ──────────────────────────────────────

export function registerSocketHandlers(
    socket: Socket,
    connection: P2PClientConnection,
    store: P2PStore,
    router: P2PEventRouter
): void {
    // ─── Session: message ────────────────────────────────────────
    socket.on('message', (data: { sid: string; message: string; localId?: string }) => {
        const { sid, message: msgContent, localId } = data;
        logger.debug(`[P2P SOCKET] message for session ${sid}`);

        const msg = store.addMessage(sid, msgContent, localId || null);
        if (!msg) {
            logger.debug(`[P2P SOCKET] message: session ${sid} not found`);
            return;
        }

        const update = buildUpdate(store, {
            t: 'new-message',
            sid,
            message: {
                id: msg.id,
                seq: msg.seq,
                content: msg.content,
                localId: msg.localId,
                createdAt: msg.createdAt,
                updatedAt: msg.updatedAt
            }
        });

        router.emitUpdate(update, { type: 'all-interested-in-session', sessionId: sid }, socket);
    });

    // ─── Session: update-metadata ────────────────────────────────
    socket.on('update-metadata', (
        data: { sid: string; metadata: string; expectedVersion: number },
        callback: (response: Record<string, unknown>) => void
    ) => {
        const { sid, metadata, expectedVersion } = data;
        logger.debug(`[P2P SOCKET] update-metadata for session ${sid}, expectedVersion=${expectedVersion}`);

        const result = store.updateSessionMetadata(sid, metadata, expectedVersion);
        callback(result);

        if (result.result === 'success') {
            const update = buildUpdate(store, {
                t: 'update-session',
                sid,
                metadata: { version: result.version, value: result.metadata }
            });
            router.emitUpdate(update, { type: 'all-interested-in-session', sessionId: sid }, socket);
        }
    });

    // ─── Session: update-state ───────────────────────────────────
    socket.on('update-state', (
        data: { sid: string; agentState: string | null; expectedVersion: number },
        callback: (response: Record<string, unknown>) => void
    ) => {
        const { sid, agentState, expectedVersion } = data;
        logger.debug(`[P2P SOCKET] update-state for session ${sid}`);

        const result = store.updateSessionState(sid, agentState, expectedVersion);
        callback(result);

        if (result.result === 'success') {
            const update = buildUpdate(store, {
                t: 'update-session',
                sid,
                agentState: { version: result.version, value: result.agentState }
            });
            router.emitUpdate(update, { type: 'all-interested-in-session', sessionId: sid }, socket);
        }
    });

    // ─── Session: session-alive ──────────────────────────────────
    socket.on('session-alive', (data: { sid: string; time: number; thinking?: boolean; mode?: string }) => {
        const { sid, time, thinking } = data;
        store.setSessionActive(sid, true);

        router.emitEphemeral({
            type: 'activity',
            id: sid,
            active: true,
            activeAt: time,
            thinking: thinking || false
        }, { type: 'user-scoped-only' });
    });

    // ─── Session: session-end ────────────────────────────────────
    socket.on('session-end', (data: { sid: string; time: number }) => {
        const { sid, time } = data;
        store.setSessionActive(sid, false);

        router.emitEphemeral({
            type: 'activity',
            id: sid,
            active: false,
            activeAt: time,
            thinking: false
        }, { type: 'user-scoped-only' });
    });

    // ─── Machine: machine-alive ──────────────────────────────────
    socket.on('machine-alive', (data: { machineId: string; time: number }) => {
        const { machineId, time } = data;

        router.emitEphemeral({
            type: 'machine-activity',
            id: machineId,
            active: true,
            activeAt: time
        }, { type: 'user-scoped-only' });
    });

    // ─── Machine: machine-update-metadata ────────────────────────
    socket.on('machine-update-metadata', (
        data: { machineId: string; metadata: string; expectedVersion: number },
        callback: (response: Record<string, unknown>) => void
    ) => {
        const { machineId, metadata, expectedVersion } = data;
        logger.debug(`[P2P SOCKET] machine-update-metadata for ${machineId}`);

        const result = store.updateMachineMetadata(machineId, metadata, expectedVersion);
        callback(result);

        if (result.result === 'success') {
            const update = buildUpdate(store, {
                t: 'update-machine',
                machineId,
                metadata: { version: result.version, value: result.metadata }
            });
            router.emitUpdate(update, { type: 'machine-scoped-only', machineId }, socket);
        }
    });

    // ─── Machine: machine-update-state ───────────────────────────
    socket.on('machine-update-state', (
        data: { machineId: string; daemonState: string; expectedVersion: number },
        callback: (response: Record<string, unknown>) => void
    ) => {
        const { machineId, daemonState, expectedVersion } = data;
        logger.debug(`[P2P SOCKET] machine-update-state for ${machineId}`);

        const result = store.updateMachineDaemonState(machineId, daemonState, expectedVersion);
        callback(result);

        if (result.result === 'success') {
            const update = buildUpdate(store, {
                t: 'update-machine',
                machineId,
                daemonState: { version: result.version, value: result.daemonState }
            });
            router.emitUpdate(update, { type: 'machine-scoped-only', machineId }, socket);
        }
    });

    // ─── RPC: register ───────────────────────────────────────────
    socket.on('rpc-register', (data: { method: string }) => {
        const { method } = data;
        logger.debug(`[P2P SOCKET] rpc-register: ${method}`);

        if (rpcListeners.has(method)) {
            socket.emit('rpc-error', { type: 'register', error: `Method ${method} already registered` });
            return;
        }

        rpcListeners.set(method, { method, socket });
        socket.emit('rpc-registered', { method });
    });

    // ─── RPC: unregister ─────────────────────────────────────────
    socket.on('rpc-unregister', (data: { method: string }) => {
        const { method } = data;
        logger.debug(`[P2P SOCKET] rpc-unregister: ${method}`);

        const listener = rpcListeners.get(method);
        if (!listener || listener.socket !== socket) {
            socket.emit('rpc-error', { type: 'unregister', error: `Method ${method} not registered by this socket` });
            return;
        }

        rpcListeners.delete(method);
        socket.emit('rpc-unregistered', { method });
    });

    // ─── RPC: call ───────────────────────────────────────────────
    socket.on('rpc-call', async (
        data: { method: string; params?: string },
        callback: (response: { ok: boolean; result?: string; error?: string }) => void
    ) => {
        const { method, params } = data;
        logger.debug(`[P2P SOCKET] rpc-call: ${method}`);

        const listener = rpcListeners.get(method);
        if (!listener) {
            callback({ ok: false, error: `No handler registered for method: ${method}` });
            return;
        }

        try {
            const response = await listener.socket.timeout(30000).emitWithAck('rpc-request', { method, params });
            callback({ ok: true, result: response });
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.debug(`[P2P SOCKET] rpc-call error for ${method}: ${errorMessage}`);
            callback({ ok: false, error: errorMessage });
        }
    });

    // ─── Ping ────────────────────────────────────────────────────
    socket.on('ping', (callback: (response: Record<string, unknown>) => void) => {
        callback({});
    });

    // ─── Usage Report ────────────────────────────────────────────
    socket.on('usage-report', (data: {
        key: string;
        sessionId?: string;
        tokens: Record<string, number>;
        cost: Record<string, number>;
    }) => {
        const { key, sessionId, tokens, cost } = data;

        if (sessionId) {
            router.emitEphemeral({
                type: 'usage',
                id: sessionId,
                key,
                tokens,
                cost,
                timestamp: Date.now()
            }, { type: 'user-scoped-only' });
        }
    });

    // ─── Artifacts ───────────────────────────────────────────────

    socket.on('artifact-create', (
        data: { id: string; header: string; body: string; dataEncryptionKey: string },
        callback: (response: Record<string, unknown>) => void
    ) => {
        const artifact = store.createArtifact(data.id, data.header, data.body, data.dataEncryptionKey);

        callback({
            result: 'success',
            artifact: {
                id: artifact.id,
                header: artifact.header,
                headerVersion: artifact.headerVersion,
                body: artifact.body,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt
            }
        });

        const update = buildUpdate(store, {
            t: 'new-artifact',
            artifactId: artifact.id,
            seq: artifact.seq,
            header: artifact.header,
            headerVersion: artifact.headerVersion,
            body: artifact.body,
            bodyVersion: artifact.bodyVersion,
            dataEncryptionKey: artifact.dataEncryptionKey,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt
        });
        router.emitUpdate(update, { type: 'user-scoped-only' }, socket);
    });

    socket.on('artifact-read', (
        data: { artifactId: string },
        callback: (response: Record<string, unknown>) => void
    ) => {
        const artifact = store.getArtifact(data.artifactId);
        if (!artifact) {
            callback({ result: 'error', message: 'Artifact not found' });
            return;
        }
        callback({
            result: 'success',
            artifact: {
                id: artifact.id,
                header: artifact.header,
                headerVersion: artifact.headerVersion,
                body: artifact.body,
                bodyVersion: artifact.bodyVersion,
                seq: artifact.seq,
                createdAt: artifact.createdAt,
                updatedAt: artifact.updatedAt
            }
        });
    });

    socket.on('artifact-update', (
        data: {
            artifactId: string;
            header?: { data: string; expectedVersion: number };
            body?: { data: string; expectedVersion: number };
        },
        callback: (response: Record<string, unknown>) => void
    ) => {
        const { artifactId } = data;
        const artifact = store.getArtifact(artifactId);
        if (!artifact) {
            callback({ result: 'error', message: 'Artifact not found' });
            return;
        }

        let headerResult: { version: number; data: string } | undefined;
        let bodyResult: { version: number; data: string } | undefined;

        if (data.header) {
            const r = store.updateArtifactHeader(artifactId, data.header.data, data.header.expectedVersion);
            if (r.result === 'version-mismatch') {
                callback({
                    result: 'version-mismatch',
                    header: { currentVersion: r.version, currentData: r.data }
                });
                return;
            }
            headerResult = { version: r.version, data: r.data };
        }

        if (data.body) {
            const r = store.updateArtifactBody(artifactId, data.body.data, data.body.expectedVersion);
            if (r.result === 'version-mismatch') {
                callback({
                    result: 'version-mismatch',
                    body: { currentVersion: r.version, currentData: r.data }
                });
                return;
            }
            bodyResult = { version: r.version, data: r.data };
        }

        const response: Record<string, unknown> = { result: 'success' };
        if (headerResult) response.header = headerResult;
        if (bodyResult) response.body = bodyResult;
        callback(response);

        // Broadcast update
        const updateBody: Record<string, unknown> = { t: 'update-artifact', artifactId };
        if (headerResult) updateBody.header = { version: headerResult.version, value: headerResult.data };
        if (bodyResult) updateBody.body = { version: bodyResult.version, value: bodyResult.data };

        const update = buildUpdate(store, updateBody);
        router.emitUpdate(update, { type: 'user-scoped-only' }, socket);
    });

    socket.on('artifact-delete', (
        data: { artifactId: string },
        callback: (response: Record<string, unknown>) => void
    ) => {
        const deleted = store.deleteArtifact(data.artifactId);
        if (!deleted) {
            callback({ result: 'error', message: 'Artifact not found' });
            return;
        }
        callback({ result: 'success' });

        const update = buildUpdate(store, {
            t: 'delete-artifact',
            artifactId: data.artifactId
        });
        router.emitUpdate(update, { type: 'user-scoped-only' }, socket);
    });

    // ─── Cleanup on disconnect ───────────────────────────────────
    socket.on('disconnect', () => {
        logger.debug(`[P2P SOCKET] Client disconnected: ${connection.connectionType}`);

        // Remove all RPC listeners registered by this socket
        for (const [method, listener] of rpcListeners.entries()) {
            if (listener.socket === socket) {
                rpcListeners.delete(method);
                logger.debug(`[P2P SOCKET] Cleaned up RPC listener: ${method}`);
            }
        }

        router.removeConnection(connection);
    });
}
