/**
 * Commits a pairing rekey only after the daemon self-machine is ready to use
 * the replacement bearer. A failed candidate leaves the existing pairing
 * active and restores its machine RPC socket before surfacing the failure.
 */

import type { MachineSocketHandle } from '@/daemon/machineSocket';
import type { PersistedPairing } from './p2pPairing';
import type { PairingRekeyCommitGuard } from './pairingRekey';

export interface PairingRekeyTransactionServer {
    prepareAuthSecret: (authSecret: Uint8Array) => void;
    commitPreparedAuthSecret: () => void;
    rollbackPreparedAuthSecret: () => void;
    disconnectDaemonMachineSockets: () => void;
}

export interface PairingRekeyTransactionDependencies {
    currentPairing: PersistedPairing;
    nextAuthSecret: Uint8Array;
    p2pServer: PairingRekeyTransactionServer;
    machineSocketHandle: MachineSocketHandle | null;
    createMachineSocket: (pairing: PersistedPairing) => MachineSocketHandle;
    persistPairing: (pairing: PersistedPairing) => PersistedPairing;
    onRollbackMachineSocketReady: (machineSocketHandle: MachineSocketHandle) => void;
    canCommit: PairingRekeyCommitGuard;
}

interface PairingRekeyTransactionCommittedResult {
    type: 'committed';
    pairing: PersistedPairing;
    machineSocketHandle: MachineSocketHandle;
}

export type PairingRekeyTransactionResult =
    | PairingRekeyTransactionCommittedResult
    | { type: 'expired' };

class PairingRekeyCommitExpiredError extends Error {
    constructor() {
        super('Pairing rekey request expired before commit.');
        this.name = 'PairingRekeyCommitExpiredError';
    }
}

export async function commitPairingRekeyAfterMachineReadiness(
    dependencies: PairingRekeyTransactionDependencies,
): Promise<PairingRekeyTransactionResult> {
    const nextPairing: PersistedPairing = {
        ...dependencies.currentPairing,
        authSecret: dependencies.nextAuthSecret,
    };
    let candidateMachineSocketHandle: MachineSocketHandle | null = null;
    let mustRestorePreviousMachineSocket = false;
    let hasPersistedNextPairing = false;

    try {
        dependencies.p2pServer.prepareAuthSecret(nextPairing.authSecret);
        mustRestorePreviousMachineSocket = true;
        dependencies.machineSocketHandle?.close();
        dependencies.p2pServer.disconnectDaemonMachineSockets();

        candidateMachineSocketHandle = dependencies.createMachineSocket(nextPairing);
        await candidateMachineSocketHandle.ready;
        if (!await dependencies.canCommit()) {
            throw new PairingRekeyCommitExpiredError();
        }

        const persistedNextPairing = dependencies.persistPairing(nextPairing);
        hasPersistedNextPairing = true;
        if (!await dependencies.canCommit()) {
            throw new PairingRekeyCommitExpiredError();
        }
        dependencies.p2pServer.commitPreparedAuthSecret();

        return {
            type: 'committed',
            pairing: persistedNextPairing,
            machineSocketHandle: candidateMachineSocketHandle,
        };
    } catch (error) {
        if (!mustRestorePreviousMachineSocket) {
            throw error;
        }

        candidateMachineSocketHandle?.close();
        dependencies.p2pServer.disconnectDaemonMachineSockets();

        let hasRestoredPreviousPairing = !hasPersistedNextPairing;
        if (hasPersistedNextPairing) {
            try {
                dependencies.persistPairing(dependencies.currentPairing);
                hasRestoredPreviousPairing = true;
            } catch {
                hasRestoredPreviousPairing = false;
            }
        }

        try {
            dependencies.p2pServer.rollbackPreparedAuthSecret();
        } catch {
            throw new Error('Pairing rekey failed and the prepared bearer could not be rolled back.');
        }

        try {
            const restoredMachineSocketHandle = dependencies.createMachineSocket(dependencies.currentPairing);
            await restoredMachineSocketHandle.ready;
            dependencies.onRollbackMachineSocketReady(restoredMachineSocketHandle);
        } catch {
            throw new Error('Pairing rekey failed and the previous machine RPC could not be restored.');
        }

        if (!hasRestoredPreviousPairing) {
            throw new Error('Pairing rekey failed and the previous pairing could not be restored.');
        }
        if (error instanceof PairingRekeyCommitExpiredError) {
            return { type: 'expired' };
        }
        throw new Error('Pairing rekey failed before commit; the previous pairing remains active.');
    }
}
