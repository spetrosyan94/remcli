/**
 * Client-side protocol state (zustand) — minimal port of remcli-app
 * sources/sync/storage.ts + reducer/ message handling:
 * decrypted machines/sessions, per-session normalized messages
 * (createdAt-ordered, deduplicated, local echo replaced by server copy),
 * and socket connection status.
 */

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { ConnectionStatus } from '@/lib/protocol/socket';
import type { NormalizedMessage } from '@/lib/protocol/messages';
import type { Machine, Session } from '@/lib/protocol/types';

// ─── Message merge (createdAt order + dedup) ─────────────────────

function sortMessages(messages: NormalizedMessage[]): NormalizedMessage[] {
    // Chronological order (matches remcli-app storage.ts). The daemon skips the
    // sender socket when broadcasting new-message, so a local echo keeps seq=null
    // forever — only createdAt interleaves it correctly with seq-numbered messages.
    // seq breaks ties between server messages created in the same millisecond.
    return [...messages].sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        if (a.seq !== null && b.seq !== null) return a.seq - b.seq;
        if (a.seq !== null) return -1;
        if (b.seq !== null) return 1;
        return 0;
    });
}

function mergeMessages(existing: NormalizedMessage[], incoming: NormalizedMessage[]): NormalizedMessage[] {
    const byId = new Map<string, NormalizedMessage>();
    for (const message of existing) {
        byId.set(message.id, message);
    }
    for (const message of incoming) {
        // Server copy of a locally-echoed message: local echo used localId as id
        if (message.localId && message.localId !== message.id && byId.has(message.localId)) {
            byId.delete(message.localId);
        }
        byId.set(message.id, message);
    }
    return sortMessages([...byId.values()]);
}

// ─── Store ───────────────────────────────────────────────────────

interface SessionMessagesState {
    messages: NormalizedMessage[];
    /** True once the newest page has been loaded via REST. */
    isLoaded: boolean;
}

interface ProtocolState {
    connectionStatus: ConnectionStatus;
    /** True when stored credentials exist and the client is initialized. */
    isAuthenticated: boolean;
    /** GET /health round-trip to the daemon in ms; null until measured / on failure. */
    latencyMs: number | null;
    machines: Record<string, Machine>;
    sessions: Record<string, Session>;
    sessionMessages: Record<string, SessionMessagesState>;
}

interface ProtocolActions {
    setConnectionStatus: (status: ConnectionStatus) => void;
    setAuthenticated: (isAuthenticated: boolean) => void;
    setLatency: (latencyMs: number | null) => void;
    applySessions: (sessions: Session[]) => void;
    removeSession: (sessionId: string) => void;
    applyMachines: (machines: Machine[]) => void;
    removeMachine: (machineId: string) => void;
    applyMessages: (sessionId: string, messages: NormalizedMessage[], options?: { markLoaded?: boolean }) => void;
    applySessionActivity: (sessionId: string, active: boolean, activeAt: number, thinking: boolean) => void;
    applyMachineActivity: (machineId: string, active: boolean, activeAt: number) => void;
    reset: () => void;
}

const initialState: ProtocolState = {
    connectionStatus: 'disconnected',
    isAuthenticated: false,
    latencyMs: null,
    machines: {},
    sessions: {},
    sessionMessages: {}
};

