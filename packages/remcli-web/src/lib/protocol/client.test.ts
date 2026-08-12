import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { P2PCredentials } from '@/lib/protocol/connection';
import type { NormalizedMessage } from '@/lib/protocol/messages';
import type { ApiMachine, ApiMessage, ApiSession } from '@/lib/protocol/types';

function installFixtureGlobals() {
    const storage = new Map<string, string>();
    const localStorageMock = {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
        removeItem: vi.fn((key: string) => { storage.delete(key); }),
        clear: vi.fn(() => { storage.clear(); }),
    };
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));

    vi.stubGlobal('localStorage', localStorageMock);
    vi.stubGlobal('window', {
        location: { search: '?fixtures=1' },
        fetch: fetchMock,
    });
}

interface IDeferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

interface IFakeSocket {
    socket: Socket;
    trigger: (event: string) => void;
}

function createFakeSocket(): IFakeSocket {
    const listeners = new Map<string, () => void>();
    const socket = {
        connected: false,
        recovered: false,
        disconnect: vi.fn(),
        emit: vi.fn(),
        emitWithAck: vi.fn(),
        on: vi.fn((event: string, listener: () => void) => {
            listeners.set(event, listener);
            return socket;
        }),
        onAny: vi.fn(),
    } as unknown as Socket;

    return {
        socket,
        trigger(event) {
            if (event === 'connect') {
                (socket as unknown as { connected: boolean }).connected = true;
            } else if (event === 'disconnect') {
                (socket as unknown as { connected: boolean }).connected = false;
            }
            listeners.get(event)?.();
        },
    };
}

interface IReconnectMockOptions {
    deleteMachine?: () => Promise<{ ok: boolean; status?: number }>;
    decryptRaw?: (value: string) => Promise<unknown | null>;
    encryptRaw?: (value: unknown) => Promise<string>;
    fetchMachines?: () => Promise<ApiMachine[]>;
    fetchMessages?: (
        config: unknown,
        sessionId: string,
        options?: { limit?: number; offset?: number }
    ) => Promise<{ messages: ApiMessage[]; total: number; hasMore: boolean }>;
    fetchSessions: () => Promise<ApiSession[]>;
    measureHealthLatency?: () => Promise<number | null>;
    realSocket?: IFakeSocket;
    realSockets?: IFakeSocket[];
    restoreCredentials?: () => P2PCredentials | null;
    sendEncryptedMessage?: (options: unknown) => void;
    waitForSocketConnection?: () => Promise<void>;
}

interface IReconnectMocks {
    notifySocketReconnect: () => Promise<void>;
    notifySocketEphemeral: (data: unknown) => Promise<void>;
    notifySocketUpdate: (data: unknown) => Promise<void>;
}

function createDeferred<T>(): IDeferred<T> {
    let resolvePromise!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function createTestSession(id: string): ApiSession {
    return {
        id,
        seq: 1,
        metadata: 'session-metadata',
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        dataEncryptionKey: null,
        active: true,
        activeAt: 1000,
        createdAt: 1000,
        updatedAt: 1000,
    };
}

function createTestMachine(id: string): ApiMachine {
    return {
        id,
        seq: 1,
        metadata: '{}',
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        dataEncryptionKey: null,
        active: true,
        activeAt: 1000,
        createdAt: 1000,
        updatedAt: 1000,
    };
}

function createTestMessage(id: string): NormalizedMessage {
    return {
        id,
        localId: null,
        seq: 1,
        createdAt: 1000,
        role: 'user',
        content: { type: 'text', text: 'Existing message' },
        isSidechain: false,
    };
}

function installReconnectMocks(options: IReconnectMockOptions): IReconnectMocks {
    let socketReconnectListener: (() => unknown) | undefined;
    let socketEphemeralListener: ((data: unknown) => unknown) | undefined;
    let socketUpdateListener: ((data: unknown) => unknown) | undefined;
    const decryptRaw = options.decryptRaw ?? vi.fn(async () => null);
    const fetchMachines = options.fetchMachines ?? (async () => []);
    const fetchMessages = options.fetchMessages ?? (async () => ({
        messages: [],
        total: 0,
        hasMore: false,
    }));

    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
    });
    vi.stubGlobal('window', {
        location: { search: '' },
        setInterval: vi.fn(() => 1),
        clearInterval: vi.fn(),
    });
    vi.doMock('@/lib/protocol/connection', () => ({
        connectP2P: vi.fn(() => ({ endpoint: 'http://127.0.0.1:12345', token: 'test-token', authSecret: new Uint8Array(32), contentSecret: new Uint8Array(32) })),
        createP2PCredentials: vi.fn(() => ({ endpoint: 'http://127.0.0.1:12345', token: 'replacement-token', authSecret: new Uint8Array(32), contentSecret: new Uint8Array(32) })),
        disconnectP2P: vi.fn(),
        restoreCredentials: options.restoreCredentials ?? vi.fn(() => null),
        storeConnection: vi.fn(),
    }));
    vi.doMock('@/lib/protocol/encryption', () => ({
        createEncryption: vi.fn(() => ({
            decryptEncryptionKey: vi.fn(() => null),
            openCipher: vi.fn(() => ({
                encryptRaw: options.encryptRaw ?? vi.fn(async () => ''),
                decryptRaw,
            })),
        })),
    }));
    vi.doMock('@/lib/protocol/rest', () => ({
        deleteMachine: options.deleteMachine ?? vi.fn(async () => ({ ok: true })),
        fetchMachines,
        fetchMessages,
        fetchSessions: options.fetchSessions,
        measureHealthLatency: options.measureHealthLatency ?? vi.fn(async () => null),
    }));
    if (options.realSocket || options.realSockets) {
        vi.doUnmock('@/lib/protocol/socket');
        const sockets = options.realSockets ?? [options.realSocket as IFakeSocket];
        let socketIndex = 0;
        vi.doMock('socket.io-client', () => ({
            io: vi.fn(() => sockets[socketIndex++]?.socket),
        }));
    } else {
        vi.doMock('@/lib/protocol/socket', () => ({
            machineListAgentSessions: vi.fn(),
            machineListDirectory: vi.fn(),
            machineSpawnNewSession: vi.fn(),
            machineStopSession: vi.fn(),
            onSocketMessage: vi.fn((event: string, listener: (data: unknown) => unknown) => {
                if (event === 'update') {
                    socketUpdateListener = listener;
                }
                if (event === 'ephemeral') {
                    socketEphemeralListener = listener;
                }
                return vi.fn();
            }),
            onSocketReconnected: vi.fn((listener: () => unknown) => {
                socketReconnectListener = listener;
                return vi.fn();
            }),
            onSocketStatusChange: vi.fn(() => vi.fn()),
            sendEncryptedMessage: options.sendEncryptedMessage ?? vi.fn(),
            sessionAllow: vi.fn(),
            sessionDeny: vi.fn(),
            socketConnect: vi.fn(),
            socketDisconnect: vi.fn(),
            socketEmitWithAck: vi.fn(),
            waitForSocketConnection: options.waitForSocketConnection ?? vi.fn().mockResolvedValue(undefined),
        }));
    }

    return {
        async notifySocketReconnect() {
            await socketReconnectListener?.();
        },
        async notifySocketEphemeral(data: unknown) {
            await socketEphemeralListener?.(data);
        },
        async notifySocketUpdate(data: unknown) {
            await socketUpdateListener?.(data);
        }
    };
}

