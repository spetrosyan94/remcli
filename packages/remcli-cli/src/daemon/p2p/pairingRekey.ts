/**
 * Pairing-key rotation coordination.
 *
 * A bearer is intentionally shared by every paired device, so it cannot prove
 * which browser requested a rekey. The daemon therefore requires a local host
 * approval and delivers the replacement QR only in a `tweetnacl.box` envelope
 * addressed to a short-lived browser public key.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { encodeBase64, decodeBase64, libsodiumEncryptForPublicKey } from '@/api/encryption';
import { generateSharedSecret } from './p2pAuth';
import type { PairingSecrets } from './p2pAuth';

const REQUEST_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_REQUESTS = 16;

export interface SealedPairingQr {
    format: 'nacl-box-v1';
    payload: string;
    expiresAt: number;
}

export interface PairingRekeyRequest {
    requestId: string;
    approvalCode: string;
    ticket: string;
    expiresAt: number;
}

export type PairingRekeyApprovalResult =
    | { type: 'approved'; expiresAt: number }
    | { type: 'not-found' }
    | { type: 'expired' }
    | { type: 'already-approved' }
    | { type: 'invalid-code' };

export type PairingRekeyCancellationResult =
    | { type: 'cancelled' }
    | { type: 'not-found' }
    | { type: 'expired' }
    | { type: 'already-approved' }
    | { type: 'invalid-code' };

export type PairingRekeyDeliveryResult =
    | { type: 'ready'; delivery: SealedPairingQr }
    | { type: 'pending'; expiresAt: number }
    | { type: 'expired' }
    | { type: 'not-found' };

export interface PairingQrPayload {
    qrUrl: string;
    qrDataUrl: string;
}

interface PendingPairingRekey extends PairingRekeyRequest {
    recipientPublicKey: Uint8Array;
    state: 'pending' | 'approving' | 'approved';
    delivery?: SealedPairingQr;
}

export interface PairingRekeyCoordinatorConfig {
    currentSecrets: () => PairingSecrets;
    createQrPayload: (secrets: PairingSecrets) => Promise<PairingQrPayload>;
    rotateAuthSecret: (authSecret: Uint8Array) => Promise<void>;
    now?: () => number;
}

function createOpaqueId(): string {
    return randomBytes(24).toString('base64url');
}

function createApprovalCode(): string {
    return randomBytes(4).toString('hex').toUpperCase();
}

function isValidPublicKey(publicKey: Uint8Array): boolean {
    return publicKey.length === 32;
}

function sameApprovalCode(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function sealPayload(payload: PairingQrPayload, recipientPublicKey: Uint8Array, expiresAt: number): SealedPairingQr {
    const encrypted = libsodiumEncryptForPublicKey(
        new TextEncoder().encode(JSON.stringify(payload)),
        recipientPublicKey,
    );
    return {
        format: 'nacl-box-v1',
        payload: encodeBase64(encrypted),
        expiresAt,
    };
}

export class PairingRekeyCoordinator {
    private readonly pendingById = new Map<string, PendingPairingRekey>();
    private readonly requestIdByTicket = new Map<string, string>();
    private readonly now: () => number;

    constructor(private readonly config: PairingRekeyCoordinatorConfig) {
        this.now = config.now ?? (() => Date.now());
    }

    async showQr(clientPublicKey: string): Promise<SealedPairingQr> {
        const publicKey = this.decodePublicKey(clientPublicKey);
        const expiresAt = this.now() + REQUEST_TTL_MS;
        const qrPayload = await this.config.createQrPayload(this.config.currentSecrets());
        return sealPayload(qrPayload, publicKey, expiresAt);
    }

    requestRekey(clientPublicKey: string): PairingRekeyRequest {
        this.pruneExpired();
        if (this.pendingById.size > 0) {
            throw new Error('PAIRING_REKEY_IN_PROGRESS');
        }
        if (this.pendingById.size >= MAX_PENDING_REQUESTS) {
            throw new Error('Too many pending pairing rekey requests');
        }

        const expiresAt = this.now() + REQUEST_TTL_MS;
        const request: PendingPairingRekey = {
            requestId: createOpaqueId(),
            approvalCode: createApprovalCode(),
            ticket: createOpaqueId(),
            recipientPublicKey: this.decodePublicKey(clientPublicKey),
            expiresAt,
            state: 'pending',
        };
        this.pendingById.set(request.requestId, request);
        this.requestIdByTicket.set(request.ticket, request.requestId);
        return this.publicRequest(request);
    }

    async approve(requestId: string, approvalCode: string): Promise<PairingRekeyApprovalResult> {
        const request = this.pendingById.get(requestId);
        if (!request) {
            return { type: 'not-found' };
        }
        if (request.expiresAt <= this.now()) {
            this.removeRequest(request);
            return { type: 'expired' };
        }
        if (request.state === 'approved' || request.state === 'approving') {
            return { type: 'already-approved' };
        }
        if (!sameApprovalCode(approvalCode, request.approvalCode)) {
            return { type: 'invalid-code' };
        }

        request.state = 'approving';
        try {
            const nextAuthSecret = generateSharedSecret();
            const qrPayload = await this.config.createQrPayload({
                authSecret: nextAuthSecret,
                contentSecret: this.config.currentSecrets().contentSecret,
            });
            // QR generation is async. Do not revoke an active bearer when the
            // one-shot request expired or was invalidated while it was running.
            if (request.expiresAt <= this.now()) {
                this.removeRequest(request);
                return { type: 'expired' };
            }
            if (this.pendingById.get(request.requestId) !== request || request.state !== 'approving') {
                return { type: 'not-found' };
            }
            const delivery = sealPayload(qrPayload, request.recipientPublicKey, request.expiresAt);
            await this.config.rotateAuthSecret(nextAuthSecret);
            request.delivery = delivery;
            request.state = 'approved';
            return { type: 'approved', expiresAt: request.expiresAt };
        } catch (error) {
            request.state = 'pending';
            throw error;
        }
    }

    cancel(requestId: string, approvalCode: string): PairingRekeyCancellationResult {
        const request = this.pendingById.get(requestId);
        if (!request) {
            return { type: 'not-found' };
        }
        if (request.expiresAt <= this.now()) {
            this.removeRequest(request);
            return { type: 'expired' };
        }
        if (request.state !== 'pending') {
            return { type: 'already-approved' };
        }
        if (!sameApprovalCode(approvalCode, request.approvalCode)) {
            return { type: 'invalid-code' };
        }

        this.removeRequest(request);
        return { type: 'cancelled' };
    }

    getDelivery(ticket: string): PairingRekeyDeliveryResult {
        const requestId = this.requestIdByTicket.get(ticket);
        if (!requestId) {
            return { type: 'not-found' };
        }
        const request = this.pendingById.get(requestId);
        if (!request) {
            return { type: 'not-found' };
        }
        if (request.expiresAt <= this.now()) {
            this.removeRequest(request);
            return { type: 'expired' };
        }
        if (!request.delivery) {
            return { type: 'pending', expiresAt: request.expiresAt };
        }
        return { type: 'ready', delivery: request.delivery };
    }

    private decodePublicKey(encoded: string): Uint8Array {
        try {
            const publicKey = decodeBase64(encoded);
            if (!isValidPublicKey(publicKey)) {
                throw new Error('invalid length');
            }
            return publicKey;
        } catch {
            throw new Error('Invalid pairing rekey public key');
        }
    }

    private publicRequest(request: PendingPairingRekey): PairingRekeyRequest {
        return {
            requestId: request.requestId,
            approvalCode: request.approvalCode,
            ticket: request.ticket,
            expiresAt: request.expiresAt,
        };
    }

    private pruneExpired(): void {
        for (const request of this.pendingById.values()) {
            if (request.expiresAt <= this.now()) {
                this.removeRequest(request);
            }
        }
    }

    private removeRequest(request: PendingPairingRekey): void {
        this.pendingById.delete(request.requestId);
        this.requestIdByTicket.delete(request.ticket);
    }
}
