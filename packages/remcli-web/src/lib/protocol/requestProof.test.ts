import { describe, expect, it } from 'vitest';
import {
    canonicalizeJson,
    createRequestProof,
    normalizeRequestPayload,
} from '@/lib/protocol/requestProof';

describe('request proof canonicalization', () => {
    it('produces the agreed deterministic v2 vector', () => {
        const payload = normalizeRequestPayload({
            z: 2,
            a: { d: 4, c: [true, null] },
        });
        const canonicalRequest = normalizeRequestPayload({
            v: 2,
            transport: 'http',
            operation: 'POST /v1/sessions',
            requestId: 'request-1',
            expiresAt: 1_000,
            payload,
        });

        expect(canonicalizeJson(canonicalRequest)).toBe(
            '{"expiresAt":1000,"operation":"POST /v1/sessions","payload":{"a":{"c":[true,null],"d":4},"z":2},"requestId":"request-1","transport":"http","v":2}'
        );
        expect(createRequestProof(new Uint8Array(32).fill(1), {
            transport: 'http',
            operation: 'POST /v1/sessions',
            requestId: 'request-1',
            expiresAt: 1_000,
            payload,
        })).toEqual({
            v: 2,
            id: 'request-1',
            expiresAt: 1_000,
            mac: 'uZlpjwj2iyhpOKHSChR6dcjyTXhogfLIdXdSOFs1j9egK5sod3_GSeOh8MGb5KfwEWPEP0KcA1LAa0BSRcx9Kg',
        });
    });
});
