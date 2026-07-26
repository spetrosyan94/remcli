import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { Cipher } from '@/lib/protocol/encryption';
import { createRequestProof } from '@/lib/protocol/requestProof';

interface FakeSocket {
    socket: Socket;
    trigger(event: string): void;
}

function createFakeSocket(): FakeSocket {
    const listeners = new Map<string, () => void>();
    const socket = {
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
            listeners.get(event)?.();
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
            proof: expect.objectContaining({ v: 1, id: expect.any(String), mac: expect.any(String) }),
        }));
        const emitted = (fakeSocket.socket.emit as unknown as {
            mock: { calls: Array<[string, Record<string, unknown>]> };
        }).mock.calls[0][1];
        const proof = emitted.proof as { v: 1; id: string; mac: string };
        expect(proof).toEqual(createRequestProof(authSecret, {
            transport: 'socket',
            operation: 'message',
            requestId: proof.id,
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

        await expect(machineListAgentSessions('machine-1', 'codex')).resolves.toEqual([]);

        const emitted = emitWithAck.mock.calls[0][1] as Record<string, unknown>;
        const proof = emitted.proof as { v: 1; id: string; mac: string };
        expect(proof).toEqual(createRequestProof(authSecret, {
            transport: 'socket',
            operation: 'rpc-call',
            requestId: proof.id,
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

        const payload = { machineId: 'machine-1', metadata: 'encrypted', expectedVersion: 2 };
        await expect(socketEmitWithAck('machine-update-metadata', payload)).resolves.toEqual({ result: 'success' });

        const emitted = emitWithAck.mock.calls[0][1] as Record<string, unknown>;
        const proof = emitted.proof as { v: 1; id: string; mac: string };
        expect(proof).toEqual(createRequestProof(authSecret, {
            transport: 'socket',
            operation: 'machine-update-metadata',
            requestId: proof.id,
            payload: emitted,
        }));

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

        await expect(machineGetCursorCapabilities('machine-1')).rejects.toThrow('Cursor capability RPC returned invalid response');

        socketDisconnect();
    });

    it('returns validated machine-scoped recent directories', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, result: 'encrypted-recent-directories' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn().mockResolvedValue({
                directories: [{
                    canonicalPath: '/Users/dev/projects/remcli',
                    displayPath: '~/projects/remcli',
                    lastUsedAt: 1_700_000_000_000,
                }],
            }),
        } as unknown as Cipher;

        const { machineListRecentDirectories, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );

        await expect(machineListRecentDirectories('machine-1')).resolves.toEqual([{
            canonicalPath: '/Users/dev/projects/remcli',
            displayPath: '~/projects/remcli',
            lastUsedAt: 1_700_000_000_000,
        }]);
        expect(emitWithAck).toHaveBeenCalledWith('rpc-call', expect.objectContaining({
            method: 'machine-1:list-recent-directories',
        }));

        socketDisconnect();
    });

    it('surfaces the typed recent-directory daemon error', async () => {
        const fakeSocket = createFakeSocket();
        const emitWithAck = vi.fn().mockResolvedValue({ ok: true, result: 'encrypted-recent-directory-error' });
        (fakeSocket.socket as unknown as { emitWithAck: typeof emitWithAck }).emitWithAck = emitWithAck;
        const io = vi.fn(() => fakeSocket.socket);
        vi.doMock('socket.io-client', () => ({ io }));
        const cipher = {
            encryptRaw: vi.fn().mockResolvedValue('encrypted-params'),
            decryptRaw: vi.fn().mockResolvedValue({
                error: { code: 'unavailable', message: 'Recent directories are unavailable.' },
            }),
        } as unknown as Cipher;

        const { machineListRecentDirectories, socketConnect, socketDisconnect } = await import('@/lib/protocol/socket');
        socketConnect(
            { endpoint: 'http://127.0.0.1:12345', token: 'test-token' },
            { getSessionCipher: () => null, getMachineCipher: () => cipher },
        );

        await expect(machineListRecentDirectories('machine-1')).rejects.toMatchObject({
            name: 'RecentDirectoriesRpcError',
            code: 'unavailable',
            message: 'Recent directories are unavailable.',
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
