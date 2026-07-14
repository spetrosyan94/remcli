const ROUTE_CHUNK_RETRY_PREFIX = 'remcli:route-chunk-retry:';
const ROUTE_CHUNK_LOAD_ERROR_PATTERN = /(?:failed to fetch|error loading) dynamically imported module|importing a module script failed|chunkloaderror|loading chunk \d+ failed/i;

export interface StorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

export type RouteLoadErrorKind = 'chunk' | 'runtime';

export function isRouteChunkLoadError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return ROUTE_CHUNK_LOAD_ERROR_PATTERN.test(message);
}

export function getRouteLoadErrorKind(error: unknown): RouteLoadErrorKind {
    return isRouteChunkLoadError(error) ? 'chunk' : 'runtime';
}

export function claimRouteChunkRetry(storage: StorageLike, locationKey: string): boolean {
    const retryKey = `${ROUTE_CHUNK_RETRY_PREFIX}${locationKey}`;
    if (storage.getItem(retryKey) === '1') {
        return false;
    }

    storage.setItem(retryKey, '1');
    return true;
}
