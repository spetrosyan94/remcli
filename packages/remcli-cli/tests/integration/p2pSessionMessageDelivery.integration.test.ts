/**
 * Delivery guarantees for phone prompts while a session-scoped runner reconnects.
 * Uses a real local P2P server and Socket.IO clients; no transport mocks.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { ApiSessionClient } from '@/api/apiSession';
import { encodeBase64, encrypt } from '@/api/encryption';
import {
    RetryableUserMessageDeliveryError,
    type Session,
    type Update,
    type UserMessage,
} from '@/api/types';
import { configuration } from '@/configuration';
import { deriveBearerToken, generateSharedSecret } from '@/daemon/p2p/p2pAuth';
import {
    calculateRequestProofMac,
    REQUEST_PROOF_TTL_MS,
    REQUEST_PROOF_VERSION,
} from '@/daemon/p2p/p2pRequestProof';
import { startP2PServer, type P2PServer } from '@/daemon/p2p/p2pServer';
import { P2PStore } from '@/daemon/p2p/p2pStore';
import {
    forgetSessionRunnerCredential,
    P2PRunnerCredentialStore,
    rememberSessionRunnerCredential,
    SESSION_MESSAGE_ACK_VERSION,
} from '@/daemon/p2p/p2pRunnerCredentials';

const SOCKET_TIMEOUT_MS = 5_000;
const NO_EVENT_WINDOW_MS = 200;

interface ApiSessionClientInternals {
    socket: ClientSocket;
}

let p2pServer: P2PServer | null = null;
const sockets = new Set<ClientSocket>();
const cachedRunnerCredentialSessionIds = new Set<string>();
const originalP2PServerUrl = configuration.p2pServerUrl;

function createSocket(
    port: number,
    bearerToken: string,
    auth: Record<string, unknown>
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

function acknowledgedRunnerAuth(sessionId: string, runnerCredential: string): Record<string, unknown> {
    return {
        clientType: 'session-scoped',
        sessionId,
        messageAckVersion: SESSION_MESSAGE_ACK_VERSION,
        runnerCredential,
    };
}

function cacheRunnerCredential(sessionId: string, runnerCredential: string): void {
    rememberSessionRunnerCredential(sessionId, runnerCredential);
    cachedRunnerCredentialSessionIds.add(sessionId);
}

function issueRunnerCredential(store: P2PRunnerCredentialStore, sessionId: string): string {
    const credential = store.issue(sessionId, `integration-runner:${sessionId}`);
    if (!credential) {
        throw new Error(`Could not issue runner credential for ${sessionId}`);
    }
    return credential;
}

function waitForSocketEvent(socket: ClientSocket, event: 'connect' | 'disconnect'): Promise<void> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off(event, handleEvent);
            reject(new Error(`Timed out waiting for Socket.IO ${event}`));
        }, SOCKET_TIMEOUT_MS);

        const handleEvent = (): void => {
            clearTimeout(timeout);
            resolve();
        };

        socket.once(event, handleEvent);
    });
}

function waitForSocketConnection(socket: ClientSocket): Promise<void> {
    if (socket.connected) {
        return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
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
    });
}

async function connectSocket(socket: ClientSocket): Promise<void> {
    const connected = waitForSocketConnection(socket);
    socket.connect();
    await connected;
}

async function expectSocketConnectionError(socket: ClientSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off('connect', handleConnect);
            socket.off('connect_error', handleConnectionError);
            reject(new Error('Expected Socket.IO connection to be rejected'));
        }, SOCKET_TIMEOUT_MS);

        const handleConnect = (): void => {
            clearTimeout(timeout);
            socket.off('connect_error', handleConnectionError);
            reject(new Error('Unexpected Socket.IO connection success'));
        };
        const handleConnectionError = (): void => {
            clearTimeout(timeout);
            socket.off('connect', handleConnect);
            resolve();
        };

        socket.once('connect', handleConnect);
        socket.once('connect_error', handleConnectionError);
        socket.connect();
    });
}

async function waitForCondition(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + SOCKET_TIMEOUT_MS;
    while (!condition()) {
        if (Date.now() >= deadline) {
            throw new Error('Timed out waiting for expected P2P delivery');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function expectNoUpdate(socket: ClientSocket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off('update', handleUpdate);
            resolve();
        }, NO_EVENT_WINDOW_MS);

        const handleUpdate = (): void => {
            clearTimeout(timeout);
            reject(new Error('Received an unexpected replayed message update'));
        };

        socket.once('update', handleUpdate);
    });
}

function toApiSession(sessionId: string, sharedSecret: Uint8Array): Session {
    return {
        id: sessionId,
        seq: 1,
        metadata: {
            path: '/tmp/remcli-p2p-delivery-test',
            host: 'test-host',
            homeDir: '/tmp',
            remcliHomeDir: '/tmp/.remcli',
            remcliLibDir: '/tmp/.remcli/lib',
            remcliToolsDir: '/tmp/.remcli/tools',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        encryptionKey: sharedSecret,
        encryptionVariant: 'legacy',
    };
}

function getRunnerSocket(runner: ApiSessionClient): ClientSocket {
    return (runner as unknown as ApiSessionClientInternals).socket;
}

function sendPhonePrompt(
    phoneSocket: ClientSocket,
    sessionId: string,
    sharedSecret: Uint8Array,
    text: string
): void {
    const payload = {
        sid: sessionId,
        message: encodeBase64(encrypt(sharedSecret, 'legacy', {
            role: 'user',
            content: {
                type: 'text',
                text,
            },
            meta: {
                sentFrom: 'phone',
            },
        })),
    };
    const id = randomUUID();
    const expiresAt = Date.now() + REQUEST_PROOF_TTL_MS;
    const mac = calculateRequestProofMac(sharedSecret, {
        v: REQUEST_PROOF_VERSION,
        transport: 'socket',
        operation: 'message',
        requestId: id,
        expiresAt,
        payload,
    });
    if (!mac) {
        throw new Error('Could not create phone message request proof');
    }
    phoneSocket.emit('message', {
        ...payload,
        proof: { v: REQUEST_PROOF_VERSION, id, expiresAt, mac },
    });
}

function isNewMessageUpdate(update: Update): boolean {
    return update.body.t === 'new-message';
}

function emitUncheckedAcknowledgement(socket: ClientSocket, data: unknown): void {
    const uncheckedSocket = socket as unknown as { emit: (event: string, payload: unknown) => void };
    uncheckedSocket.emit('message-ack', data);
}

afterEach(async () => {
    for (const socket of sockets) {
        socket.close();
    }
    sockets.clear();
    for (const sessionId of cachedRunnerCredentialSessionIds) {
        forgetSessionRunnerCredential(sessionId);
    }
    cachedRunnerCredentialSessionIds.clear();

    await p2pServer?.stop();
    p2pServer = null;
    configuration.p2pServerUrl = originalP2PServerUrl;
});

describe('P2P session message delivery on reconnect', { timeout: 15_000 }, () => {
    it('keeps a phone prompt deliverable after a failed daemon handoff until a later valid runner connects', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('failed-handoff-runner', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });
        configuration.p2pServerUrl = `http://127.0.0.1:${p2pServer.port}`;

        const phoneSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        await connectSocket(phoneSocket);

        // A failed /session-started handoff must not create ApiSessionClient. The
        // prompt therefore stays pending until a newly valid daemon runner connects.
        sendPhonePrompt(phoneSocket, session.id, sharedSecret, 'prompt after failed handoff');
        await waitForCondition(() => store.getMessageCount(session.id) === 1);

        const runnerCredential = issueRunnerCredential(runnerCredentialStore, session.id);
        cacheRunnerCredential(session.id, runnerCredential);
        const runner = new ApiSessionClient(bearerToken, toApiSession(session.id, sharedSecret));
        const receivedMessages: UserMessage[] = [];
        runner.onUserMessage((message) => receivedMessages.push(message));
        await waitForCondition(() => receivedMessages.length === 1);
        await runner.flush();

        expect(receivedMessages.map((message) => message.content.text)).toEqual([
            'prompt after failed handoff',
        ]);

        await runner.close();

        const acknowledgedReconnect = createSocket(
            p2pServer.port,
            bearerToken,
            acknowledgedRunnerAuth(session.id, runnerCredential)
        );
        const noReplayAfterAcknowledgement = expectNoUpdate(acknowledgedReconnect);
        await connectSocket(acknowledgedReconnect);
        await noReplayAfterAcknowledgement;
    });

    it('delivers a pending phone prompt exactly once during the session-started credential handoff', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('session-started-runner', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const runnerCredential = issueRunnerCredential(runnerCredentialStore, session.id);
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });
        configuration.p2pServerUrl = `http://127.0.0.1:${p2pServer.port}`;

        const phoneSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        await connectSocket(phoneSocket);

        // Mirrors the /session-started response, which supplies the daemon-issued
        // credential before runCodex creates the session socket.
        cacheRunnerCredential(session.id, runnerCredential);
        const runner = new ApiSessionClient(bearerToken, toApiSession(session.id, sharedSecret));
        const runnerSocket = getRunnerSocket(runner);
        let runnerConnectionCount = 0;
        let runnerMessageUpdateCount = 0;
        runnerSocket.on('connect', () => {
            runnerConnectionCount += 1;
        });
        runnerSocket.on('update', (update: Update) => {
            if (isNewMessageUpdate(update)) {
                runnerMessageUpdateCount += 1;
            }
        });
        await waitForSocketConnection(runnerSocket);

        sendPhonePrompt(phoneSocket, session.id, sharedSecret, 'session-started transition prompt');
        await waitForCondition(() => runnerMessageUpdateCount === 1);

        const receivedMessages: UserMessage[] = [];
        runner.onUserMessage((message) => receivedMessages.push(message));
        await waitForCondition(() => receivedMessages.length === 1);
        await runner.flush();

        expect(receivedMessages.map((message) => message.content.text)).toEqual([
            'session-started transition prompt',
        ]);
        expect(runnerConnectionCount).toBe(1);

        await runner.close();

        const acknowledgedReconnect = createSocket(
            p2pServer.port,
            bearerToken,
            acknowledgedRunnerAuth(session.id, runnerCredential)
        );
        const noReplayAfterAcknowledgement = expectNoUpdate(acknowledgedReconnect);
        await connectSocket(acknowledgedReconnect);
        await noReplayAfterAcknowledgement;
    });

    it('delivers a phone prompt exactly once to a reconnecting runner and does not replay it again after acknowledgement', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('reconnecting-runner', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const runnerCredential = issueRunnerCredential(runnerCredentialStore, session.id);
        cacheRunnerCredential(session.id, runnerCredential);
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });
        configuration.p2pServerUrl = `http://127.0.0.1:${p2pServer.port}`;

        const phoneSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        await connectSocket(phoneSocket);

        const receivedMessages: UserMessage[] = [];
        const runner = new ApiSessionClient(bearerToken, toApiSession(session.id, sharedSecret));
        const runnerSocket = getRunnerSocket(runner);
        const originalEmit = runnerSocket.emit;
        const mutableRunnerSocket = runnerSocket as unknown as { emit: (...args: unknown[]) => unknown };
        let acknowledgementAttempts = 0;
        mutableRunnerSocket.emit = (...args: unknown[]): unknown => {
            if (args[0] === 'message-ack') {
                acknowledgementAttempts++;
                if (acknowledgementAttempts === 1) {
                    return runnerSocket;
                }
            }
            return Reflect.apply(originalEmit, runnerSocket, args);
        };
        runner.onUserMessage((message) => receivedMessages.push(message));
        await waitForSocketConnection(runnerSocket);

        const disconnected = waitForSocketEvent(runnerSocket, 'disconnect');
        runnerSocket.disconnect();
        await disconnected;

        sendPhonePrompt(phoneSocket, session.id, sharedSecret, 'reconnect prompt');
        await waitForCondition(() => store.getMessageCount(session.id) === 1);

        const reconnected = waitForSocketConnection(runnerSocket);
        runnerSocket.connect();
        await reconnected;
        await waitForCondition(() => receivedMessages.length === 1);
        await waitForCondition(() => acknowledgementAttempts === 1);
        expect(receivedMessages.map((message) => message.content.text)).toEqual(['reconnect prompt']);

        const disconnectedAgain = waitForSocketEvent(runnerSocket, 'disconnect');
        runnerSocket.disconnect();
        await disconnectedAgain;

        const reconnectedAgain = waitForSocketConnection(runnerSocket);
        runnerSocket.connect();
        await reconnectedAgain;
        await waitForCondition(() => acknowledgementAttempts === 2);
        expect(receivedMessages).toHaveLength(1);

        await runner.flush();

        const disconnectedAfterAcknowledgement = waitForSocketEvent(runnerSocket, 'disconnect');
        runnerSocket.disconnect();
        await disconnectedAfterAcknowledgement;

        const noReplayAfterAcknowledgement = expectNoUpdate(runnerSocket);
        const reconnectedAfterAcknowledgement = waitForSocketConnection(runnerSocket);
        runnerSocket.connect();
        await reconnectedAfterAcknowledgement;
        await noReplayAfterAcknowledgement;

        await runner.close();
    });

    it('reoffers an unacknowledged phone prompt to the same connected runner only after explicit recovery', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('same-runner-redelivery', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const runnerCredential = issueRunnerCredential(runnerCredentialStore, session.id);
        const promptText = 'recover this prompt on the same runner';
        cacheRunnerCredential(session.id, runnerCredential);
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });
        configuration.p2pServerUrl = `http://127.0.0.1:${p2pServer.port}`;

        const phoneSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        await connectSocket(phoneSocket);

        const runner = new ApiSessionClient(bearerToken, toApiSession(session.id, sharedSecret));
        const runnerSocket = getRunnerSocket(runner);
        const originalRunnerEmit = runnerSocket.emit;
        const mutableRunnerSocket = runnerSocket as unknown as { emit: (...args: unknown[]) => unknown };
        let acknowledgementAttempts = 0;
        mutableRunnerSocket.emit = (...args: unknown[]): unknown => {
            if (args[0] === 'message-ack') {
                acknowledgementAttempts++;
            }
            return Reflect.apply(originalRunnerEmit, runnerSocket, args);
        };

        const deliveryIds: string[] = [];
        let attempts = 0;
        runner.onUserMessage(async (message) => {
            attempts++;
            deliveryIds.push(message.deliveryId ?? '');
            if (attempts === 1) {
                throw new RetryableUserMessageDeliveryError(new Error('wait for Codex recovery'));
            }
        });
        await waitForSocketConnection(runnerSocket);

        sendPhonePrompt(phoneSocket, session.id, sharedSecret, promptText);
        await waitForCondition(() => attempts === 1);
        expect(runnerSocket.connected).toBe(true);
        expect(acknowledgementAttempts).toBe(0);
        await expectNoUpdate(runnerSocket);

        expect(runner.requestPendingUserMessageRedelivery()).toBe(true);
        await waitForCondition(() => attempts === 2);
        await waitForCondition(() => acknowledgementAttempts === 1);
        expect(deliveryIds).toEqual([`p2p:${session.id}:1`, `p2p:${session.id}:1`]);
        await runner.flush();

        const runnerDisconnected = waitForSocketEvent(runnerSocket, 'disconnect');
        await runner.close();
        await runnerDisconnected;

        const acknowledgedReconnect = createSocket(
            p2pServer.port,
            bearerToken,
            acknowledgedRunnerAuth(session.id, runnerCredential),
        );
        const noReplayAfterAcknowledgement = expectNoUpdate(acknowledgedReconnect);
        await connectSocket(acknowledgedReconnect);
        await noReplayAfterAcknowledgement;
    });

    it('replays an unacknowledged phone prompt to a new runner after an async callback rejection', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('async-callback-retry', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const runnerCredential = issueRunnerCredential(runnerCredentialStore, session.id);
        const promptText = 'retry this async callback prompt';
        const expectedPromptSequence = 1;
        cacheRunnerCredential(session.id, runnerCredential);
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });
        configuration.p2pServerUrl = `http://127.0.0.1:${p2pServer.port}`;

        const phoneSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        await connectSocket(phoneSocket);

        const rejectedRunner = new ApiSessionClient(bearerToken, toApiSession(session.id, sharedSecret));
        const rejectedRunnerSocket = getRunnerSocket(rejectedRunner);
        const originalRejectedRunnerEmit = rejectedRunnerSocket.emit;
        const mutableRejectedRunnerSocket = rejectedRunnerSocket as unknown as { emit: (...args: unknown[]) => unknown };
        let rejectedRunnerAcknowledgementAttempts = 0;
        mutableRejectedRunnerSocket.emit = (...args: unknown[]): unknown => {
            if (args[0] === 'message-ack') {
                rejectedRunnerAcknowledgementAttempts++;
            }
            return Reflect.apply(originalRejectedRunnerEmit, rejectedRunnerSocket, args);
        };

        const rejectedCallbackMessages: UserMessage[] = [];
        const rejectedDeliveryIds: string[] = [];
        rejectedRunner.onUserMessage(async (message) => {
            rejectedCallbackMessages.push(message);
            rejectedDeliveryIds.push(message.deliveryId ?? '');
            await Promise.resolve();
            throw new Error('Simulated asynchronous runner callback failure');
        });
        await waitForSocketConnection(rejectedRunnerSocket);

        sendPhonePrompt(phoneSocket, session.id, sharedSecret, promptText);
        await waitForCondition(() => rejectedCallbackMessages.length === 1);
        expect(rejectedRunnerAcknowledgementAttempts).toBe(0);

        const rejectedRunnerDisconnected = waitForSocketEvent(rejectedRunnerSocket, 'disconnect');
        await rejectedRunner.close();
        await rejectedRunnerDisconnected;

        // The retry runner has no local queue from the rejected callback, so the
        // observed update must be replayed by the P2P server.
        const retryRunner = new ApiSessionClient(bearerToken, toApiSession(session.id, sharedSecret));
        const retryRunnerSocket = getRunnerSocket(retryRunner);
        const replayedUpdates: Update[] = [];
        retryRunnerSocket.on('update', (update: Update) => {
            if (isNewMessageUpdate(update)) {
                replayedUpdates.push(update);
            }
        });
        const originalRetryRunnerEmit = retryRunnerSocket.emit;
        const mutableRetryRunnerSocket = retryRunnerSocket as unknown as { emit: (...args: unknown[]) => unknown };
        let retryRunnerAcknowledgementAttempts = 0;
        mutableRetryRunnerSocket.emit = (...args: unknown[]): unknown => {
            if (args[0] === 'message-ack') {
                retryRunnerAcknowledgementAttempts++;
            }
            return Reflect.apply(originalRetryRunnerEmit, retryRunnerSocket, args);
        };
        await waitForSocketConnection(retryRunnerSocket);
        await waitForCondition(() => replayedUpdates.length === 1);

        expect(replayedUpdates.map((update) => update.body.message.seq)).toEqual([expectedPromptSequence]);
        await expectNoUpdate(retryRunnerSocket);

        const retriedCallbackMessages: UserMessage[] = [];
        const retriedDeliveryIds: string[] = [];
        retryRunner.onUserMessage(async (message) => {
            retriedCallbackMessages.push(message);
            retriedDeliveryIds.push(message.deliveryId ?? '');
            await Promise.resolve();
        });
        await waitForCondition(() => retriedCallbackMessages.length === 1);
        await waitForCondition(() => retryRunnerAcknowledgementAttempts === 1);
        await retryRunner.flush();

        expect(retriedCallbackMessages.map((message) => message.content.text)).toEqual([promptText]);
        expect(rejectedDeliveryIds).toEqual([`p2p:${session.id}:${expectedPromptSequence}`]);
        expect(retriedDeliveryIds).toEqual(rejectedDeliveryIds);

        const retryRunnerDisconnected = waitForSocketEvent(retryRunnerSocket, 'disconnect');
        await retryRunner.close();
        await retryRunnerDisconnected;

        const acknowledgedReconnect = createSocket(
            p2pServer.port,
            bearerToken,
            acknowledgedRunnerAuth(session.id, runnerCredential)
        );
        const noReplayAfterAcknowledgement = expectNoUpdate(acknowledgedReconnect);
        await connectSocket(acknowledgedReconnect);
        await noReplayAfterAcknowledgement;
    });

    it('replays every runner-directed message that has not been acknowledged before advancing the cursor', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('unacknowledged-runner', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const runnerCredential = issueRunnerCredential(runnerCredentialStore, session.id);
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });

        const phoneSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        await connectSocket(phoneSocket);

        const initialRunner = createSocket(
            p2pServer.port,
            bearerToken,
            acknowledgedRunnerAuth(session.id, runnerCredential)
        );
        await connectSocket(initialRunner);
        initialRunner.close();

        sendPhonePrompt(phoneSocket, session.id, sharedSecret, 'first unacknowledged prompt');
        await waitForCondition(() => store.getMessageCount(session.id) === 1);

        const firstReconnect = createSocket(
            p2pServer.port,
            bearerToken,
            acknowledgedRunnerAuth(session.id, runnerCredential)
        );
        const firstReconnectUpdates: Update[] = [];
        firstReconnect.on('update', (update) => firstReconnectUpdates.push(update));
        await connectSocket(firstReconnect);
        await waitForCondition(() => firstReconnectUpdates.filter(isNewMessageUpdate).length === 1);
        firstReconnect.close();

        sendPhonePrompt(phoneSocket, session.id, sharedSecret, 'second unacknowledged prompt');
        await waitForCondition(() => store.getMessageCount(session.id) === 2);

        const secondReconnect = createSocket(
            p2pServer.port,
            bearerToken,
            acknowledgedRunnerAuth(session.id, runnerCredential)
        );
        const replayedUpdates: Update[] = [];
        secondReconnect.on('update', (update) => replayedUpdates.push(update));
        await connectSocket(secondReconnect);
        await waitForCondition(() => replayedUpdates.filter(isNewMessageUpdate).length === 2);

        const replayedSequences = replayedUpdates
            .filter(isNewMessageUpdate)
            .map((update) => update.body.message.seq);
        expect(replayedSequences).toEqual([1, 2]);

        secondReconnect.emit('message-ack', { sid: session.id, seq: 2 });
        await secondReconnect.timeout(SOCKET_TIMEOUT_MS).emitWithAck('ping');
        secondReconnect.close();

        const acknowledgedReconnect = createSocket(
            p2pServer.port,
            bearerToken,
            acknowledgedRunnerAuth(session.id, runnerCredential)
        );
        const noReplayAfterCursorAdvance = expectNoUpdate(acknowledgedReconnect);
        await connectSocket(acknowledgedReconnect);
        await noReplayAfterCursorAdvance;
    });

    it('keeps legacy session runners on safe replay-once delivery across reconnects', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('legacy-runner', '{}', null);
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
        });

        const phoneSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        await connectSocket(phoneSocket);

        const initialRunner = createSocket(p2pServer.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: session.id,
        });
        await connectSocket(initialRunner);
        initialRunner.close();

        sendPhonePrompt(phoneSocket, session.id, sharedSecret, 'legacy prompt');
        await waitForCondition(() => store.getMessageCount(session.id) === 1);

        const firstReconnect = createSocket(p2pServer.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: session.id,
        });
        const firstReplay: Update[] = [];
        firstReconnect.on('update', (update) => firstReplay.push(update));
        await connectSocket(firstReconnect);
        await waitForCondition(() => firstReplay.filter(isNewMessageUpdate).length === 1);
        firstReconnect.close();

        const repeatedReconnect = createSocket(p2pServer.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: session.id,
        });
        const noRepeatedLegacyReplay = expectNoUpdate(repeatedReconnect);
        await connectSocket(repeatedReconnect);
        await noRepeatedLegacyReplay;
    });

    it('disconnects and blocks legacy consumers when a runner lease activates without duplicating the prompt', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('lease-anti-downgrade', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });

        const phoneSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        const legacyRunner = createSocket(p2pServer.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: session.id,
        });
        const legacyUpdates: Update[] = [];
        legacyRunner.on('update', (update) => legacyUpdates.push(update));
        await connectSocket(phoneSocket);
        await connectSocket(legacyRunner);

        const legacyDisconnected = waitForSocketEvent(legacyRunner, 'disconnect');
        const runnerCredential = issueRunnerCredential(runnerCredentialStore, session.id);
        await legacyDisconnected;
        expect(legacyRunner.connected).toBe(false);

        const legacyReconnect = createSocket(p2pServer.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: session.id,
        });
        await expectSocketConnectionError(legacyReconnect);

        const acknowledgedRunner = createSocket(
            p2pServer.port,
            bearerToken,
            acknowledgedRunnerAuth(session.id, runnerCredential)
        );
        const acknowledgedUpdates: Update[] = [];
        acknowledgedRunner.on('update', (update) => acknowledgedUpdates.push(update));
        await connectSocket(acknowledgedRunner);

        sendPhonePrompt(phoneSocket, session.id, sharedSecret, 'only the ACK runner receives this prompt');
        await waitForCondition(() => acknowledgedUpdates.filter(isNewMessageUpdate).length === 1);

        expect(legacyUpdates.filter(isNewMessageUpdate)).toHaveLength(0);
        expect(acknowledgedUpdates.filter(isNewMessageUpdate)).toHaveLength(1);

        const acknowledgedRunnerDisconnected = waitForSocketEvent(acknowledgedRunner, 'disconnect');
        expect(runnerCredentialStore.revoke(session.id)).toBe(true);
        await acknowledgedRunnerDisconnected;

        const restoredLegacyRunner = createSocket(p2pServer.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: session.id,
        });
        await connectSocket(restoredLegacyRunner);
    });

    it('rejects paired ACK and legacy impersonators without the daemon-issued runner credential', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('runner-authentication', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const runnerCredential = issueRunnerCredential(runnerCredentialStore, session.id);
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });

        const phoneSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        await connectSocket(phoneSocket);
        sendPhonePrompt(phoneSocket, session.id, sharedSecret, 'protected prompt');
        await waitForCondition(() => store.getMessageCount(session.id) === 1);

        const pairedAttacker = createSocket(p2pServer.port, bearerToken, acknowledgedRunnerAuth(session.id, 'not-a-runner-credential'));
        await expectSocketConnectionError(pairedAttacker);

        const legacyImpersonator = createSocket(p2pServer.port, bearerToken, {
            clientType: 'session-scoped',
            sessionId: session.id,
        });
        await expectSocketConnectionError(legacyImpersonator);

        const authenticatedRunner = createSocket(
            p2pServer.port,
            bearerToken,
            acknowledgedRunnerAuth(session.id, runnerCredential)
        );
        const receivedUpdates: Update[] = [];
        authenticatedRunner.on('update', (update) => receivedUpdates.push(update));
        await connectSocket(authenticatedRunner);
        await waitForCondition(() => receivedUpdates.filter(isNewMessageUpdate).length === 1);
    });

    it('rejects null and malformed acknowledgements without stopping the daemon', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('malformed-ack', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const runnerCredential = issueRunnerCredential(runnerCredentialStore, session.id);
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });

        const phoneSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        const runner = createSocket(p2pServer.port, bearerToken, acknowledgedRunnerAuth(session.id, runnerCredential));
        const receivedUpdates: Update[] = [];
        runner.on('update', (update) => receivedUpdates.push(update));
        await connectSocket(phoneSocket);
        await connectSocket(runner);

        sendPhonePrompt(phoneSocket, session.id, sharedSecret, 'malformed acknowledgement prompt');
        await waitForCondition(() => receivedUpdates.filter(isNewMessageUpdate).length === 1);

        emitUncheckedAcknowledgement(runner, null);
        emitUncheckedAcknowledgement(runner, { sid: session.id, seq: 'not-a-sequence' });
        await runner.timeout(SOCKET_TIMEOUT_MS).emitWithAck('ping');

        const healthResponse = await fetch(`http://127.0.0.1:${p2pServer.port}/health`);
        expect(healthResponse.ok).toBe(true);

        runner.close();
        const reconnect = createSocket(p2pServer.port, bearerToken, acknowledgedRunnerAuth(session.id, runnerCredential));
        const replayedUpdates: Update[] = [];
        reconnect.on('update', (update) => replayedUpdates.push(update));
        await connectSocket(reconnect);
        await waitForCondition(() => replayedUpdates.filter(isNewMessageUpdate).length === 1);
    });

    it('rejects acknowledgements beyond the runner-delivered range', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('beyond-delivery-range', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const runnerCredential = issueRunnerCredential(runnerCredentialStore, session.id);
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });

        const phoneSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        const runner = createSocket(p2pServer.port, bearerToken, acknowledgedRunnerAuth(session.id, runnerCredential));
        const receivedUpdates: Update[] = [];
        runner.on('update', (update) => receivedUpdates.push(update));
        await connectSocket(phoneSocket);
        await connectSocket(runner);

        sendPhonePrompt(phoneSocket, session.id, sharedSecret, 'range prompt');
        await waitForCondition(() => receivedUpdates.filter(isNewMessageUpdate).length === 1);

        emitUncheckedAcknowledgement(runner, { sid: session.id, seq: 99_999 });
        await runner.timeout(SOCKET_TIMEOUT_MS).emitWithAck('ping');
        runner.close();

        const reconnect = createSocket(p2pServer.port, bearerToken, acknowledgedRunnerAuth(session.id, runnerCredential));
        const replayedUpdates: Update[] = [];
        reconnect.on('update', (update) => replayedUpdates.push(update));
        await connectSocket(reconnect);
        await waitForCondition(() => replayedUpdates.filter(isNewMessageUpdate).length === 1);
    });

    it('replaces an older authenticated runner before delivering new prompts', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('duplicate-runner', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const runnerCredential = issueRunnerCredential(runnerCredentialStore, session.id);
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });

        const firstRunner = createSocket(p2pServer.port, bearerToken, acknowledgedRunnerAuth(session.id, runnerCredential));
        await connectSocket(firstRunner);
        const firstRunnerDisconnected = waitForSocketEvent(firstRunner, 'disconnect');

        const replacementRunner = createSocket(p2pServer.port, bearerToken, acknowledgedRunnerAuth(session.id, runnerCredential));
        const replacementUpdates: Update[] = [];
        replacementRunner.on('update', (update) => replacementUpdates.push(update));
        await connectSocket(replacementRunner);
        await firstRunnerDisconnected;

        const phoneSocket = createSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        await connectSocket(phoneSocket);
        sendPhonePrompt(phoneSocket, session.id, sharedSecret, 'only replacement receives this');
        await waitForCondition(() => replacementUpdates.filter(isNewMessageUpdate).length === 1);
    });

    it('disconnects an established ACK-capable runner immediately after credential revocation', async () => {
        const sharedSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(sharedSecret);
        const store = new P2PStore({ kvFilePath: null });
        const session = store.createSession('revoked-runner', '{}', null);
        const runnerCredentialStore = new P2PRunnerCredentialStore();
        const runnerCredential = issueRunnerCredential(runnerCredentialStore, session.id);
        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret: sharedSecret,
            store,
            runnerCredentialStore,
        });

        const runner = createSocket(p2pServer.port, bearerToken, acknowledgedRunnerAuth(session.id, runnerCredential));
        await connectSocket(runner);
        const disconnected = waitForSocketEvent(runner, 'disconnect');

        expect(runnerCredentialStore.revoke(session.id)).toBe(true);
        await disconnected;
        expect(runner.connected).toBe(false);

        const reconnect = createSocket(p2pServer.port, bearerToken, acknowledgedRunnerAuth(session.id, runnerCredential));
        await expectSocketConnectionError(reconnect);
    });
});
