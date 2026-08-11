import { describe, expect, it } from 'vitest';

import {
    REQUEST_PROOF_VERSION,
    calculateRequestProofMac,
    canonicalizeRequestProofInput,
    createP2PRequestProofVerifier,
    type JsonValue,
    type P2PRequestProof,
    type RequestProofTransport,
} from './p2pRequestProof';

const AUTH_SECRET = new Uint8Array(32).fill(7);

function createProof(
    transport: RequestProofTransport,
    operation: string,
    payload: JsonValue,
    id: string,
    expiresAt: number,
): P2PRequestProof {
    const mac = calculateRequestProofMac(AUTH_SECRET, {
        v: REQUEST_PROOF_VERSION,
        transport,
        operation,
        requestId: id,
        expiresAt,
        payload,
    });
    if (!mac) {
        throw new Error('Could not create test request proof');
    }

    return { v: REQUEST_PROOF_VERSION, id, expiresAt, mac };
}

describe('P2P request proofs', () => {
    it('canonicalizes nested object keys before calculating the MAC', () => {
        const canonical = canonicalizeRequestProofInput({
            v: REQUEST_PROOF_VERSION,
            transport: 'socket',
            operation: 'message',
            requestId: 'proof-id',
            expiresAt: 1_000,
            payload: {
                z: [{ y: 1, a: true }],
                a: { d: null, b: 'value' },
            },
        });

        expect(canonical).toBe(
            '{"expiresAt":1000,"operation":"message","payload":{"a":{"b":"value","d":null},"z":[{"a":true,"y":1}]},"requestId":"proof-id","transport":"socket","v":2}',
        );
    });

    it('matches the client v1 canonical request vector', () => {
        const input = {
            v: REQUEST_PROOF_VERSION,
            transport: 'http' as const,
            operation: 'POST /v1/sessions',
            requestId: 'request-1',
            expiresAt: 1_000,
            payload: { z: 2, a: { d: 4, c: [true, null] } },
        };

        expect(canonicalizeRequestProofInput(input)).toBe(
            '{"expiresAt":1000,"operation":"POST /v1/sessions","payload":{"a":{"c":[true,null],"d":4},"z":2},"requestId":"request-1","transport":"http","v":2}',
        );
        expect(calculateRequestProofMac(new Uint8Array(32).fill(1), input)).toBe(
            'uZlpjwj2iyhpOKHSChR6dcjyTXhogfLIdXdSOFs1j9egK5sod3_GSeOh8MGb5KfwEWPEP0KcA1LAa0BSRcx9Kg',
        );
    });

    it('binds a proof to the complete request and rejects replay before expiry', () => {
        let currentTime = 1_000;
        const verifier = createP2PRequestProofVerifier({
            getAuthSecret: () => AUTH_SECRET,
            replayCapacity: 1,
            maxProofLifetimeMs: 100,
            now: () => currentTime,
        });
        const payload = { sid: 'session-a', message: 'ciphertext' };
        const proof = createProof('socket', 'message', payload, 'proof-a', 1_050);

        expect(verifier.verify({ transport: 'socket', operation: 'message', payload, proof })).toBe(true);
        expect(verifier.verify({ transport: 'socket', operation: 'message', payload, proof })).toBe(false);
        expect(verifier.verify({
            transport: 'socket',
            operation: 'message',
            payload: { ...payload, sid: 'session-b' },
            proof,
        })).toBe(false);

        const secondProof = createProof('socket', 'message', payload, 'proof-b', 1_050);
        expect(verifier.verify({
            transport: 'socket',
            operation: 'message',
            payload,
            proof: secondProof,
        })).toBe(false);

        currentTime = 1_051;
        const freshProof = createProof('socket', 'message', payload, 'proof-c', 1_100);
        expect(verifier.verify({
            transport: 'socket',
            operation: 'message',
            payload,
            proof: freshProof,
        })).toBe(true);
    });

    it('rejects expired, too-far-future, and expiry-tampered proofs without consuming capacity', () => {
        const verifier = createP2PRequestProofVerifier({
            getAuthSecret: () => AUTH_SECRET,
            replayCapacity: 1,
            maxProofLifetimeMs: 100,
            now: () => 1_000,
        });
        const payload = { sid: 'session-a', message: 'ciphertext' };
        const expiredProof = createProof('socket', 'message', payload, 'expired', 1_000);
        const tooFarFutureProof = createProof('socket', 'message', payload, 'future', 1_101);
        const validProof = createProof('socket', 'message', payload, 'valid', 1_100);
        const tamperedProof = { ...validProof, expiresAt: 1_051 };

        expect(verifier.verify({ transport: 'socket', operation: 'message', payload, proof: expiredProof })).toBe(false);
        expect(verifier.verify({ transport: 'socket', operation: 'message', payload, proof: tooFarFutureProof })).toBe(false);
        expect(verifier.verify({ transport: 'socket', operation: 'message', payload, proof: tamperedProof })).toBe(false);
        expect(verifier.verify({ transport: 'socket', operation: 'message', payload, proof: validProof })).toBe(true);
    });
});
