import { afterEach, describe, expect, it, vi } from 'vitest';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import { deriveBearerToken, generateSharedSecret } from './p2p/p2pAuth';
import { startP2PServer, type P2PServer } from './p2p/p2pServer';
import { P2PStore } from './p2p/p2pStore';
import { P2PRunnerCredentialStore, SESSION_MESSAGE_ACK_VERSION } from './p2p/p2pRunnerCredentials';
import { publishSessionActivity } from './p2p/p2pSessionLifecycle';
import { createStoppedSessionLifecycleHandler, type StoppedSessionLifecycleStore } from './sessionLifecycle';

const SOCKET_TIMEOUT_MS = 5_000;

interface InactiveSessionActivity {
    type: 'activity';
    id: string;
    active: false;
    activeAt: number;
    thinking: false;
}

let p2pServer: P2PServer | null = null;
const sockets = new Set<ClientSocket>();

function createSocket(
    port: number,
    bearerToken: string,
    auth: Record<string, unknown>,
): ClientSocket {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
        auth: {
            token: bearerToken,
            ...auth,
        },
        path: '/v1/updates',
        reconnection: false,
        transports: ['websocket'],
        autoConnect: false,
        timeout: SOCKET_TIMEOUT_MS,
    });
    sockets.add(socket);
    return socket;
}

async function connectSocket(socket: ClientSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off('connect', handleConnect);
            socket.off('connect_error', handleError);
            reject(new Error('Timed out connecting to P2P Socket.IO server'));
        }, SOCKET_TIMEOUT_MS);

        const handleConnect = (): void => {
            clearTimeout(timeout);
            socket.off('connect_error', handleError);
            resolve();
        };
        const handleError = (error: Error): void => {
            clearTimeout(timeout);
            socket.off('connect', handleConnect);
            reject(error);
        };

        socket.once('connect', handleConnect);
        socket.once('connect_error', handleError);
        socket.connect();
    });
}

function waitForSocketDisconnect(socket: ClientSocket): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off('disconnect', handleDisconnect);
            reject(new Error('Timed out waiting for the ACK runner to disconnect'));
        }, SOCKET_TIMEOUT_MS);

        const handleDisconnect = (): void => {
            clearTimeout(timeout);
            resolve();
        };

        socket.once('disconnect', handleDisconnect);
    });
}

function isInactiveSessionActivity(value: unknown, sessionId: string): value is InactiveSessionActivity {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const activity = value as Record<string, unknown>;
    return (
        activity.type === 'activity'
        && activity.id === sessionId
        && activity.active === false
        && typeof activity.activeAt === 'number'
        && activity.thinking === false
    );
}

function waitForInactiveSessionActivity(socket: ClientSocket, sessionId: string): Promise<InactiveSessionActivity> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off('ephemeral', handleEphemeral);
            reject(new Error(`Timed out waiting for inactive activity for session ${sessionId}`));
        }, SOCKET_TIMEOUT_MS);

        const handleEphemeral = (payload: unknown): void => {
            if (!isInactiveSessionActivity(payload, sessionId)) {
                return;
            }

            clearTimeout(timeout);
            socket.off('ephemeral', handleEphemeral);
            resolve(payload);
        };

        socket.on('ephemeral', handleEphemeral);
    });
}

afterEach(async () => {
    for (const socket of sockets) {
        socket.close();
    }
    sockets.clear();

    await p2pServer?.stop();
    p2pServer = null;
});

