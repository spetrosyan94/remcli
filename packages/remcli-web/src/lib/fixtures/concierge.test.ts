import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    fixtureConciergeFeed,
    fixtureRestConfig,
    initFixturesIfEnabled
} from '@/lib/fixtures';
import {
    FIXTURE_CONCIERGE_CHAT_RESPONSE,
    FIXTURE_CONCIERGE_STATUS
} from '@/lib/fixtures/data';
import { conciergeChat, fetchConciergeStatus } from '@/lib/protocol/rest';
import { useProtocolStore } from '@/lib/protocol/store';

interface LocalStorageStub extends Storage {
    backing: Map<string, string>;
}

function createLocalStorageStub(): LocalStorageStub {
    const backing = new Map<string, string>();
    return {
        backing,
        get length() {
            return backing.size;
        },
        clear: () => { backing.clear(); },
        getItem: (key: string) => backing.get(key) ?? null,
        key: (index: number) => [...backing.keys()][index] ?? null,
        removeItem: (key: string) => { backing.delete(key); },
        setItem: (key: string, value: string) => { backing.set(key, value); }
    };
}

describe('concierge fixtures', () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    const originalLocation = globalThis.location;
    const originalLocalStorage = globalThis.localStorage;

    beforeAll(() => {
        Object.defineProperty(globalThis, 'window', { value: globalThis, configurable: true });
        Object.defineProperty(globalThis, 'location', {
            value: { search: '?fixtures=1' },
            configurable: true
        });
        Object.defineProperty(globalThis, 'localStorage', {
            value: createLocalStorageStub(),
            configurable: true
        });

        expect(initFixturesIfEnabled()).toBe(true);
    });

    afterAll(() => {
        Object.defineProperty(globalThis, 'fetch', { value: originalFetch, configurable: true });
        Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true });
        Object.defineProperty(globalThis, 'location', { value: originalLocation, configurable: true });
        Object.defineProperty(globalThis, 'localStorage', { value: originalLocalStorage, configurable: true });
        useProtocolStore.getState().reset();
    });

    it('returns an available Jarvis status through the fixture REST path', async () => {
        await expect(fetchConciergeStatus(fixtureRestConfig()))
            .resolves.toEqual(FIXTURE_CONCIERGE_STATUS);
    });

    it('returns a disabled Jarvis status through the fixture REST path', async () => {
        const previousLocation = globalThis.location;
        try {
            Object.defineProperty(globalThis, 'location', {
                value: { search: '?fixtures=1&conciergeStatus=disabled' },
                configurable: true
            });

            await expect(fetchConciergeStatus(fixtureRestConfig()))
                .resolves.toEqual({
                    enabled: false,
                    available: false,
                    model: null,
                });
        } finally {
            Object.defineProperty(globalThis, 'location', {
                value: previousLocation,
                configurable: true
            });
        }
    });

    it('returns a deterministic assistant response through the fixture chat path', async () => {
        const response = await conciergeChat(fixtureRestConfig(), [
            { role: 'user', content: 'Что запущено?' }
        ], { lang: 'ru' });

        expect(response).toEqual(FIXTURE_CONCIERGE_CHAT_RESPONSE);
    });

    it('seeds a selectable assistant feed with a copyable answer and session action', () => {
        const feed = fixtureConciergeFeed();

        expect(feed).toHaveLength(2);
        expect(feed[0]).toMatchObject({ role: 'user', content: expect.stringContaining('Джарвис') });
        expect(feed[1]).toMatchObject({
            role: 'assistant',
            content: expect.stringContaining('копирование и выделение ответа')
        });
        expect(feed[1]?.content).not.toMatch(/^\s*Джарвис\s*:/);
        expect(feed[1]?.actions).toContainEqual({
            tool: 'spawn_agent_session',
            result: { sessionId: 'fx-chat' }
        });
    });
});
