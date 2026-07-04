import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io';
import { P2PEventRouter } from './p2pEventRouter';
import { publishSessionActivity } from './p2pSessionLifecycle';
import { P2PStore } from './p2pStore';

describe('publishSessionActivity', () => {
    it('marks the session inactive in the store and emits user activity', () => {
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('tag-1', '{}', null);
        const router = new P2PEventRouter();
        const emit = vi.fn();
        const stoppedAt = session.activeAt + 1;
        router.addConnection({
            socket: { emit } as unknown as Socket,
            connectionType: 'user-scoped'
        });

        const result = publishSessionActivity(store, router, {
            sessionId: session.id,
            active: false,
            activeAt: stoppedAt
        });

        expect(result).toEqual({ sessionExists: true, activeAt: stoppedAt });
        expect(store.getSession(session.id)).toMatchObject({
            active: false,
            activeAt: stoppedAt,
            updatedAt: stoppedAt
        });
        expect(emit).toHaveBeenCalledWith('ephemeral', {
            type: 'activity',
            id: session.id,
            active: false,
            activeAt: stoppedAt,
            thinking: false
        });
    });

    it('does not revive a terminally stopped session from later keep-alives', () => {
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('tag-1', '{}', null);
        const router = new P2PEventRouter();
        const emit = vi.fn();
        const stoppedAt = session.activeAt + 1;
        const staleAliveAt = stoppedAt + 1000;
        router.addConnection({
            socket: { emit } as unknown as Socket,
            connectionType: 'user-scoped'
        });

        publishSessionActivity(store, router, {
            sessionId: session.id,
            active: false,
            activeAt: stoppedAt,
            terminal: true
        });
        publishSessionActivity(store, router, {
            sessionId: session.id,
            active: true,
            activeAt: staleAliveAt,
            thinking: false
        });

        expect(store.getSession(session.id)).toMatchObject({
            active: false,
            activeAt: stoppedAt,
            updatedAt: stoppedAt
        });
        expect(emit).toHaveBeenCalledTimes(1);
    });

    it('ignores out-of-order lifecycle events', () => {
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('tag-1', '{}', null);
        const router = new P2PEventRouter();
        const emit = vi.fn();
        const freshAliveAt = session.activeAt + 1000;
        const staleEndAt = session.activeAt + 100;
        router.addConnection({
            socket: { emit } as unknown as Socket,
            connectionType: 'user-scoped'
        });

        publishSessionActivity(store, router, {
            sessionId: session.id,
            active: true,
            activeAt: freshAliveAt,
            thinking: false
        });
        publishSessionActivity(store, router, {
            sessionId: session.id,
            active: false,
            activeAt: staleEndAt
        });

        expect(store.getSession(session.id)).toMatchObject({
            active: true,
            activeAt: freshAliveAt,
            updatedAt: freshAliveAt
        });
        expect(emit).toHaveBeenCalledTimes(1);
    });
});
