import { randomUUID } from 'node:crypto';

import type { P2PEventRouter } from './p2pEventRouter';
import type { P2PMachine, P2PStore } from './p2pStore';

/**
 * Delivers a machine snapshot to already-connected user clients. The daemon
 * uses this after its self-machine RPC registration has completed, so clients
 * that connected during startup do not miss the machine entirely.
 */
export function publishMachineSnapshot(
    store: P2PStore,
    router: P2PEventRouter,
    machine: P2PMachine,
): void {
    router.emitUpdate({
        id: randomUUID(),
        seq: store.allocateUserSeq(),
        body: {
            t: 'new-machine',
            machineId: machine.id,
            seq: machine.seq,
            metadata: machine.metadata,
            metadataVersion: machine.metadataVersion,
            daemonState: machine.daemonState,
            daemonStateVersion: machine.daemonStateVersion,
            dataEncryptionKey: machine.dataEncryptionKey,
            active: machine.active,
            activeAt: machine.activeAt,
            createdAt: machine.createdAt,
            updatedAt: machine.updatedAt,
        },
        createdAt: Date.now(),
    }, { type: 'user-scoped-only' });
}
