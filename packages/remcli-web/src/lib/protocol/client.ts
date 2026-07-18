/**
 * Protocol client orchestration for the web-only client.
 *
 * Owns credentials, the encryption root, per-entity ciphers and the socket;
 * fetches initial data over REST, decrypts it into the zustand store and keeps
 * the store updated from `update` / `ephemeral` socket events.
 */

import {
    fixtureAnswerPermission,
    fixtureListAgentSessions,
    fixtureListDirectory,
    fixtureLoadSessionMessages,
    fixtureRecordProtocolReconnect,
    fixtureRecordSentSession,
    fixtureRefreshSessions,
    fixtureRestConfig,
    fixtureSpawnNewSession,
    fixtureStopSession,
    initFixturesIfEnabled
} from '@/lib/fixtures';
import {
    connectP2P,
    createP2PCredentials,
    disconnectP2P,
    parseConnectUrl,
    restoreCredentials,
    storeConnection,
    type P2PCredentials,
    type P2PQRPayload
} from '@/lib/protocol/connection';
import { decodeBase64, encodeBase64 } from '@/lib/protocol/encoding';
import { createEncryption, decryptBox, type Cipher, type Encryption } from '@/lib/protocol/encryption';
import nacl from 'tweetnacl';
import { normalizeRawMessage, type NormalizedMessage, type RawRecord } from '@/lib/protocol/messages';
import {
    deleteMachine,
    fetchMachines,
    fetchMessages,
    fetchSessions,
    measureHealthLatency,
    type DeleteMachineResult,
    type RestConfig
} from '@/lib/protocol/rest';
import {
    machineListAgentSessions as socketMachineListAgentSessions,
    machineListDirectory as socketMachineListDirectory,
    machineCancelPairingRekey as socketMachineCancelPairingRekey,
    machineRequestPairingRekey as socketMachineRequestPairingRekey,
    machineShowPairingQr as socketMachineShowPairingQr,
    machineSpawnNewSession as socketMachineSpawnNewSession,
    machineStopSession as socketMachineStopSession,
    onSocketMessage,
    onSocketReconnected,
    onSocketStatusChange,
    sendEncryptedMessage,
    sessionAllow as socketSessionAllow,
    sessionDeny as socketSessionDeny,
    socketConnect,
    socketDisconnect,
    socketEmitWithAck,
    waitForSocketConnection,
    type DirectoryListing,
    type SpawnSessionOptions,
    type SpawnSessionResult,
    type PairingRekeyCancellationResult,
    type PairingRekeyRequest,
    type SealedPairingQr,
} from '@/lib/protocol/socket';
import { useProtocolStore } from '@/lib/protocol/store';
import {
    AgentStateSchema,
    ApiEphemeralUpdateSchema,
    ApiUpdateContainerSchema,
    MachineMetadataSchema,
    MetadataSchema,
    type AgentState,
    type AgentSessionInfo,
    type ApiMachine,
    type ApiMessage,
    type ApiSession,
    type KvChange,
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
    generation: number;
    sessionsEpoch: number;
    machinesEpoch: number;
    sessionActivityPatches: Map<string, SessionActivityPatch>;
    machineActivityPatches: Map<string, MachineActivityPatch>;
    credentials: P2PCredentials;
    encryption: Encryption;
    sessionCiphers: Map<string, Cipher>;
    /** RPC ciphers (P2P mode: legacy secretbox — daemon RpcHandlerManager uses encryptionVariant 'legacy'). */
    machineCiphers: Map<string, Cipher>;
    /** Metadata/daemonState ciphers (P2P mode: plain JSON — daemon stores them unencrypted). */
    machineDataCiphers: Map<string, Cipher>;
    unsubscribers: Array<() => void>;
}

interface SessionActivityPatch {
    active: boolean;
    activeAt: number;
    thinking: boolean;
}

interface MachineActivityPatch {
    active: boolean;
    activeAt: number;
}

const MAX_PENDING_ACTIVITY_PATCHES = 512;
const FIXTURE_PAIRING_QR_DATA_URL = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 320 320"%3E%3Crect width="320" height="320" fill="%23fafafa"/%3E%3Cpath fill="%2309090b" d="M24 24h88v88H24zm16 16v56h56V40zm16 16h24v24H56zM208 24h88v88h-88zm16 16v56h56V40zm16 16h24v24h-24zM24 208h88v88H24zm16 16v56h56v-56zm16 16h24v24H56zM144 144h32v32h-32zm48 0h32v32h-32zm-48 48h32v32h-32zm48 0h80v32h-80z"/%3E%3C/svg%3E';

let context: ClientContext | null = null;
let lifecycleGeneration = 0;
const protocolReconnectedListeners = new Set<() => void>();

export interface IProtocolReconnectOperations {
    refreshMachines: () => Promise<void>;
    refreshSessions: () => Promise<void>;
    notifyReconnected: () => void;
}

export interface PairingQrPresentation {
    qrDataUrl: string;
    payload: P2PQRPayload;
}

export interface PendingPairingRekey {
    requestId: string;
    approvalCode: string;
    ticket: string;
    expiresAt: number;
    privateKey: Uint8Array;
    endpoint: string;
    fixture?: boolean;
}

export type PairingRekeyPollResult =
    | { type: 'pending'; expiresAt: number }
    | { type: 'ready'; pairing: PairingQrPresentation };

