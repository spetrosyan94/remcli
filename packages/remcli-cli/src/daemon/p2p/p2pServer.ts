/**
 * Main P2P server composition
 * Creates a Fastify + Socket.IO server on 0.0.0.0 for LAN access
 * Handles auth, REST routes, and Socket.IO event handlers
 */

import { existsSync } from 'fs';
import { basename, extname, sep } from 'path';
import { randomUUID } from 'node:crypto';
import fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyCompress from '@fastify/compress';
import { Server as SocketIOServer } from 'socket.io';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { P2PStore } from './p2pStore';
import { P2PEventRouter, P2PClientConnection, ConnectionType } from './p2pEventRouter';
import { registerSocketHandlers } from './p2pSocketHandlers';
import { registerP2PRestRoutes } from './p2pRestRoutes';
import { verifyBearerToken } from './p2pAuth';
import { P2PRunnerCredentialStore, SESSION_MESSAGE_ACK_VERSION } from './p2pRunnerCredentials';
import { ConciergeDeps } from '../concierge/types';
import { logger } from '@/ui/logger';

// ─── Types ───────────────────────────────────────────────────────

export interface P2PServerConfig {
    port: number;              // 0 for random
    host: string;              // '0.0.0.0' for LAN
    sharedSecret: Uint8Array;  // 32 bytes from QR code
    store: P2PStore;
    webAppDir?: string;        // Path to web app build (static files)
    conciergeDeps?: ConciergeDeps; // Optional local concierge capabilities
    runnerCredentialStore?: P2PRunnerCredentialStore;
}

export interface P2PServer {
    port: number;
    host: string;
    store: P2PStore;
    router: P2PEventRouter;
    stop: () => Promise<void>;
}

interface MessageAcknowledgement {
    sid: string;
    seq: number;
}

