import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { Cipher } from '@/lib/protocol/encryption';
import { createRequestProof } from '@/lib/protocol/requestProof';

interface FakeSocket {
    socket: Socket;
    trigger(event: string): void;
    triggerMessage(event: string, data: unknown): void;
}

interface IDeferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

function createDeferred<T>(): IDeferred<T> {
    let resolvePromise!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function createFakeSocket(): FakeSocket {
    const listeners = new Map<string, () => void>();
    let anyListener: ((event: string, data: unknown) => void) | undefined;
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
        onAny: vi.fn((listener: (event: string, data: unknown) => void) => {
            anyListener = listener;
            return socket;
        }),
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
        triggerMessage(event, data) {
            anyListener?.(event, data);
        }
    };
}

describe('socket reconnect lifecycle', () => {
    afterEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('attaches a proof to a user-scoped mutation event', async () => {
        const fakeSocket = createFakeSocket();
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const authSecret = new Uint8Array(32).fill(3);

        const { sendEncryptedMessage, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token', authSecret },
            { getSessionCipher: () => null, getMachineCipher: () => null }
        );
        fakeSocket.trigger('connect');

        sendEncryptedMessage({
            sessionId: 'session-1',
            encryptedRecord: 'encrypted-message',
            localId: 'local-1',
        });

        expect(fakeSocket.socket.emit).toHaveBeenCalledWith('message', expect.objectContaining({
            sid: 'session-1',
            message: 'encrypted-message',
            localId: 'local-1',
            sentFrom: 'web',
            proof: expect.objectContaining({
                v: 2,
                id: expect.any(String),
                expiresAt: expect.any(Number),
                mac: expect.any(String),
            }),
        }));
        const emitted = (fakeSocket.socket.emit as unknown as {
            mock: { calls: Array<[string, Record<string, unknown>]> };
        }).mock.calls[0][1];
        const proof = emitted.proof as { v: 2; id: string; expiresAt: number; mac: string };
        expect(proof).toEqual(createRequestProof(authSecret, {
            transport: 'socket',
            operation: 'message',
            requestId: proof.id,
            expiresAt: proof.expiresAt,
            payload: emitted,
        }));

        socketDisconnect();
    });

    it('attaches a proof to encrypted user RPC calls after params are encrypted', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, result: 'encrypted-list' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const authSecret = new Uint8Array(32).fill(4);
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn().mockResolvedValue({ sessions: [] }),
        } as unknown as Cipher;

        const { machineListAgentSessions, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token', authSecret },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );
        fakeSocket.trigger('connect');

        await expect(machineListAgentSessions('machine-1', 'codex')).resolves.toEqual([]);

        const emitted = emitWithAck.mock.calls[0][1] as Record<string, unknown>;
        const proof = emitted.proof as { v: 2; id: string; expiresAt: number; mac: string };
        expect(proof).toEqual(createRequestProof(authSecret, {
            transport: 'socket',
            operation: 'rpc-call',
            requestId: proof.id,
            expiresAt: proof.expiresAt,
            payload: emitted,
        }));
        expect(emitted).toEqual(expect.objectContaining({
            method: 'machine-1:list-agent-sessions',
            params: 'encrypted-params',
        }));

        socketDisconnect();
    });

    it('attaches a proof to an acknowledged user-scoped mutation', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ result: 'success' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const authSecret = new Uint8Array(32).fill(5);

        const { socketConnect, socketDisconnect, socketEmitWithAck } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token', authSecret },
            { getSessionCipher: () => null, getMachineCipher: () => null },
        );
        fakeSocket.trigger('connect');

        const payload = { machineId: 'machine-1', metadata: 'encrypted', expectedVersion: 2 };
        await expect(socketEmitWithAck('machine-update-metadata', payload)).resolves.toEqual({ result: 'success' });

        const emitted = emitWithAck.mock.calls[0][1] as Record<string, unknown>;
        const proof = emitted.proof as { v: 2; id: string; expiresAt: number; mac: string };
        expect(proof).toEqual(createRequestProof(authSecret, {
            transport: 'socket',
            operation: 'machine-update-metadata',
            requestId: proof.id,
            expiresAt: proof.expiresAt,
            payload: emitted,
        }));

        socketDisconnect();
    });

    it('rejects unauthenticated RPC and acknowledged mutations before encrypting or proving them', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, result: 'encrypted-list' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn().mockResolvedValue({ sessions: [] }),
        } as unknown as Cipher;

        const { machineListAgentSessions, socketConnect, socketDisconnect, socketEmitWithAck } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token', authSecret: new Uint8Array(32).fill(6) },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );

        await expect(machineListAgentSessions('machine-1', 'codex')).rejects.toThrow('Socket is not authenticated');
        await expect(socketEmitWithAck('machine-update-metadata', {
            machineId: 'machine-1',
            metadata: 'encrypted',
            expectedVersion: 2,
        })).rejects.toThrow('Socket is not authenticated');

        expect((cipher.encryptRaw as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        expect(emitWithAck).not.toHaveBeenCalled();

        fakeSocket.trigger('connect');

        await expect(machineListAgentSessions('machine-1', 'codex')).resolves.toEqual([]);
        await expect(socketEmitWithAck('machine-update-metadata', {
            machineId: 'machine-1',
            metadata: 'encrypted',
            expectedVersion: 2,
        })).resolves.toEqual({ ok: true, result: 'encrypted-list' });
        expect(cipher.encryptRaw).toHaveBeenCalledOnce();
        expect(emitWithAck).toHaveBeenCalledTimes(2);
        expect(emitWithAck.mock.calls.every(([, payload]) => (
            typeof payload === 'object' && payload !== null && 'proof' in payload
        ))).toBe(true);

        socketDisconnect();
    });

    it('notifies once per reconnect, including recovered connections, but not on the initial connect', async () => {
        const fakeSocket = createFakeSocket();
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));

        const { onSocketReconnected, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        const onReconnect = vi.fn();
        const unsubscribe = onSocketReconnected(onReconnect);

        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => null }
        );

        fakeSocket.trigger('connect');
        expect(onReconnect).not.toHaveBeenCalled();

        fakeSocket.trigger('disconnect');
        fakeSocket.trigger('connect');
        (fakeSocket.socket as unknown as { recovered: boolean }).recovered = true;
        fakeSocket.trigger('disconnect');
        fakeSocket.trigger('connect');

        expect(onReconnect).toHaveBeenCalledTimes(2);

        unsubscribe();
        fakeSocket.trigger('disconnect');
        fakeSocket.trigger('connect');
        expect(onReconnect).toHaveBeenCalledTimes(2);

        socketDisconnect();
    });

    it('binds waits and events to the current socket generation', async () => {
        const firstSocket = createFakeSocket();
        const secondSocket = createFakeSocket();
        const io = vi.fn()
            .mockReturnValueOnce(firstSocket.socket)
            .mockReturnValueOnce(secondSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));

        const { getSocketStatus, onSocketMessage, socketConnect, socketDisconnect, waitForSocketConnection } = await import('@/lib/protocol/socket');
        const onUpdate = vi.fn();
        onSocketMessage('update', onUpdate);

        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'first-token' },
            { getSessionCipher: () => null, getMachineCipher: () => null },
        );
        const firstWait = waitForSocketConnection();

        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'second-token' },
            { getSessionCipher: () => null, getMachineCipher: () => null },
        );
        const secondWait = waitForSocketConnection();

        await expect(firstWait).rejects.toThrow('Socket connection changed during wait');
        firstSocket.trigger('connect');
        firstSocket.triggerMessage('update', { source: 'stale' });
        expect(getSocketStatus()).toBe('connecting');
        expect(onUpdate).not.toHaveBeenCalled();

        secondSocket.trigger('connect');
        secondSocket.triggerMessage('update', { source: 'current' });
        await expect(secondWait).resolves.toBeUndefined();
        expect(getSocketStatus()).toBe('connected');
        expect(onUpdate).toHaveBeenCalledWith({ source: 'current' });

        socketDisconnect();
    });

    it('keeps the initial handshake pending across transient connection errors', async () => {
        const fakeSocket = createFakeSocket();
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));

        const { getSocketStatus, socketConnect, socketDisconnect, waitForSocketConnection } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => null }
        );

        const handshake = waitForSocketConnection(100);
        let didSettle = false;
        void handshake.then(
            () => { didSettle = true; },
            () => { didSettle = true; },
        );

        fakeSocket.trigger('connect_error');
        fakeSocket.trigger('error');
        await Promise.resolve();

        expect(didSettle).toBe(false);
        expect(getSocketStatus()).toBe('connecting');

        fakeSocket.trigger('connect');

        await expect(handshake).resolves.toBeUndefined();
        expect(getSocketStatus()).toBe('connected');

        socketDisconnect();
    });

    it('rejects the initial handshake only when its timeout expires', async () => {
        vi.useFakeTimers();
        try {
            const fakeSocket = createFakeSocket();
            const io = vi.fn(() => fakeSocket.socket);
            vi.doMock('socket.io-client', () => ({ io }));

            const { getSocketStatus, socketConnect, socketDisconnect, waitForSocketConnection } = await import('@/lib/protocol/socket');
            socketConnect(
                { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
                { getSessionCipher: () => null, getMachineCipher: () => null }
            );

            const handshake = waitForSocketConnection(1_000);
            fakeSocket.trigger('connect_error');
            fakeSocket.trigger('error');
            await Promise.resolve();

            const rejection = expect(handshake).rejects.toThrow('Timed out waiting for Socket.IO authentication');
            await vi.advanceTimersByTimeAsync(1_000);
            await rejection;
            expect(getSocketStatus()).toBe('connecting');

            socketDisconnect();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps terminal error and lost statuses after the first authenticated connection', async () => {
        const fakeSocket = createFakeSocket();
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));

        const { getSocketStatus, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => null },
        );
        fakeSocket.trigger('connect');

        fakeSocket.trigger('connect_error');
        expect(getSocketStatus()).toBe('error');

        fakeSocket.trigger('disconnect');
        expect(getSocketStatus()).toBe('disconnected');

        socketDisconnect();
    });

    it('rejects an encrypted RPC without emitting when the authenticated socket disconnects during encryption', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn();
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const encryption = createDeferred<string>();
        const cipher = {
            encryptRaw: vi.fn(() => encryption.promise),
            decryptRaw: vi.fn(),
        } as unknown as Cipher;

        const { machineListAgentSessions, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );
        fakeSocket.trigger('connect');

        const request = machineListAgentSessions('machine-1', 'codex');
        expect(cipher.encryptRaw).toHaveBeenCalledOnce();

        fakeSocket.trigger('disconnect');
        fakeSocket.trigger('connect');
        encryption.resolve('encrypted-params');

        await expect(request).rejects.toThrow('Socket connection changed during request');
        expect(emitWithAck).not.toHaveBeenCalled();

        socketDisconnect();
    });

    it('does not buffer an encrypted RPC when the socket disconnects before emission', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn();
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const encryption = createDeferred<string>();
        const cipher = {
            encryptRaw: vi.fn(() => encryption.promise),
            decryptRaw: vi.fn(),
        } as unknown as Cipher;

        const { machineListAgentSessions, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );
        fakeSocket.trigger('connect');

        const request = machineListAgentSessions('machine-1', 'codex');
        (fakeSocket.socket as unknown as { connected: boolean }).connected = false;
        encryption.resolve('encrypted-params');

        await expect(request).rejects.toThrow('Socket is not authenticated');
        expect(emitWithAck).not.toHaveBeenCalled();

        socketDisconnect();
    });

    it('does not emit a fire-and-forget mutation after a synchronous connection change', async () => {
        const fakeSocket = createFakeSocket();
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const authSecret = new Uint8Array(32).fill(7);

        const { socketConnect, socketDisconnect, socketSend } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token', authSecret },
            { getSessionCipher: () => null, getMachineCipher: () => null },
        );
        fakeSocket.trigger('connect');

        const payload = {
            toJSON: () => {
                fakeSocket.trigger('disconnect');
                return { value: 'mutation' };
            },
        };

        expect(() => socketSend('message', payload)).toThrow('Socket is not authenticated');
        expect(fakeSocket.socket.emit).not.toHaveBeenCalled();

        socketDisconnect();
    });

    it('returns an empty resume list only from a validated successful RPC response', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, result: 'encrypted-list' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn().mockResolvedValue({ sessions: [] }),
        } as unknown as Cipher;

        const { machineListAgentSessions, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );
        fakeSocket.trigger('connect');

        await expect(machineListAgentSessions('machine-1', 'codex')).resolves.toEqual([]);

        socketDisconnect();
    });

    it('propagates a rejected resume RPC instead of converting it to an empty list', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: false, error: 'history unavailable' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn(),
        } as unknown as Cipher;

        const { machineListAgentSessions, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );
        fakeSocket.trigger('connect');

        await expect(machineListAgentSessions('machine-1', 'codex')).rejects.toThrow('history unavailable');

        socketDisconnect();
    });

    it('accepts only a normalized Cursor capability snapshot from encrypted machine RPC', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, result: 'encrypted-cursor-capabilities' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn().mockResolvedValue({
                agent: 'cursor',
                status: 'ready',
                fetchedAt: 1,
                expiresAt: 2,
                catalogVersion: 'cursor-catalog-1',
                models: [{ id: 'auto', displayName: 'Auto', isDefault: true }],
            }),
        } as unknown as Cipher;

        const { machineGetCursorCapabilities, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );
        fakeSocket.trigger('connect');

        await expect(machineGetCursorCapabilities('machine-1')).resolves.toEqual({
            agent: 'cursor',
            status: 'ready',
            fetchedAt: 1,
            expiresAt: 2,
            catalogVersion: 'cursor-catalog-1',
            models: [{ id: 'auto', displayName: 'Auto', isDefault: true }],
        });

        socketDisconnect();
    });

    it('rejects malformed Cursor capability RPC output before it reaches the UI', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, result: 'malformed-cursor-capabilities' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn().mockResolvedValue({
                agent: 'cursor',
                status: 'ready',
                fetchedAt: 1,
                expiresAt: 2,
                catalogVersion: 'cursor-catalog-1',
                models: [{ id: 'auto', displayName: 'Auto', isDefault: false }],
            }),
        } as unknown as Cipher;

        const { machineGetCursorCapabilities, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );
        fakeSocket.trigger('connect');

        await expect(machineGetCursorCapabilities('machine-1')).rejects.toThrow('Cursor capability RPC returned invalid response');

        socketDisconnect();
    });

    it('returns validated machine-scoped directory projects', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, result: 'encrypted-directory-projects' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn().mockResolvedValue({
                projects: [{
                    canonicalPath: '/Users/dev/projects/remcli',
                    displayPath: '~/projects/remcli',
                    lastUsedAt: 1_700_000_000_000,
                    isPinned: true,
                    lastAgent: 'codex',
                    branchAtLastLaunch: 'main',
                }],
            }),
        } as unknown as Cipher;

        const { machineListDirectoryProjects, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );
        fakeSocket.trigger('connect');

        await expect(machineListDirectoryProjects('machine-1')).resolves.toEqual([{
            canonicalPath: '/Users/dev/projects/remcli',
            displayPath: '~/projects/remcli',
            lastUsedAt: 1_700_000_000_000,
            isPinned: true,
            lastAgent: 'codex',
            branchAtLastLaunch: 'main',
        }]);
        expect(emitWithAck).toHaveBeenCalledWith('rpc-call', expect.objectContaining({
            method: 'machine-1:list-directory-projects',
        }));

        socketDisconnect();
    });

    it('sends only the selected path and pin state for a project pin mutation', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, result: 'encrypted-directory-project-pin' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn().mockResolvedValue({
                projects: [{
                    canonicalPath: '/Users/dev/projects/remcli',
                    displayPath: '~/projects/remcli',
                    lastUsedAt: 1_700_000_000_000,
                    isPinned: true,
                    lastAgent: 'codex',
                    branchAtLastLaunch: 'main',
                }],
            }),
        } as unknown as Cipher;

        const { machineSetDirectoryProjectPin, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );
        fakeSocket.trigger('connect');

        await expect(machineSetDirectoryProjectPin('machine-1', '/Users/dev/projects/remcli', true))
            .resolves.toEqual([expect.objectContaining({ isPinned: true })]);
        expect(emitWithAck).toHaveBeenCalledWith('rpc-call', expect.objectContaining({
            method: 'machine-1:set-directory-project-pin',
        }));

        socketDisconnect();
    });

    it('surfaces the typed directory-project daemon error', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, result: 'encrypted-directory-project-error' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn().mockResolvedValue({
                error: { code: 'unavailable', message: 'Directory projects are unavailable.' },
            }),
        } as unknown as Cipher;

        const { machineListDirectoryProjects, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );
        fakeSocket.trigger('connect');

        await expect(machineListDirectoryProjects('machine-1')).rejects.toMatchObject({
            name: 'DirectoryProjectsRpcError',
            code: 'unavailable',
            message: 'Directory projects are unavailable.',
        });

        socketDisconnect();
    });

    it('preserves an unavailable terminal outcome from a successful encrypted spawn RPC', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, result: 'encrypted-spawn-result' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn().mockResolvedValue({
                type: 'success',
                sessionId: 'session-1',
                terminal: { type: 'unavailable', error: 'terminal-unavailable' },
            }),
        } as unknown as Cipher;

        const { machineSpawnNewSession, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );
        fakeSocket.trigger('connect');

        await expect(machineSpawnNewSession({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'codex',
        })).resolves.toEqual({
            type: 'success',
            sessionId: 'session-1',
            terminal: { type: 'unavailable', error: 'terminal-unavailable' },
        });
        expect(emitWithAck).toHaveBeenCalledWith('rpc-call', expect.objectContaining({
            method: 'machine-1:spawn-remcli-session',
        }));

        socketDisconnect();
    });

    it('rejects a successful spawn RPC with an unknown terminal outcome', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, result: 'encrypted-invalid-spawn-result' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn().mockResolvedValue({
                type: 'success',
                sessionId: 'session-1',
                terminal: { type: 'unknown', error: 'terminal-unavailable' },
            }),
        } as unknown as Cipher;

        const { machineSpawnNewSession, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );
        fakeSocket.trigger('connect');

        await expect(machineSpawnNewSession({
            machineId: 'machine-1',
            directory: '/workspace/remcli',
            agent: 'codex',
        })).resolves.toEqual({
            type: 'error',
            errorMessage: 'Spawn session RPC returned an invalid response',
        });

        socketDisconnect();
    });
});
