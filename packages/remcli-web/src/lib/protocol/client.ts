/**
 * Protocol client orchestration — the web-only counterpart of remcli-app
 * sources/sync/sync.ts (minimal port).
 *
 * Owns credentials, the encryption root, per-entity ciphers and the socket;
 * fetches initial data over REST, decrypts it into the zustand store and keeps
 * the store updated from `update` / `ephemeral` socket events.
 */

import {
    connectP2P,
    disconnectP2P,
    restoreCredentials,
    type P2PCredentials,
    type P2PQRPayload
} from '@/lib/protocol/connection';
import { createEncryption, type Cipher, type Encryption } from '@/lib/protocol/encryption';
import { normalizeRawMessage, type NormalizedMessage, type RawRecord } from '@/lib/protocol/messages';
import {
    fetchMachines,
    fetchMessages,
    fetchSessions,
    type RestConfig
} from '@/lib/protocol/rest';
import {
    onSocketMessage,
    onSocketReconnected,
    onSocketStatusChange,
    sendEncryptedMessage,
    socketConnect,
    socketDisconnect,
    socketEmitWithAck
} from '@/lib/protocol/socket';
import { useProtocolStore } from '@/lib/protocol/store';
import {
    AgentStateSchema,
    ApiEphemeralUpdateSchema,
    ApiUpdateContainerSchema,
    MachineMetadataSchema,
    MetadataSchema,
    type AgentState,
    type ApiMachine,
    type ApiMessage,
    type ApiSession,
    type Machine,
    type MachineMetadata,
    type PermissionMode,
    type Session,
    type SessionMetadata
} from '@/lib/protocol/types';

// ─── UUID (secure-context independent) ───────────────────────────