export type { PairingRekeyCancellationResult };

function isCurrentClientContext(ctx: ClientContext): boolean {
    return context === ctx && ctx.generation === lifecycleGeneration;
}

function getCurrentProtocolStore(ctx: ClientContext) {
    return isCurrentClientContext(ctx) ? useProtocolStore.getState() : null;
}

function beginSessionsRefresh(ctx: ClientContext): number {
    ctx.sessionsEpoch += 1;
    return ctx.sessionsEpoch;
}

function beginMachinesRefresh(ctx: ClientContext): number {
    ctx.machinesEpoch += 1;
    return ctx.machinesEpoch;
}

function markSessionsMutation(ctx: ClientContext): void {
    ctx.sessionsEpoch += 1;
}

function markMachinesMutation(ctx: ClientContext): void {
    ctx.machinesEpoch += 1;
}

function canCommitSessionsSnapshot(ctx: ClientContext, epoch: number): boolean {
    return isCurrentClientContext(ctx) && ctx.sessionsEpoch === epoch;
}

function canCommitMachinesSnapshot(ctx: ClientContext, epoch: number): boolean {
    return isCurrentClientContext(ctx) && ctx.machinesEpoch === epoch;
}

function removeMissingSessionCiphers(ctx: ClientContext, sessions: Session[]): void {
    const sessionIds = new Set(sessions.map((session) => session.id));
    for (const sessionId of ctx.sessionCiphers.keys()) {
        if (!sessionIds.has(sessionId)) {
            ctx.sessionCiphers.delete(sessionId);
        }
    }
}

function removeMissingMachineCiphers(ctx: ClientContext, machines: Machine[]): void {
    const machineIds = new Set(machines.map((machine) => machine.id));
    for (const machineId of ctx.machineCiphers.keys()) {
        if (!machineIds.has(machineId)) {
            ctx.machineCiphers.delete(machineId);
            ctx.machineDataCiphers.delete(machineId);
        }
    }
}

function removeMissingSessionActivityPatches(ctx: ClientContext, sessions: Session[]): void {
    const sessionIds = new Set(sessions.map((session) => session.id));
    for (const sessionId of ctx.sessionActivityPatches.keys()) {
        if (!sessionIds.has(sessionId)) {
            ctx.sessionActivityPatches.delete(sessionId);
        }
    }
}

function removeMissingMachineActivityPatches(ctx: ClientContext, machines: Machine[]): void {
    const machineIds = new Set(machines.map((machine) => machine.id));
    for (const machineId of ctx.machineActivityPatches.keys()) {
        if (!machineIds.has(machineId)) {
            ctx.machineActivityPatches.delete(machineId);
        }
    }
}

function setBoundedActivityPatch<T>(patches: Map<string, T>, id: string, patch: T): void {
    patches.delete(id);
    patches.set(id, patch);
    while (patches.size > MAX_PENDING_ACTIVITY_PATCHES) {
        const oldestId = patches.keys().next().value;
        if (typeof oldestId !== 'string') {
            return;
        }
        patches.delete(oldestId);
    }
}

function applySessionActivityPatch(ctx: ClientContext, session: Session): Session {
    const patch = ctx.sessionActivityPatches.get(session.id);
    if (!patch) {
        return session;
    }
    if (patch.activeAt < session.activeAt) {
        ctx.sessionActivityPatches.delete(session.id);
        return session;
    }
    return {
        ...session,
        active: patch.active,
        activeAt: patch.activeAt,
        thinking: patch.thinking,
        thinkingAt: patch.thinking ? patch.activeAt : session.thinkingAt,
        presence: patch.active ? 'online' : patch.activeAt,
    };
}

function mergeSessionSnapshot(snapshot: Session, current: Session | undefined): Session {
    if (!current) {
        return snapshot;
    }

    const shouldKeepCurrentMetadata = current.metadataVersion > snapshot.metadataVersion
        || (current.metadataVersion === snapshot.metadataVersion && current.updatedAt > snapshot.updatedAt);
    const shouldKeepCurrentAgentState = current.agentStateVersion > snapshot.agentStateVersion
        || (current.agentStateVersion === snapshot.agentStateVersion && current.updatedAt > snapshot.updatedAt);

    return {
        ...snapshot,
        metadata: shouldKeepCurrentMetadata ? current.metadata : snapshot.metadata,
        metadataVersion: Math.max(current.metadataVersion, snapshot.metadataVersion),
        agentState: shouldKeepCurrentAgentState ? current.agentState : snapshot.agentState,
        agentStateVersion: Math.max(current.agentStateVersion, snapshot.agentStateVersion),
        updatedAt: Math.max(current.updatedAt, snapshot.updatedAt),
        seq: Math.max(current.seq, snapshot.seq)
    };
}

function applyMachineActivityPatch(ctx: ClientContext, machine: Machine): Machine {
    const patch = ctx.machineActivityPatches.get(machine.id);
    if (!patch) {
        return machine;
    }
    if (patch.activeAt < machine.activeAt) {
        ctx.machineActivityPatches.delete(machine.id);
        return machine;
    }
    return {
        ...machine,
        active: patch.active,
        activeAt: patch.activeAt,
    };
}

export interface SessionMessagesPage {
    total: number;
    hasMore: boolean;
    /** Number of raw server records consumed by this request, including records skipped by the normalizer. */
    consumed: number;
    /** Raw server cursor for the next older-history request. */
    nextOffset: number;
}

