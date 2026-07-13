import { P2PRunnerCredentialStore } from './p2p/p2pRunnerCredentials';

export interface StoppedSessionLifecycleStore {
    getSession: (sessionId: string) => unknown | undefined;
    onSessionDeleted: (listener: (sessionId: string) => void) => void;
}

export interface StoppedSessionLifecycleOptions {
    p2pStore: StoppedSessionLifecycleStore;
    runnerCredentialStore: P2PRunnerCredentialStore;
    getInactivePublisher: () => ((sessionId: string) => void) | undefined;
    onInactivePublisherUnavailable?: (sessionId: string) => void;
}

export function createStoppedSessionLifecycleHandler({
    p2pStore,
    runnerCredentialStore,
    getInactivePublisher,
    onInactivePublisherUnavailable,
}: StoppedSessionLifecycleOptions): (sessionId: string) => void {
    const stoppedSessionIds = new Set<string>();
    p2pStore.onSessionDeleted((sessionId) => {
        stoppedSessionIds.delete(sessionId);
    });

    return (sessionId: string): void => {
        if (stoppedSessionIds.has(sessionId) || !p2pStore.getSession(sessionId)) {
            return;
        }

        stoppedSessionIds.add(sessionId);
        runnerCredentialStore.revoke(sessionId);
        const publishInactive = getInactivePublisher();
        if (!publishInactive) {
            onInactivePublisherUnavailable?.(sessionId);
            return;
        }

        publishInactive(sessionId);
    };
}
