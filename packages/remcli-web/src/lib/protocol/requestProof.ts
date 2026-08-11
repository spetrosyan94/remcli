import { encodeBase64 } from '@/lib/protocol/encoding';
import { hmacSha512 } from '@/lib/protocol/encryption';

export const REQUEST_PROOF_VERSION = 2 as const;
export const REQUEST_PROOF_TTL_MS = 60_000;

export const REQUEST_PROOF_HEADERS = {
    version: 'X-Remcli-Request-Proof-Version',
    id: 'X-Remcli-Request-Proof-Id',
    expiresAt: 'X-Remcli-Request-Proof-Expires-At',
    mac: 'X-Remcli-Request-Proof-Mac',
} as const;

export type RequestProofTransport = 'socket' | 'http';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface RequestProof {
    v: typeof REQUEST_PROOF_VERSION;
    id: string;
    expiresAt: number;
    mac: string;
}

export interface RequestProofInput {
    transport: RequestProofTransport;
    operation: string;
    requestId: string;
    expiresAt?: number;
    payload: unknown;
}

const REQUEST_PROOF_KEY = 'proof';

/** Normalize values to the exact JSON representation that will be sent on the wire. */
export function normalizeRequestPayload(value: unknown): JsonValue {
    let serialized: string | undefined;
    try {
        serialized = JSON.stringify(value);
    } catch {
        throw new Error('Request payload is not JSON-compatible');
    }

    if (serialized === undefined) {
        return null;
    }

    try {
        return JSON.parse(serialized) as JsonValue;
    } catch {
        throw new Error('Request payload is not JSON-compatible');
    }
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function withoutRequestProof(value: JsonValue): JsonValue {
    if (!isJsonObject(value)) {
        return value;
    }

    const payload = { ...value };
    delete payload[REQUEST_PROOF_KEY];
    return payload;
}

/** Serialize JSON with object keys sorted recursively and array order preserved. */
export function canonicalizeJson(value: JsonValue): string {
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
    }

    if (isJsonObject(value)) {
        return `{${Object.keys(value).sort().map((key) =>
            `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`
        ).join(',')}}`;
    }

    return JSON.stringify(value) ?? 'null';
}

export function createRequestProof(authSecret: Uint8Array, input: RequestProofInput): RequestProof {
    const expiresAt = input.expiresAt ?? Date.now() + REQUEST_PROOF_TTL_MS;
    const canonicalPayload = withoutRequestProof(normalizeRequestPayload(input.payload));
    const canonicalRequest: JsonValue = {
        v: REQUEST_PROOF_VERSION,
        transport: input.transport,
        operation: input.operation,
        requestId: input.requestId,
        expiresAt,
        payload: canonicalPayload,
    };
    const mac = hmacSha512(authSecret, new TextEncoder().encode(canonicalizeJson(canonicalRequest)));

    return {
        v: REQUEST_PROOF_VERSION,
        id: input.requestId,
        expiresAt,
        mac: encodeBase64(mac, 'base64url'),
    };
}

export function createRequestId(): string {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Add a proof to a JSON object while keeping the normalized object as the wire payload. */
export function attachRequestProof(
    authSecret: Uint8Array | undefined,
    transport: RequestProofTransport,
    operation: string,
    payload: unknown,
): unknown {
    if (!authSecret) {
        return payload;
    }

    const normalizedPayload = withoutRequestProof(normalizeRequestPayload(payload));
    if (!isJsonObject(normalizedPayload)) {
        throw new Error('Request payload must be a JSON object');
    }

    const proof = createRequestProof(authSecret, {
        transport,
        operation,
        requestId: createRequestId(),
        payload: normalizedPayload,
    });
    return { ...normalizedPayload, [REQUEST_PROOF_KEY]: proof };
}