function randomUUID(): string {
    // crypto.randomUUID is unavailable in non-secure contexts (plain-HTTP LAN)
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Client state ────────────────────────────────────────────────

interface ClientContext {
    credentials: P2PCredentials;
    encryption: Encryption;
    sessionCiphers: Map<string, Cipher>;
    /** RPC ciphers (P2P mode: legacy secretbox — daemon RpcHandlerManager uses encryptionVariant 'legacy'). */
    machineCiphers: Map<string, Cipher>;
    /** Metadata/daemonState ciphers (P2P mode: plain JSON — daemon stores them unencrypted). */
    machineDataCiphers: Map<string, Cipher>;
    unsubscribers: Array<() => void>;
}

let context: ClientContext | null = null;

export function isClientStarted(): boolean {
    return context !== null;
}

/** REST config for direct API calls (TTS, Whisper, concierge). Null when not connected. */
export function getRestConfig(): RestConfig | null {
    if (!context) return null;
    return { endpoint: context.credentials.endpoint, token: context.credentials.token };
}

function requireContext(): ClientContext {
    if (!context) {
        throw new Error('Protocol client is not started');
    }
    return context;
}

function restConfigOf(ctx: ClientContext): RestConfig {
    return { endpoint: ctx.credentials.endpoint, token: ctx.credentials.token };
}

// ─── Decryption helpers ──────────────────────────────────────────

function ensureSessionCipher(ctx: ClientContext, sessionId: string, dataEncryptionKey: string | null): Cipher {
    const existing = ctx.sessionCiphers.get(sessionId);
    if (existing) return existing;
    const dataKey = dataEncryptionKey ? ctx.encryption.decryptEncryptionKey(dataEncryptionKey) : null;
    const cipher = ctx.encryption.openCipher(dataKey);
    ctx.sessionCiphers.set(sessionId, cipher);
    return cipher;
}

function ensureMachineCipher(ctx: ClientContext, machineId: string, dataEncryptionKey: string | null): Cipher {
    const existing = ctx.machineCiphers.get(machineId);
    if (existing) return existing;
    const dataKey = dataEncryptionKey ? ctx.encryption.decryptEncryptionKey(dataEncryptionKey) : null;
    const cipher = ctx.encryption.openCipher(dataKey);
    ctx.machineCiphers.set(machineId, cipher);
    return cipher;
}

/**
 * P2P mode (dataEncryptionKey === null): the daemon stores machine metadata
 * and daemonState as plain JSON (daemon/run.ts getOrCreateMachine), unlike
 * sessions which are legacy-encrypted — mirror of remcli-app sync.ts
 * "P2P mode: metadata and daemonState are stored as plain JSON".
 */
const plainJsonCipher: Cipher = {
    async encryptRaw(data: unknown): Promise<string> {
        return JSON.stringify(data);
    },
    async decryptRaw(value: string): Promise<unknown | null> {
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    }
};

function ensureMachineDataCipher(ctx: ClientContext, machineId: string, dataEncryptionKey: string | null): Cipher {
    const existing = ctx.machineDataCiphers.get(machineId);
    if (existing) return existing;
    let cipher = plainJsonCipher;
    if (dataEncryptionKey) {
        const dataKey = ctx.encryption.decryptEncryptionKey(dataEncryptionKey);
        cipher = ctx.encryption.openCipher(dataKey);
    }
    ctx.machineDataCiphers.set(machineId, cipher);
    return cipher;
}

async function decryptSessionMetadata(cipher: Cipher, encrypted: string): Promise<SessionMetadata | null> {
    const decrypted = await cipher.decryptRaw(encrypted);
    if (!decrypted) return null;
    const parsed = MetadataSchema.safeParse(decrypted);
    return parsed.success ? parsed.data : null;
}

async function decryptAgentState(cipher: Cipher, encrypted: string | null | undefined): Promise<AgentState> {
    if (!encrypted) return {};
    const decrypted = await cipher.decryptRaw(encrypted);
    if (!decrypted) return {};
    const parsed = AgentStateSchema.safeParse(decrypted);
    return parsed.success ? parsed.data : {};
}

async function decryptApiSession(ctx: ClientContext, api: ApiSession): Promise<Session> {
    const cipher = ensureSessionCipher(ctx, api.id, api.dataEncryptionKey);
    const metadata = await decryptSessionMetadata(cipher, api.metadata);
    const agentState = await decryptAgentState(cipher, api.agentState);
    return {
        id: api.id,
        seq: api.seq,
        createdAt: api.createdAt,
        updatedAt: api.updatedAt,
        active: api.active,
        activeAt: api.activeAt,
        metadata,
        metadataVersion: api.metadataVersion,
        agentState,
        agentStateVersion: api.agentStateVersion,
        thinking: false,
        thinkingAt: 0,
        presence: api.active ? 'online' : api.activeAt
    };
}

async function decryptMachineMetadata(cipher: Cipher, encrypted: string): Promise<MachineMetadata | null> {
    const decrypted = await cipher.decryptRaw(encrypted);
    if (!decrypted) return null;
    const parsed = MachineMetadataSchema.safeParse(decrypted);
    return parsed.success ? parsed.data : null;
}

async function decryptApiMachine(ctx: ClientContext, api: ApiMachine): Promise<Machine> {
    // RPC cipher — initialized here so machineRpc (stop-session, spawn, ...) can address the machine
    ensureMachineCipher(ctx, api.id, api.dataEncryptionKey);
    const dataCipher = ensureMachineDataCipher(ctx, api.id, api.dataEncryptionKey);
    const metadata = await decryptMachineMetadata(dataCipher, api.metadata);
    const daemonState = api.daemonState ? await dataCipher.decryptRaw(api.daemonState) : null;
    return {
        id: api.id,
        seq: api.seq,
        createdAt: api.createdAt,
        updatedAt: api.updatedAt,
        active: api.active,
        activeAt: api.activeAt,
        metadata,
        metadataVersion: api.metadataVersion,
        daemonState,
        daemonStateVersion: api.daemonStateVersion
    };
}

async function decryptApiMessage(cipher: Cipher, message: ApiMessage): Promise<NormalizedMessage | null> {
    if (message.content.t !== 'encrypted') return null;
    const decrypted = await cipher.decryptRaw(message.content.c);
    if (!decrypted) return null;
    return normalizeRawMessage(message.id, message.localId ?? null, message.seq, message.createdAt, decrypted);
}

// ─── Sync ────────────────────────────────────────────────────────

export async function refreshSessions(): Promise<void> {
    const ctx = requireContext();
    const apiSessions = await fetchSessions(restConfigOf(ctx));
    const sessions: Session[] = [];
    for (const api of apiSessions) {
        sessions.push(await decryptApiSession(ctx, api));
    }
    useProtocolStore.getState().applySessions(sessions);
}

export async function refreshMachines(): Promise<void> {
    const ctx = requireContext();
    const apiMachines = await fetchMachines(restConfigOf(ctx));
    const machines: Machine[] = [];
    for (const api of apiMachines) {
        machines.push(await decryptApiMachine(ctx, api));
    }
    useProtocolStore.getState().applyMachines(machines);
}

/**
 * Load a page of session messages (newest-first pages; offset skips the
 * newest N). Decrypted + normalized messages are merged into the store.
 */
export async function loadSessionMessages(
    sessionId: string,
    options?: { limit?: number; offset?: number }
): Promise<{ total: number; hasMore: boolean }> {
    const ctx = requireContext();
    const cipher = ctx.sessionCiphers.get(sessionId);
    if (!cipher) {
        // Session list not fetched yet — fetch it to initialize the cipher
        await refreshSessions();
    }
    const readyCipher = ctx.sessionCiphers.get(sessionId);
    if (!readyCipher) {
        throw new Error(`Unknown session: ${sessionId}`);
    }

    const page = await fetchMessages(restConfigOf(ctx), sessionId, options);
    const normalized: NormalizedMessage[] = [];
    for (const message of page.messages) {
        const decrypted = await decryptApiMessage(readyCipher, message);
        if (decrypted) {
            normalized.push(decrypted);
        }
    }
    useProtocolStore.getState().applyMessages(sessionId, normalized, { markLoaded: true });
    return { total: page.total, hasMore: page.hasMore };
}

/**
 * Send a user text message into a session: encrypts the RawRecord, echoes it
 * locally (seq=null until the server copy arrives) and emits `message`.
 */
export async function sendSessionMessage(
    sessionId: string,
    text: string,
    options?: {
        permissionMode?: PermissionMode;
        model?: string | null;
        displayText?: string;
    }
): Promise<void> {
    const ctx = requireContext();
    const cipher = ctx.sessionCiphers.get(sessionId);
    if (!cipher) {
        throw new Error(`Session encryption not found for ${sessionId}`);
    }

    const localId = randomUUID();
    const permissionMode = options?.permissionMode ?? 'default';
    const record: RawRecord = {
        role: 'user',
        content: { type: 'text', text },
        meta: {
            sentFrom: 'web',
            permissionMode,
            model: options?.model ?? null,
            fallbackModel: null,
            ...(options?.displayText ? { displayText: options.displayText } : {})
        }
    };
    const encryptedRecord = await cipher.encryptRaw(record);

    // Local echo — replaced when the server broadcasts the stored copy
    const createdAt = Date.now();
    const normalized = normalizeRawMessage(localId, localId, null, createdAt, record);
    if (normalized) {
        useProtocolStore.getState().applyMessages(sessionId, [normalized]);
    }

    sendEncryptedMessage({ sessionId, encryptedRecord, localId, permissionMode });
}

/**
 * Set a custom machine display name via `machine-update-metadata` with
 * optimistic concurrency control and retry on version conflicts — port of
 * remcli-app sources/sync/ops.ts machineUpdateMetadata. Empty name clears
 * the custom display name.
 */
export async function machineSetDisplayName(machineId: string, displayName: string, maxRetries = 3): Promise<void> {
    const ctx = requireContext();
    const machine = useProtocolStore.getState().machines[machineId];
    const cipher = ctx.machineDataCiphers.get(machineId);
    if (!machine || !machine.metadata || !cipher) {
        throw new Error(`Machine not found: ${machineId}`);
    }

    let expectedVersion = machine.metadataVersion;
    let metadata: MachineMetadata = { ...machine.metadata, displayName: displayName.trim() || undefined };

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const encrypted = await cipher.encryptRaw(metadata);
        const result = await socketEmitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
            message?: string;
        }>('machine-update-metadata', { machineId, metadata: encrypted, expectedVersion });

        if (result.result === 'success') {
            const current = useProtocolStore.getState().machines[machineId];
            if (current) {
                useProtocolStore.getState().applyMachines([{
                    ...current,
                    metadata,
                    metadataVersion: result.version ?? expectedVersion + 1
                }]);
            }
            return;
        }
        if (result.result === 'version-mismatch' && typeof result.version === 'number' && result.metadata) {
            // Merge: take the latest metadata, keep our intended displayName change
            expectedVersion = result.version;
            const latest = await decryptMachineMetadata(cipher, result.metadata);
            metadata = { ...(latest ?? metadata), displayName: displayName.trim() || undefined };
            continue;
        }
        throw new Error(result.message || 'Failed to update machine metadata');
    }
    throw new Error(`Failed to update machine metadata after ${maxRetries} retries`);
}

