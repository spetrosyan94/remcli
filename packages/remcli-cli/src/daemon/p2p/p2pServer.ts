/**
 * Main P2P server composition
 * Creates a Fastify + Socket.IO server on 0.0.0.0 for LAN access
 * Handles auth, REST routes, and Socket.IO event handlers
 */

import { existsSync } from 'fs';
import fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Server as SocketIOServer } from 'socket.io';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { P2PStore } from './p2pStore';
import { P2PEventRouter, P2PClientConnection, ConnectionType } from './p2pEventRouter';
import { registerSocketHandlers } from './p2pSocketHandlers';
import { registerP2PRestRoutes } from './p2pRestRoutes';
import { verifyBearerToken } from './p2pAuth';
import { logger } from '@/ui/logger';
import { TrackedSession } from '../types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';
import { Metadata } from '@/api/types';

// ─── Types ───────────────────────────────────────────────────────

export interface P2PServerConfig {
    port: number;              // 0 for random
    host: string;              // '0.0.0.0' for LAN
    sharedSecret: Uint8Array;  // 32 bytes from QR code
    store: P2PStore;
    getChildren: () => TrackedSession[];
    stopSession: (sessionId: string) => boolean;
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    requestShutdown: () => void;
    onRemcliSessionWebhook: (sessionId: string, metadata: Metadata) => void;
    webAppDir?: string;        // Path to web app build (static files)
}

export interface P2PServer {
    port: number;
    host: string;
    store: P2PStore;
    router: P2PEventRouter;
    stop: () => Promise<void>;
    getConnectionCount: () => number;
}

// ─── Server ──────────────────────────────────────────────────────

export async function startP2PServer(config: P2PServerConfig): Promise<P2PServer> {
    const { port, host, sharedSecret, store } = config;

    const router = new P2PEventRouter();

    // Create Fastify instance
    const app = fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

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
    registerP2PRestRoutes(app, store, router, sharedSecret);

    // Serve web app static files if available
    if (config.webAppDir && existsSync(config.webAppDir)) {
        await app.register(fastifyStatic, {
            root: config.webAppDir,
            prefix: '/',
            decorateReply: true,
            wildcard: false
        });

        // SPA fallback: any GET that didn't match a file or API route → index.html
        app.setNotFoundHandler(async (request, reply) => {
            if (request.method === 'GET' && !request.url.startsWith('/v1/') && !request.url.startsWith('/v2/')) {
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
        const token = socket.handshake.auth?.token;
        if (!token || !verifyBearerToken(token, sharedSecret)) {
            logger.debug('[P2P SERVER] Socket.IO auth failed');
            next(new Error('Authentication failed'));
            return;
        }
        next();
    });

    // Socket.IO connection handler
    io.on('connection', (socket) => {
        const { clientType, sessionId, machineId } = socket.handshake.auth || {};
        const connectionType: ConnectionType = clientType || 'user-scoped';

        logger.debug(`[P2P SERVER] New connection: type=${connectionType}, sessionId=${sessionId}, machineId=${machineId}`);

        const connection: P2PClientConnection = {
            socket,
            connectionType,
            sessionId,
            machineId
        };

        router.addConnection(connection);
        registerSocketHandlers(socket, connection, store, router);
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
                getConnectionCount: () => router.getConnectionCount(),
                stop: async () => {
                    logger.debug('[P2P SERVER] Stopping...');
                    io.close();
                    await app.close();
                    logger.debug('[P2P SERVER] Stopped');
                }
            });
        });
    });
}
