import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import { deriveBearerToken, generateSharedSecret } from '@/daemon/p2p/p2pAuth';
import {
    REQUEST_PROOF_VERSION,
    calculateRequestProofMac,
    type JsonValue,
    type P2PRequestProof,
    type RequestProofTransport,
} from '@/daemon/p2p/p2pRequestProof';
import { startP2PServer, type P2PServer } from '@/daemon/p2p/p2pServer';
import { P2PRunnerCredentialStore, SESSION_MESSAGE_ACK_VERSION } from '@/daemon/p2p/p2pRunnerCredentials';
import { P2PStore } from '@/daemon/p2p/p2pStore';

const SOCKET_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 20;

const {
    mockEnsureWhisperModel,
    mockIsWhisperAvailable,
    mockTranscribe,
} = vi.hoisted(() => ({
    mockEnsureWhisperModel: vi.fn(),
    mockIsWhisperAvailable: vi.fn(() => false),
    mockTranscribe: vi.fn(),
}));

vi.mock('@/daemon/whisper/whisperService', () => ({
    ensureModel: mockEnsureWhisperModel,
    getStatus: vi.fn(() => ({
        available: false,
        nativeBindings: false,
        modelDownloaded: false,
        selectedModel: null,
    })),
    isAvailable: mockIsWhisperAvailable,
    transcribe: mockTranscribe,
}));

let server: P2PServer | null = null;
const sockets = new Set<ClientSocket>();

function createSocket(port: number, token: string, auth: Record<string, unknown>): ClientSocket {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
        auth: { token, ...auth },
        path: '/v1/updates',
        transports: ['websocket'],
        reconnection: false,
        autoConnect: false,
        timeout: SOCKET_TIMEOUT_MS,
    });
    sockets.add(socket);
    return socket;
}

async function connectSocket(socket: ClientSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off('connect', handleConnect);
            socket.off('connect_error', handleError);
            reject(new Error('Timed out connecting to the P2P Socket.IO server'));
        }, SOCKET_TIMEOUT_MS);
        const handleConnect = (): void => {
            clearTimeout(timeout);
            socket.off('connect_error', handleError);
            resolve();
        };
        const handleError = (error: Error): void => {
            clearTimeout(timeout);
            socket.off('connect', handleConnect);
            reject(error);
        };
        socket.once('connect', handleConnect);
        socket.once('connect_error', handleError);
        socket.connect();
    });
}

async function waitForSocketEvent<T>(socket: ClientSocket, event: string): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off(event, handleEvent);
            reject(new Error(`Timed out waiting for Socket.IO event: ${event}`));
        }, SOCKET_TIMEOUT_MS);
        const handleEvent = (value: T): void => {
            clearTimeout(timeout);
            resolve(value);
        };
        socket.once(event, handleEvent);
    });
}

