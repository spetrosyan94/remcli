/**
 * P2P Event Router
 * Broadcasts update and ephemeral events to connected Socket.IO clients
 * Simplified version of server's EventRouter — single-user, few connections
 */

import { Socket } from 'socket.io';
import { logger } from '@/ui/logger';

// ─── Types ───────────────────────────────────────────────────────

export type ConnectionType = 'user-scoped' | 'session-scoped' | 'machine-scoped';

export interface P2PClientConnection {
    socket: Socket;
    connectionType: ConnectionType;
    sessionId?: string;   // Only for session-scoped
    machineId?: string;   // Only for machine-scoped
}

export interface UpdatePayload {
    id: string;
    seq: number;
    body: Record<string, unknown>;
    createdAt: number;
}

export interface EphemeralPayload {
    type: string;
    [key: string]: unknown;
}

/**
 * Recipient filter determines which connections receive an event
 */
export type RecipientFilter =
    | { type: 'all-interested-in-session'; sessionId: string }
    | { type: 'user-scoped-only' }
    | { type: 'machine-scoped-only'; machineId: string }
    | { type: 'all-user-authenticated-connections' };

// ─── Router ──────────────────────────────────────────────────────

export class P2PEventRouter {
    private connections = new Set<P2PClientConnection>();

    addConnection(conn: P2PClientConnection): void {
        this.connections.add(conn);
        logger.debug(`[P2P ROUTER] Connection added: ${conn.connectionType} (total: ${this.connections.size})`);
    }

    removeConnection(conn: P2PClientConnection): void {
        this.connections.delete(conn);
        logger.debug(`[P2P ROUTER] Connection removed: ${conn.connectionType} (total: ${this.connections.size})`);
    }

    getConnectionCount(): number {
        return this.connections.size;
    }

    /**
     * Broadcast a persistent update event to matching connections
     */
    emitUpdate(payload: UpdatePayload, filter: RecipientFilter, skipSender?: Socket): void {
        for (const conn of this.connections) {
            if (skipSender && conn.socket === skipSender) continue;
            if (this.matchesFilter(conn, filter)) {
                conn.socket.emit('update', payload);
            }
        }
    }

    /**
     * Broadcast an ephemeral event to matching connections
     */
    emitEphemeral(payload: EphemeralPayload, filter: RecipientFilter, skipSender?: Socket): void {
        for (const conn of this.connections) {
            if (skipSender && conn.socket === skipSender) continue;
            if (this.matchesFilter(conn, filter)) {
                conn.socket.emit('ephemeral', payload);
            }
        }
    }

    private matchesFilter(conn: P2PClientConnection, filter: RecipientFilter): boolean {
        switch (filter.type) {
            case 'all-interested-in-session':
                // Session-scoped for that specific session + all user-scoped
                return conn.connectionType === 'user-scoped' ||
                    (conn.connectionType === 'session-scoped' && conn.sessionId === filter.sessionId);

            case 'user-scoped-only':
                return conn.connectionType === 'user-scoped';

            case 'machine-scoped-only':
                // The specific machine + all user-scoped
                return conn.connectionType === 'user-scoped' ||
                    (conn.connectionType === 'machine-scoped' && conn.machineId === filter.machineId);

            case 'all-user-authenticated-connections':
                return true;
        }
    }
}
