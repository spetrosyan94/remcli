import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import nacl from 'tweetnacl';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';

import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { deriveBearerToken, generateSharedSecret } from '@/daemon/p2p/p2pAuth';
import {
    calculateRequestProofMac,
    REQUEST_PROOF_TTL_MS,
    REQUEST_PROOF_VERSION,
} from '@/daemon/p2p/p2pRequestProof';
import { PairingRekeyCoordinator } from '@/daemon/p2p/pairingRekey';
import { startP2PServer, type P2PServer } from '@/daemon/p2p/p2pServer';
import { P2PStore } from '@/daemon/p2p/p2pStore';

const SOCKET_TIMEOUT_MS = 5_000;
const TEST_MACHINE_ID = 'web-p2p-rekey-contract-machine';
const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../remcli-web');

interface WebCipher {
    encryptRaw: (data: unknown) => Promise<string>;
    decryptRaw: (encrypted: string) => Promise<unknown | null>;
}

interface WebEncryptionModule {
    createCipher: (masterSecret: Uint8Array, dataKey: Uint8Array | null) => WebCipher;
}

interface WebRequestProofModule {
    attachRequestProof: (
        authSecret: Uint8Array | undefined,
        transport: 'socket',
        operation: 'rpc-call',
        payload: unknown,
    ) => unknown;
}

interface RpcRequest {
    method?: unknown;
    params?: unknown;
}

interface RpcAck {
    ok?: unknown;
    result?: unknown;
    error?: unknown;
}

interface PairingRekeyRequest {
    requestId?: unknown;
    approvalCode?: unknown;
    ticket?: unknown;
}

let p2pServer: P2PServer | null = null;
let viteServer: ViteDevServer | null = null;
const sockets = new Set<ClientSocket>();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withInvalidProof(payload: Record<string, unknown>): Record<string, unknown> {
    const proof = payload.proof;
    if (!isRecord(proof)) {
        throw new Error('Production web proof payload is missing its proof envelope');
    }

    return {
        ...payload,
        proof: {
            ...proof,
            mac: 'invalid-request-proof',
        },
    };
}

function connectSocket(port: number, token: string, auth: Record<string, unknown>): Promise<ClientSocket> {
    const socket = ioClient(`http://127.0.0.1:${port}`, {
        auth: { token, ...auth },
        path: '/v1/updates',
        transports: ['websocket'],
        reconnection: false,
        timeout: SOCKET_TIMEOUT_MS,
    });
    sockets.add(socket);

    return new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => {
            socket.close();
            reject(new Error('Timed out connecting to P2P Socket.IO server'));
        }, SOCKET_TIMEOUT_MS);
        socket.once('connect', () => {
            clearTimeout(timeout);
            resolvePromise(socket);
        });
        socket.once('connect_error', (error: Error) => {
            clearTimeout(timeout);
            socket.close();
            reject(error);
        });
    });
}

function waitForSocketEvent<T>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise((resolvePromise, reject) => {
        const timeout = setTimeout(() => {
            socket.off(event, onEvent);
            reject(new Error(`Timed out waiting for Socket.IO event: ${event}`));
        }, SOCKET_TIMEOUT_MS);
        const onEvent = (value: T): void => {
            clearTimeout(timeout);
            resolvePromise(value);
        };
        socket.once(event, onEvent);
    });
}

function withServerProof(
    authSecret: Uint8Array,
    operation: string,
    payload: Record<string, string>,
): Record<string, unknown> {
    const id = randomUUID();
    const expiresAt = Date.now() + REQUEST_PROOF_TTL_MS;
    const mac = calculateRequestProofMac(authSecret, {
        v: REQUEST_PROOF_VERSION,
        transport: 'socket',
        operation,
        requestId: id,
        expiresAt,
        payload,
    });
    if (!mac) {
        throw new Error('Could not create test request proof');
    }
    return {
        ...payload,
        proof: { v: REQUEST_PROOF_VERSION, id, expiresAt, mac },
    };
}

async function loadWebProtocol(): Promise<{ encryption: WebEncryptionModule; proof: WebRequestProofModule }> {
    viteServer = await createServer({
        root: WEB_ROOT,
        configFile: resolve(WEB_ROOT, 'vite.config.ts'),
        appType: 'custom',
        server: { middlewareMode: true },
        optimizeDeps: { noDiscovery: true },
    });

    const [encryption, proof] = await Promise.all([
        viteServer.ssrLoadModule('/src/lib/protocol/encryption.ts'),
        viteServer.ssrLoadModule('/src/lib/protocol/requestProof.ts'),
    ]);
    return {
        encryption: encryption as WebEncryptionModule,
        proof: proof as WebRequestProofModule,
    };
}