interface AcknowledgedRunnerConnection {
    deliveredMessageSequences: Set<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function readString(value: unknown, key: string): string | undefined {
    if (!isRecord(value) || typeof value[key] !== 'string') {
        return undefined;
    }
    return value[key];
}

function getConnectionType(auth: unknown): ConnectionType {
    const connectionType = readString(auth, 'clientType');
    switch (connectionType) {
        case 'session-scoped':
        case 'machine-scoped':
        case 'user-scoped':
            return connectionType;
        default:
            return 'user-scoped';
    }
}

function getMessageAckVersion(auth: unknown): number | undefined {
    if (
        !isRecord(auth) ||
        typeof auth.messageAckVersion !== 'number' ||
        !Number.isSafeInteger(auth.messageAckVersion)
    ) {
        return undefined;
    }
    return auth.messageAckVersion;
}

function parseMessageAcknowledgement(value: unknown): MessageAcknowledgement | null {
    if (
        !isRecord(value) ||
        typeof value.sid !== 'string' ||
        typeof value.seq !== 'number' ||
        !Number.isSafeInteger(value.seq) ||
        value.seq < 0
    ) {
        return null;
    }
    return { sid: value.sid, seq: value.seq };
}

function getNewMessageSequence(payload: Record<string, unknown>, sessionId: string): number | null {
    if (payload.t !== 'new-message' || payload.sid !== sessionId || !isRecord(payload.message)) {
        return null;
    }

    const sequence = payload.message.seq;
    return typeof sequence === 'number' && Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

const IMMUTABLE_WEB_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const REVALIDATED_WEB_ASSET_CACHE_CONTROL = 'no-cache';

export function getWebStaticCacheControl(filePath: string): string {
    const isViteAsset = filePath.includes(`${sep}assets${sep}`);
    const isViteEntryChunk = isViteAsset && /^index-[A-Za-z0-9_-]+\.js$/.test(basename(filePath));

    // Rollup can retain an entry filename while a lazy route dependency changes.
    // Revalidating the entry lets a recovered client resolve the current route chunk.
    return isViteAsset && !isViteEntryChunk
        ? IMMUTABLE_WEB_ASSET_CACHE_CONTROL
        : REVALIDATED_WEB_ASSET_CACHE_CONTROL;
}

export function isWebStaticAssetRequest(requestUrl: string): boolean {
    const pathname = requestUrl.split('?', 1)[0] ?? '';
    return pathname.startsWith('/assets/') || extname(pathname) !== '';
}

// ─── Server ──────────────────────────────────────────────────────

export async function startP2PServer(config: P2PServerConfig): Promise<P2PServer> {
    const { port, host, sharedSecret, store } = config;
    const runnerCredentialStore = config.runnerCredentialStore ?? new P2PRunnerCredentialStore();

    const router = new P2PEventRouter();

    // Create Fastify instance
    const app = fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    // Gzip/Brotli compression for static assets (8.5MB JS → ~1.5MB compressed)
    await app.register(fastifyCompress, {
        global: true,
        encodings: ['br', 'gzip', 'deflate'],
    });

    // Multipart support for file uploads (voice transcription)
    await app.register(fastifyMultipart, {
        limits: {
            fileSize: 25 * 1024 * 1024, // 25MB max audio file
            files: 1,
        },
    });

    // CORS for mobile app
    app.addHook('onRequest', async (request, reply) => {
        reply.header('Access-Control-Allow-Origin', '*');
        reply.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

        if (request.method === 'OPTIONS') {
            reply.code(204).send();
        }
    });

    // Register REST routes
    registerP2PRestRoutes(app, store, router, sharedSecret, config.conciergeDeps);

    // Serve web app static files if available
    if (config.webAppDir && existsSync(config.webAppDir)) {
        await app.register(fastifyStatic, {
            root: config.webAppDir,
            prefix: '/',
            decorateReply: true,
            // The web build can change its hashed lazy-route chunks while a
            // developer daemon remains running. Resolve files per request so
            // a current index never falls through to the SPA document.
            wildcard: true,
            cacheControl: false,  // Cache-Control set per file below
            setHeaders: (res, filePath) => {
                res.setHeader('Cache-Control', getWebStaticCacheControl(filePath));
            },
        });

        // SPA fallback: any GET that didn't match a file or API route → index.html
        // so deep links (/terminal/connect, /session/:id) work on direct load.
        app.setNotFoundHandler(async (request, reply) => {
            const isApiRoute = request.url.startsWith('/v1/') || request.url.startsWith('/v2/') || request.url.startsWith('/health');
            if (request.method === 'GET' && !isApiRoute && !isWebStaticAssetRequest(request.url)) {
                reply.header('Cache-Control', 'no-cache');
                return reply.sendFile('index.html');
            }
            reply.code(404).send({ error: 'Not found' });
        });

        logger.debug(`[P2P SERVER] Serving web app from ${config.webAppDir}`);
    }

    // Get underlying HTTP server for Socket.IO
    await app.ready();
    const httpServer = app.server;

    // Create Socket.IO server attached to Fastify's HTTP server
    const io = new SocketIOServer(httpServer, {
        path: '/v1/updates',
        cors: {
            origin: '*',
            methods: ['GET', 'POST']
        },
        transports: ['websocket', 'polling'],
        pingTimeout: 45000,
        pingInterval: 15000
    });

    // Socket.IO authentication middleware
    io.use((socket, next) => {
        const auth = socket.handshake.auth as unknown;
        const token = readString(auth, 'token');
        if (!token || !verifyBearerToken(token, sharedSecret)) {
            logger.debug('[P2P SERVER] Socket.IO auth failed');
            next(new Error('Authentication failed'));
            return;
        }

        const connectionType = getConnectionType(auth);
        if (connectionType === 'session-scoped') {
            const sessionId = readString(auth, 'sessionId');
            const runnerCredential = readString(auth, 'runnerCredential');
            const messageAckVersion = getMessageAckVersion(auth);
            const hasActiveRunnerLease = sessionId !== undefined && runnerCredentialStore.hasActiveLease(sessionId);
            const requestsRunnerAcknowledgements = messageAckVersion !== undefined || runnerCredential !== undefined;
            if (
                !sessionId ||
                (hasActiveRunnerLease || requestsRunnerAcknowledgements) && (
                    messageAckVersion !== SESSION_MESSAGE_ACK_VERSION ||
                    !runnerCredentialStore.verify(sessionId, runnerCredential)
                )
            ) {
                logger.debug('[P2P SERVER] Session runner authentication failed');
                next(new Error('Session runner authentication failed'));
                return;
            }
        }

        next();
    });

    // Cursor and credentials are daemon-local by design: messages and sessions are
    // in-memory too, so a daemon restart starts a fresh P2P delivery epoch.
    const acknowledgedMessageSequences = new Map<string, number>();
    const legacyDeliveredMessageSequences = new Map<string, Set<number>>();
    const legacySessionConnections = new Map<string, Set<P2PClientConnection>>();
    const activeAcknowledgedRunnerConnections = new Map<string, P2PClientConnection>();
    const disconnectConnection = (connection: P2PClientConnection): void => {
        router.removeConnection(connection);
        connection.socket.disconnect(true);
    };
    const clearAcknowledgedRunnerState = (sessionId: string, disconnectRunner: boolean): void => {
        acknowledgedMessageSequences.delete(sessionId);
        const runnerConnection = activeAcknowledgedRunnerConnections.get(sessionId);
        activeAcknowledgedRunnerConnections.delete(sessionId);
        if (disconnectRunner && runnerConnection) {
            disconnectConnection(runnerConnection);
        }
    };
    const unsubscribeRunnerLeaseActivation = runnerCredentialStore.onLeaseActivated((sessionId) => {
        const legacyConnections = legacySessionConnections.get(sessionId);
        legacySessionConnections.delete(sessionId);
        for (const connection of legacyConnections ?? []) {
            disconnectConnection(connection);
        }
    });
    const unsubscribeRunnerCredentialRevocation = runnerCredentialStore.onRevoked((sessionId) => {
        clearAcknowledgedRunnerState(sessionId, true);
    });
    store.onSessionDeleted((sessionId) => {
        clearAcknowledgedRunnerState(sessionId, true);
        legacyDeliveredMessageSequences.delete(sessionId);
        runnerCredentialStore.revoke(sessionId);
    });

    // Socket.IO connection handler
    io.on('connection', (socket) => {
        const auth = socket.handshake.auth as unknown;
        const sessionId = readString(auth, 'sessionId');
        const machineId = readString(auth, 'machineId');
        const connectionType = getConnectionType(auth);
        const runnerCredential = readString(auth, 'runnerCredential');
        const isAcknowledgedRunner = (
            connectionType === 'session-scoped' &&
            sessionId !== undefined &&
            getMessageAckVersion(auth) === SESSION_MESSAGE_ACK_VERSION &&
            runnerCredentialStore.verify(sessionId, runnerCredential)
        );
        const runnerConnection: AcknowledgedRunnerConnection | null = isAcknowledgedRunner
            ? { deliveredMessageSequences: new Set<number>() }
            : null;

        if (
            connectionType === 'session-scoped'
            && sessionId
            && !isAcknowledgedRunner
            && runnerCredentialStore.hasActiveLease(sessionId)
        ) {
            logger.debug('[P2P SERVER] Rejected legacy session connection after runner lease activation');
            socket.disconnect(true);
            return;
        }

        logger.debug(`[P2P SERVER] New connection: type=${connectionType}, sessionId=${sessionId}, machineId=${machineId}`);

        // The only machine-scoped client is the daemon's own self-connection
        // (bootstrapMachineSocket) — remember its machine id so DELETE /v1/machines/:id
        // can refuse to delete the machine the daemon itself runs on.
        if (connectionType === 'machine-scoped' && machineId) {
            store.markOwnMachine(machineId);
        }

        const connection: P2PClientConnection = {
            socket,
            connectionType,
            sessionId,
            machineId,
            onUpdateDelivered: (payload) => {
                if (!sessionId) {
                    return;
                }

                const messageSequence = getNewMessageSequence(payload.body, sessionId);
                if (messageSequence === null) {
                    return;
                }

                if (runnerConnection) {
                    runnerConnection.deliveredMessageSequences.add(messageSequence);
                    return;
                }

                if (connectionType === 'session-scoped') {
                    const deliveredSequences = legacyDeliveredMessageSequences.get(sessionId) ?? new Set<number>();
                    deliveredSequences.add(messageSequence);
                    legacyDeliveredMessageSequences.set(sessionId, deliveredSequences);
                }
            }
        };

        router.addConnection(connection);
        registerSocketHandlers(socket, connection, store, router);

        if (isAcknowledgedRunner && sessionId && runnerConnection) {
            const previousRunnerConnection = activeAcknowledgedRunnerConnections.get(sessionId);
            activeAcknowledgedRunnerConnections.set(sessionId, connection);
            if (previousRunnerConnection && previousRunnerConnection.socket !== socket) {
                logger.debug(`[P2P SERVER] Replacing active ACK-capable runner for session ${sessionId}`);
                disconnectConnection(previousRunnerConnection);
            }

            socket.on('disconnect', () => {
                if (activeAcknowledgedRunnerConnections.get(sessionId) === connection) {
                    activeAcknowledgedRunnerConnections.delete(sessionId);
                }
            });

            socket.on('message-ack', (data: unknown) => {
                const acknowledgement = parseMessageAcknowledgement(data);
                if (!acknowledgement || acknowledgement.sid !== sessionId) {
                    logger.debug('[P2P SERVER] Ignoring invalid session message acknowledgement');
                    return;
                }

                if (activeAcknowledgedRunnerConnections.get(sessionId) !== connection) {
                    logger.debug('[P2P SERVER] Ignoring acknowledgement from inactive runner socket');
                    return;
                }
                if (!runnerCredentialStore.verify(sessionId, runnerCredential)) {
                    logger.debug('[P2P SERVER] Ignoring acknowledgement after runner credential revocation');
                    socket.disconnect(true);
                    return;
                }

                const acknowledgedSequence = acknowledgedMessageSequences.get(sessionId) || 0;
                if (acknowledgement.seq <= acknowledgedSequence) {
                    return;
                }

                const deliveredRange = store
                    .getSessionDeliveryMessagesAfter(sessionId, acknowledgedSequence)
                    .filter((message) => message.seq <= acknowledgement.seq);
                const lastDeliveredMessage = deliveredRange.at(-1);
                if (
                    lastDeliveredMessage?.seq !== acknowledgement.seq ||
                    !runnerConnection.deliveredMessageSequences.has(acknowledgement.seq) ||
                    !deliveredRange.every((message) => runnerConnection.deliveredMessageSequences.has(message.seq))
                ) {
                    logger.debug(`[P2P SERVER] Ignoring unknown session message acknowledgement for session ${sessionId}`);
                    return;
                }

                acknowledgedMessageSequences.set(sessionId, acknowledgement.seq);
            });

            // A runner may reconnect after a phone message was stored while its
            // socket was unavailable. Replay only messages above the explicit
            // acknowledged high-water mark, in their original order.
            const acknowledgedSequence = acknowledgedMessageSequences.get(sessionId) || 0;
            const messages = store.getSessionDeliveryMessagesAfter(sessionId, acknowledgedSequence);
            if (messages.length > 0) {
                logger.debug(`[P2P SERVER] Replaying ${messages.length} session message(s) for session ${sessionId}`);
                for (const msg of messages) {
                    socket.emit('update', {
                        id: randomUUID(),
                        seq: store.allocateUserSeq(),
                        body: {
                            t: 'new-message',
                            sid: sessionId,
                            message: {
                                id: msg.id,
                                seq: msg.seq,
                                content: msg.content,
                                localId: msg.localId,
                                createdAt: msg.createdAt,
                                updatedAt: msg.updatedAt
                            }
                        },
                        createdAt: Date.now()
                    });
                    runnerConnection.deliveredMessageSequences.add(msg.seq);
                }
            }
            return;
        }

        if (connectionType === 'session-scoped' && sessionId) {
            const sessionConnections = legacySessionConnections.get(sessionId) ?? new Set<P2PClientConnection>();
            sessionConnections.add(connection);
            legacySessionConnections.set(sessionId, sessionConnections);
            socket.on('disconnect', () => {
                sessionConnections.delete(connection);
                if (sessionConnections.size === 0 && legacySessionConnections.get(sessionId) === sessionConnections) {
                    legacySessionConnections.delete(sessionId);
                }
            });

            const acknowledgedSequence = acknowledgedMessageSequences.get(sessionId) || 0;
            const deliveredSequences = legacyDeliveredMessageSequences.get(sessionId) ?? new Set<number>();
            const messages = store
                .getSessionDeliveryMessagesAfter(sessionId, acknowledgedSequence)
                .filter((message) => !deliveredSequences.has(message.seq));

            if (messages.length > 0) {
                logger.debug(`[P2P SERVER] Replaying ${messages.length} legacy session message(s) for session ${sessionId}`);
                for (const msg of messages) {
                    socket.emit('update', {
                        id: randomUUID(),
                        seq: store.allocateUserSeq(),
                        body: {
                            t: 'new-message',
                            sid: sessionId,
                            message: {
                                id: msg.id,
                                seq: msg.seq,
                                content: msg.content,
                                localId: msg.localId,
                                createdAt: msg.createdAt,
                                updatedAt: msg.updatedAt
                            }
                        },
                        createdAt: Date.now()
                    });
                    deliveredSequences.add(msg.seq);
                }
                legacyDeliveredMessageSequences.set(sessionId, deliveredSequences);
            }
        }
    });

    // Start listening
    return new Promise((resolve, reject) => {
        app.listen({ port, host }, (err, address) => {
            if (err) {
                logger.debug('[P2P SERVER] Failed to start:', err);
                reject(err);
                return;
            }

            const actualPort = parseInt(address.split(':').pop()!);
            logger.debug(`[P2P SERVER] Started on ${address}`);

            resolve({
                port: actualPort,
                host,
                store,
                router,
                stop: async () => {
                    logger.debug('[P2P SERVER] Stopping...');
                    unsubscribeRunnerLeaseActivation();
                    unsubscribeRunnerCredentialRevocation();
                    io.close();
                    await app.close();
                    logger.debug('[P2P SERVER] Stopped');
                }
            });
        });
    });
}