/**
 * Remove a machine from the local store (the daemon has no DELETE machines
 * endpoint — the machine re-appears on the next refetch if its daemon is alive).
 */
export function forgetMachine(machineId: string): void {
    context?.machineCiphers.delete(machineId);
    context?.machineDataCiphers.delete(machineId);
    useProtocolStore.getState().removeMachine(machineId);
}

// ─── Socket event handlers ───────────────────────────────────────

async function handleUpdate(ctx: ClientContext, data: unknown): Promise<void> {
    const parsed = ApiUpdateContainerSchema.safeParse(data);
    if (!parsed.success) {
        return;
    }
    const update = parsed.data;
    const store = useProtocolStore.getState();

    if (update.body.t === 'new-message') {
        const { sid, message } = update.body;
        let cipher = ctx.sessionCiphers.get(sid);
        if (!cipher) {
            await refreshSessions();
            cipher = ctx.sessionCiphers.get(sid);
        }
        if (!cipher) return;
        const normalized = await decryptApiMessage(cipher, message);
        if (normalized) {
            store.applyMessages(sid, [normalized]);
        }
        const session = store.sessions[sid];
        if (session) {
            store.applySessions([{ ...session, updatedAt: update.createdAt }]);
        }
        return;
    }

    if (update.body.t === 'new-session') {
        await refreshSessions();
        return;
    }

    if (update.body.t === 'delete-session') {
        const sessionId = update.body.sid ?? update.body.sessionId;
        if (sessionId) {
            ctx.sessionCiphers.delete(sessionId);
            store.removeSession(sessionId);
        }
        return;
    }

    if (update.body.t === 'update-session') {
        const body = update.body;
        const session = store.sessions[body.id];
        if (!session) {
            await refreshSessions();
            return;
        }
        const cipher = ctx.sessionCiphers.get(body.id);
        if (!cipher) return;
        const metadata = body.metadata
            ? await decryptSessionMetadata(cipher, body.metadata.value)
            : session.metadata;
        const agentState = body.agentState
            ? await decryptAgentState(cipher, body.agentState.value)
            : session.agentState;
        store.applySessions([{
            ...session,
            metadata,
            metadataVersion: body.metadata ? body.metadata.version : session.metadataVersion,
            agentState,
            agentStateVersion: body.agentState ? body.agentState.version : session.agentStateVersion,
            updatedAt: update.createdAt,
            seq: update.seq
        }]);
        return;
    }

    if (update.body.t === 'new-machine') {
        await refreshMachines();
        return;
    }

    if (update.body.t === 'update-machine') {
        const body = update.body;
        const machine = store.machines[body.machineId];
        if (!machine) {
            await refreshMachines();
            return;
        }
        const cipher = ctx.machineDataCiphers.get(body.machineId);
        if (!cipher) return;
        const metadata = body.metadata
            ? await decryptMachineMetadata(cipher, body.metadata.value)
            : machine.metadata;
        const daemonState = body.daemonState
            ? await cipher.decryptRaw(body.daemonState.value)
            : machine.daemonState;
        store.applyMachines([{
            ...machine,
            metadata,
            metadataVersion: body.metadata ? body.metadata.version : machine.metadataVersion,
            daemonState,
            daemonStateVersion: body.daemonState ? body.daemonState.version : machine.daemonStateVersion,
            active: body.active ?? machine.active,
            activeAt: body.activeAt ?? machine.activeAt,
            updatedAt: update.createdAt
        }]);
    }
}

