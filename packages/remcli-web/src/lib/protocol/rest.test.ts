import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    deleteMachine,
    deleteSession,
    fetchSessions,
    kvMutate,
    synthesizeSpeech,
    transcribeAudio,
} from '@/lib/protocol/rest';
import { createRequestProof, REQUEST_PROOF_HEADERS } from '@/lib/protocol/requestProof';

const endpoint = 'http://127.0.0.1:12345';
const authSecret = new Uint8Array(32).fill(9);
const config = { endpoint, token: 'test-token', authSecret };

function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function proofHeaders(init: RequestInit): Headers {
    return new Headers(init.headers);
}

describe('REST request proof', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('adds proof headers to protected session, machine, and KV mutations', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ success: true }))
            .mockResolvedValueOnce(jsonResponse({ ok: true }))
            .mockResolvedValueOnce(jsonResponse({ success: true, results: [] }));
        vi.stubGlobal('fetch', fetchMock);

        await deleteSession(config, 'session-1');
        await deleteMachine(config, 'machine-1');
        await kvMutate(config, [{ key: 'theme', value: 'dark', version: 1 }]);

        const expectedRequests = [
            { method: 'DELETE', pathname: '/v1/sessions/session-1', payload: null },
            { method: 'DELETE', pathname: '/v1/machines/machine-1', payload: null },
            { method: 'POST', pathname: '/v1/kv', payload: { mutations: [{ key: 'theme', value: 'dark', version: 1 }] } },
        ];
        for (const [index, expected] of expectedRequests.entries()) {
            const init = fetchMock.mock.calls[index][1] as RequestInit;
            const headers = proofHeaders(init);
            const requestId = headers.get(REQUEST_PROOF_HEADERS.id);
            expect(headers.get(REQUEST_PROOF_HEADERS.version)).toBe('1');
            expect(requestId).toEqual(expect.any(String));
            expect(headers.get(REQUEST_PROOF_HEADERS.mac)).toBe(
                createRequestProof(authSecret, {
                    transport: 'http',
                    operation: `${expected.method} ${expected.pathname}`,
                    requestId: requestId!,
                    payload: expected.payload,
                }).mac
            );
        }
    });

    it('adds an action proof to multipart transcription without changing its FormData body', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ text: 'hello' }));
        vi.stubGlobal('fetch', fetchMock);

        await transcribeAudio(config, new Blob(['audio'], { type: 'audio/webm' }));

        const init = fetchMock.mock.calls[0][1] as RequestInit;
        const headers = proofHeaders(init);
        const requestId = headers.get(REQUEST_PROOF_HEADERS.id);
        expect(headers.get(REQUEST_PROOF_HEADERS.version)).toBe('1');
        expect(requestId).toEqual(expect.any(String));
        expect(headers.get(REQUEST_PROOF_HEADERS.mac)).toBe(
            createRequestProof(authSecret, {
                transport: 'http',
                operation: 'POST /v1/voice/transcribe',
                requestId: requestId!,
                payload: null,
            }).mac
        );
        expect(init.body).toBeInstanceOf(FormData);
        expect(headers.has('Content-Type')).toBe(false);
    });

    it('does not add body-bound proof to reads or synthesis media requests', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ sessions: [] }))
            .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
        vi.stubGlobal('fetch', fetchMock);

        await fetchSessions(config);
        await synthesizeSpeech(config, 'hello');

        for (const call of fetchMock.mock.calls) {
            const headers = proofHeaders(call[1] as RequestInit);
            expect(headers.has(REQUEST_PROOF_HEADERS.version)).toBe(false);
            expect(headers.has(REQUEST_PROOF_HEADERS.id)).toBe(false);
            expect(headers.has(REQUEST_PROOF_HEADERS.mac)).toBe(false);
        }
    });
});
