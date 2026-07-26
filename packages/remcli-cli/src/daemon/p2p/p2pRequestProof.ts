/**
 * One-shot integrity proofs for bearer-authenticated P2P mutations.
 *
 * A bearer token authenticates a connection. This proof additionally binds an
 * individual mutation to its complete transport payload and makes it
 * single-use for the current daemon process.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const REQUEST_PROOF_VERSION = 1;
export const REQUEST_PROOF_REPLAY_CAPACITY = 10_000;

const REQUEST_PROOF_MAC_PATTERN = /^[A-Za-z0-9_-]{86}$/;
const REQUEST_PROOF_ID_MAX_LENGTH = 128;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type RequestProofTransport = 'socket' | 'http';

export interface P2PRequestProof {
    v: number;
    id: string;
    mac: string;
}

export interface P2PRequestProofInput {
    v: number;
    transport: RequestProofTransport;
    operation: string;
    requestId: string;
    payload: JsonValue;
}

export interface P2PRequestProofVerifier {
    verify: (input: {
        transport: RequestProofTransport;
        operation: string;
        payload: unknown;
        proof: unknown;
    }) => boolean;
}

interface P2PRequestProofVerifierOptions {
    getAuthSecret: () => Uint8Array;
    replayCapacity?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function normalizeJsonValue(value: unknown, ancestors: Set<object>): JsonValue | undefined {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }

    if (Array.isArray(value)) {
        if (ancestors.has(value)) {
            return undefined;
        }
        ancestors.add(value);
        const normalized = value.map((item) => normalizeJsonValue(item, ancestors));
        ancestors.delete(value);
        return normalized.every((item) => item !== undefined)
            ? normalized as JsonValue[]
            : undefined;
    }

    if (!isJsonObject(value) || ancestors.has(value)) {
        return undefined;
    }

    ancestors.add(value);
    const normalized: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
    for (const key of Object.keys(value).sort()) {
        const normalizedValue = normalizeJsonValue(value[key], ancestors);
        if (normalizedValue === undefined) {
            ancestors.delete(value);
            return undefined;
        }
        normalized[key] = normalizedValue;
    }
    ancestors.delete(value);
    return normalized;
}

function parseRequestProof(value: unknown): P2PRequestProof | null {
    if (!isRecord(value) || value.v !== REQUEST_PROOF_VERSION) {
        return null;
    }
    if (
        typeof value.id !== 'string'
        || value.id.length === 0
        || value.id.length > REQUEST_PROOF_ID_MAX_LENGTH
        || typeof value.mac !== 'string'
        || !REQUEST_PROOF_MAC_PATTERN.test(value.mac)
    ) {
        return null;
    }

    return {
        v: value.v,
        id: value.id,
        mac: value.mac,
    };
}

export function canonicalizeRequestProofInput(input: P2PRequestProofInput): string | null {
    const normalized = normalizeJsonValue(input, new Set<object>());
    return normalized === undefined ? null : JSON.stringify(normalized);
}

export function calculateRequestProofMac(authSecret: Uint8Array, input: P2PRequestProofInput): string | null {
    const canonicalInput = canonicalizeRequestProofInput(input);
    if (canonicalInput === null) {
        return null;
    }

    return createHmac('sha512', authSecret)
        .update(canonicalInput, 'utf8')
        .digest('base64url');
}

function hasMatchingMac(expected: string, actual: string): boolean {
    if (expected.length !== actual.length) {
        return false;
    }

    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));
}

export function createP2PRequestProofVerifier(
    options: P2PRequestProofVerifierOptions,
): P2PRequestProofVerifier {
    const replayedRequestIds = new Set<string>();
    const replayCapacity = options.replayCapacity ?? REQUEST_PROOF_REPLAY_CAPACITY;

    if (!Number.isSafeInteger(replayCapacity) || replayCapacity <= 0) {
        throw new Error('P2P request proof replay capacity must be a positive integer');
    }

    return {
        verify: ({ transport, operation, payload, proof }) => {
            const parsedProof = parseRequestProof(proof);
            if (!parsedProof) {
                return false;
            }

            const expectedMac = calculateRequestProofMac(options.getAuthSecret(), {
                v: REQUEST_PROOF_VERSION,
                transport,
                operation,
                requestId: parsedProof.id,
                payload: payload as JsonValue,
            });
            if (!expectedMac || !hasMatchingMac(expectedMac, parsedProof.mac)) {
                return false;
            }

            if (replayedRequestIds.has(parsedProof.id) || replayedRequestIds.size >= replayCapacity) {
                return false;
            }

            replayedRequestIds.add(parsedProof.id);
            return true;
        },
    };
}
