/**
 * Ephemeral credentials for ACK-capable session runners.
 *
 * A pairing bearer grants P2P access to a paired device, but does not grant the
 * authority to advance a runner's message-delivery cursor. The daemon keeps the
 * credential in memory only and issues it through its loopback control server.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const SESSION_MESSAGE_ACK_VERSION = 1;

const RUNNER_CREDENTIAL_BYTES = 32;
const RUNNER_CREDENTIAL_ENCODED_LENGTH = Math.ceil((RUNNER_CREDENTIAL_BYTES * 8) / 6);

interface RunnerCredentialLease {
    credential: Buffer;
    owner: Buffer;
}

export class P2PRunnerCredentialStore {
    private readonly credentials = new Map<string, RunnerCredentialLease>();
    private readonly leaseActivationListeners = new Set<(sessionId: string) => void>();
    private readonly revocationListeners = new Set<(sessionId: string) => void>();

    issue(sessionId: string, owner: string): string | undefined {
        const ownerBuffer = Buffer.from(owner);
        if (ownerBuffer.length === 0) {
            return undefined;
        }

        const existingLease = this.credentials.get(sessionId);
        if (existingLease) {
            if (
                existingLease.owner.length !== ownerBuffer.length
                || !timingSafeEqual(existingLease.owner, ownerBuffer)
            ) {
                return undefined;
            }
            return existingLease.credential.toString('base64url');
        }

        const credential = randomBytes(RUNNER_CREDENTIAL_BYTES);
        this.credentials.set(sessionId, { credential, owner: ownerBuffer });
        for (const listener of this.leaseActivationListeners) {
            listener(sessionId);
        }
        return credential.toString('base64url');
    }

    hasActiveLease(sessionId: string): boolean {
        return this.credentials.has(sessionId);
    }

    verify(sessionId: string, credential: unknown): boolean {
        if (typeof credential !== 'string' || credential.length !== RUNNER_CREDENTIAL_ENCODED_LENGTH) {
            return false;
        }

        const lease = this.credentials.get(sessionId);
        if (!lease) {
            return false;
        }

        const receivedCredential = Buffer.from(credential, 'base64url');
        if (receivedCredential.length !== lease.credential.length) {
            return false;
        }

        return timingSafeEqual(receivedCredential, lease.credential);
    }

    revoke(sessionId: string): boolean {
        const didRevoke = this.credentials.delete(sessionId);
        if (!didRevoke) {
            return false;
        }

        for (const listener of this.revocationListeners) {
            listener(sessionId);
        }
        return true;
    }

    onRevoked(listener: (sessionId: string) => void): () => void {
        this.revocationListeners.add(listener);
        return () => this.revocationListeners.delete(listener);
    }

    onLeaseActivated(listener: (sessionId: string) => void): () => void {
        this.leaseActivationListeners.add(listener);
        return () => this.leaseActivationListeners.delete(listener);
    }
}

const runnerCredentials = new Map<string, string>();

export function rememberSessionRunnerCredential(sessionId: string, credential: string): void {
    runnerCredentials.set(sessionId, credential);
}

export function getSessionRunnerCredential(sessionId: string): string | undefined {
    return runnerCredentials.get(sessionId);
}

export function forgetSessionRunnerCredential(sessionId: string): void {
    runnerCredentials.delete(sessionId);
}