describe('protocol client message meta', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('runs one central session refresh before notifying reconnect listeners', async () => {
        const { runProtocolReconnect } = await import('@/lib/protocol/client');
        const events: string[] = [];
        const refreshMachines = vi.fn(async () => {
            events.push('machines');
        });
        const refreshSessions = vi.fn(async () => {
            events.push('sessions');
        });
        const notifyReconnected = vi.fn(() => {
            events.push('listeners');
        });

        await runProtocolReconnect({ refreshMachines, refreshSessions, notifyReconnected });

        expect(refreshMachines).toHaveBeenCalledOnce();
        expect(refreshSessions).toHaveBeenCalledOnce();
        expect(notifyReconnected).toHaveBeenCalledOnce();
        expect(events.indexOf('sessions')).toBeLessThan(events.indexOf('listeners'));
    });

    it('does not send a model reset unless a model override is explicit', async () => {
        vi.resetModules();
        installFixtureGlobals();

        const { sendSessionMessage } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');

        await sendSessionMessage('fx-offline', 'Привет', { permissionMode: 'workspace-write' });

        const messages = useProtocolStore.getState().sessionMessages['fx-offline']?.messages ?? [];
        const lastMessage = messages.at(-1);
        expect(lastMessage).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'Привет' },
            meta: {
                sentFrom: 'web',
            },
        });
        expect(lastMessage?.meta).not.toHaveProperty('model');
        expect(lastMessage?.meta).not.toHaveProperty('permissionMode');
    });

    it('sends explicit null model as a deliberate reset', async () => {
        vi.resetModules();
        installFixtureGlobals();

        const { sendSessionMessage } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');

        await sendSessionMessage('fx-thinking', 'Сбрось модель', {
            permissionMode: 'workspace-write',
            model: null,
        });

        const messages = useProtocolStore.getState().sessionMessages['fx-thinking']?.messages ?? [];
        const lastMessage = messages.at(-1);
        expect(lastMessage?.meta).toMatchObject({
            sentFrom: 'web',
            model: null,
        });
        expect(lastMessage?.meta).not.toHaveProperty('permissionMode');
    });

    it('emits canonical harmless metadata and keeps the local echo for a Codex session', async () => {
        const session = createTestSession('session-codex');
        const encryptRaw = vi.fn(async () => 'encrypted-message');
        installReconnectMocks({
            decryptRaw: async (value) => value === session.metadata
                ? { path: '/workspace', host: 'host', flavor: 'codex' }
                : null,
            encryptRaw,
            fetchSessions: async () => [session],
        });

        const { sendSessionMessage, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        await sendSessionMessage(session.id, 'Keep the local echo', {
            permissionMode: 'workspace-write',
            model: 'foreign-turn-model',
            displayText: 'Visible local echo',
        });

        expect(encryptRaw).toHaveBeenCalledWith({
            role: 'user',
            content: { type: 'text', text: 'Keep the local echo' },
            meta: { sentFrom: 'web', displayText: 'Visible local echo' },
        });
        expect(useProtocolStore.getState().sessionMessages[session.id]?.messages.at(-1)).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'Keep the local echo' },
            meta: { sentFrom: 'web', displayText: 'Visible local echo' },
        });

        stopProtocolClient();
    });

    it('does not leave a local echo when message emission fails', async () => {
        const session = createTestSession('session-send-failure');
        const sendEncryptedMessage = vi.fn(() => {
            throw new Error('message emission failed');
        });
        installReconnectMocks({
            decryptRaw: async (value) => value === session.metadata
                ? { path: '/workspace', host: 'host', flavor: 'codex' }
                : null,
            fetchSessions: async () => [session],
            sendEncryptedMessage,
        });

        const { sendSessionMessage, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        await expect(sendSessionMessage(session.id, 'Do not echo this')).rejects.toThrow('message emission failed');
        expect(sendEncryptedMessage).toHaveBeenCalledOnce();
        expect(useProtocolStore.getState().sessionMessages[session.id]).toBeUndefined();

        stopProtocolClient();
    });

    it.each([
        ['claude', 'workspace-write'],
        ['gemini', 'danger-full-access'],
    ] as const)('drops a foreign %s permission mode without dropping the prompt', async (flavor, permissionMode) => {
        const session = createTestSession(`session-${flavor}`);
        const encryptRaw = vi.fn(async () => 'encrypted-message');
        installReconnectMocks({
            decryptRaw: async (value) => value === session.metadata
                ? { path: '/workspace', host: 'host', flavor }
                : null,
            encryptRaw,
            fetchSessions: async () => [session],
        });

        const { sendSessionMessage, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        await sendSessionMessage(session.id, 'Keep the text prompt', { permissionMode });

        expect(encryptRaw).toHaveBeenCalledWith({
            role: 'user',
            content: { type: 'text', text: 'Keep the text prompt' },
            meta: { sentFrom: 'web' },
        });

        stopProtocolClient();
    });

    it.each([
        ['claude', 'acceptEdits'],
        ['gemini', 'auto_edit'],
    ] as const)('keeps a native %s permission mode on the encrypted prompt', async (flavor, permissionMode) => {
        const session = createTestSession(`session-${flavor}`);
        const encryptRaw = vi.fn(async () => 'encrypted-message');
        installReconnectMocks({
            decryptRaw: async (value) => value === session.metadata
                ? { path: '/workspace', host: 'host', flavor }
                : null,
            encryptRaw,
            fetchSessions: async () => [session],
        });

        const { sendSessionMessage, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        await sendSessionMessage(session.id, 'Keep the native control', { permissionMode });

        expect(encryptRaw).toHaveBeenCalledWith({
            role: 'user',
            content: { type: 'text', text: 'Keep the native control' },
            meta: { sentFrom: 'web', permissionMode },
        });

        stopProtocolClient();
    });

    it.each([
        ['fx-running', 'codex'],
        ['fx-error', 'cursor'],
    ])('keeps fixture local echo canonical for %s', async (sessionId) => {
        vi.resetModules();
        installFixtureGlobals();

        const { sendSessionMessage } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');

        await sendSessionMessage(sessionId, 'Fixture local echo', {
            permissionMode: 'workspace-write',
            model: 'foreign-turn-model',
        });

        expect(useProtocolStore.getState().sessionMessages[sessionId]?.messages.at(-1)).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'Fixture local echo' },
            meta: { sentFrom: 'web' },
        });
        expect(useProtocolStore.getState().sessionMessages[sessionId]?.messages.at(-1)?.meta).not.toHaveProperty('permissionMode');
        expect(useProtocolStore.getState().sessionMessages[sessionId]?.messages.at(-1)?.meta).not.toHaveProperty('model');
    });

    it('routes fixture session spawn through the client wrapper instead of encrypted machine RPC', async () => {
        vi.resetModules();
        installFixtureGlobals();

        const { machineSpawnNewSession, useProtocolStore } = await import('@/lib/protocol');

        const result = await machineSpawnNewSession({
            machineId: 'fx-machine-online',
            directory: '~/projects/remcli',
            agent: 'codex',
        });

        expect(result.type).toBe('success');
        if (result.type !== 'success') return;

        const session = useProtocolStore.getState().sessions[result.sessionId];
        expect(session).toMatchObject({
            id: result.sessionId,
            active: true,
            metadata: {
                path: '/Users/dev/projects/remcli',
                machineId: 'fx-machine-online',
                flavor: 'codex',
                codexSessionId: expect.stringContaining('fixture-codex-'),
            },
        });
    });

    it('routes fixture resumable agent sessions through the client wrapper', async () => {
        vi.resetModules();
        installFixtureGlobals();

        const { machineListAgentSessions } = await import('@/lib/protocol');

        const sessions = await machineListAgentSessions('fx-machine-online', 'codex', undefined, 5);

        expect(sessions).toContainEqual(expect.objectContaining({
            sessionId: 'fixture-codex-fx-running',
            agent: 'codex',
            projectPath: '/Users/dev/projects/webapp',
            sessionName: 'webapp',
        }));
    });

    it('cancels a fixture pairing rekey without touching the network transport', async () => {
        vi.resetModules();
        installFixtureGlobals();

        const { machineCancelPairingRekey, machineRequestPairingRekey } = await import('@/lib/protocol/client');
        const pending = await machineRequestPairingRekey('fx-machine-online');

        await expect(machineCancelPairingRekey('fx-machine-online', pending)).resolves.toEqual({ type: 'cancelled' });
    });

    it('keeps each fixture pairing rekey pending for one poll before delivering its replacement QR', async () => {
        vi.resetModules();
        installFixtureGlobals();

        const { machineRequestPairingRekey, pollPairingRekey } = await import('@/lib/protocol/client');
        const firstRequest = await machineRequestPairingRekey('fx-machine-online');

        await expect(pollPairingRekey(firstRequest)).resolves.toEqual({
            type: 'pending',
            expiresAt: firstRequest.expiresAt,
        });
        await expect(pollPairingRekey(firstRequest)).resolves.toMatchObject({
            type: 'ready',
            pairing: { qrDataUrl: expect.stringContaining('data:image/svg+xml') },
        });

        const nextRequest = await machineRequestPairingRekey('fx-machine-online');
        await expect(pollPairingRekey(nextRequest)).resolves.toEqual({
            type: 'pending',
            expiresAt: nextRequest.expiresAt,
        });
    });
});