describe('createStoppedSessionLifecycleHandler', { timeout: 15_000 }, () => {
    it('revokes a runner and reports an unavailable publisher only once', () => {
        const p2pStore = new P2PStore({ kvFilePath: null });
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const session = p2pStore.createSession('publisher-not-ready', '{}', null);
        const runnerCredential = runnerCredentialStore.issue(session.id, 'lifecycle-unavailable-publisher');
        if (!runnerCredential) {
            throw new Error('Could not issue runner credential for lifecycle test');
        }

        const onInactivePublisherUnavailable = vi.fn();
        const handleStoppedSession = createStoppedSessionLifecycleHandler({
            p2pStore,
            runnerCredentialStore,
            getInactivePublisher: () => undefined,
            onInactivePublisherUnavailable,
        });

        handleStoppedSession(session.id);
        handleStoppedSession(session.id);

        expect(runnerCredentialStore.verify(session.id, runnerCredential)).toBe(false);
        expect(onInactivePublisherUnavailable).toHaveBeenCalledOnce();
        expect(onInactivePublisherUnavailable).toHaveBeenCalledWith(session.id);
    });

    it('clears deleted ids while ignoring a stale stop callback after deletion', () => {
        const deletedListeners: Array<(sessionId: string) => void> = [];
        let hasSession = true;
        const p2pStore: StoppedSessionLifecycleStore = {
            getSession: () => hasSession ? {} : undefined,
            onSessionDeleted: (listener) => {
                deletedListeners.push(listener);
            },
        };
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const sessionId = 'deleted-session-race';
        const firstCredential = runnerCredentialStore.issue(sessionId, 'first-runner-owner');
        if (!firstCredential) {
            throw new Error('Could not issue initial runner credential for lifecycle test');
        }

        const revoke = vi.spyOn(runnerCredentialStore, 'revoke');
        const publishInactive = vi.fn();
        const handleStoppedSession = createStoppedSessionLifecycleHandler({
            p2pStore,
            runnerCredentialStore,
            getInactivePublisher: () => publishInactive,
        });

        expect(deletedListeners).toHaveLength(1);
        handleStoppedSession(sessionId);
        expect(publishInactive).toHaveBeenCalledTimes(1);
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(runnerCredentialStore.verify(sessionId, firstCredential)).toBe(false);

        hasSession = false;
        for (const listener of deletedListeners) {
            listener(sessionId);
        }
        handleStoppedSession(sessionId);

        expect(publishInactive).toHaveBeenCalledTimes(1);
        expect(revoke).toHaveBeenCalledTimes(1);

        hasSession = true;
        const replacementCredential = runnerCredentialStore.issue(sessionId, 'replacement-runner-owner');
        if (!replacementCredential) {
            throw new Error('Could not issue replacement runner credential for lifecycle test');
        }
        handleStoppedSession(sessionId);

        expect(publishInactive).toHaveBeenCalledTimes(2);
        expect(revoke).toHaveBeenCalledTimes(2);
        expect(runnerCredentialStore.verify(sessionId, replacementCredential)).toBe(false);
    });

    it('revokes the runner, publishes inactivity, and disconnects the active ACK runner once', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('stopped-session-lifecycle', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const runnerCredential = runnerCredentialStore.issue(session.id, `lifecycle-runner:${session.id}`);
        if (!runnerCredential) {
            throw new Error('Could not issue runner credential for lifecycle test');
        }

        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });

        const appSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        const runnerSocket = createSocket(p2pServer.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: session.id,
            messageAckVersion: SESSION_MESSAGE_ACK_VERSION,
            runnerCredential,
        });
        await connectSocket(appSocket);
        await connectSocket(runnerSocket);

        const onSessionDeleted = vi.spyOn(store, 'onSessionDeleted');
        const revoke = vi.spyOn(runnerCredentialStore, 'revoke');
        const sessionDeletionListenerCount = onSessionDeleted.mock.calls.length;
        let inactivePublisher: ((sessionId: string) => void) | undefined;
        const handleStoppedSession = createStoppedSessionLifecycleHandler({
            p2pStore: store,
            runnerCredentialStore,
            getInactivePublisher: () => inactivePublisher,
        });
        expect(onSessionDeleted).toHaveBeenCalledTimes(sessionDeletionListenerCount + 1);
        const publishInactive = vi.fn((sessionId: string) => {
            publishSessionActivity(store, p2pServer!.router, {
                sessionId,
                active: false,
                terminal: true,
            });
        });
        inactivePublisher = publishInactive;
        const inactiveActivity = waitForInactiveSessionActivity(appSocket, session.id);
        const runnerDisconnected = waitForSocketDisconnect(runnerSocket);

        handleStoppedSession(session.id);
        handleStoppedSession(session.id);

        const activity = await inactiveActivity;
        await runnerDisconnected;

        expect(publishInactive).toHaveBeenCalledOnce();
        expect(publishInactive).toHaveBeenCalledWith(session.id);
        expect(revoke).toHaveBeenCalledTimes(1);
        expect(runnerCredentialStore.verify(session.id, runnerCredential)).toBe(false);
        expect(runnerSocket.connected).toBe(false);
        expect(store.getSession(session.id)).toMatchObject({ active: false, activeAt: activity.activeAt });

        expect(store.deleteSession(session.id)).toBe(true);
        handleStoppedSession(session.id);

        expect(publishInactive).toHaveBeenCalledOnce();
        expect(revoke).toHaveBeenCalledTimes(2);
    });
});
