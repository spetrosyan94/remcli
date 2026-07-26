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
): P2PRequestProof {
    const mac = calculateRequestProofMac(AUTH_SECRET, {
        v: REQUEST_PROOF_VERSION,
        transport,
        operation,
        requestId: id,
        payload,
    });
    if (!mac) {
        throw new Error('Could not create test request proof');
    }

    return { v: REQUEST_PROOF_VERSION, id, mac };
}

describe('P2P request proofs', () => {
    it('canonicalizes nested object keys before calculating the MAC', () => {
        const canonical = canonicalizeRequestProofInput({
            v: REQUEST_PROOF_VERSION,
            transport: 'socket',
            operation: 'message',
            requestId: 'proof-id',
            payload: {
                z: [{ y: 1, a: true }],
                a: { d: null, b: 'value' },
            },
        });

        expect(canonical).toBe(
            '{"operation":"message","payload":{"a":{"b":"value","d":null},"z":[{"a":true,"y":1}]},"requestId":"proof-id","transport":"socket","v":1}',
        );
    });

    it('matches the client v1 canonical request vector', () => {
        const input = {
            v: REQUEST_PROOF_VERSION,
            transport: 'http' as const,
            operation: 'POST /v1/sessions',
            requestId: 'request-1',
            payload: { z: 2, a: { d: 4, c: [true, null] } },
        };

        expect(canonicalizeRequestProofInput(input)).toBe(
            '{"operation":"POST /v1/sessions","payload":{"a":{"c":[true,null],"d":4},"z":2},"requestId":"request-1","transport":"http","v":1}',
        );
        expect(calculateRequestProofMac(new Uint8Array(32).fill(1), input)).toBe(
            'akwsU3zaWsHazukoWNCnudVE7PMhXmP1rWqcp9PxqHBZ2sjOLVCGi0qmHqF8uJLv-afx-sUaUQ9sevgfM4NK6Q',
        );
    });

    it('binds a proof to the complete request and fails closed at replay capacity', () => {
        const verifier = createP2PRequestProofVerifier({
            getAuthSecret: () => AUTH_SECRET,
            replayCapacity: 1,
        });
        const payload = { sid: 'session-a', message: 'ciphertext' };
        const proof = createProof('socket', 'message', payload, 'proof-a');

        expect(verifier.verify({ transport: 'socket', operation: 'message', payload, proof })).toBe(true);
        expect(verifier.verify({ transport: 'socket', operation: 'message', payload, proof })).toBe(false);
        expect(verifier.verify({
            transport: 'socket',
            operation: 'message',
            payload: { ...payload, sid: 'session-b' },
            proof,
        })).toBe(false);

        const secondProof = createProof('socket', 'message', payload, 'proof-b');
        expect(verifier.verify({
            transport: 'socket',
            operation: 'message',
            payload,
            proof: secondProof,
        })).toBe(false);
    });
});