function handleEphemeral(data: unknown): void {
    const parsed = ApiEphemeralUpdateSchema.safeParse(data);
    if (!parsed.success) {
        return;
    }
    const update = parsed.data;
    const store = useProtocolStore.getState();

    if (update.type === 'activity') {
        store.applySessionActivity(update.id, update.active, update.activeAt, update.thinking);
    } else if (update.type === 'machine-activity') {
        store.applyMachineActivity(update.id, update.active, update.activeAt);
    }
    // 'usage' — not consumed by the web client yet
}

// ─── Lifecycle ───────────────────────────────────────────────────

async function startWithCredentials(credentials: P2PCredentials): Promise<void> {
    stopProtocolClient();

    const ctx: ClientContext = {
        credentials,
        encryption: createEncryption(credentials.secret),
        sessionCiphers: new Map(),
        machineCiphers: new Map(),
        machineDataCiphers: new Map(),
        unsubscribers: []
    };
    context = ctx;

    ctx.unsubscribers.push(onSocketStatusChange((status) => {
        useProtocolStore.getState().setConnectionStatus(status);
    }));
    ctx.unsubscribers.push(onSocketMessage('update', (data) => {
        void handleUpdate(ctx, data);
    }));
    ctx.unsubscribers.push(onSocketMessage('ephemeral', (data) => {
        handleEphemeral(data);
    }));
    ctx.unsubscribers.push(onSocketReconnected(() => {
        void refreshSessions().catch(() => undefined);
        void refreshMachines().catch(() => undefined);
    }));

    socketConnect(
        { endpoint: credentials.endpoint, token: credentials.token },
        {
            getSessionCipher: (sessionId) => ctx.sessionCiphers.get(sessionId) ?? null,
            getMachineCipher: (machineId) => ctx.machineCiphers.get(machineId) ?? null
        }
    );

    useProtocolStore.getState().setAuthenticated(true);

    // Initial data load (socket handlers keep it fresh afterwards)
    await Promise.all([
        refreshSessions().catch(() => undefined),
        refreshMachines().catch(() => undefined)
    ]);
}

/** Connect using a parsed QR/URL/manual payload; persists the connection. */
export async function startProtocolClient(payload: P2PQRPayload): Promise<void> {
    const credentials = connectP2P(payload);
    await startWithCredentials(credentials);
}

/** Restore a persisted connection (page load). Returns false when none stored. */
export async function restoreProtocolClient(): Promise<boolean> {
    const credentials = restoreCredentials();
    if (!credentials) {
        return false;
    }
    await startWithCredentials(credentials);
    return true;
}

/** Disconnect the socket and drop in-memory state (keeps stored credentials). */
export function stopProtocolClient(): void {
    if (context) {
        for (const unsubscribe of context.unsubscribers) {
            unsubscribe();
        }
        context = null;
    }
    socketDisconnect();
    useProtocolStore.getState().reset();
}

/** Logout: disconnect and forget the stored connection. */
export function logoutProtocolClient(): void {
    stopProtocolClient();
    disconnectP2P();
}