describe('protocol client reconnect lifecycle', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('hydrates exactly once after a transient initial socket error recovers', async () => {
        const fakeSocket = createFakeSocket();
        const fetchMachines = vi.fn(async () => []);
        const fetchSessions = vi.fn(async () => []);
        const measureHealthLatency = vi.fn(async () => null);
        installReconnectMocks({
            fetchMachines,
            fetchSessions,
            measureHealthLatency,
            realSocket: fakeSocket,
        });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');

        const start = startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });
        fakeSocket.trigger('connect_error');
        fakeSocket.trigger('error');
        await Promise.resolve();

        expect(useProtocolStore.getState().isAuthenticated).toBe(false);
        expect(fetchMachines).not.toHaveBeenCalled();
        expect(fetchSessions).not.toHaveBeenCalled();

        fakeSocket.trigger('connect');

        await expect(start).resolves.toBeUndefined();
        expect(useProtocolStore.getState().isAuthenticated).toBe(true);
        expect(fetchMachines).toHaveBeenCalledOnce();
        expect(fetchSessions).toHaveBeenCalledOnce();
        expect(measureHealthLatency).toHaveBeenCalledOnce();

        stopProtocolClient();
    });

    it('lets only the latest overlapping socket start authenticate the client', async () => {
        const firstSocket = createFakeSocket();
        const secondSocket = createFakeSocket();
        const fetchMachines = vi.fn(async () => []);
        const fetchSessions = vi.fn(async () => []);
        installReconnectMocks({
            fetchMachines,
            fetchSessions,
            realSockets: [firstSocket, secondSocket],
        });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');

        const firstStart = startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'first-key', v: 1 });
        const secondStart = startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'second-key', v: 1 });

        await expect(firstStart).rejects.toThrow('Socket connection changed during wait');
        firstSocket.trigger('connect');
        expect(useProtocolStore.getState().isAuthenticated).toBe(false);

        secondSocket.trigger('connect');
        await expect(secondStart).resolves.toBeUndefined();
        expect(useProtocolStore.getState().isAuthenticated).toBe(true);

        stopProtocolClient();
    });

    it('waits for authentication before exposing fresh or restored client data', async () => {
        const freshHandshake = createDeferred<void>();
        const restoredHandshake = createDeferred<void>();
        const waitForSocketConnection = vi.fn()
            .mockImplementationOnce(() => freshHandshake.promise)
            .mockImplementationOnce(() => restoredHandshake.promise);
        const fetchMachines = vi.fn(async () => []);
        const fetchSessions = vi.fn(async () => []);
        const measureHealthLatency = vi.fn(async () => null);
        const restoredCredentials: P2PCredentials = {
            endpoint: 'http://127.0.0.1:12345',
            token: 'restored-token',
            authSecret: new Uint8Array(32),
            contentSecret: new Uint8Array(32),
        };
        installReconnectMocks({
            fetchMachines,
            fetchSessions,
            measureHealthLatency,
            restoreCredentials: () => restoredCredentials,
            waitForSocketConnection,
        });
        const { restoreProtocolClient, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');

        const freshStart = startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });
        await vi.waitFor(() => expect(waitForSocketConnection).toHaveBeenCalledOnce());
        expect(useProtocolStore.getState().isAuthenticated).toBe(false);
        expect(fetchMachines).not.toHaveBeenCalled();
        expect(fetchSessions).not.toHaveBeenCalled();
        expect(measureHealthLatency).not.toHaveBeenCalled();

        freshHandshake.resolve(undefined);
        await freshStart;
        expect(useProtocolStore.getState().isAuthenticated).toBe(true);

        stopProtocolClient();

        const restoredStart = restoreProtocolClient();
        await vi.waitFor(() => expect(waitForSocketConnection).toHaveBeenCalledTimes(2));
        expect(useProtocolStore.getState().isAuthenticated).toBe(false);
        expect(fetchMachines).toHaveBeenCalledOnce();
        expect(fetchSessions).toHaveBeenCalledOnce();
        expect(measureHealthLatency).toHaveBeenCalledOnce();

        restoredHandshake.resolve(undefined);
        await expect(restoredStart).resolves.toBe(true);
        expect(useProtocolStore.getState().isAuthenticated).toBe(true);
        expect(fetchMachines).toHaveBeenCalledTimes(2);
        expect(fetchSessions).toHaveBeenCalledTimes(2);
        expect(measureHealthLatency).toHaveBeenCalledTimes(2);

        stopProtocolClient();
    });

    it('persists a decrypted replacement pairing before the new Socket.IO handshake', async () => {
        installReconnectMocks({ fetchSessions: async () => [] });
        const { replaceProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const connection = await import('@/lib/protocol/connection');
        const socket = await import('@/lib/protocol/socket');

        await replaceProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'replacement-key', v: 1 });

        expect(socket.waitForSocketConnection).toHaveBeenCalledOnce();
        expect(connection.storeConnection).toHaveBeenCalledWith({
            host: '127.0.0.1',
            port: 12345,
            key: 'replacement-key',
        });
        stopProtocolClient();
    });

    it('cleans up after the initial handshake timeout while keeping the decrypted replacement pairing', async () => {
        installReconnectMocks({ fetchSessions: async () => [] });
        const { replaceProtocolClient } = await import('@/lib/protocol/client');
        const connection = await import('@/lib/protocol/connection');
        const socket = await import('@/lib/protocol/socket');
        vi.mocked(socket.waitForSocketConnection).mockRejectedValueOnce(new Error('Timed out waiting for Socket.IO authentication'));

        const replacementStart = replaceProtocolClient({
            mode: 'p2p',
            host: '127.0.0.1',
            port: 12345,
            key: 'replacement-key',
            v: 1,
        });
        vi.mocked(socket.socketDisconnect).mockClear();

        await expect(replacementStart).rejects.toThrow('Timed out waiting for Socket.IO authentication');

        expect(connection.storeConnection).toHaveBeenCalledWith({
            host: '127.0.0.1',
            port: 12345,
            key: 'replacement-key',
        });
        expect(socket.socketDisconnect).toHaveBeenCalledOnce();
    });

    it('clears auth on a failed preserve-store rekey while retaining existing data', async () => {
        const handshake = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('replacement handshake failed'));
        const session = createTestSession('preserved-session');
        installReconnectMocks({
            fetchSessions: async () => [session],
            waitForSocketConnection: handshake,
        });
        const { replaceProtocolClient, startProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');

        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'current-key', v: 1 });
        useProtocolStore.getState().applyMessages(session.id, [createTestMessage('preserved-message')]);
        const preservedSession = useProtocolStore.getState().sessions[session.id];
        expect(useProtocolStore.getState().isAuthenticated).toBe(true);

        await expect(replaceProtocolClient({
            mode: 'p2p',
            host: '127.0.0.1',
            port: 12345,
            key: 'replacement-key',
            v: 1,
        })).rejects.toThrow('replacement handshake failed');

        const state = useProtocolStore.getState();
        expect(state.isAuthenticated).toBe(false);
        expect(state.connectionStatus).toBe('disconnected');
        expect(state.sessions[session.id]).toEqual(preservedSession);
        expect(state.sessionMessages[session.id]?.messages).toEqual([
            createTestMessage('preserved-message'),
        ]);
    });

    it('notifies ChatPage only after session refresh completes', async () => {
        const session = createTestSession('session-visible');
        const reconnectSessions = createDeferred<ApiSession[]>();
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([session])
            .mockImplementationOnce(() => reconnectSessions.promise);
        const fetchMessages = vi.fn(async () => ({
            messages: [],
            total: 0,
            hasMore: false,
        }));
        const { notifySocketReconnect } = installReconnectMocks({ fetchMessages, fetchSessions });
        const { loadSessionMessages, onProtocolReconnected, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        const refreshVisibleChat = vi.fn(async () => {
            await loadSessionMessages(session.id);
        });
        const unsubscribe = onProtocolReconnected(() => {
            void refreshVisibleChat().catch(() => undefined);
        });
        fetchSessions.mockClear();
        fetchMessages.mockClear();

        notifySocketReconnect();
        await Promise.resolve();

        expect(fetchSessions).toHaveBeenCalledOnce();
        expect(refreshVisibleChat).not.toHaveBeenCalled();
        expect(fetchMessages).not.toHaveBeenCalled();

        reconnectSessions.resolve([session]);
        await vi.waitFor(() => {
            expect(fetchMessages).toHaveBeenCalledOnce();
        });

        expect(fetchSessions.mock.invocationCallOrder[0])
            .toBeLessThan(fetchMessages.mock.invocationCallOrder[0]);
        expect(fetchMessages).toHaveBeenCalledWith(expect.any(Object), session.id, undefined);

        unsubscribe();
        stopProtocolClient();
    });

    it('reconciles empty reconnect snapshots by removing sessions, messages, and machines', async () => {
        const session = createTestSession('session-to-remove');
        const machine = createTestMachine('machine-to-remove');
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([session])
            .mockResolvedValueOnce([]);
        const fetchMachines = vi.fn()
            .mockResolvedValueOnce([machine])
            .mockResolvedValueOnce([]);
        const { notifySocketReconnect } = installReconnectMocks({ fetchMachines, fetchSessions });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        useProtocolStore.getState().applyMessages(session.id, [createTestMessage('old-message')], { markLoaded: true });
        await notifySocketReconnect();

        const state = useProtocolStore.getState();
        expect(state.sessions).toEqual({});
        expect(state.sessionMessages).toEqual({});
        expect(state.machines).toEqual({});

        stopProtocolClient();
    });

    it('reconciles initial snapshots after ephemeral activity without rolling the activity back', async () => {
        const session = createTestSession('session-with-pending-activity');
        const machine = createTestMachine('machine-with-pending-activity');
        const initialSessions = createDeferred<ApiSession[]>();
        const initialMachines = createDeferred<ApiMachine[]>();
        const fetchSessions = vi.fn(() => initialSessions.promise);
        const fetchMachines = vi.fn(() => initialMachines.promise);
        const { notifySocketEphemeral } = installReconnectMocks({ fetchMachines, fetchSessions });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');

        const start = startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });
        await vi.waitFor(() => {
            expect(fetchSessions).toHaveBeenCalledOnce();
            expect(fetchMachines).toHaveBeenCalledOnce();
        });

        await notifySocketEphemeral({
            type: 'activity',
            id: session.id,
            active: false,
            activeAt: 2000,
            thinking: true,
        });
        await notifySocketEphemeral({
            type: 'machine-activity',
            id: machine.id,
            active: false,
            activeAt: 3000,
        });
        await notifySocketEphemeral({
            type: 'activity',
            id: session.id,
            active: false,
            activeAt: 2000,
            thinking: true,
        });

        initialSessions.resolve([session]);
        initialMachines.resolve([machine]);
        await start;

        const state = useProtocolStore.getState();
        expect(state.sessions[session.id]).toMatchObject({
            id: session.id,
            active: false,
            activeAt: 2000,
            thinking: true,
            thinkingAt: 2000,
        });
        expect(state.machines[machine.id]).toMatchObject({
            id: machine.id,
            active: false,
            activeAt: 3000,
        });
        expect(fetchSessions).toHaveBeenCalledOnce();
        expect(fetchMachines).toHaveBeenCalledOnce();

        stopProtocolClient();
    });

    it('applies activity that arrives while another snapshot entity is still decrypting', async () => {
        const firstSession = { ...createTestSession('session-first'), metadata: 'session-first-metadata' };
        const secondSession = { ...createTestSession('session-second'), metadata: 'session-second-metadata' };
        const firstMachine = {
            ...createTestMachine('machine-first'),
            metadata: 'machine-first-metadata',
            dataEncryptionKey: 'machine-first-key',
        };
        const secondMachine = {
            ...createTestMachine('machine-second'),
            metadata: 'machine-second-metadata',
            dataEncryptionKey: 'machine-second-key',
        };
        const secondSessionDecryption = createDeferred<unknown | null>();
        const secondMachineDecryption = createDeferred<unknown | null>();
        const decryptRaw = vi.fn((value: string) => {
            if (value === secondSession.metadata) return secondSessionDecryption.promise;
            if (value === secondMachine.metadata) return secondMachineDecryption.promise;
            return Promise.resolve(null);
        });
        const fetchSessions = vi.fn(async () => [firstSession, secondSession]);
        const fetchMachines = vi.fn(async () => [firstMachine, secondMachine]);
        const { notifySocketEphemeral } = installReconnectMocks({ decryptRaw, fetchMachines, fetchSessions });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');

        const start = startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });
        await vi.waitFor(() => {
            expect(decryptRaw).toHaveBeenCalledWith(secondSession.metadata);
            expect(decryptRaw).toHaveBeenCalledWith(secondMachine.metadata);
        });

        await notifySocketEphemeral({
            type: 'activity',
            id: firstSession.id,
            active: false,
            activeAt: 2000,
            thinking: true,
        });
        await notifySocketEphemeral({
            type: 'machine-activity',
            id: firstMachine.id,
            active: false,
            activeAt: 3000,
        });

        secondSessionDecryption.resolve(null);
        secondMachineDecryption.resolve(null);
        await start;

        expect(useProtocolStore.getState().sessions[firstSession.id]).toMatchObject({
            active: false,
            activeAt: 2000,
            thinking: true,
            thinkingAt: 2000,
        });
        expect(useProtocolStore.getState().machines[firstMachine.id]).toMatchObject({
            active: false,
            activeAt: 3000,
        });

        stopProtocolClient();
    });

    it('clears activity patches for ids excluded by an authoritative snapshot', async () => {
        const initialSession = createTestSession('session-initial');
        const initialMachine = createTestMachine('machine-initial');
        const reappearingSession = createTestSession('session-patch-cleared');
        const reappearingMachine = createTestMachine('machine-patch-cleared');
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([initialSession])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([reappearingSession]);
        const fetchMachines = vi.fn()
            .mockResolvedValueOnce([initialMachine])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([reappearingMachine]);
        const { notifySocketEphemeral, notifySocketReconnect } = installReconnectMocks({ fetchMachines, fetchSessions });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        await notifySocketEphemeral({
            type: 'activity',
            id: reappearingSession.id,
            active: false,
            activeAt: 9000,
            thinking: true,
        });
        await notifySocketEphemeral({
            type: 'machine-activity',
            id: reappearingMachine.id,
            active: false,
            activeAt: 9000,
        });

        await notifySocketReconnect();
        await notifySocketReconnect();

        expect(useProtocolStore.getState().sessions[reappearingSession.id]).toMatchObject({
            active: true,
            activeAt: 1000,
            thinking: false,
        });
        expect(useProtocolStore.getState().machines[reappearingMachine.id]).toMatchObject({
            active: true,
            activeAt: 1000,
        });

        stopProtocolClient();
    });

    it('bounds unknown activity patches until the next authoritative snapshot', async () => {
        const evictedSession = createTestSession('session-activity-0');
        const retainedSession = createTestSession('session-activity-512');
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([evictedSession, retainedSession]);
        const { notifySocketEphemeral, notifySocketReconnect } = installReconnectMocks({
            fetchMachines: vi.fn(async () => []),
            fetchSessions,
        });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        for (let index = 0; index <= 512; index += 1) {
            await notifySocketEphemeral({
                type: 'activity',
                id: `session-activity-${index}`,
                active: false,
                activeAt: 10_000 + index,
                thinking: true,
            });
        }
        await notifySocketReconnect();

        expect(useProtocolStore.getState().sessions[evictedSession.id]).toMatchObject({
            active: true,
            activeAt: 1000,
            thinking: false,
        });
        expect(useProtocolStore.getState().sessions[retainedSession.id]).toMatchObject({
            active: false,
            activeAt: 10_512,
            thinking: true,
        });

        stopProtocolClient();
    });

    it('clears a machine activity patch after a local machine deletion', async () => {
        const machine = createTestMachine('machine-local-delete');
        const deleteMachine = vi.fn(async () => ({ ok: true }));
        const fetchMachines = vi.fn()
            .mockResolvedValueOnce([machine])
            .mockResolvedValueOnce([machine]);
        const { notifySocketEphemeral, notifySocketReconnect } = installReconnectMocks({
            deleteMachine,
            fetchMachines,
            fetchSessions: vi.fn(async () => []),
        });
        const { machineDelete, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        await notifySocketEphemeral({
            type: 'machine-activity',
            id: machine.id,
            active: false,
            activeAt: 9000,
        });
        await expect(machineDelete(machine.id)).resolves.toEqual({ ok: true });
        expect(useProtocolStore.getState().machines[machine.id]).toBeUndefined();

        await notifySocketReconnect();

        expect(useProtocolStore.getState().machines[machine.id]).toMatchObject({
            active: true,
            activeAt: 1000,
        });

        stopProtocolClient();
    });

    it('does not let a stale reconnect snapshot restore a session deleted by socket', async () => {
        const session = createTestSession('session-deleted-by-socket');
        const staleSnapshot = createDeferred<ApiSession[]>();
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([session])
            .mockImplementationOnce(() => staleSnapshot.promise);
        const { notifySocketReconnect, notifySocketUpdate } = installReconnectMocks({ fetchSessions });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });
        useProtocolStore.getState().applyMessages(session.id, [createTestMessage('deleted-message')], { markLoaded: true });

        const reconnect = notifySocketReconnect();
        await vi.waitFor(() => {
            expect(fetchSessions).toHaveBeenCalledTimes(2);
        });

        await notifySocketUpdate({
            id: 'delete-session-update',
            seq: 2,
            body: { t: 'delete-session', sessionId: session.id },
            createdAt: 2000,
        });
        expect(useProtocolStore.getState().sessions[session.id]).toBeUndefined();
        expect(useProtocolStore.getState().sessionMessages[session.id]).toBeUndefined();

        staleSnapshot.resolve([session]);
        await reconnect;

        expect(useProtocolStore.getState().sessions[session.id]).toBeUndefined();
        expect(useProtocolStore.getState().sessionMessages[session.id]).toBeUndefined();

        stopProtocolClient();
    });

    it('does not let stale reconnect snapshots roll back newer socket updates', async () => {
        const session = createTestSession('session-updated-by-socket');
        const machine = createTestMachine('machine-updated-by-socket');
        const staleSessions = createDeferred<ApiSession[]>();
        const staleMachines = createDeferred<ApiMachine[]>();
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([session])
            .mockImplementationOnce(() => staleSessions.promise);
        const fetchMachines = vi.fn()
            .mockResolvedValueOnce([machine])
            .mockImplementationOnce(() => staleMachines.promise);
        const { notifySocketReconnect, notifySocketUpdate } = installReconnectMocks({ fetchMachines, fetchSessions });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        const reconnect = notifySocketReconnect();
        await vi.waitFor(() => {
            expect(fetchSessions).toHaveBeenCalledTimes(2);
            expect(fetchMachines).toHaveBeenCalledTimes(2);
        });

        await notifySocketUpdate({
            id: 'update-session-after-reconnect',
            seq: 2,
            body: { t: 'update-session', id: session.id },
            createdAt: 2000,
        });
        await notifySocketUpdate({
            id: 'update-machine-after-reconnect',
            seq: 2,
            body: {
                t: 'update-machine',
                machineId: machine.id,
                active: false,
                activeAt: 3000,
            },
            createdAt: 3000,
        });

        staleSessions.resolve([session]);
        staleMachines.resolve([machine]);
        await reconnect;

        const state = useProtocolStore.getState();
        expect(state.sessions[session.id]).toMatchObject({ seq: 2, updatedAt: 2000 });
        expect(state.machines[machine.id]).toMatchObject({ active: false, activeAt: 3000, updatedAt: 3000 });

        stopProtocolClient();
    });

    it('does not let a slower older socket decrypt roll back a newer durable update', async () => {
        const session = createTestSession('session-socket-decrypt-order');
        const machine = { ...createTestMachine('machine-socket-decrypt-order'), dataEncryptionKey: 'machine-key' };
        const olderSessionMetadata = createDeferred<unknown>();
        const olderMachineMetadata = createDeferred<unknown>();
        const decryptRaw = vi.fn((value: string): Promise<unknown | null> => {
            if (value === 'session-metadata-old') return olderSessionMetadata.promise;
            if (value === 'machine-metadata-old') return olderMachineMetadata.promise;
            if (value === 'session-metadata-new') {
                return Promise.resolve({ path: '/workspace/new', host: 'new-host' });
            }
            if (value === 'machine-metadata-new') {
                return Promise.resolve({
                    host: 'new-machine',
                    platform: 'darwin',
                    remcliCliVersion: '1.0.0',
                    remcliHomeDir: '/Users/test/.remcli',
                    homeDir: '/Users/test',
                });
            }
            return Promise.resolve(null);
        });
        const { notifySocketUpdate } = installReconnectMocks({
            decryptRaw,
            fetchMachines: vi.fn(async () => [machine]),
            fetchSessions: vi.fn(async () => [session]),
        });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        await notifySocketUpdate({
            id: 'session-update-old',
            seq: 10,
            body: {
                t: 'update-session',
                id: session.id,
                metadata: { version: 2, value: 'session-metadata-old' },
            },
            createdAt: 2_000,
        });
        await notifySocketUpdate({
            id: 'machine-update-old',
            seq: 10,
            body: {
                t: 'update-machine',
                machineId: machine.id,
                metadata: { version: 2, value: 'machine-metadata-old' },
            },
            createdAt: 2_000,
        });
        await vi.waitFor(() => {
            expect(decryptRaw).toHaveBeenCalledWith('session-metadata-old');
            expect(decryptRaw).toHaveBeenCalledWith('machine-metadata-old');
        });

        await notifySocketUpdate({
            id: 'session-update-new',
            seq: 11,
            body: {
                t: 'update-session',
                id: session.id,
                metadata: { version: 3, value: 'session-metadata-new' },
            },
            createdAt: 3_000,
        });
        await notifySocketUpdate({
            id: 'machine-update-new',
            seq: 11,
            body: {
                t: 'update-machine',
                machineId: machine.id,
                metadata: { version: 3, value: 'machine-metadata-new' },
            },
            createdAt: 3_000,
        });
        await vi.waitFor(() => {
            expect(useProtocolStore.getState().sessions[session.id]).toMatchObject({
                metadata: { path: '/workspace/new', host: 'new-host' },
                metadataVersion: 3,
                updatedAt: 3_000,
            });
            expect(useProtocolStore.getState().machines[machine.id]).toMatchObject({
                metadata: { host: 'new-machine' },
                metadataVersion: 3,
                updatedAt: 3_000,
            });
        });

        olderSessionMetadata.resolve({ path: '/workspace/old', host: 'old-host' });
        olderMachineMetadata.resolve({
            host: 'old-machine',
            platform: 'darwin',
            remcliCliVersion: '1.0.0',
            remcliHomeDir: '/Users/test/.remcli',
            homeDir: '/Users/test',
        });

        await vi.waitFor(() => {
            expect(useProtocolStore.getState().sessions[session.id]).toMatchObject({
                metadata: { path: '/workspace/new', host: 'new-host' },
                metadataVersion: 3,
                updatedAt: 3_000,
            });
            expect(useProtocolStore.getState().machines[machine.id]).toMatchObject({
                metadata: { host: 'new-machine' },
                metadataVersion: 3,
                updatedAt: 3_000,
            });
        });

        stopProtocolClient();
    });

    it('does not let an in-flight older socket decrypt overwrite newer snapshot field versions', async () => {
        const session = { ...createTestSession('session-snapshot-wins'), metadata: 'session-metadata-initial' };
        const machine = {
            ...createTestMachine('machine-snapshot-wins'),
            dataEncryptionKey: 'machine-key',
            metadata: 'machine-metadata-initial',
        };
        const snapshotSession = {
            ...session,
            metadata: 'session-metadata-snapshot',
            metadataVersion: 3,
            updatedAt: 3_000,
        };
        const snapshotMachine = {
            ...machine,
            metadata: 'machine-metadata-snapshot',
            metadataVersion: 3,
            updatedAt: 3_000,
        };
        const olderSessionMetadata = createDeferred<unknown>();
        const olderMachineMetadata = createDeferred<unknown>();
        const decryptRaw = vi.fn((value: string): Promise<unknown | null> => {
            if (value === 'session-metadata-update-old') return olderSessionMetadata.promise;
            if (value === 'machine-metadata-update-old') return olderMachineMetadata.promise;
            if (value === 'session-metadata-snapshot') {
                return Promise.resolve({ path: '/workspace/snapshot', host: 'snapshot-host' });
            }
            if (value === 'machine-metadata-snapshot') {
                return Promise.resolve({
                    host: 'snapshot-machine',
                    platform: 'darwin',
                    remcliCliVersion: '1.0.0',
                    remcliHomeDir: '/Users/test/.remcli',
                    homeDir: '/Users/test',
                });
            }
            if (value === 'session-metadata-initial') {
                return Promise.resolve({ path: '/workspace/initial', host: 'initial-host' });
            }
            if (value === 'machine-metadata-initial') {
                return Promise.resolve({
                    host: 'initial-machine',
                    platform: 'darwin',
                    remcliCliVersion: '1.0.0',
                    remcliHomeDir: '/Users/test/.remcli',
                    homeDir: '/Users/test',
                });
            }
            return Promise.resolve(null);
        });
        const { notifySocketUpdate } = installReconnectMocks({
            decryptRaw,
            fetchMachines: vi.fn()
                .mockResolvedValueOnce([machine])
                .mockResolvedValueOnce([snapshotMachine]),
            fetchSessions: vi.fn()
                .mockResolvedValueOnce([session])
                .mockResolvedValueOnce([snapshotSession]),
        });
        const { refreshMachines, refreshSessions, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        await notifySocketUpdate({
            id: 'session-update-before-snapshot',
            seq: 10,
            body: {
                t: 'update-session',
                id: session.id,
                metadata: { version: 2, value: 'session-metadata-update-old' },
            },
            createdAt: 2_000,
        });
        await notifySocketUpdate({
            id: 'machine-update-before-snapshot',
            seq: 10,
            body: {
                t: 'update-machine',
                machineId: machine.id,
                metadata: { version: 2, value: 'machine-metadata-update-old' },
            },
            createdAt: 2_000,
        });
        await vi.waitFor(() => {
            expect(decryptRaw).toHaveBeenCalledWith('session-metadata-update-old');
            expect(decryptRaw).toHaveBeenCalledWith('machine-metadata-update-old');
        });

        await Promise.all([refreshSessions(), refreshMachines()]);
        expect(useProtocolStore.getState().sessions[session.id]).toMatchObject({
            metadata: { path: '/workspace/snapshot', host: 'snapshot-host' },
            metadataVersion: 3,
        });
        expect(useProtocolStore.getState().machines[machine.id]).toMatchObject({
            metadata: { host: 'snapshot-machine' },
            metadataVersion: 3,
        });

        olderSessionMetadata.resolve({ path: '/workspace/socket-old', host: 'old-host' });
        olderMachineMetadata.resolve({
            host: 'old-machine',
            platform: 'darwin',
            remcliCliVersion: '1.0.0',
            remcliHomeDir: '/Users/test/.remcli',
            homeDir: '/Users/test',
        });

        await vi.waitFor(() => {
            expect(useProtocolStore.getState().sessions[session.id]).toMatchObject({
                metadata: { path: '/workspace/snapshot', host: 'snapshot-host' },
                metadataVersion: 3,
            });
            expect(useProtocolStore.getState().machines[machine.id]).toMatchObject({
                metadata: { host: 'snapshot-machine' },
                metadataVersion: 3,
            });
        });

        stopProtocolClient();
    });

    it('keeps a fresher snapshot timestamp when a delayed message decrypt completes', async () => {
        const session = { ...createTestSession('session-message-snapshot-wins'), metadata: 'session-metadata-initial' };
        const snapshotSession = {
            ...session,
            metadata: 'session-metadata-snapshot',
            metadataVersion: 3,
            updatedAt: 3_000,
        };
        const delayedMessage = createDeferred<unknown>();
        const decryptRaw = vi.fn((value: string): Promise<unknown | null> => {
            if (value === 'late-message') return delayedMessage.promise;
            if (value === 'session-metadata-initial') {
                return Promise.resolve({ path: '/workspace/initial', host: 'initial-host' });
            }
            if (value === 'session-metadata-snapshot') {
                return Promise.resolve({ path: '/workspace/snapshot', host: 'snapshot-host' });
            }
            return Promise.resolve(null);
        });
        const { notifySocketUpdate } = installReconnectMocks({
            decryptRaw,
            fetchSessions: vi.fn()
                .mockResolvedValueOnce([session])
                .mockResolvedValueOnce([snapshotSession]),
        });
        const { refreshSessions, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        void notifySocketUpdate({
            id: 'late-new-message',
            seq: 2,
            body: {
                t: 'new-message',
                sid: session.id,
                message: {
                    id: 'late-message-id',
                    seq: 2,
                    content: { t: 'encrypted', c: 'late-message' },
                    createdAt: 2_000,
                },
            },
            createdAt: 2_000,
        });
        await vi.waitFor(() => expect(decryptRaw).toHaveBeenCalledWith('late-message'));

        await refreshSessions();
        delayedMessage.resolve({ role: 'user', content: { type: 'text', text: 'Late, but valid message' } });

        await vi.waitFor(() => {
            const state = useProtocolStore.getState();
            expect(state.sessions[session.id]).toMatchObject({
                metadata: { path: '/workspace/snapshot', host: 'snapshot-host' },
                metadataVersion: 3,
                updatedAt: 3_000,
            });
            expect(state.sessionMessages[session.id]?.messages).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'late-message-id' }),
            ]));
        });

        stopProtocolClient();
    });

    it('commits a fresh snapshot after an older delayed message update without losing the message', async () => {
        const session = { ...createTestSession('session-message-before-snapshot'), metadata: 'session-metadata-initial' };
        const snapshotSession = {
            ...session,
            metadata: 'session-metadata-snapshot',
            metadataVersion: 3,
            updatedAt: 3_000,
        };
        const delayedMessage = createDeferred<unknown>();
        const freshSnapshot = createDeferred<ApiSession[]>();
        const snapshotMetadata = createDeferred<unknown | null>();
        const decryptRaw = vi.fn((value: string): Promise<unknown | null> => {
            if (value === 'late-message') return delayedMessage.promise;
            if (value === 'session-metadata-initial') {
                return Promise.resolve({ path: '/workspace/initial', host: 'initial-host' });
            }
            if (value === 'session-metadata-snapshot') return snapshotMetadata.promise;
            return Promise.resolve(null);
        });
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([session])
            .mockImplementationOnce(() => freshSnapshot.promise);
        const { notifySocketUpdate } = installReconnectMocks({ decryptRaw, fetchSessions });
        const { refreshSessions, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        void notifySocketUpdate({
            id: 'older-new-message-before-snapshot',
            seq: 2,
            body: {
                t: 'new-message',
                sid: session.id,
                message: {
                    id: 'older-message-id',
                    seq: 2,
                    content: { t: 'encrypted', c: 'late-message' },
                    createdAt: 2_000,
                },
            },
            createdAt: 2_000,
        });
        await vi.waitFor(() => expect(decryptRaw).toHaveBeenCalledWith('late-message'));

        const refresh = refreshSessions();
        await vi.waitFor(() => expect(fetchSessions).toHaveBeenCalledTimes(2));

        delayedMessage.resolve({ role: 'user', content: { type: 'text', text: 'Older, but valid message' } });
        await vi.waitFor(() => {
            const state = useProtocolStore.getState();
            expect(state.sessions[session.id]).toMatchObject({
                metadataVersion: 1,
                updatedAt: 2_000,
                seq: 2,
            });
            expect(state.sessionMessages[session.id]?.messages).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: 'older-message-id' }),
            ]));
        });

        freshSnapshot.resolve([snapshotSession]);
        await vi.waitFor(() => expect(decryptRaw).toHaveBeenCalledWith('session-metadata-snapshot'));
        snapshotMetadata.resolve({ path: '/workspace/snapshot', host: 'snapshot-host' });
        await refresh;

        const state = useProtocolStore.getState();
        expect(state.sessions[session.id]).toMatchObject({
            metadata: { path: '/workspace/snapshot', host: 'snapshot-host' },
            metadataVersion: 3,
            updatedAt: 3_000,
            seq: 2,
        });
        expect(state.sessionMessages[session.id]?.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'older-message-id' }),
        ]));

        stopProtocolClient();
    });

    it('does not recreate a deleted session message cache after delayed history or socket decrypts', async () => {
        const session = createTestSession('session-deleted-during-message-decrypt');
        const delayedHistory = createDeferred<unknown>();
        const delayedSocketMessage = createDeferred<unknown>();
        const decryptRaw = vi.fn((value: string): Promise<unknown | null> => {
            if (value === 'history-message') return delayedHistory.promise;
            if (value === 'socket-message') return delayedSocketMessage.promise;
            if (value === session.metadata) {
                return Promise.resolve({ path: '/workspace', host: 'host' });
            }
            return Promise.resolve(null);
        });
        const historyMessage: ApiMessage = {
            id: 'history-message-id',
            seq: 1,
            content: { t: 'encrypted', c: 'history-message' },
            createdAt: 2_000,
        };
        const socketMessage: ApiMessage = {
            id: 'socket-message-id',
            seq: 2,
            content: { t: 'encrypted', c: 'socket-message' },
            createdAt: 2_001,
        };
        const { notifySocketUpdate } = installReconnectMocks({
            decryptRaw,
            fetchMessages: vi.fn(async () => ({
                messages: [historyMessage],
                total: 1,
                hasMore: false,
            })),
            fetchSessions: vi.fn(async () => [session]),
        });
        const { loadSessionMessages, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        const historyLoad = loadSessionMessages(session.id);
        await vi.waitFor(() => expect(decryptRaw).toHaveBeenCalledWith('history-message'));
        await notifySocketUpdate({
            id: 'delayed-new-message',
            seq: 2,
            body: { t: 'new-message', sid: session.id, message: socketMessage },
            createdAt: 2_001,
        });
        await vi.waitFor(() => expect(decryptRaw).toHaveBeenCalledWith('socket-message'));

        await notifySocketUpdate({
            id: 'delete-before-message-decrypt-finishes',
            seq: 3,
            body: { t: 'delete-session', sessionId: session.id },
            createdAt: 3_000,
        });
        expect(useProtocolStore.getState().sessions[session.id]).toBeUndefined();
        expect(useProtocolStore.getState().sessionMessages[session.id]).toBeUndefined();

        delayedHistory.resolve({ role: 'user', content: { type: 'text', text: 'history' } });
        delayedSocketMessage.resolve({ role: 'assistant', content: { type: 'text', text: 'socket' } });
        await historyLoad;

        await vi.waitFor(() => {
            expect(useProtocolStore.getState().sessions[session.id]).toBeUndefined();
            expect(useProtocolStore.getState().sessionMessages[session.id]).toBeUndefined();
        });

        stopProtocolClient();
    });

    it('keeps equal reconnect snapshot state and messages', async () => {
        const session = createTestSession('session-still-current');
        const machine = createTestMachine('machine-still-current');
        const message = createTestMessage('message-still-current');
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([session])
            .mockResolvedValueOnce([session]);
        const fetchMachines = vi.fn()
            .mockResolvedValueOnce([machine])
            .mockResolvedValueOnce([machine]);
        const { notifySocketReconnect } = installReconnectMocks({ fetchMachines, fetchSessions });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        useProtocolStore.getState().applyMessages(session.id, [message], { markLoaded: true });
        await notifySocketReconnect();

        const state = useProtocolStore.getState();
        expect(state.sessions[session.id]).toMatchObject({ id: session.id, seq: session.seq, updatedAt: session.updatedAt });
        expect(state.machines[machine.id]).toMatchObject({ id: machine.id, seq: machine.seq, updatedAt: machine.updatedAt });
        expect(state.sessionMessages[session.id]).toEqual({ messages: [message], isLoaded: true });

        stopProtocolClient();
    });

    it('does not notify ChatPage after it unsubscribes during a pending session refresh', async () => {
        const session = createTestSession('session-visible');
        const refreshedSession = { ...session, seq: 2, updatedAt: 2000 };
        const reconnectSessions = createDeferred<ApiSession[]>();
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([session])
            .mockImplementationOnce(() => reconnectSessions.promise);
        const fetchMessages = vi.fn(async () => ({
            messages: [],
            total: 0,
            hasMore: false,
        }));
        const { notifySocketReconnect } = installReconnectMocks({ fetchMessages, fetchSessions });
        const { loadSessionMessages, onProtocolReconnected, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        const refreshVisibleChat = vi.fn(async () => {
            await loadSessionMessages(session.id);
        });
        const unsubscribe = onProtocolReconnected(() => {
            void refreshVisibleChat().catch(() => undefined);
        });
        fetchSessions.mockClear();
        fetchMessages.mockClear();

        notifySocketReconnect();
        await vi.waitFor(() => {
            expect(fetchSessions).toHaveBeenCalledOnce();
        });

        unsubscribe();
        reconnectSessions.resolve([refreshedSession]);
        await vi.waitFor(() => {
            expect(useProtocolStore.getState().sessions[session.id]?.seq).toBe(refreshedSession.seq);
        });

        expect(refreshVisibleChat).not.toHaveBeenCalled();
        expect(fetchMessages).not.toHaveBeenCalled();

        stopProtocolClient();
    });

    it('does not apply a stale reconnect to a new protocol lifecycle', async () => {
        const staleSession = createTestSession('session-a');
        const currentSession = createTestSession('session-b');
        const staleReconnectSessions = createDeferred<ApiSession[]>();
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([])
            .mockImplementationOnce(() => staleReconnectSessions.promise)
            .mockResolvedValueOnce([currentSession]);
        const fetchMessages = vi.fn(async () => ({
            messages: [],
            total: 0,
            hasMore: false,
        }));
        const { notifySocketReconnect } = installReconnectMocks({ fetchMessages, fetchSessions });
        const { loadSessionMessages, onProtocolReconnected, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key-a', v: 1 });

        const unsubscribeA = onProtocolReconnected(vi.fn());
        fetchSessions.mockClear();
        const staleReconnect = notifySocketReconnect();
        await vi.waitFor(() => {
            expect(fetchSessions).toHaveBeenCalledOnce();
        });

        unsubscribeA();
        stopProtocolClient();
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key-b', v: 1 });

        const refreshVisibleChatB = vi.fn(async () => {
            await loadSessionMessages(currentSession.id);
        });
        const unsubscribeB = onProtocolReconnected(() => {
            void refreshVisibleChatB().catch(() => undefined);
        });
        fetchMessages.mockClear();

        staleReconnectSessions.resolve([staleSession]);
        await staleReconnect;

        expect(useProtocolStore.getState().sessions[staleSession.id]).toBeUndefined();
        expect(useProtocolStore.getState().sessions[currentSession.id]).toMatchObject({ id: currentSession.id });
        expect(refreshVisibleChatB).not.toHaveBeenCalled();
        expect(fetchMessages).not.toHaveBeenCalled();

        unsubscribeB();
        stopProtocolClient();
    });

    it('does not apply stale history to a new protocol lifecycle with the same session id', async () => {
        const sharedSession = createTestSession('shared-session');
        const staleHistory = createDeferred<{ messages: ApiMessage[]; total: number; hasMore: boolean }>();
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([sharedSession])
            .mockResolvedValueOnce([sharedSession])
            .mockResolvedValueOnce([sharedSession]);
        const fetchMessages = vi.fn(() => staleHistory.promise);
        const { notifySocketReconnect } = installReconnectMocks({ fetchMessages, fetchSessions });
        const { loadSessionMessages, onProtocolReconnected, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key-a', v: 1 });

        let pendingHistory: Promise<unknown> | null = null;
        const unsubscribeA = onProtocolReconnected(() => {
            pendingHistory = loadSessionMessages(sharedSession.id);
        });
        const reconnectA = notifySocketReconnect();
        await vi.waitFor(() => {
            expect(fetchMessages).toHaveBeenCalledOnce();
        });
        await reconnectA;

        if (!pendingHistory) {
            throw new Error('Expected reconnect listener A to start history loading');
        }

        unsubscribeA();
        stopProtocolClient();
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key-b', v: 1 });

        const refreshVisibleChatB = vi.fn();
        const unsubscribeB = onProtocolReconnected(refreshVisibleChatB);

        staleHistory.resolve({
            messages: [{
                id: 'stale-message',
                seq: 1,
                content: { t: 'encrypted', c: 'stale-message' },
                createdAt: 2000,
            }],
            total: 1,
            hasMore: false,
        });
        await pendingHistory;

        expect(useProtocolStore.getState().sessionMessages[sharedSession.id]).toBeUndefined();
        expect(refreshVisibleChatB).not.toHaveBeenCalled();
        expect(fetchMessages).toHaveBeenCalledOnce();

        unsubscribeB();
        stopProtocolClient();
    });

    it('does not apply a stale socket update to a new protocol lifecycle', async () => {
        const sharedSession = createTestSession('shared-session');
        const currentSession = { ...sharedSession, seq: 2, updatedAt: 3000 };
        const staleMessageDecryption = createDeferred<unknown | null>();
        const decryptRaw = vi.fn((value: string) => (
            value === 'stale-message' ? staleMessageDecryption.promise : Promise.resolve(null)
        ));
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([sharedSession])
            .mockResolvedValueOnce([currentSession]);
        const { notifySocketUpdate } = installReconnectMocks({ decryptRaw, fetchSessions });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key-a', v: 1 });

        await notifySocketUpdate({
            id: 'update-a',
            seq: 2,
            body: {
                t: 'new-message',
                sid: sharedSession.id,
                message: {
                    id: 'stale-message',
                    seq: 1,
                    content: { t: 'encrypted', c: 'stale-message' },
                    createdAt: 2000,
                }
            },
            createdAt: 2000,
        });
        await vi.waitFor(() => {
            expect(decryptRaw).toHaveBeenCalledWith('stale-message');
        });

        stopProtocolClient();
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key-b', v: 1 });

        staleMessageDecryption.resolve({
            role: 'user',
            content: { type: 'text', text: 'Stale message from A' },
        });
        await vi.waitFor(() => {
            const state = useProtocolStore.getState();
            expect(state.sessionMessages[sharedSession.id]).toBeUndefined();
            expect(state.sessions[sharedSession.id]?.updatedAt).toBe(currentSession.updatedAt);
        });

        stopProtocolClient();
    });

    it('does not apply stale latency to a new protocol lifecycle', async () => {
        const staleLatency = createDeferred<number | null>();
        const measureHealthLatency = vi.fn()
            .mockImplementationOnce(() => staleLatency.promise)
            .mockResolvedValueOnce(42);
        const fetchSessions = vi.fn(async () => []);
        installReconnectMocks({ fetchSessions, measureHealthLatency });
        const { startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');

        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key-a', v: 1 });
        await vi.waitFor(() => {
            expect(measureHealthLatency).toHaveBeenCalledOnce();
        });

        stopProtocolClient();
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key-b', v: 1 });
        await vi.waitFor(() => {
            expect(useProtocolStore.getState().latencyMs).toBe(42);
        });

        staleLatency.resolve(999);
        await vi.waitFor(() => {
            expect(useProtocolStore.getState().latencyMs).toBe(42);
        });

        stopProtocolClient();
    });

    it('notifies ChatPage after a failed session refresh', async () => {
        const fetchMachines = vi.fn()
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('machines unavailable'));
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('sessions unavailable'));
        const { notifySocketReconnect } = installReconnectMocks({ fetchMachines, fetchSessions });
        const { onProtocolReconnected, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        const refreshVisibleChat = vi.fn();
        const unsubscribe = onProtocolReconnected(refreshVisibleChat);
        fetchMachines.mockClear();
        fetchSessions.mockClear();

        notifySocketReconnect();
        await vi.waitFor(() => {
            expect(refreshVisibleChat).toHaveBeenCalledOnce();
        });

        expect(fetchSessions).toHaveBeenCalledOnce();
        expect(fetchMachines).toHaveBeenCalledOnce();

        unsubscribe();
        stopProtocolClient();
    });

    it('lets the ChatPage queue coalesce a reconnect burst into one active history reload', async () => {
        const session = createTestSession('session-visible');
        const firstSessionsRefresh = createDeferred<ApiSession[]>();
        const secondSessionsRefresh = createDeferred<ApiSession[]>();
        const pendingHistoryReload = createDeferred<{ messages: ApiMessage[]; total: number; hasMore: boolean }>();
        const fetchSessions = vi.fn()
            .mockResolvedValueOnce([session])
            .mockImplementationOnce(() => firstSessionsRefresh.promise)
            .mockImplementationOnce(() => secondSessionsRefresh.promise);
        const fetchMessages = vi.fn(() => pendingHistoryReload.promise);
        const { notifySocketReconnect } = installReconnectMocks({ fetchMessages, fetchSessions });
        const { loadSessionMessages, onProtocolReconnected, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { createMessageLoadQueue } = await import('@/pages/ChatPage');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        const queue = createMessageLoadQueue();
        const refreshVisibleChat = vi.fn(async () => {
            await loadSessionMessages(session.id);
        });
        const enqueueVisibleChatRefresh = vi.fn(() => {
            void queue.enqueueReconnect(refreshVisibleChat);
        });
        const unsubscribe = onProtocolReconnected(enqueueVisibleChatRefresh);
        fetchSessions.mockClear();
        fetchMessages.mockClear();

        notifySocketReconnect();
        notifySocketReconnect();
        await vi.waitFor(() => {
            expect(fetchSessions).toHaveBeenCalledTimes(2);
        });

        firstSessionsRefresh.resolve([session]);
        await vi.waitFor(() => {
            expect(fetchMessages).toHaveBeenCalledOnce();
        });

        secondSessionsRefresh.resolve([session]);
        await vi.waitFor(() => {
            expect(enqueueVisibleChatRefresh).toHaveBeenCalledTimes(2);
        });

        expect(refreshVisibleChat).toHaveBeenCalledOnce();
        expect(fetchMessages).toHaveBeenCalledOnce();

        pendingHistoryReload.resolve({ messages: [], total: 0, hasMore: false });
        await vi.waitFor(() => {
            expect(refreshVisibleChat).toHaveBeenCalledOnce();
        });

        unsubscribe();
        stopProtocolClient();
    });

    it('advances the raw message cursor through ignored meta records until history is exhausted', async () => {
        const rawRecords: Record<string, unknown> = {
            'message-visible': {
                role: 'user',
                content: { type: 'text', text: 'Visible terminal prompt' }
            },
            'message-summary-one': {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'summary', summary: 'Hidden summary', isMeta: true }
                }
            },
            'message-summary-two': {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'summary', summary: 'Older hidden summary', isMeta: true }
                }
            }
        };
        const cipher = {
            encryptRaw: vi.fn(async () => ''),
            decryptRaw: vi.fn(async (value: string) => rawRecords[value] ?? null),
        };
        const session: ApiSession = {
            id: 'session-raw-cursor',
            seq: 1,
            metadata: 'session-metadata',
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            active: true,
            activeAt: 1000,
            createdAt: 1000,
            updatedAt: 1000,
        };
        const message = (id: string, seq: number): ApiMessage => ({
            id,
            seq,
            content: { t: 'encrypted', c: id },
            createdAt: seq * 1000,
        });
        const fetchMessages = vi.fn()
            .mockResolvedValueOnce({
                messages: [message('message-visible', 3), message('message-summary-one', 2)],
                total: 3,
                hasMore: true,
            })
            .mockResolvedValueOnce({
                messages: [message('message-summary-two', 1)],
                total: 3,
                hasMore: false,
            });

        vi.stubGlobal('localStorage', {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
            clear: vi.fn(),
        });
        vi.stubGlobal('window', {
            location: { search: '' },
            setInterval: vi.fn(() => 1),
            clearInterval: vi.fn(),
        });
    vi.doMock('@/lib/protocol/connection', () => ({
            connectP2P: vi.fn(() => ({ endpoint: 'http://127.0.0.1:12345', token: 'test-token', authSecret: new Uint8Array(32), contentSecret: new Uint8Array(32) })),
            createP2PCredentials: vi.fn(() => ({ endpoint: 'http://127.0.0.1:12345', token: 'replacement-token', authSecret: new Uint8Array(32), contentSecret: new Uint8Array(32) })),
            disconnectP2P: vi.fn(),
            restoreCredentials: vi.fn(() => null),
            storeConnection: vi.fn(),
        }));
        vi.doMock('@/lib/protocol/encryption', () => ({
            createEncryption: vi.fn(() => ({
                decryptEncryptionKey: vi.fn(() => null),
                openCipher: vi.fn(() => cipher),
            })),
        }));
        vi.doMock('@/lib/protocol/rest', () => ({
            deleteMachine: vi.fn(),
            fetchMachines: vi.fn(async () => []),
            fetchMessages,
            fetchSessions: vi.fn(async () => [session]),
            measureHealthLatency: vi.fn(async () => null),
        }));
        vi.doMock('@/lib/protocol/socket', () => ({
            machineListAgentSessions: vi.fn(),
            machineListDirectory: vi.fn(),
            machineSpawnNewSession: vi.fn(),
            machineStopSession: vi.fn(),
            onSocketMessage: vi.fn(() => vi.fn()),
            onSocketReconnected: vi.fn(() => vi.fn()),
            onSocketStatusChange: vi.fn(() => vi.fn()),
            sendEncryptedMessage: vi.fn(),
            sessionAllow: vi.fn(),
            sessionDeny: vi.fn(),
            socketConnect: vi.fn(),
            socketDisconnect: vi.fn(),
            socketEmitWithAck: vi.fn(),
            waitForSocketConnection: vi.fn().mockResolvedValue(undefined),
        }));

        const { loadSessionMessages, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        const newestPage = await loadSessionMessages('session-raw-cursor');
        const olderPage = await loadSessionMessages('session-raw-cursor', { offset: newestPage.nextOffset });

        expect(newestPage).toMatchObject({ consumed: 2, nextOffset: 2, hasMore: true });
        expect(olderPage).toMatchObject({ consumed: 1, nextOffset: 3, hasMore: false });
        expect(fetchMessages).toHaveBeenLastCalledWith(
            expect.anything(),
            'session-raw-cursor',
            { offset: 2 }
        );
        expect(useProtocolStore.getState().sessionMessages['session-raw-cursor']?.messages)
            .toHaveLength(1);

        stopProtocolClient();
    });
});
