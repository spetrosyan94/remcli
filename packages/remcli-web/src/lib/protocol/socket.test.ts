import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { Cipher } from '@/lib/protocol/encryption';

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
});
