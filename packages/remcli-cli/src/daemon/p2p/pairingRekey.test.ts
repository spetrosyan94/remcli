import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import { decodeBase64 } from '@/api/encryption';
import type { PairingSecrets } from './p2pAuth';
import { PairingRekeyCoordinator, type PairingRekeyCommitGuard } from './pairingRekey';

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

function decryptDelivery(payload: string, recipientSecretKey: Uint8Array): unknown | null {
    const bundle = decodeBase64(payload);
    const publicKeyLength = nacl.box.publicKeyLength;
    const nonceLength = nacl.box.nonceLength;
    const plaintext = nacl.box.open(
        bundle.slice(publicKeyLength + nonceLength),
        bundle.slice(publicKeyLength, publicKeyLength + nonceLength),
        bundle.slice(0, publicKeyLength),
        recipientSecretKey,
    );
    return plaintext ? JSON.parse(new TextDecoder().decode(plaintext)) : null;
}

function createCoordinator(now = () => Date.now()) {
    let secrets: PairingSecrets = {
        authSecret: new Uint8Array(32).fill(1),
        contentSecret: new Uint8Array(32).fill(2),
    };
    const rotateAuthSecret = vi.fn(async (authSecret: Uint8Array) => {
        secrets = { ...secrets, authSecret };
    });
    const createQrPayload = vi.fn(async (payloadSecrets: PairingSecrets) => ({
        qrUrl: `http://127.0.0.1:1234/terminal/connect#${Buffer.from(payloadSecrets.authSecret).toString('base64')}`,
        qrDataUrl: 'data:image/png;base64,fixture',
    }));
    return {
        coordinator: new PairingRekeyCoordinator({
            currentSecrets: () => secrets,
            createQrPayload,
            rotateAuthSecret,
            now,
        }),
        getSecrets: () => secrets,
        rotateAuthSecret,
        createQrPayload,
    };
}

