/**
 * Hook for loading older messages with offset-based pagination.
 * Used in ChatList to implement infinite scroll — when user scrolls
 * to the top (oldest messages), fetches the next page from P2P store.
 */

import * as React from 'react';
import { sync } from '@/sync/sync';
import { useSessionMessages } from '@/sync/storage';

export function useLoadMoreMessages(sessionId: string) {
    const { messages } = useSessionMessages(sessionId);
    const [hasMore, setHasMore] = React.useState(true);
    const [loading, setLoading] = React.useState(false);
    const loadingRef = React.useRef(false);

    // Track offset based on currently loaded message count
    const offsetRef = React.useRef(0);

    // Reset when session changes
    React.useEffect(() => {
        offsetRef.current = 0;
        setHasMore(true);
        setLoading(false);
        loadingRef.current = false;
    }, [sessionId]);

    // Keep offset in sync with message count (messages can arrive from live stream too)
    React.useEffect(() => {
        if (messages.length > offsetRef.current) {
            offsetRef.current = messages.length;
        }
    }, [messages.length]);

    const loadMore = React.useCallback(async () => {
        if (loadingRef.current || !hasMore) return;
        loadingRef.current = true;
        setLoading(true);

        try {
            const result = await sync.fetchOlderMessages(sessionId, offsetRef.current);
            offsetRef.current = offsetRef.current + 150;
            setHasMore(result.hasMore);
        } catch {
            // Silent fail — don't block UI
        } finally {
            loadingRef.current = false;
            setLoading(false);
        }
    }, [sessionId, hasMore]);

    return { loadMore, hasMore, loading };
}
