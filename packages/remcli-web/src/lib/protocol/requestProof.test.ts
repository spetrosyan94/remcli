import { describe, expect, it } from 'vitest';
import {
    canonicalizeJson,
    createRequestProof,
    normalizeRequestPayload,
} from '@/lib/protocol/requestProof';

describe('request proof canonicalization', () => {
    it('produces the agreed deterministic v1 vector', () => {
        const payload = normalizeRequestPayload({
            z: 2,
            a: { d: 4, c: [true, null] },
        });
        const canonicalRequest = normalizeRequestPayload({
            v: 1,
            transport: 'http',
            operation: 'POST /v1/sessions',
            requestId: 'request-1',
            payload,
        });

        expect(canonicalizeJson(canonicalRequest)).toBe(
            '{"operation":"POST /v1/sessions","payload":{"a":{"c":[true,null],"d":4},"z":2},"requestId":"request-1","transport":"http","v":1}'
        );
        expect(createRequestProof(new Uint8Array(32).fill(1), {
            transport: 'http',
            operation: 'POST /v1/sessions',
            requestId: 'request-1',
            payload,
        })).toEqual({
            v: 1,
            id: 'request-1',
            mac: 'akwsU3zaWsHazukoWNCnudVE7PMhXmP1rWqcp9PxqHBZ2sjOLVCGi0qmHqF8uJLv-afx-sUaUQ9sevgfM4NK6Q',
        });
    });
});