describe('PairingRekeyCoordinator', () => {
    it('does not generate or deliver a replacement before local host approval', async () => {
        const { coordinator, rotateAuthSecret, createQrPayload } = createCoordinator();
        const requester = nacl.box.keyPair();
        const request = coordinator.requestRekey(Buffer.from(requester.publicKey).toString('base64'));

        expect(coordinator.getDelivery(request.ticket)).toEqual({
            type: 'pending',
            expiresAt: request.expiresAt,
        });
        expect(rotateAuthSecret).not.toHaveBeenCalled();
        expect(createQrPayload).not.toHaveBeenCalled();

        await expect(coordinator.approve(request.requestId, 'wrong-code')).resolves.toEqual({ type: 'invalid-code' });
        expect(coordinator.getDelivery(request.ticket)).toEqual({
            type: 'pending',
            expiresAt: request.expiresAt,
        });
        expect(rotateAuthSecret).not.toHaveBeenCalled();
    });

    it('rotates only auth material and seals the new QR to the requesting browser', async () => {
        const { coordinator, getSecrets, rotateAuthSecret } = createCoordinator();
        const requester = nacl.box.keyPair();
        const unrelatedBrowser = nacl.box.keyPair();
        const before = getSecrets();
        const request = coordinator.requestRekey(Buffer.from(requester.publicKey).toString('base64'));

        await expect(coordinator.approve(request.requestId, request.approvalCode)).resolves.toEqual({
            type: 'approved',
            expiresAt: request.expiresAt,
        });
        expect(rotateAuthSecret).toHaveBeenCalledOnce();
        expect(getSecrets().contentSecret).toEqual(before.contentSecret);
        expect(getSecrets().authSecret).not.toEqual(before.authSecret);

        const delivery = coordinator.getDelivery(request.ticket);
        expect(delivery.type).toBe('ready');
        if (delivery.type !== 'ready') throw new Error('Expected ready delivery');

        expect(decryptDelivery(delivery.delivery.payload, requester.secretKey)).toEqual({
            qrUrl: expect.any(String),
            qrDataUrl: 'data:image/png;base64,fixture',
        });
        expect(decryptDelivery(delivery.delivery.payload, unrelatedBrowser.secretKey)).toBeNull();
        await expect(coordinator.approve(request.requestId, request.approvalCode)).resolves.toEqual({ type: 'already-approved' });
        expect(rotateAuthSecret).toHaveBeenCalledOnce();
    });

    it('rejects concurrent requests and expires a pending request without rotating', () => {
        let nowMs = 10_000;
        const { coordinator, rotateAuthSecret } = createCoordinator(() => nowMs);
        const requester = nacl.box.keyPair();
        const request = coordinator.requestRekey(Buffer.from(requester.publicKey).toString('base64'));

        expect(() => coordinator.requestRekey(Buffer.from(nacl.box.keyPair().publicKey).toString('base64')))
            .toThrow('PAIRING_REKEY_IN_PROGRESS');

        nowMs = request.expiresAt;
        expect(coordinator.getDelivery(request.ticket)).toEqual({ type: 'expired' });
        expect(rotateAuthSecret).not.toHaveBeenCalled();
    });

    it('cancels a pending request so it cannot later rotate the pairing', async () => {
        const { coordinator, rotateAuthSecret } = createCoordinator();
        const requester = nacl.box.keyPair();
        const request = coordinator.requestRekey(Buffer.from(requester.publicKey).toString('base64'));

        expect(coordinator.cancel(request.requestId, 'wrong-code')).toEqual({ type: 'invalid-code' });
        expect(coordinator.cancel(request.requestId, request.approvalCode)).toEqual({ type: 'cancelled' });
        expect(coordinator.getDelivery(request.ticket)).toEqual({ type: 'not-found' });
        await expect(coordinator.approve(request.requestId, request.approvalCode)).resolves.toEqual({ type: 'not-found' });
        expect(rotateAuthSecret).not.toHaveBeenCalled();

        expect(() => coordinator.requestRekey(Buffer.from(nacl.box.keyPair().publicKey).toString('base64'))).not.toThrow();
    });

    it('does not rotate when the request expires during asynchronous QR creation', async () => {
        let nowMs = 10_000;
        let expirationAt = 0;
        const { coordinator, createQrPayload, rotateAuthSecret } = createCoordinator(() => nowMs);
        const requester = nacl.box.keyPair();
        const request = coordinator.requestRekey(Buffer.from(requester.publicKey).toString('base64'));
        expirationAt = request.expiresAt;

        createQrPayload.mockImplementationOnce(async () => {
            nowMs = expirationAt;
            return { qrUrl: 'http://127.0.0.1:1234/terminal/connect#fixture', qrDataUrl: 'data:image/png;base64,fixture' };
        });

        await expect(coordinator.approve(request.requestId, request.approvalCode)).resolves.toEqual({ type: 'expired' });
        expect(rotateAuthSecret).not.toHaveBeenCalled();
        expect(coordinator.getDelivery(request.ticket)).toEqual({ type: 'not-found' });
    });

    it('expires and removes the request when candidate readiness crosses the approval TTL', async () => {
        let nowMs = 10_000;
        const candidateReadiness = createDeferred<void>();
        const rotationStarted = createDeferred<void>();
        let canCommit: PairingRekeyCommitGuard | undefined;
        const rotateAuthSecret = vi.fn(async (_authSecret: Uint8Array, guard: PairingRekeyCommitGuard) => {
            canCommit = guard;
            rotationStarted.resolve();
            await candidateReadiness.promise;
            return await guard() ? { type: 'committed' as const } : { type: 'expired' as const };
        });
        const currentSecrets: PairingSecrets = {
            authSecret: new Uint8Array(32).fill(1),
            contentSecret: new Uint8Array(32).fill(2),
        };
        const coordinator = new PairingRekeyCoordinator({
            currentSecrets: () => currentSecrets,
            createQrPayload: async () => ({
                qrUrl: 'http://127.0.0.1:1234/terminal/connect#fixture',
                qrDataUrl: 'data:image/png;base64,fixture',
            }),
            rotateAuthSecret,
            now: () => nowMs,
        });
        const requester = nacl.box.keyPair();
        const request = coordinator.requestRekey(Buffer.from(requester.publicKey).toString('base64'));
        const approval = coordinator.approve(request.requestId, request.approvalCode);

        await rotationStarted.promise;
        if (!canCommit) {
            throw new Error('Expected rekey rotation to receive the commit guard');
        }
        expect(await canCommit()).toBe(true);

        nowMs = request.expiresAt;
        candidateReadiness.resolve();

        await expect(approval).resolves.toEqual({ type: 'expired' });
        expect(rotateAuthSecret).toHaveBeenCalledOnce();
        expect(coordinator.getDelivery(request.ticket)).toEqual({ type: 'not-found' });
        expect(() => coordinator.requestRekey(Buffer.from(nacl.box.keyPair().publicKey).toString('base64'))).not.toThrow();
    });

    it('rejects malformed public keys before creating state', () => {
        const { coordinator } = createCoordinator();
        expect(() => coordinator.requestRekey(Buffer.alloc(31).toString('base64')))
            .toThrow('Invalid pairing rekey public key');
        expect(() => coordinator.requestRekey('not-base64'))
            .toThrow('Invalid pairing rekey public key');
    });
});
