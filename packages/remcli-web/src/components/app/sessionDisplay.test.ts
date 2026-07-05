import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/protocol';

let dedupeSessionsByNativeAgent: typeof import('./sessionDisplay').dedupeSessionsByNativeAgent;
let nativeAgentSessionKey: typeof import('./sessionDisplay').nativeAgentSessionKey;

beforeAll(async () => {
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
    });
    vi.stubGlobal('navigator', {
        language: 'en-US',
        languages: ['en-US'],
    });

    const mod = await import('./sessionDisplay');
    dedupeSessionsByNativeAgent = mod.dedupeSessionsByNativeAgent;
    nativeAgentSessionKey = mod.nativeAgentSessionKey;
});

afterAll(() => {
    vi.unstubAllGlobals();
});

function session(overrides: Partial<Session>): Session {
    return {
        id: 'session-id',
        seq: 1,
        metadata: {
            path: '/tmp/project',
            host: 'test-host',
            flavor: 'codex',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        presence: 0,
        active: false,
        activeAt: 0,
        createdAt: 0,
        updatedAt: 0,
        thinking: false,
        thinkingAt: 0,
        ...overrides,
    } as Session;
}

describe('sessionDisplay native session dedupe', () => {
    it('builds provider-specific native keys', () => {
        expect(nativeAgentSessionKey(session({
            metadata: {
                path: '/tmp/project',
                host: 'test-host',
                flavor: 'codex',
                codexSessionId: 'codex-thread',
            },
        }))).toBe('codex:codex-thread');

        expect(nativeAgentSessionKey(session({
            metadata: {
                path: '/tmp/project',
                host: 'test-host',
                flavor: 'gemini',
                agentSessionId: 'gemini-session',
            },
        }))).toBe('gemini:gemini-session');
    });

    it('keeps the active wrapper when multiple Remcli sessions point to the same Codex thread', () => {
        const stopped = session({
            id: 'old-remcli-wrapper',
            presence: 2000,
            active: false,
            activeAt: 2000,
            metadata: {
                path: '/tmp/project',
                host: 'test-host',
                flavor: 'codex',
                codexSessionId: 'codex-thread',
            },
        });
        const active = session({
            id: 'active-remcli-wrapper',
            presence: 'online',
            active: true,
            activeAt: 1000,
            metadata: {
                path: '/tmp/project',
                host: 'test-host',
                flavor: 'codex',
                codexSessionId: 'codex-thread',
            },
        });

        expect(dedupeSessionsByNativeAgent([stopped, active])).toEqual([active]);
    });

    it('does not merge sessions that have no native agent id', () => {
        const first = session({ id: 'first' });
        const second = session({ id: 'second' });

        expect(dedupeSessionsByNativeAgent([first, second]).map((item) => item.id)).toEqual(['first', 'second']);
    });
});