async function waitForCondition(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + SOCKET_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (condition()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error('Timed out waiting for P2P condition');
}

function createProof(
    authSecret: Uint8Array,
    transport: RequestProofTransport,
    operation: string,
    payload: JsonValue,
    id = randomUUID(),
): P2PRequestProof {
    const mac = calculateRequestProofMac(authSecret, {
        v: REQUEST_PROOF_VERSION,
        transport,
        operation,
        requestId: id,
        payload,
    });
    if (!mac) {
        throw new Error('Could not create request proof');
    }

    return { v: REQUEST_PROOF_VERSION, id, mac };
}

function withSocketProof<T extends Record<string, JsonValue>>(
    authSecret: Uint8Array,
    operation: string,
    payload: T,
): T & { proof: P2PRequestProof } {
    return {
        ...payload,
        proof: createProof(authSecret, 'socket', operation, payload),
    };
}

function requestProofHeaders(
    authSecret: Uint8Array,
    operation: string,
    payload: JsonValue,
): HeadersInit {
    const proof = createProof(authSecret, 'http', operation, payload);
    return {
        'X-Remcli-Request-Proof-Version': String(proof.v),
        'X-Remcli-Request-Proof-Id': proof.id,
        'X-Remcli-Request-Proof-Mac': proof.mac,
    };
}

function createTranscriptionFormData(): FormData {
    const formData = new FormData();
    formData.set('audio', new Blob(['not-audio'], { type: 'audio/webm' }), 'sample.webm');
    return formData;
}

afterEach(async () => {
    for (const socket of sockets) {
        socket.close();
    }
    sockets.clear();
    await server?.stop();
    server = null;
    mockEnsureWhisperModel.mockClear();
    mockIsWhisperAvailable.mockClear();
    mockTranscribe.mockClear();
});

describe('P2P request proof integrity', { timeout: 15_000 }, () => {
    it('rejects bearer-only, replayed, and session-transplanted message ciphertexts', async () => {
        const authSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(authSecret);
        const store = new P2PStore({ kvFilePath: null });
        const sessionA = store.createSession('request-proof-a', '{}', null);
        const sessionB = store.createSession('request-proof-b', '{}', null);
        server = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret,
            store,
        });

        const userSocket = createSocket(server.port, bearerToken, { clientType: 'user-scoped' });
        const observerSocket = createSocket(server.port, bearerToken, { clientType: 'user-scoped' });
        let observerUpdates = 0;
        observerSocket.on('update', () => {
            observerUpdates += 1;
        });
        await Promise.all([connectSocket(userSocket), connectSocket(observerSocket)]);

        userSocket.emit('message', { sid: sessionA.id, message: 'bearer-only-ciphertext' });
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        expect(store.getMessageCount(sessionA.id)).toBe(0);
        expect(observerUpdates).toBe(0);

        const message = withSocketProof(authSecret, 'message', {
            sid: sessionA.id,
            message: 'captured-ciphertext',
        });
        userSocket.emit('message', message);
        await waitForCondition(() => store.getMessageCount(sessionA.id) === 1);

        userSocket.emit('message', message);
        userSocket.emit('message', { ...message, sid: sessionB.id });
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

        expect(store.getMessageCount(sessionA.id)).toBe(1);
        expect(store.getMessageCount(sessionB.id)).toBe(0);
    });

    it('blocks bearer-only session and machine scope escalation while retaining acknowledged runners', async () => {
        const authSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(authSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('request-proof-runner', 'initial', null);
        const machineId = 'request-proof-machine';
        const method = `${machineId}:mutate`;
        const machine = store.getOrCreateMachine(machineId, 'machine-initial', null, null);
        if (!machine) {
            throw new Error('Could not create test machine');
        }
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        server = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret,
            store,
            runnerCredentialStore,
        });

        const userSocket = createSocket(server.port, bearerToken, { clientType: 'user-scoped' });
        const machineSocket = createSocket(server.port, bearerToken, {
            clientType: 'machine-scoped',
            machineId,
        });
        const legacySessionSocket = createSocket(server.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: session.id,
        });
        await Promise.all([
            connectSocket(userSocket),
            connectSocket(machineSocket),
            connectSocket(legacySessionSocket),
        ]);

        const legacySessionResponse = await legacySessionSocket
            .timeout(SOCKET_TIMEOUT_MS)
            .emitWithAck('update-metadata', {
                sid: session.id,
                metadata: 'bearer-only-session-update',
                expectedVersion: session.metadataVersion,
            });
        const machineScopeResponse = await machineSocket
            .timeout(SOCKET_TIMEOUT_MS)
            .emitWithAck('machine-update-metadata', {
                machineId,
                metadata: 'bearer-only-machine-update',
                expectedVersion: machine.metadataVersion,
            });
        expect(legacySessionResponse).toEqual({ result: 'error' });
        expect(machineScopeResponse).toEqual({ result: 'error' });
        expect(store.getSession(session.id)?.metadata).toBe('initial');
        expect(store.getMachine(machineId)?.metadata).toBe('machine-initial');

        const runnerCredential = runnerCredentialStore.issue(session.id, 'request-proof-runner');
        if (!runnerCredential) {
            throw new Error('Could not issue runner credential');
        }
        const runnerSocket = createSocket(server.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: session.id,
            messageAckVersion: SESSION_MESSAGE_ACK_VERSION,
            runnerCredential,
        });
        await connectSocket(runnerSocket);

        let handlerCalls = 0;
        machineSocket.on('rpc-request', (_data, callback: (response: string) => void) => {
            handlerCalls += 1;
            callback('machine-response');
        });
        const registration = waitForSocketEvent<{ method: string }>(machineSocket, 'rpc-registered');
        machineSocket.emit('rpc-register', withSocketProof(authSecret, 'rpc-register', { method }));
        await expect(registration).resolves.toEqual({ method });

        const missingProofResponse = await userSocket
            .timeout(SOCKET_TIMEOUT_MS)
            .emitWithAck('rpc-call', { method, params: 'ciphertext' });
        expect(missingProofResponse).toEqual({ ok: false, error: 'Invalid request proof' });

        const invalidProof = createProof(authSecret, 'socket', 'message', { method, params: 'ciphertext' });
        const invalidProofResponse = await userSocket
            .timeout(SOCKET_TIMEOUT_MS)
            .emitWithAck('rpc-call', { method, params: 'ciphertext', proof: invalidProof });
        expect(invalidProofResponse).toEqual({ ok: false, error: 'Invalid request proof' });
        expect(handlerCalls).toBe(0);

        const rpcCall = withSocketProof(authSecret, 'rpc-call', { method, params: 'ciphertext' });
        const validResponse = await userSocket.timeout(SOCKET_TIMEOUT_MS).emitWithAck('rpc-call', rpcCall);
        expect(validResponse).toEqual({ ok: true, result: 'machine-response' });
        expect(handlerCalls).toBe(1);

        const replayedResponse = await userSocket.timeout(SOCKET_TIMEOUT_MS).emitWithAck('rpc-call', rpcCall);
        expect(replayedResponse).toEqual({ ok: false, error: 'Invalid request proof' });
        expect(handlerCalls).toBe(1);

        const runnerResponse = await runnerSocket.timeout(SOCKET_TIMEOUT_MS).emitWithAck('update-metadata', {
            sid: session.id,
            metadata: 'runner-update-without-proof',
            expectedVersion: session.metadataVersion,
        });
        expect(runnerResponse).toMatchObject({ result: 'success', metadata: 'runner-update-without-proof' });
    });

    it('requires and consumes proof headers for JSON and no-body REST mutations', async () => {
        const authSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(authSecret);
        const store = new P2PStore({ kvFilePath: null });
        server = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret,
            store,
        });

        const body = { tag: 'request-proof-rest', metadata: '{}', agentState: null, dataEncryptionKey: null };
        const url = `http://127.0.0.1:${server.port}/v1/sessions`;
        const authorization = { Authorization: `Bearer ${bearerToken}`, 'Content-Type': 'application/json' };

        const missingProof = await fetch(url, {
            method: 'POST',
            headers: authorization,
            body: JSON.stringify(body),
        });
        expect(missingProof.status).toBe(403);
        expect(store.getSessions()).toHaveLength(0);

        const proofHeaders = requestProofHeaders(authSecret, 'POST /v1/sessions', body);
        const accepted = await fetch(url, {
            method: 'POST',
            headers: { ...authorization, ...proofHeaders },
            body: JSON.stringify(body),
        });
        expect(accepted.status).toBe(200);
        const acceptedBody = await accepted.json() as { session: { id: string } };

        const replay = await fetch(url, {
            method: 'POST',
            headers: { ...authorization, ...proofHeaders },
            body: JSON.stringify(body),
        });
        expect(replay.status).toBe(403);
        expect(store.getSessions()).toHaveLength(1);

        const deletePath = `/v1/sessions/${acceptedBody.session.id}`;
        const deleted = await fetch(`http://127.0.0.1:${server.port}${deletePath}`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${bearerToken}`,
                ...requestProofHeaders(authSecret, `DELETE ${deletePath}`, null),
            },
        });
        expect(deleted.status).toBe(200);
        expect(store.getSessions()).toHaveLength(0);
    });

    it('does not derive daemon machine ownership from a bearer socket handshake', async () => {
        const authSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(authSecret);
        const daemonMachineId = 'configured-daemon-machine';
        const forgedMachineId = 'forged-machine-id';
        const store = new P2PStore({ kvFilePath: null });
        store.getOrCreateMachine(daemonMachineId, '{}', null, null);
        store.getOrCreateMachine(forgedMachineId, '{}', null, null);
        server = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret,
            store,
            daemonMachineId,
        });

        const forgedMachineSocket = createSocket(server.port, bearerToken, {
            clientType: 'machine-scoped',
            machineId: forgedMachineId,
        });
        await connectSocket(forgedMachineSocket);

        expect(store.isOwnMachine(daemonMachineId)).toBe(true);
        expect(store.isOwnMachine(forgedMachineId)).toBe(false);

        const deleteForgedPath = `/v1/machines/${forgedMachineId}`;
        const deletedForgedMachine = await fetch(`http://127.0.0.1:${server.port}${deleteForgedPath}`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${bearerToken}`,
                ...requestProofHeaders(authSecret, `DELETE ${deleteForgedPath}`, null),
            },
        });
        expect(deletedForgedMachine.status).toBe(200);
        expect(store.getMachine(forgedMachineId)).toBeUndefined();

        const deleteDaemonPath = `/v1/machines/${daemonMachineId}`;
        const deletedDaemonMachine = await fetch(`http://127.0.0.1:${server.port}${deleteDaemonPath}`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${bearerToken}`,
                ...requestProofHeaders(authSecret, `DELETE ${deleteDaemonPath}`, null),
            },
        });
        expect(deletedDaemonMachine.status).toBe(403);
        expect(store.getMachine(daemonMachineId)).not.toBeNull();
    });

    it('requires a one-shot null-payload proof before multipart transcription', async () => {
        const authSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(authSecret);
        const store = new P2PStore({ kvFilePath: null });
        server = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret,
            store,
        });

        const path = '/v1/voice/transcribe';
        const url = `http://127.0.0.1:${server.port}${path}`;
        const authorization = { Authorization: `Bearer ${bearerToken}` };

        const missingProof = await fetch(url, {
            method: 'POST',
            headers: authorization,
            body: createTranscriptionFormData(),
        });
        expect(missingProof.status).toBe(403);
        expect(mockIsWhisperAvailable).not.toHaveBeenCalled();
        expect(mockEnsureWhisperModel).not.toHaveBeenCalled();
        expect(mockTranscribe).not.toHaveBeenCalled();

        const proofHeaders = requestProofHeaders(authSecret, `POST ${path}`, null);
        const accepted = await fetch(url, {
            method: 'POST',
            headers: { ...authorization, ...proofHeaders },
            body: createTranscriptionFormData(),
        });
        expect(accepted.status).toBe(503);
        expect(mockIsWhisperAvailable).toHaveBeenCalledTimes(1);
        expect(mockEnsureWhisperModel).not.toHaveBeenCalled();
        expect(mockTranscribe).not.toHaveBeenCalled();

        const replay = await fetch(url, {
            method: 'POST',
            headers: { ...authorization, ...proofHeaders },
            body: createTranscriptionFormData(),
        });
        expect(replay.status).toBe(403);
        expect(mockIsWhisperAvailable).toHaveBeenCalledTimes(1);
        expect(mockEnsureWhisperModel).not.toHaveBeenCalled();
        expect(mockTranscribe).not.toHaveBeenCalled();
    });
});