/**
 * Fixture-режим (?fixtures=1 / localStorage remcli-fixtures=1) — единственная
 * точка входа гварда: при инициализации модуля (до первого рендера React)
 * стор наполняется детерминированными данными из src/lib/fixtures/, а все
 * сетевые входы ниже проверяют isFixturesActive и работают локально.
 */
const isFixturesActive = initFixturesIfEnabled();

export function isClientStarted(): boolean {
    return isFixturesActive || context !== null;
}

/** Subscribe to a completed Socket.IO reconnect without coupling screens to the socket singleton. */
export function onProtocolReconnected(listener: () => void): () => void {
    protocolReconnectedListeners.add(listener);
    return () => {
        protocolReconnectedListeners.delete(listener);
    };
}

function notifyProtocolReconnected(canNotify: () => boolean = () => true): void {
    for (const listener of protocolReconnectedListeners) {
        if (!canNotify()) break;
        listener();
    }
}

/** Runs the single reconnect sequence shared by the Socket.IO lifecycle and fixture tests. */
export async function runProtocolReconnect(operations: IProtocolReconnectOperations): Promise<void> {
    const machinesRefresh = operations.refreshMachines().catch(() => undefined);
    try {
        await operations.refreshSessions();
    } finally {
        operations.notifyReconnected();
        await machinesRefresh;
    }
}

/** Runs the production reconnect sequence against fixture-backed refresh operations. */
export async function runFixtureProtocolReconnect(): Promise<void> {
    if (!isFixturesActive) {
        throw new Error('Fixture protocol reconnect is available only in fixture mode');
    }
    await runProtocolReconnect({
        refreshMachines: async () => undefined,
        refreshSessions: async () => {
            fixtureRefreshSessions();
        },
        notifyReconnected: () => {
            fixtureRecordProtocolReconnect();
            notifyProtocolReconnected();
        }
    });
}

/** REST config for direct API calls (TTS, Whisper, concierge). Null when not connected. */
export function getRestConfig(): RestConfig | null {
    if (isFixturesActive) return fixtureRestConfig();
    if (!context) return null;
    return { endpoint: context.credentials.endpoint, token: context.credentials.token };
}

/** List child directories on a machine; fixture mode returns a local daemon-shaped contract. */
export async function machineListDirectory(machineId: string, path?: string): Promise<DirectoryListing> {
    if (isFixturesActive) {
        return fixtureListDirectory(machineId, path);
    }
    return socketMachineListDirectory(machineId, path);
}

/** Spawn a new agent session on a machine; fixture mode creates a local store session. */
export async function machineSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
    if (isFixturesActive) {
        return fixtureSpawnNewSession(options);
    }
    return socketMachineSpawnNewSession(options);
}

/** List resumable agent sessions on a machine; fixture mode returns deterministic seeded sessions. */
export async function machineListAgentSessions(
    machineId: string,
    agent?: string,
    directory?: string,
    limit?: number
): Promise<AgentSessionInfo[]> {
    if (isFixturesActive) {
        return fixtureListAgentSessions(machineId, agent, directory, limit);
    }
    return socketMachineListAgentSessions(machineId, agent, directory, limit);
}

/** Stop a daemon-tracked session; fixture mode updates the local seeded store. */
export async function machineStopSession(machineId: string, sessionId: string): Promise<{ message: string }> {
    if (isFixturesActive) {
        return fixtureStopSession(machineId, sessionId);
    }
    return socketMachineStopSession(machineId, sessionId);
}

function decodeSealedPairingQr(sealed: SealedPairingQr, privateKey: Uint8Array): PairingQrPresentation {
    const decrypted = decryptBox(decodeBase64(sealed.payload), privateKey);
    if (!decrypted) {
        throw new Error('Pairing QR delivery could not be decrypted');
    }
    try {
        const parsed = JSON.parse(new TextDecoder().decode(decrypted)) as { qrUrl?: unknown; qrDataUrl?: unknown };
        if (typeof parsed.qrUrl !== 'string' || typeof parsed.qrDataUrl !== 'string') {
            throw new Error('Pairing QR delivery has an invalid payload');
        }
        const payload = parseConnectUrl(parsed.qrUrl);
        if (!payload) {
            throw new Error('Pairing QR delivery has an invalid connection URL');
        }
        return { qrDataUrl: parsed.qrDataUrl, payload };
    } catch (error) {
        if (error instanceof Error) throw error;
        throw new Error('Pairing QR delivery could not be decoded');
    }
}

function fixturePairingPayload(): P2PQRPayload {
    const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    return { mode: 'p2p', host: '127.0.0.1', port: 5178, key, v: 1 };
}

/** Read the current connection QR without writing it into route/history state. */
export async function machineShowPairingQr(machineId: string): Promise<PairingQrPresentation> {
    if (isFixturesActive) {
        return { qrDataUrl: FIXTURE_PAIRING_QR_DATA_URL, payload: fixturePairingPayload() };
    }
    const keyPair = nacl.box.keyPair();
    const sealed = await socketMachineShowPairingQr(machineId, encodeBase64(keyPair.publicKey));
    return decodeSealedPairingQr(sealed, keyPair.secretKey);
}

