import { describe, expect, it, vi } from 'vitest';

import type { MachineSocketHandle } from '@/daemon/machineSocket';
import type { PersistedPairing } from './p2pPairing';
import {
    commitPairingRekeyAfterMachineReadiness,
    type PairingRekeyTransactionServer,
} from './pairingRekeyTransaction';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
}

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

const CURRENT_PAIRING: PersistedPairing = {
    authSecret: new Uint8Array(32).fill(1),
    contentSecret: new Uint8Array(32).fill(2),
    port: 43123,
    createdAt: '2026-08-12T00:00:00.000Z',
};

function createMachineSocketHandle(ready: Promise<void>): MachineSocketHandle {
    return {
        socket: {} as MachineSocketHandle['socket'],
        ready,
        close: vi.fn(),
    };
}

function createServer(): PairingRekeyTransactionServer {
    return {
        prepareAuthSecret: vi.fn(),
        commitPreparedAuthSecret: vi.fn(),
        rollbackPreparedAuthSecret: vi.fn(),
        disconnectDaemonMachineSockets: vi.fn(),
    };
}

describe('pairing rekey machine readiness transaction', () => {
    it('keeps the existing pairing active and restores its machine socket when candidate readiness fails', async () => {
        const server = createServer();
        const currentMachineSocketHandle = createMachineSocketHandle(Promise.resolve());
        const failedCandidateMachineSocketHandle = createMachineSocketHandle(
            Promise.reject(new Error('candidate registration rejected')),
        );
        const restoredMachineSocketHandle = createMachineSocketHandle(Promise.resolve());
        const createMachineSocket = vi.fn()
            .mockReturnValueOnce(failedCandidateMachineSocketHandle)
            .mockReturnValueOnce(restoredMachineSocketHandle);
        const persistPairing = vi.fn((pairing: PersistedPairing) => pairing);
        const onRollbackMachineSocketReady = vi.fn();
        const nextAuthSecret = new Uint8Array(32).fill(3);

        await expect(commitPairingRekeyAfterMachineReadiness({
            currentPairing: CURRENT_PAIRING,
            nextAuthSecret,
            p2pServer: server,
            machineSocketHandle: currentMachineSocketHandle,
            createMachineSocket,
            persistPairing,
            onRollbackMachineSocketReady,
            canCommit: () => true,
        })).rejects.toThrow('Pairing rekey failed before commit; the previous pairing remains active.');

        expect(server.prepareAuthSecret).toHaveBeenCalledWith(nextAuthSecret);
        expect(server.commitPreparedAuthSecret).not.toHaveBeenCalled();
        expect(server.rollbackPreparedAuthSecret).toHaveBeenCalledOnce();
        expect(currentMachineSocketHandle.close).toHaveBeenCalledOnce();
        expect(failedCandidateMachineSocketHandle.close).toHaveBeenCalledOnce();
        expect(persistPairing).not.toHaveBeenCalled();
        expect(createMachineSocket).toHaveBeenNthCalledWith(1, expect.objectContaining({ authSecret: nextAuthSecret }));
        expect(createMachineSocket).toHaveBeenNthCalledWith(2, CURRENT_PAIRING);
        expect(onRollbackMachineSocketReady).toHaveBeenCalledWith(restoredMachineSocketHandle);
    });

    it('rolls back the prepared bearer and restores the previous socket when persisting a ready candidate fails', async () => {
        const server = createServer();
        const currentMachineSocketHandle = createMachineSocketHandle(Promise.resolve());
        const candidateMachineSocketHandle = createMachineSocketHandle(Promise.resolve());
        const restoredMachineSocketHandle = createMachineSocketHandle(Promise.resolve());
        const createMachineSocket = vi.fn()
            .mockReturnValueOnce(candidateMachineSocketHandle)
            .mockReturnValueOnce(restoredMachineSocketHandle);
        const persistPairing = vi.fn((): PersistedPairing => {
            throw new Error('pairing storage is unavailable');
        });
        const onRollbackMachineSocketReady = vi.fn();
        const nextAuthSecret = new Uint8Array(32).fill(3);

        await expect(commitPairingRekeyAfterMachineReadiness({
            currentPairing: CURRENT_PAIRING,
            nextAuthSecret,
            p2pServer: server,
            machineSocketHandle: currentMachineSocketHandle,
            createMachineSocket,
            persistPairing,
            onRollbackMachineSocketReady,
            canCommit: () => true,
        })).rejects.toThrow('Pairing rekey failed before commit; the previous pairing remains active.');

        expect(server.prepareAuthSecret).toHaveBeenCalledWith(nextAuthSecret);
        expect(server.commitPreparedAuthSecret).not.toHaveBeenCalled();
        expect(server.rollbackPreparedAuthSecret).toHaveBeenCalledOnce();
        expect(server.disconnectDaemonMachineSockets).toHaveBeenCalledTimes(2);
        expect(currentMachineSocketHandle.close).toHaveBeenCalledOnce();
        expect(candidateMachineSocketHandle.close).toHaveBeenCalledOnce();
        expect(persistPairing).toHaveBeenCalledOnce();
        expect(persistPairing).toHaveBeenCalledWith(expect.objectContaining({ authSecret: nextAuthSecret }));
        expect(createMachineSocket).toHaveBeenNthCalledWith(1, expect.objectContaining({ authSecret: nextAuthSecret }));
        expect(createMachineSocket).toHaveBeenNthCalledWith(2, CURRENT_PAIRING);
        expect(onRollbackMachineSocketReady).toHaveBeenCalledWith(restoredMachineSocketHandle);
    });

    it('persists and commits the replacement only after candidate machine readiness succeeds', async () => {
        const server = createServer();
        const currentMachineSocketHandle = createMachineSocketHandle(Promise.resolve());
        const candidateMachineSocketHandle = createMachineSocketHandle(Promise.resolve());
        const nextAuthSecret = new Uint8Array(32).fill(3);
        const persistedPairing: PersistedPairing = {
            ...CURRENT_PAIRING,
            authSecret: nextAuthSecret,
            createdAt: '2026-08-12T00:01:00.000Z',
        };
        const persistPairing = vi.fn(() => persistedPairing);

        await expect(commitPairingRekeyAfterMachineReadiness({
            currentPairing: CURRENT_PAIRING,
            nextAuthSecret,
            p2pServer: server,
            machineSocketHandle: currentMachineSocketHandle,
            createMachineSocket: () => candidateMachineSocketHandle,
            persistPairing,
            onRollbackMachineSocketReady: vi.fn(),
            canCommit: () => true,
        })).resolves.toEqual({
            type: 'committed',
            pairing: persistedPairing,
            machineSocketHandle: candidateMachineSocketHandle,
        });

        expect(server.prepareAuthSecret).toHaveBeenCalledWith(nextAuthSecret);
        expect(persistPairing).toHaveBeenCalledWith(expect.objectContaining({ authSecret: nextAuthSecret }));
        expect(server.commitPreparedAuthSecret).toHaveBeenCalledOnce();
        expect(server.rollbackPreparedAuthSecret).not.toHaveBeenCalled();
    });

    it('rolls back without persistence when approval expires while candidate readiness is pending', async () => {
        let nowMs = 10_000;
        const approvalExpiresAt = 20_000;
        const candidateReadiness = createDeferred<void>();
        const server = createServer();
        const currentMachineSocketHandle = createMachineSocketHandle(Promise.resolve());
        const candidateMachineSocketHandle = createMachineSocketHandle(candidateReadiness.promise);
        const restoredMachineSocketHandle = createMachineSocketHandle(Promise.resolve());
        const createMachineSocket = vi.fn()
            .mockReturnValueOnce(candidateMachineSocketHandle)
            .mockReturnValueOnce(restoredMachineSocketHandle);
        const persistPairing = vi.fn((pairing: PersistedPairing) => pairing);
        const canCommit = vi.fn(() => nowMs < approvalExpiresAt);
        const onRollbackMachineSocketReady = vi.fn();

        const transaction = commitPairingRekeyAfterMachineReadiness({
            currentPairing: CURRENT_PAIRING,
            nextAuthSecret: new Uint8Array(32).fill(3),
            p2pServer: server,
            machineSocketHandle: currentMachineSocketHandle,
            createMachineSocket,
            persistPairing,
            onRollbackMachineSocketReady,
            canCommit,
        });

        nowMs = approvalExpiresAt;
        candidateReadiness.resolve();

        await expect(transaction).resolves.toEqual({ type: 'expired' });
        expect(canCommit).toHaveBeenCalledOnce();
        expect(server.prepareAuthSecret).toHaveBeenCalledOnce();
        expect(server.commitPreparedAuthSecret).not.toHaveBeenCalled();
        expect(server.rollbackPreparedAuthSecret).toHaveBeenCalledOnce();
        expect(persistPairing).not.toHaveBeenCalled();
        expect(currentMachineSocketHandle.close).toHaveBeenCalledOnce();
        expect(candidateMachineSocketHandle.close).toHaveBeenCalledOnce();
        expect(createMachineSocket).toHaveBeenNthCalledWith(2, CURRENT_PAIRING);
        expect(onRollbackMachineSocketReady).toHaveBeenCalledWith(restoredMachineSocketHandle);
    });

    it('restores the current pairing and machine RPC when approval expires after persistence before bearer commit', async () => {
        let canCommit = true;
        const server = createServer();
        const currentMachineSocketHandle = createMachineSocketHandle(Promise.resolve());
        const candidateMachineSocketHandle = createMachineSocketHandle(Promise.resolve());
        const restoredMachineSocketHandle = createMachineSocketHandle(Promise.resolve());
        const createMachineSocket = vi.fn()
            .mockReturnValueOnce(candidateMachineSocketHandle)
            .mockReturnValueOnce(restoredMachineSocketHandle);
        const nextAuthSecret = new Uint8Array(32).fill(3);
        const canCommitGuard = vi.fn(() => canCommit);
        const persistPairing = vi.fn((pairing: PersistedPairing) => {
            if (pairing.authSecret === nextAuthSecret) {
                expect(canCommitGuard).toHaveBeenCalledOnce();
                canCommit = false;
            }
            return pairing;
        });
        const onRollbackMachineSocketReady = vi.fn();

        await expect(commitPairingRekeyAfterMachineReadiness({
            currentPairing: CURRENT_PAIRING,
            nextAuthSecret,
            p2pServer: server,
            machineSocketHandle: currentMachineSocketHandle,
            createMachineSocket,
            persistPairing,
            onRollbackMachineSocketReady,
            canCommit: canCommitGuard,
        })).resolves.toEqual({ type: 'expired' });

        expect(canCommitGuard).toHaveBeenCalledTimes(2);
        expect(persistPairing).toHaveBeenNthCalledWith(1, expect.objectContaining({ authSecret: nextAuthSecret }));
        expect(persistPairing).toHaveBeenNthCalledWith(2, CURRENT_PAIRING);
        expect(server.commitPreparedAuthSecret).not.toHaveBeenCalled();
        expect(server.rollbackPreparedAuthSecret).toHaveBeenCalledOnce();
        expect(currentMachineSocketHandle.close).toHaveBeenCalledOnce();
        expect(candidateMachineSocketHandle.close).toHaveBeenCalledOnce();
        expect(createMachineSocket).toHaveBeenNthCalledWith(2, CURRENT_PAIRING);
        expect(onRollbackMachineSocketReady).toHaveBeenCalledWith(restoredMachineSocketHandle);
    });
});