afterEach(async () => {
    for (const socket of sockets) {
        socket.close();
    }
    sockets.clear();
    await p2pServer?.stop();
    p2pServer = null;
    await viteServer?.close();
    viteServer = null;
});

describe('web-to-daemon rekey request-proof contract', { timeout: 20_000 }, () => {
    it('accepts the production web rekey payload and rejects invalid or replayed requests', async () => {
        const authSecret = generateSharedSecret();
        const bearerToken = deriveBearerToken(authSecret);
        const coordinator = new PairingRekeyCoordinator({
            currentSecrets: () => ({ authSecret, contentSecret: authSecret }),
            createQrPayload: async () => ({
                qrUrl: 'https://remcli.local/terminal/connect#test',
                qrDataUrl: 'data:image/png;base64,test',
            }),
            rotateAuthSecret: async () => undefined,
        });
        const requestRekey = vi.spyOn(coordinator, 'requestRekey');
        const { encryption, proof } = await loadWebProtocol();

        p2pServer = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            authSecret,
            store: new P2PStore({ kvFilePath: null }),
        });

        const method = `${TEST_MACHINE_ID}:request-pairing-rekey`;
        const machineSocket = await connectSocket(p2pServer.port, bearerToken, {
            clientType: 'machine-scoped',
            machineId: TEST_MACHINE_ID,
        });
        machineSocket.on('rpc-request', (request: RpcRequest, callback: (response: string) => void) => {
            if (request.method !== method || typeof request.params !== 'string') {
                callback('');
                return;
            }
            const params = decrypt(authSecret, 'legacy', decodeBase64(request.params));
            if (!isRecord(params) || typeof params.clientPublicKey !== 'string') {
                callback('');
                return;
            }
            callback(encodeBase64(encrypt(
                authSecret,
                'legacy',
                coordinator.requestRekey(params.clientPublicKey),
            )));
        });

        const registration = waitForSocketEvent<{ method: string }>(machineSocket, 'rpc-registered');
        machineSocket.emit('rpc-register', withServerProof(authSecret, 'rpc-register', { method }));
        await expect(registration).resolves.toEqual({ method });

        const browserSocket = await connectSocket(p2pServer.port, bearerToken, { clientType: 'user-scoped' });
        const browserCipher = encryption.createCipher(authSecret, null);
        const clientPublicKey = encodeBase64(nacl.box.keyPair().publicKey);
        const params = await browserCipher.encryptRaw({ clientPublicKey });
        const payload = proof.attachRequestProof(authSecret, 'socket', 'rpc-call', { method, params });
        if (!isRecord(payload)) {
            throw new Error('Production web proof payload was not an object');
        }

        const response = await browserSocket
            .timeout(SOCKET_TIMEOUT_MS)
            .emitWithAck('rpc-call', payload) as RpcAck;
        expect(response).toMatchObject({ ok: true });
        expect(typeof response.result).toBe('string');

        const result = await browserCipher.decryptRaw(response.result as string) as PairingRekeyRequest | null;
        expect(result).not.toBeNull();
        expect(typeof result?.requestId).toBe('string');
        expect(typeof result?.approvalCode).toBe('string');
        expect(typeof result?.ticket).toBe('string');
        expect(requestRekey).toHaveBeenCalledOnce();

        const replayResponse = await browserSocket
            .timeout(SOCKET_TIMEOUT_MS)
            .emitWithAck('rpc-call', payload) as RpcAck;
        expect(replayResponse).toMatchObject({ ok: false });
        expect(requestRekey).toHaveBeenCalledOnce();

        const invalidPayload = proof.attachRequestProof(authSecret, 'socket', 'rpc-call', { method, params });
        if (!isRecord(invalidPayload)) {
            throw new Error('Production web proof payload was not an object');
        }

        const invalidResponse = await browserSocket
            .timeout(SOCKET_TIMEOUT_MS)
            .emitWithAck('rpc-call', withInvalidProof(invalidPayload)) as RpcAck;
        expect(invalidResponse).toMatchObject({ ok: false });
        expect(requestRekey).toHaveBeenCalledOnce();
    });
});
