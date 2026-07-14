import { describe, expect, it } from 'vitest';
import {
    claimRouteChunkRetry,
    getRouteLoadErrorKind,
    isRouteChunkLoadError,
    type StorageLike,
} from './routeChunkRecovery';

function createStorage(): StorageLike {
    const values = new Map<string, string>();
    return {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
}

describe('route chunk recovery', () => {
    it('recognizes browser lazy-import failures', () => {
        expect(isRouteChunkLoadError(new Error('Failed to fetch dynamically imported module: /assets/TerminalPage-old.js'))).toBe(true);
        expect(isRouteChunkLoadError(new Error('Error loading dynamically imported module: https://remcli.test/assets/TerminalPage-old.js'))).toBe(true);
        expect(isRouteChunkLoadError(new Error('Loading chunk 23 failed.'))).toBe(true);
        expect(isRouteChunkLoadError(new Error('Error loading session history'))).toBe(false);
        expect(isRouteChunkLoadError(new Error('The request was rejected by the daemon'))).toBe(false);
    });

    it('keeps ordinary route failures out of chunk recovery', () => {
        expect(getRouteLoadErrorKind(new Error('Failed to fetch dynamically imported module'))).toBe('chunk');
        expect(getRouteLoadErrorKind(new Error('Cannot read properties of undefined'))).toBe('runtime');
    });

    it('claims one reload attempt per location', () => {
        const storage = createStorage();

        expect(claimRouteChunkRetry(storage, '/session/a/terminal')).toBe(true);
        expect(claimRouteChunkRetry(storage, '/session/a/terminal')).toBe(false);
        expect(claimRouteChunkRetry(storage, '/session/b/terminal')).toBe(true);
    });
});