/** Create a local-host-approved rotation request and keep its private key in memory only. */
export async function machineRequestPairingRekey(machineId: string): Promise<PendingPairingRekey> {
    const keyPair = nacl.box.keyPair();
    if (isFixturesActive) {
        return {
            requestId: 'fixture-pairing-request-0001',
            approvalCode: 'F1A2B3C4',
            ticket: 'fixture-pairing-ticket-0001',
            expiresAt: Date.now() + 5 * 60 * 1000,
            privateKey: keyPair.secretKey,
            endpoint: 'http://127.0.0.1:5178',
            fixture: true,
        };
    }
    const request: PairingRekeyRequest = await socketMachineRequestPairingRekey(
        machineId,
        encodeBase64(keyPair.publicKey),
    );
    return {
        ...request,
        privateKey: keyPair.secretKey,
        endpoint: requireContext().credentials.endpoint,
    };
}

/** Cancel a request that has not been locally approved yet. */
export async function machineCancelPairingRekey(
    machineId: string,
    pending: PendingPairingRekey,
): Promise<PairingRekeyCancellationResult> {
    if (pending.fixture) {
        return { type: 'cancelled' };
    }
    return await socketMachineCancelPairingRekey(machineId, pending.requestId, pending.approvalCode);
}

/** Poll the opaque rekey ticket; the endpoint never returns an unsealed QR. */
export async function pollPairingRekey(pending: PendingPairingRekey): Promise<PairingRekeyPollResult> {
    if (pending.fixture) {
        return {
            type: 'ready',
            pairing: { qrDataUrl: FIXTURE_PAIRING_QR_DATA_URL, payload: fixturePairingPayload() },
        };
    }
    const response = await fetch(
        `${pending.endpoint}/v1/pairing-rekey/${encodeURIComponent(pending.ticket)}`,
        { cache: 'no-store', headers: { 'Cache-Control': 'no-store' } },
    );
    if (response.status === 202) {
        const body = await response.json() as { status?: unknown; expiresAt?: unknown };
        if (body.status !== 'pending' || typeof body.expiresAt !== 'number') {
            throw new Error('Pairing rekey pending response is invalid');
        }
        return { type: 'pending', expiresAt: body.expiresAt };
    }
    if (response.status === 410) {
        throw new Error('Pairing rekey request expired');
    }
    if (!response.ok) {
        throw new Error('Pairing rekey request was not found');
    }
    const body = await response.json() as { status?: unknown; delivery?: unknown };
    if (body.status !== 'ready' || !body.delivery || typeof body.delivery !== 'object') {
        throw new Error('Pairing rekey delivery response is invalid');
    }
    const delivery = body.delivery as Partial<SealedPairingQr>;
    if (
        delivery.format !== 'nacl-box-v1'
        || typeof delivery.payload !== 'string'
        || typeof delivery.expiresAt !== 'number'
    ) {
        throw new Error('Pairing rekey delivery has an invalid envelope');
    }
    return {
        type: 'ready',
        pairing: decodeSealedPairingQr(delivery as SealedPairingQr, pending.privateKey),
    };
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
 * sessions which are legacy-encrypted.
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

async function refreshSessionsForContext(ctx: ClientContext): Promise<void> {
    const epoch = beginSessionsRefresh(ctx);
    const apiSessions = await fetchSessions(restConfigOf(ctx));
    if (!canCommitSessionsSnapshot(ctx, epoch)) return;
    const decryptedSessions: Session[] = [];
    for (const api of apiSessions) {
        if (!canCommitSessionsSnapshot(ctx, epoch)) return;
        const session = await decryptApiSession(ctx, api);
        if (!canCommitSessionsSnapshot(ctx, epoch)) return;
        decryptedSessions.push(session);
    }
    if (!canCommitSessionsSnapshot(ctx, epoch)) return;
    const store = getCurrentProtocolStore(ctx);
    if (!store) return;
    const sessions = decryptedSessions
        .map((session) => applySessionActivityPatch(ctx, session))
        .map((session) => mergeSessionSnapshot(session, store.sessions[session.id]));
    store.replaceSessions(sessions);
    removeMissingSessionCiphers(ctx, sessions);
    removeMissingSessionActivityPatches(ctx, sessions);
}

export async function refreshSessions(): Promise<void> {
    if (isFixturesActive) {
        fixtureRefreshSessions();
        return;
    }
    await refreshSessionsForContext(requireContext());
}

async function refreshMachinesForContext(ctx: ClientContext): Promise<void> {
    const epoch = beginMachinesRefresh(ctx);
    const apiMachines = await fetchMachines(restConfigOf(ctx));
    if (!canCommitMachinesSnapshot(ctx, epoch)) return;
    const decryptedMachines: Machine[] = [];
    for (const api of apiMachines) {
        if (!canCommitMachinesSnapshot(ctx, epoch)) return;
        const machine = await decryptApiMachine(ctx, api);
        if (!canCommitMachinesSnapshot(ctx, epoch)) return;
        decryptedMachines.push(machine);
    }
    if (!canCommitMachinesSnapshot(ctx, epoch)) return;
    const store = getCurrentProtocolStore(ctx);
    if (!store) return;
    const machines = decryptedMachines.map((machine) => applyMachineActivityPatch(ctx, machine));
    store.replaceMachines(machines);
    removeMissingMachineCiphers(ctx, machines);
    removeMissingMachineActivityPatches(ctx, machines);
}

export async function refreshMachines(): Promise<void> {
    if (isFixturesActive) return;
    await refreshMachinesForContext(requireContext());
}

/**
 * Load a page of session messages (newest-first pages; offset skips the
 * newest N). Decrypted + normalized messages are merged into the store.
 */
export async function loadSessionMessages(
    sessionId: string,
    options?: { limit?: number; offset?: number }
): Promise<SessionMessagesPage> {
    const offset = options?.offset ?? 0;
    if (isFixturesActive) {
        const page = fixtureLoadSessionMessages(sessionId);
        return {
            ...page,
            consumed: Math.max(0, page.total - offset),
            nextOffset: page.total
        };
    }
    const ctx = requireContext();
    const cipher = ctx.sessionCiphers.get(sessionId);
    if (!cipher) {
        // Session list not fetched yet — fetch it to initialize the cipher
        await refreshSessionsForContext(ctx);
    }
    const readyCipher = ctx.sessionCiphers.get(sessionId);
    if (!readyCipher) {
        throw new Error(`Unknown session: ${sessionId}`);
    }

    const page = await fetchMessages(restConfigOf(ctx), sessionId, options);
    const result: SessionMessagesPage = {
        total: page.total,
        hasMore: page.hasMore,
        consumed: page.messages.length,
        nextOffset: offset + page.messages.length
    };
    if (!isCurrentClientContext(ctx)) return result;

    const normalized: NormalizedMessage[] = [];
    for (const message of page.messages) {
        const decrypted = await decryptApiMessage(readyCipher, message);
        if (!isCurrentClientContext(ctx)) return result;
        if (decrypted) {
            normalized.push(decrypted);
        }
    }
    const store = getCurrentProtocolStore(ctx);
    if (store?.sessions[sessionId]) {
        store.applyMessages(sessionId, normalized, { markLoaded: true });
    }
    return result;
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
    const localId = randomUUID();
    const permissionMode = options?.permissionMode;
    const meta: NonNullable<RawRecord['meta']> = {
        sentFrom: 'web',
        ...(permissionMode ? { permissionMode } : {}),
        ...(options && Object.prototype.hasOwnProperty.call(options, 'model') ? { model: options.model ?? null } : {}),
        ...(options?.displayText ? { displayText: options.displayText } : {})
    };
    const record: RawRecord = {
        role: 'user',
        content: { type: 'text', text },
        meta
    };

    // Fixture-режим: только локальное эхо, без шифрования и сети
    if (isFixturesActive) {
        fixtureRecordSentSession(sessionId);
        const normalized = normalizeRawMessage(localId, localId, null, Date.now(), record);
        if (normalized) {
            useProtocolStore.getState().applyMessages(sessionId, [normalized]);
        }
        return;
    }

    const ctx = requireContext();
    const cipher = ctx.sessionCiphers.get(sessionId);
    if (!cipher) {
        throw new Error(`Session encryption not found for ${sessionId}`);
    }
    const encryptedRecord = await cipher.encryptRaw(record);
    if (!isCurrentClientContext(ctx)) return;

    // Local echo — replaced when the server broadcasts the stored copy
    const createdAt = Date.now();
    const store = getCurrentProtocolStore(ctx);
    if (!store?.sessions[sessionId]) {
        throw new Error(`Unknown session: ${sessionId}`);
    }
    const normalized = normalizeRawMessage(localId, localId, null, createdAt, record);
    if (normalized) {
        store.applyMessages(sessionId, [normalized]);
    }

    sendEncryptedMessage({ sessionId, encryptedRecord, localId, permissionMode });
}

// ─── Permission responses (fixture-aware) ────────────────────────
// Обёртки над socket.ts: в fixture-режиме allow/deny убирают карточку локально
// (запрос переезжает в completedRequests стора), без RPC.

/** Allow a pending permission request. */
export async function sessionAllow(
    sessionId: string,
    id: string,
    mode?: 'manual' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' | 'dontAsk',
    allowedTools?: string[],
    decision?: 'approved' | 'approved_for_session'
): Promise<void> {
    if (isFixturesActive) {
        fixtureAnswerPermission(sessionId, id, 'approved');
        return;
    }
    await socketSessionAllow(sessionId, id, mode, allowedTools, decision);
}

/** Deny a pending permission request. */
export async function sessionDeny(
    sessionId: string,
    id: string,
    mode?: 'manual' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'auto' | 'dontAsk',
    allowedTools?: string[],
    decision?: 'denied' | 'abort'
): Promise<void> {
    if (isFixturesActive) {
        fixtureAnswerPermission(sessionId, id, 'denied');
        return;
    }
    await socketSessionDeny(sessionId, id, mode, allowedTools, decision);
}

/**
 * Set a custom machine display name via `machine-update-metadata` with
 * optimistic concurrency control and retry on version conflicts. Empty name
 * clears the custom display name.
 */
export async function machineSetDisplayName(machineId: string, displayName: string, maxRetries = 3): Promise<void> {
    if (isFixturesActive) return;
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
        if (!isCurrentClientContext(ctx)) return;
        const result = await socketEmitWithAck<{
            result: 'success' | 'version-mismatch' | 'error';
            version?: number;
            metadata?: string;
            message?: string;
        }>('machine-update-metadata', { machineId, metadata: encrypted, expectedVersion });
        if (!isCurrentClientContext(ctx)) return;

        if (result.result === 'success') {
            const store = getCurrentProtocolStore(ctx);
            const current = store?.machines[machineId];
            if (current && store) {
                markMachinesMutation(ctx);
                store.applyMachines([{
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
            if (!isCurrentClientContext(ctx)) return;
            metadata = { ...(latest ?? metadata), displayName: displayName.trim() || undefined };
            continue;
        }
        throw new Error(result.message || 'Failed to update machine metadata');
    }
    throw new Error(`Failed to update machine metadata after ${maxRetries} retries`);
}

/** Drop a machine's ciphers and store entry (delete-machine event / local delete). */
function evictMachine(machineId: string): void {
    context?.machineCiphers.delete(machineId);
    context?.machineDataCiphers.delete(machineId);
    context?.machineActivityPatches.delete(machineId);
    useProtocolStore.getState().removeMachine(machineId);
}

/**
 * Delete a machine on the daemon (DELETE /v1/machines/:id). On success (or 404 —
 * already gone) the machine is evicted locally right away; the daemon also
 * broadcasts a 'delete-machine' update to every connected client. 403 means the
 * daemon's own machine — surfaced as a typed result for the UI to explain.
 */
export async function machineDelete(machineId: string): Promise<DeleteMachineResult> {
    if (isFixturesActive) {
        evictMachine(machineId);
        return { ok: true };
    }
    const ctx = requireContext();
    const result = await deleteMachine(restConfigOf(ctx), machineId);
    if (isCurrentClientContext(ctx) && (result.ok || result.status === 404)) {
        markMachinesMutation(ctx);
        evictMachine(machineId);
    }
    return result;
}

// ─── KV live updates (kv-batch-update) ───────────────────────────

const kvListeners = new Set<(changes: KvChange[]) => void>();

/** Subscribe to live KV changes broadcast by the daemon (cross-device sync, e.g. zen tasks). */
export function subscribeKvChanges(listener: (changes: KvChange[]) => void): () => void {
    kvListeners.add(listener);
    return () => {
        kvListeners.delete(listener);
    };
}

// ─── Socket event handlers ───────────────────────────────────────

async function handleUpdate(ctx: ClientContext, data: unknown): Promise<void> {
    if (!isCurrentClientContext(ctx)) return;
    const parsed = ApiUpdateContainerSchema.safeParse(data);
    if (!parsed.success) {
        return;
    }
    const update = parsed.data;

    if (update.body.t === 'new-message') {
        const { sid, message } = update.body;
        let cipher = ctx.sessionCiphers.get(sid);
        if (!cipher) {
            await refreshSessionsForContext(ctx);
            if (!isCurrentClientContext(ctx)) return;
            cipher = ctx.sessionCiphers.get(sid);
        }
        if (!cipher) return;
        const normalized = await decryptApiMessage(cipher, message);
        const store = getCurrentProtocolStore(ctx);
        const session = store?.sessions[sid];
        if (!store || !session) return;
        if (normalized) {
            store.applyMessages(sid, [normalized]);
        }
        const currentSession = getCurrentProtocolStore(ctx)?.sessions[sid];
        if (!currentSession) return;
        const shouldApplyTimestamp = update.createdAt > currentSession.updatedAt;
        const shouldApplySequence = update.seq > currentSession.seq;
        if (!shouldApplyTimestamp && !shouldApplySequence) return;

        getCurrentProtocolStore(ctx)?.applySessions([{
            ...currentSession,
            updatedAt: Math.max(currentSession.updatedAt, update.createdAt),
            seq: Math.max(currentSession.seq, update.seq)
        }]);
        return;
    }

    if (update.body.t === 'new-session') {
        await refreshSessionsForContext(ctx);
        return;
    }

    if (update.body.t === 'delete-session') {
        const sessionId = update.body.sid ?? update.body.sessionId;
        if (sessionId) {
            const store = getCurrentProtocolStore(ctx);
            if (!store) return;
            markSessionsMutation(ctx);
            ctx.sessionCiphers.delete(sessionId);
            ctx.sessionActivityPatches.delete(sessionId);
            store.removeSession(sessionId);
        }
        return;
    }

    if (update.body.t === 'update-session') {
        const body = update.body;
        const store = getCurrentProtocolStore(ctx);
        if (!store) return;
        const session = store.sessions[body.id];
        if (!session) {
            await refreshSessionsForContext(ctx);
            return;
        }
        const cipher = ctx.sessionCiphers.get(body.id);
        if (!cipher) return;
        const shouldDecryptMetadata = body.metadata !== null
            && body.metadata !== undefined
            && body.metadata.version > session.metadataVersion;
        const shouldDecryptAgentState = body.agentState !== null
            && body.agentState !== undefined
            && body.agentState.version > session.agentStateVersion;
        const shouldApplyTimestamp = update.createdAt > session.updatedAt;
        if (!shouldDecryptMetadata && !shouldDecryptAgentState && !shouldApplyTimestamp) {
            return;
        }

        let metadata = session.metadata;
        if (shouldDecryptMetadata && body.metadata) {
            metadata = await decryptSessionMetadata(cipher, body.metadata.value);
            if (!isCurrentClientContext(ctx)) return;
        }
        let agentState = session.agentState;
        if (shouldDecryptAgentState && body.agentState) {
            agentState = await decryptAgentState(cipher, body.agentState.value);
            if (!isCurrentClientContext(ctx)) return;
        }
        const currentStore = getCurrentProtocolStore(ctx);
        const currentSession = currentStore?.sessions[body.id];
        if (!currentStore || !currentSession) return;
        const shouldApplyMetadata = body.metadata !== null
            && body.metadata !== undefined
            && body.metadata.version > currentSession.metadataVersion;
        const shouldApplyAgentState = body.agentState !== null
            && body.agentState !== undefined
            && body.agentState.version > currentSession.agentStateVersion;
        const shouldApplyCurrentTimestamp = update.createdAt > currentSession.updatedAt;
        if (!shouldApplyMetadata && !shouldApplyAgentState && !shouldApplyCurrentTimestamp) return;
        markSessionsMutation(ctx);
        currentStore.applySessions([{
            ...currentSession,
            metadata: shouldApplyMetadata ? metadata : currentSession.metadata,
            metadataVersion: shouldApplyMetadata && body.metadata ? body.metadata.version : currentSession.metadataVersion,
            agentState: shouldApplyAgentState ? agentState : currentSession.agentState,
            agentStateVersion: shouldApplyAgentState && body.agentState ? body.agentState.version : currentSession.agentStateVersion,
            updatedAt: Math.max(currentSession.updatedAt, update.createdAt),
            seq: Math.max(currentSession.seq, update.seq)
        }]);
        return;
    }

    if (update.body.t === 'new-machine') {
        await refreshMachinesForContext(ctx);
        return;
    }

    if (update.body.t === 'delete-machine') {
        markMachinesMutation(ctx);
        ctx.machineActivityPatches.delete(update.body.machineId);
        evictMachine(update.body.machineId);
        return;
    }

    if (update.body.t === 'kv-batch-update') {
        const changes = update.body.changes;
        for (const listener of kvListeners) {
            if (!isCurrentClientContext(ctx)) return;
            listener(changes);
        }
        return;
    }

    if (update.body.t === 'update-machine') {
        const body = update.body;
        const store = getCurrentProtocolStore(ctx);
        if (!store) return;
        const machine = store.machines[body.machineId];
        if (!machine) {
            await refreshMachinesForContext(ctx);
            return;
        }
        const cipher = ctx.machineDataCiphers.get(body.machineId);
        if (!cipher) return;
        const shouldDecryptMetadata = body.metadata !== null
            && body.metadata !== undefined
            && body.metadata.version > machine.metadataVersion;
        const shouldDecryptDaemonState = body.daemonState !== null
            && body.daemonState !== undefined
            && body.daemonState.version > machine.daemonStateVersion;
        const shouldApplyActivity = body.active !== undefined
            && body.activeAt !== undefined
            && body.activeAt > machine.activeAt;
        if (!shouldDecryptMetadata && !shouldDecryptDaemonState && !shouldApplyActivity) {
            return;
        }

        let metadata = machine.metadata;
        if (shouldDecryptMetadata && body.metadata) {
            metadata = await decryptMachineMetadata(cipher, body.metadata.value);
            if (!isCurrentClientContext(ctx)) return;
        }
        let daemonState = machine.daemonState;
        if (shouldDecryptDaemonState && body.daemonState) {
            daemonState = await cipher.decryptRaw(body.daemonState.value);
            if (!isCurrentClientContext(ctx)) return;
        }
        const currentStore = getCurrentProtocolStore(ctx);
        const currentMachine = currentStore?.machines[body.machineId];
        if (!currentStore || !currentMachine) return;
        const shouldApplyMetadata = body.metadata !== null
            && body.metadata !== undefined
            && body.metadata.version > currentMachine.metadataVersion;
        const shouldApplyDaemonState = body.daemonState !== null
            && body.daemonState !== undefined
            && body.daemonState.version > currentMachine.daemonStateVersion;
        const shouldApplyCurrentActivity = body.active !== undefined
            && body.activeAt !== undefined
            && body.activeAt > currentMachine.activeAt;
        if (!shouldApplyMetadata && !shouldApplyDaemonState && !shouldApplyCurrentActivity) return;
        markMachinesMutation(ctx);
        currentStore.applyMachines([{
            ...currentMachine,
            metadata: shouldApplyMetadata ? metadata : currentMachine.metadata,
            metadataVersion: shouldApplyMetadata && body.metadata ? body.metadata.version : currentMachine.metadataVersion,
            daemonState: shouldApplyDaemonState ? daemonState : currentMachine.daemonState,
            daemonStateVersion: shouldApplyDaemonState && body.daemonState ? body.daemonState.version : currentMachine.daemonStateVersion,
            active: shouldApplyCurrentActivity && body.active !== undefined ? body.active : currentMachine.active,
            activeAt: shouldApplyCurrentActivity && body.activeAt !== undefined ? body.activeAt : currentMachine.activeAt,
            updatedAt: Math.max(currentMachine.updatedAt, update.createdAt)
        }]);
    }
}

function handleEphemeral(ctx: ClientContext, data: unknown): void {
    if (!isCurrentClientContext(ctx)) return;
    const parsed = ApiEphemeralUpdateSchema.safeParse(data);
    if (!parsed.success) {
        return;
    }
    const update = parsed.data;
    const store = getCurrentProtocolStore(ctx);
    if (!store) return;

    if (update.type === 'activity') {
        setBoundedActivityPatch(ctx.sessionActivityPatches, update.id, {
            active: update.active,
            activeAt: update.activeAt,
            thinking: update.thinking,
        });
        store.applySessionActivity(update.id, update.active, update.activeAt, update.thinking);
    } else if (update.type === 'machine-activity') {
        setBoundedActivityPatch(ctx.machineActivityPatches, update.id, {
            active: update.active,
            activeAt: update.activeAt,
        });
        store.applyMachineActivity(update.id, update.active, update.activeAt);
    }
    // 'usage' — not consumed by the web client yet
}

// ─── Lifecycle ───────────────────────────────────────────────────

/** Период замера латентности демона (GET /health) для пилюли соединения. */
const LATENCY_PING_INTERVAL_MS = 30_000;

async function refreshAfterReconnect(ctx: ClientContext): Promise<void> {
    await runProtocolReconnect({
        refreshMachines: () => refreshMachinesForContext(ctx),
        refreshSessions: () => refreshSessionsForContext(ctx),
        notifyReconnected: () => notifyProtocolReconnected(() => isCurrentClientContext(ctx))
    });
}

async function startWithCredentials(
    credentials: P2PCredentials,
    preserveStore = false,
    shouldRequireSocketAuthentication = false,
): Promise<void> {
    stopProtocolClient({ preserveStore });

    const ctx: ClientContext = {
        generation: lifecycleGeneration,
        sessionsEpoch: 0,
        machinesEpoch: 0,
        sessionActivityPatches: new Map(),
        machineActivityPatches: new Map(),
        credentials,
        encryption: createEncryption(credentials.contentSecret),
        sessionCiphers: new Map(),
        machineCiphers: new Map(),
        machineDataCiphers: new Map(),
        unsubscribers: []
    };
    context = ctx;

    ctx.unsubscribers.push(onSocketStatusChange((status) => {
        getCurrentProtocolStore(ctx)?.setConnectionStatus(status);
    }));
    ctx.unsubscribers.push(onSocketMessage('update', (data) => {
        void handleUpdate(ctx, data);
    }));
    ctx.unsubscribers.push(onSocketMessage('ephemeral', (data) => {
        handleEphemeral(ctx, data);
    }));
    ctx.unsubscribers.push(onSocketReconnected(() => refreshAfterReconnect(ctx).catch(() => undefined)));

    socketConnect(
        { endpoint: credentials.endpoint, token: credentials.token },
        {
            getSessionCipher: (sessionId) => ctx.sessionCiphers.get(sessionId) ?? null,
            getMachineCipher: (machineId) => ctx.machineCiphers.get(machineId) ?? null
        }
    );

    if (shouldRequireSocketAuthentication) {
        await waitForSocketConnection();
    }

    useProtocolStore.getState().setAuthenticated(true);

    // Латентность соединения: GET /health раз в ~30s — пилюля HomePage («p2p · 12ms»)
    const measureLatency = async () => {
        const latencyMs = await measureHealthLatency(credentials.endpoint);
        getCurrentProtocolStore(ctx)?.setLatency(latencyMs);
    };
    void measureLatency();
    const latencyTimer = window.setInterval(() => { void measureLatency(); }, LATENCY_PING_INTERVAL_MS);
    ctx.unsubscribers.push(() => window.clearInterval(latencyTimer));

    // Initial data load (socket handlers keep it fresh afterwards)
    await Promise.all([
        refreshSessionsForContext(ctx).catch(() => undefined),
        refreshMachinesForContext(ctx).catch(() => undefined)
    ]);
}

/** Connect using a parsed QR/URL/manual payload; persists the connection. */
export async function startProtocolClient(payload: P2PQRPayload): Promise<void> {
    if (isFixturesActive) return;
    const credentials = connectP2P(payload);
    await startWithCredentials(credentials);
}

/**
 * Promote a sealed, host-approved pairing without navigating away or losing
 * the visible session list. After the caller decrypts the sealed replacement,
 * persist it before the handshake: the daemon has already revoked the old
 * bearer, so this is the browser's recovery credential during Socket.IO retry.
 */
export async function replaceProtocolClient(payload: P2PQRPayload): Promise<void> {
    if (isFixturesActive) return;
    const credentials = createP2PCredentials(payload);
    storeConnection({ host: payload.host, port: payload.port, key: payload.key });
    await startWithCredentials(credentials, true, true);
}

/** Restore a persisted connection (page load). Returns false when none stored. */
export async function restoreProtocolClient(): Promise<boolean> {
    if (isFixturesActive) return true;
    const credentials = restoreCredentials();
    if (!credentials) {
        return false;
    }
    await startWithCredentials(credentials);
    return true;
}

/** Disconnect the socket and drop in-memory state (keeps stored credentials). */
export function stopProtocolClient(options: { preserveStore?: boolean } = {}): void {
    if (isFixturesActive) return; // фикстуры в сторе живут до выключения режима
    lifecycleGeneration += 1;
    if (context) {
        for (const unsubscribe of context.unsubscribers) {
            unsubscribe();
        }
        context = null;
    }
    socketDisconnect();
    if (!options.preserveStore) {
        useProtocolStore.getState().reset();
    }
}

/** Logout: disconnect and forget the stored connection. */
export function logoutProtocolClient(): void {
    stopProtocolClient();
    disconnectP2P();
}
