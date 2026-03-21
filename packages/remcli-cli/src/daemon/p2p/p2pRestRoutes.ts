/**
 * P2P REST API routes
 * Mirrors the server's REST endpoints so the mobile app can fetch initial data
 * Response shapes are identical to the server's routes
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { tmpNameSync } from 'tmp';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { P2PStore } from './p2pStore';
import { P2PEventRouter } from './p2pEventRouter';
import { verifyBearerToken } from './p2pAuth';
import { logger } from '@/ui/logger';
import { transcribe, isAvailable as isWhisperAvailable, ensureModel, getStatus as getWhisperStatus } from '../whisper/whisperService';
import { synthesize as ttsSynthesize, getTtsStatus } from '../tts/ttsService';

// ─── Types ───────────────────────────────────────────────────────

function sessionToResponse(s: ReturnType<P2PStore['getSession']>) {
    if (!s) return null;
    return {
        id: s.id,
        tag: s.tag,
        seq: s.seq,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        active: s.active,
        activeAt: s.activeAt,
        metadata: s.metadata,
        metadataVersion: s.metadataVersion,
        agentState: s.agentState,
        agentStateVersion: s.agentStateVersion,
        dataEncryptionKey: s.dataEncryptionKey,
        lastMessage: null
    };
}

function machineToResponse(m: ReturnType<P2PStore['getMachine']>) {
    if (!m) return null;
    return {
        id: m.id,
        seq: m.seq,
        metadata: m.metadata,
        metadataVersion: m.metadataVersion,
        daemonState: m.daemonState,
        daemonStateVersion: m.daemonStateVersion,
        dataEncryptionKey: m.dataEncryptionKey,
        active: m.active,
        activeAt: m.activeAt,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt
    };
}

// ─── Register Routes ─────────────────────────────────────────────

export function registerP2PRestRoutes(
    app: FastifyInstance,
    store: P2PStore,
    router: P2PEventRouter,
    sharedSecret: Uint8Array
): void {
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // ─── Auth middleware ──────────────────────────────────────────
    app.addHook('onRequest', async (request, reply) => {
        // Skip auth for health check
        if (request.url === '/health') return;

        // Skip auth for non-API routes (static files served by @fastify/static)
        if (!request.url.startsWith('/v1/') && !request.url.startsWith('/v2/')) return;

        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            reply.code(401).send({ error: 'Missing or invalid authorization header' });
            return;
        }

        const token = authHeader.slice(7);
        if (!verifyBearerToken(token, sharedSecret)) {
            reply.code(401).send({ error: 'Invalid token' });
            return;
        }
    });

    // ─── Health Check ────────────────────────────────────────────
    app.get('/health', async () => {
        return { status: 'ok', mode: 'p2p' };
    });

    // ─── GET /v1/account/settings (stub for P2P) ────────────────
    typed.get('/v1/account/settings', async () => {
        return { settings: null, settingsVersion: 0 };
    });

    // ─── GET /v1/account/profile (stub for P2P) ──────────────────
    typed.get('/v1/account/profile', async () => {
        return {
            id: 'p2p-local',
            timestamp: Date.now(),
            firstName: null,
            lastName: null,
            avatar: null,
            github: null
        };
    });

    // ─── POST /v1/account/settings (stub for P2P) ────────────────
    typed.post('/v1/account/settings', async () => {
        return { success: true };
    });

    // ─── GET /v1/artifacts (stub for P2P) ─────────────────────────
    typed.get('/v1/artifacts', async () => {
        return [];
    });

    // ─── GET /v1/artifacts/:artifactId (stub for P2P) ──────────────
    typed.get('/v1/artifacts/:artifactId', {
        schema: {
            params: z.object({
                artifactId: z.string()
            })
        }
    }, async (_request, reply) => {
        reply.code(404);
        return { error: 'Artifact not found' };
    });

    // ─── POST /v1/artifacts (stub for P2P) ──────────────────────────
    typed.post('/v1/artifacts', async (_request, reply) => {
        reply.code(501);
        return { error: 'Artifacts not supported in P2P mode' };
    });

    // ─── POST /v1/artifacts/:artifactId (stub for P2P) ─────────────
    typed.post('/v1/artifacts/:artifactId', {
        schema: {
            params: z.object({
                artifactId: z.string()
            })
        }
    }, async (_request, reply) => {
        reply.code(501);
        return { error: 'Artifacts not supported in P2P mode' };
    });

    // ─── DELETE /v1/artifacts/:artifactId (stub for P2P) ────────────
    typed.delete('/v1/artifacts/:artifactId', {
        schema: {
            params: z.object({
                artifactId: z.string()
            })
        }
    }, async (_request, reply) => {
        reply.code(501);
        return { error: 'Artifacts not supported in P2P mode' };
    });

    // ─── GET /v1/kv (stub for P2P — returns empty list) ────────────
    typed.get('/v1/kv', async () => {
        return { items: [] };
    });

    // ─── GET /v1/kv/:key (stub for P2P) ────────────────────────────
    typed.get('/v1/kv/:key', {
        schema: {
            params: z.object({
                key: z.string()
            })
        }
    }, async (_request, reply) => {
        reply.code(404);
        return { error: 'Key not found' };
    });

    // ─── POST /v1/kv/bulk (stub for P2P) ───────────────────────────
    typed.post('/v1/kv/bulk', async () => {
        return { values: [] };
    });

    // ─── POST /v1/kv (stub for P2P — mutate) ──────────────────────
    typed.post('/v1/kv', async (request) => {
        const body = request.body as { mutations?: Array<{ key: string }> };
        const mutations = body.mutations || [];
        return {
            success: true,
            results: mutations.map((m: { key: string }) => ({
                key: m.key,
                version: 1
            }))
        };
    });

    // ─── POST /v1/voice/token (stub for P2P) ──────────────────────
    typed.post('/v1/voice/token', async (_request, reply) => {
        reply.code(400);
        return { error: 'Voice not supported in P2P mode' };
    });

    // ─── GET /v1/whisper/status ──────────────────────────────────
    app.get('/v1/whisper/status', async () => {
        const status = getWhisperStatus();
        return {
            available: status.available && status.nativeBindings,
            model: status.selectedModel ?? null,
            modelDownloaded: status.modelDownloaded,
        };
    });

    // ─── POST /v1/voice/transcribe (Whisper STT) ────────────────
    app.post('/v1/voice/transcribe', async (request, reply) => {
        if (!isWhisperAvailable()) {
            reply.code(503);
            return { error: 'Whisper native bindings not available' };
        }

        let tempPath: string | null = null;
        try {
            const data = await request.file();
            if (!data) {
                reply.code(400);
                return { error: 'No audio file provided. Send multipart/form-data with field "audio".' };
            }

            // Determine file extension from mimetype
            const ext = mimeToExt(data.mimetype) || 'm4a';
            tempPath = tmpNameSync({ postfix: `.${ext}` });

            // Write uploaded file to temp
            const chunks: Buffer[] = [];
            for await (const chunk of data.file) {
                chunks.push(chunk);
            }
            writeFileSync(tempPath, Buffer.concat(chunks));

            logger.debug(`[WHISPER] Received audio file: ${data.filename}, ${data.mimetype}, ${chunks.reduce((s, c) => s + c.length, 0)} bytes`);

            // Ensure model is downloaded (first-time auto-download)
            await ensureModel();

            // Transcribe
            const result = await transcribe(tempPath);

            logger.debug(`[WHISPER] Transcription result: "${result.text.substring(0, 100)}"`);

            return {
                text: result.text,
                language: result.language,
                duration: result.duration,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Transcription failed';
            logger.debug(`[WHISPER] Transcription error: ${message}`);
            reply.code(500);
            return { error: message };
        } finally {
            if (tempPath && existsSync(tempPath)) {
                try { unlinkSync(tempPath); } catch { /* ignore cleanup errors */ }
            }
        }
    });

    // ─── GET /v1/tts/status ────────────────────────────────────────
    app.get('/v1/tts/status', async () => {
        return getTtsStatus();
    });

    // ─── POST /v1/voice/synthesize (TTS) ───────────────────────────
    typed.post('/v1/voice/synthesize', {
        schema: {
            body: z.object({
                text: z.string().min(1).max(5000),
                voice: z.string().optional(),
                lang: z.string().optional(),
            })
        }
    }, async (request, reply) => {
        const { text, voice, lang } = request.body;

        const status = getTtsStatus();
        if (!status.available) {
            reply.code(503);
            return { error: 'TTS not available. Configure via remcli setup.' };
        }

        try {
            logger.debug(`[TTS] Synthesize request: ${text.substring(0, 100)}...`);
            const audioBuffer = await ttsSynthesize(text, { voice, lang });

            reply.header('Content-Type', 'audio/ogg');
            reply.header('Content-Length', audioBuffer.length);
            return reply.send(audioBuffer);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Synthesis failed';
            logger.debug(`[TTS] Synthesis error: ${message}`);
            reply.code(500);
            return { error: message };
        }
    });

    // ─── GET /v1/sessions ────────────────────────────────────────
    typed.get('/v1/sessions', async () => {
        const sessions = store.getSessions().slice(0, 150);
        return {
            sessions: sessions.map(s => sessionToResponse(s))
        };
    });

    // ─── GET /v2/sessions/active ─────────────────────────────────
    typed.get('/v2/sessions/active', {
        schema: {
            querystring: z.object({
                limit: z.coerce.number().min(1).max(500).default(150)
            })
        }
    }, async (request) => {
        const { limit } = request.query;
        const sessions = store.getActiveSessions(limit);
        return {
            sessions: sessions.map(s => sessionToResponse(s))
        };
    });

    // ─── GET /v2/sessions (cursor-based pagination) ──────────────
    typed.get('/v2/sessions', {
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().min(1).max(200).default(50),
                changedSince: z.coerce.number().optional()
            })
        }
    }, async (request) => {
        const { cursor, limit, changedSince } = request.query;

        let sessions = store.getSessions();

        // Filter by changedSince if provided
        if (changedSince) {
            sessions = sessions.filter(s => s.updatedAt > changedSince);
        }

        // Apply cursor (sessions are sorted by updatedAt desc, cursor is "cursor_v1_{sessionId}")
        if (cursor) {
            const cursorId = cursor.replace('cursor_v1_', '');
            const cursorIndex = sessions.findIndex(s => s.id === cursorId);
            if (cursorIndex >= 0) {
                sessions = sessions.slice(cursorIndex + 1);
            }
        }

        const page = sessions.slice(0, limit);
        const hasNext = sessions.length > limit;
        const lastSession = page[page.length - 1];

        return {
            sessions: page.map(s => sessionToResponse(s)),
            nextCursor: hasNext && lastSession ? `cursor_v1_${lastSession.id}` : null,
            hasNext
        };
    });

    // ─── POST /v1/sessions ───────────────────────────────────────
    typed.post('/v1/sessions', {
        schema: {
            body: z.object({
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullable().optional(),
                dataEncryptionKey: z.string().nullable().optional()
            })
        }
    }, async (request) => {
        const { tag, metadata, agentState, dataEncryptionKey } = request.body;

        // Check if session with tag already exists
        const existing = store.getSessionByTag(tag);
        if (existing) {
            return { session: sessionToResponse(existing) };
        }

        const session = store.createSession(tag, metadata, dataEncryptionKey || null);

        // Set agentState if provided
        if (agentState) {
            store.updateSessionState(session.id, agentState, session.agentStateVersion);
        }

        // Broadcast new session event
        const update = {
            id: require('node:crypto').randomUUID(),
            seq: store.allocateUserSeq(),
            body: {
                t: 'new-session',
                sessionId: session.id,
                seq: session.seq,
                metadata: session.metadata,
                metadataVersion: session.metadataVersion,
                agentState: session.agentState,
                agentStateVersion: session.agentStateVersion,
                dataEncryptionKey: session.dataEncryptionKey,
                active: session.active,
                activeAt: session.activeAt,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt
            },
            createdAt: Date.now()
        };
        router.emitUpdate(update, { type: 'user-scoped-only' });

        return { session: sessionToResponse(session) };
    });

    // ─── GET /v1/sessions/:sessionId/messages ────────────────────
    typed.get('/v1/sessions/:sessionId/messages', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        }
    }, async (request) => {
        const { sessionId } = request.params;
        const messages = store.getMessages(sessionId, 150);
        return {
            messages: messages.map(m => ({
                id: m.id,
                seq: m.seq,
                content: m.content,
                localId: m.localId,
                createdAt: m.createdAt,
                updatedAt: m.updatedAt
            }))
        };
    });

    // ─── DELETE /v1/sessions/:sessionId ──────────────────────────
    typed.delete('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        }
    }, async (request, reply) => {
        const { sessionId } = request.params;
        const deleted = store.deleteSession(sessionId);

        if (!deleted) {
            reply.code(404);
            return { error: 'Session not found or not owned by user' };
        }

        // Broadcast delete event
        const update = {
            id: require('node:crypto').randomUUID(),
            seq: store.allocateUserSeq(),
            body: {
                t: 'delete-session',
                sessionId
            },
            createdAt: Date.now()
        };
        router.emitUpdate(update, { type: 'user-scoped-only' });

        return { success: true };
    });

    // ─── POST /v1/machines ───────────────────────────────────────
    typed.post('/v1/machines', {
        schema: {
            body: z.object({
                id: z.string(),
                metadata: z.string(),
                daemonState: z.string().optional(),
                dataEncryptionKey: z.string().nullable().optional()
            })
        }
    }, async (request) => {
        const { id, metadata, daemonState, dataEncryptionKey } = request.body;

        const machine = store.getOrCreateMachine(id, metadata, daemonState || null, dataEncryptionKey || null);

        // Broadcast new/update machine event
        const update = {
            id: require('node:crypto').randomUUID(),
            seq: store.allocateUserSeq(),
            body: {
                t: 'new-machine',
                machineId: machine.id,
                seq: machine.seq,
                metadata: machine.metadata,
                metadataVersion: machine.metadataVersion,
                daemonState: machine.daemonState,
                daemonStateVersion: machine.daemonStateVersion,
                dataEncryptionKey: machine.dataEncryptionKey,
                active: machine.active,
                activeAt: machine.activeAt,
                createdAt: machine.createdAt,
                updatedAt: machine.updatedAt
            },
            createdAt: Date.now()
        };
        router.emitUpdate(update, { type: 'user-scoped-only' });

        return { machine: machineToResponse(machine) };
    });

    // ─── GET /v1/machines ────────────────────────────────────────
    typed.get('/v1/machines', async () => {
        const machines = store.getMachines();
        return machines.map(m => machineToResponse(m));
    });

    // ─── GET /v1/machines/:id ────────────────────────────────────
    typed.get('/v1/machines/:id', {
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const machine = store.getMachine(request.params.id);
        if (!machine) {
            reply.code(404);
            return { error: 'Machine not found' };
        }
        return { machine: machineToResponse(machine) };
    });

    logger.debug('[P2P REST] All routes registered');
}

// ─── Helpers ────────────────────────────────────────────────────

function mimeToExt(mime: string): string | null {
    const map: Record<string, string> = {
        'audio/wav': 'wav',
        'audio/x-wav': 'wav',
        'audio/wave': 'wav',
        'audio/mp4': 'm4a',
        'audio/x-m4a': 'm4a',
        'audio/aac': 'aac',
        'audio/mpeg': 'mp3',
        'audio/webm': 'webm',
        'audio/ogg': 'ogg',
        'audio/3gpp': '3gp',
    };
    return map[mime] || null;
}