export const useProtocolStore = create<ProtocolState & ProtocolActions>()((set) => ({
    ...initialState,

    setConnectionStatus: (status) => set({ connectionStatus: status }),

    setAuthenticated: (isAuthenticated) => set({ isAuthenticated }),

    setLatency: (latencyMs) => set({ latencyMs }),

    applySessions: (sessions) => set((state) => {
        const next = { ...state.sessions };
        for (const session of sessions) {
            next[session.id] = session;
        }
        return { sessions: next };
    }),

    removeSession: (sessionId) => set((state) => {
        if (!state.sessions[sessionId] && !state.sessionMessages[sessionId]) return {};
        const sessions = { ...state.sessions };
        delete sessions[sessionId];
        const sessionMessages = { ...state.sessionMessages };
        delete sessionMessages[sessionId];
        return { sessions, sessionMessages };
    }),

    applyMachines: (machines) => set((state) => {
        const next = { ...state.machines };
        for (const machine of machines) {
            next[machine.id] = machine;
        }
        return { machines: next };
    }),

    removeMachine: (machineId) => set((state) => {
        if (!state.machines[machineId]) return {};
        const machines = { ...state.machines };
        delete machines[machineId];
        return { machines };
    }),

    applyMessages: (sessionId, messages, options) => set((state) => {
        const current = state.sessionMessages[sessionId] ?? { messages: [], isLoaded: false };
        return {
            sessionMessages: {
                ...state.sessionMessages,
                [sessionId]: {
                    messages: mergeMessages(current.messages, messages),
                    isLoaded: current.isLoaded || (options?.markLoaded ?? false)
                }
            }
        };
    }),

    applySessionActivity: (sessionId, active, activeAt, thinking) => set((state) => {
        const session = state.sessions[sessionId];
        if (!session) return {};
        return {
            sessions: {
                ...state.sessions,
                [sessionId]: {
                    ...session,
                    active,
                    activeAt,
                    thinking,
                    thinkingAt: thinking ? activeAt : session.thinkingAt,
                    presence: active ? 'online' : activeAt
                }
            }
        };
    }),

    applyMachineActivity: (machineId, active, activeAt) => set((state) => {
        const machine = state.machines[machineId];
        if (!machine) return {};
        return {
            machines: {
                ...state.machines,
                [machineId]: { ...machine, active, activeAt }
            }
        };
    }),

    reset: () => set({ ...initialState })
}));

// ─── Selector hooks ──────────────────────────────────────────────

const EMPTY_MESSAGES: NormalizedMessage[] = [];

/** Socket connection status: disconnected | connecting | connected | error. */
export function useConnectionStatus(): ConnectionStatus {
    return useProtocolStore((state) => state.connectionStatus);
}

/** True when a stored connection exists and the client is initialized. */
export function useIsAuthenticated(): boolean {
    return useProtocolStore((state) => state.isAuthenticated);
}

/** Daemon GET /health latency in ms (measured every ~30s); null until known. */
export function useLatencyMs(): number | null {
    return useProtocolStore((state) => state.latencyMs);
}

/** All known machines, most recently active first. */
export function useMachines(): Machine[] {
    return useProtocolStore(useShallow((state) =>
        Object.values(state.machines).sort((a, b) => b.activeAt - a.activeAt)
    ));
}

export function useMachine(machineId: string | null | undefined): Machine | null {
    return useProtocolStore((state) => (machineId ? state.machines[machineId] ?? null : null));
}

/** All known sessions, most recently updated first. */
export function useSessions(): Session[] {
    return useProtocolStore(useShallow((state) =>
        Object.values(state.sessions).sort((a, b) => b.updatedAt - a.updatedAt)
    ));
}

export function useSession(sessionId: string | null | undefined): Session | null {
    return useProtocolStore((state) => (sessionId ? state.sessions[sessionId] ?? null : null));
}

/** Normalized messages of a session in display order (oldest first). */
export function useSessionMessages(sessionId: string | null | undefined): NormalizedMessage[] {
    return useProtocolStore((state) =>
        sessionId ? state.sessionMessages[sessionId]?.messages ?? EMPTY_MESSAGES : EMPTY_MESSAGES
    );
}

/** True once the newest message page of the session has been fetched. */
export function useSessionMessagesLoaded(sessionId: string | null | undefined): boolean {
    return useProtocolStore((state) =>
        sessionId ? state.sessionMessages[sessionId]?.isLoaded ?? false : false
    );
}

// Exported for unit tests
export { mergeMessages, sortMessages };
