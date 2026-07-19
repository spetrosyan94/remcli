import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';

export interface ControlledCodexAppServerRequest {
    connectionId: number;
    id: number | null;
    method: string;
    params: unknown;
}

export interface ControlledCodexAppServerOptions {
    model: string;
    reasoningEffort: string;
    nativeThreadId: string;
}

export interface ControlledCodexAppServer {
    endpoint: string;
    requests: ControlledCodexAppServerRequest[];
    protocolViolations: string[];
    close: () => Promise<void>;
    getRequests: (method: string) => ControlledCodexAppServerRequest[];
}

interface JsonRpcRequest {
    id?: unknown;
    method?: unknown;
    params?: unknown;
}

interface ControlledTurn {
    id: string;
    clientUserMessageId: string;
    prompt: string;
    status: 'inProgress' | 'completed';
    response: string;
}

const WEB_SOCKET_OPEN = 1;
const FIRST_CONTEXT_PROMPT = 'fixture seed context';
const RESUME_CONTEXT_PROMPT = 'fixture resume context';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value !== '' ? value : null;
}

function createProtocolViolation(message: string, violations: string[]): { error: { code: number; message: string } } {
    violations.push(message);
    return { error: { code: -32602, message } };
}

function isExpectedReadOnlyPolicy(value: unknown): boolean {
    return isRecord(value)
        && value.type === 'readOnly'
        && value.networkAccess === false;
}

function safelySend(socket: WebSocket, payload: unknown): void {
    if (socket.readyState === WEB_SOCKET_OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

function closeServer(server: HttpServer): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
    });
}

/**
 * Narrow deterministic substitute for the documented Codex app-server boundary.
 * It validates the wire contract while the daemon, P2P server, tmux runner and
 * compiled Remcli CLI stay real in the lifecycle integration test.
 */
export async function startControlledCodexAppServer(
    options: ControlledCodexAppServerOptions,
): Promise<ControlledCodexAppServer> {
    const requests: ControlledCodexAppServerRequest[] = [];
    const protocolViolations: string[] = [];
    const turns: ControlledTurn[] = [];
    const httpServer = createServer((request, response) => {
        if (request.url === '/readyz') {
            response.writeHead(200, { 'content-type': 'text/plain' });
            response.end('ok');
            return;
        }
        response.writeHead(404);
        response.end();
    });
    const webSocketServer = new WebSocketServer({ noServer: true });
    let nextConnectionId = 1;
    let nextTurnId = 1;

    httpServer.on('upgrade', (request, socket, head) => {
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
            webSocketServer.emit('connection', webSocket, request);
        });
    });

    webSocketServer.on('connection', (socket) => {
        const connectionId = nextConnectionId;
        nextConnectionId += 1;

        socket.on('message', (data) => {
            let request: JsonRpcRequest;
            try {
                request = JSON.parse(data.toString()) as JsonRpcRequest;
            } catch {
                protocolViolations.push('Codex app-server client sent invalid JSON.');
                return;
            }

            const method = readString(request.method);
            const id = typeof request.id === 'number' ? request.id : null;
            if (!method) {
                protocolViolations.push('Codex app-server client sent a request without a method.');
                return;
            }

            requests.push({ connectionId, id, method, params: request.params });
            if (id === null) {
                if (method !== 'initialized') {
                    protocolViolations.push(`Unexpected Codex app-server notification: ${method}.`);
                }
                return;
            }

            const respond = (result: unknown): void => safelySend(socket, { id, result });
            const reject = (message: string): void => safelySend(
                socket,
                { id, ...createProtocolViolation(message, protocolViolations) },
            );

            switch (method) {
                case 'initialize':
                    respond({});
                    return;
                case 'model/list':
                    respond({
                        data: [{
                            id: options.model,
                            displayName: 'Controlled Codex',
                            defaultReasoningEffort: options.reasoningEffort,
                            supportedReasoningEfforts: [{ reasoningEffort: options.reasoningEffort }],
                            isDefault: true,
                        }],
                    });
                    return;
                case 'configRequirements/read':
                    respond({
                        allowedSandboxModes: ['readOnly'],
                        allowedApprovalPolicies: ['onRequest'],
                    });
                    return;
                case 'thread/start': {
                    const params = isRecord(request.params) ? request.params : null;
                    if (
                        !params
                        || params.model !== options.model
                        || params.sandbox !== 'read-only'
                        || params.approvalPolicy !== 'on-request'
                        || params.ephemeral !== false
                    ) {
                        reject('thread/start did not receive the selected read-only Codex execution.');
                        return;
                    }
                    respond({ thread: { id: options.nativeThreadId } });
                    return;
                }
                case 'thread/resume': {
                    const params = isRecord(request.params) ? request.params : null;
                    if (
                        !params
                        || params.threadId !== options.nativeThreadId
                        || params.model !== options.model
                        || params.sandbox !== 'read-only'
                        || params.approvalPolicy !== 'on-request'
                    ) {
                        reject('thread/resume did not receive the selected read-only Codex execution.');
                        return;
                    }
                    respond({ thread: { id: options.nativeThreadId } });
                    return;
                }
                case 'thread/read': {
                    const params = isRecord(request.params) ? request.params : null;
                    if (!params || params.threadId !== options.nativeThreadId || params.includeTurns !== true) {
                        reject('thread/read did not request the controlled native thread with turns.');
                        return;
                    }
                    respond({
                        thread: {
                            id: options.nativeThreadId,
                            status: { type: 'idle' },
                            turns: turns.map((turn) => ({
                                id: turn.id,
                                status: turn.status,
                                items: [],
                            })),
                        },
                    });
                    return;
                }
                case 'turn/start': {
                    const params = isRecord(request.params) ? request.params : null;
                    const input = params && Array.isArray(params.input) ? params.input[0] : null;
                    const prompt = isRecord(input) ? readString(input.text) : null;
                    const clientUserMessageId = params ? readString(params.clientUserMessageId) : null;
                    if (
                        !params
                        || params.threadId !== options.nativeThreadId
                        || params.model !== options.model
                        || params.effort !== options.reasoningEffort
                        || params.approvalPolicy !== 'on-request'
                        || !isExpectedReadOnlyPolicy(params.sandboxPolicy)
                        || !prompt
                        || !clientUserMessageId
                    ) {
                        reject('turn/start did not receive the selected model, effort, approval policy and read-only sandbox.');
                        return;
                    }

                    const turn: ControlledTurn = {
                        id: `${options.nativeThreadId}-turn-${nextTurnId}`,
                        clientUserMessageId,
                        prompt,
                        status: 'inProgress',
                        response: prompt === RESUME_CONTEXT_PROMPT
                            ? turns.some((candidate) => candidate.prompt === FIRST_CONTEXT_PROMPT)
                                ? 'fixture resume context preserved'
                                : 'fixture resume context missing'
                            : `fixture accepted: ${prompt}`,
                    };
                    nextTurnId += 1;
                    turns.push(turn);
                    respond({ turn: { id: turn.id } });

                    setTimeout(() => {
                        turn.status = 'completed';
                        safelySend(socket, {
                            method: 'item/completed',
                            params: {
                                threadId: options.nativeThreadId,
                                turnId: turn.id,
                                item: {
                                    id: `${turn.id}-agent-message`,
                                    type: 'agentMessage',
                                    text: turn.response,
                                },
                            },
                        });
                        safelySend(socket, {
                            method: 'turn/completed',
                            params: {
                                threadId: options.nativeThreadId,
                                turn: { id: turn.id, status: 'completed' },
                            },
                        });
                    }, 10);
                    return;
                }
                default:
                    reject(`Unsupported controlled Codex app-server method: ${method}.`);
            }
        });
    });

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', () => {
            httpServer.off('error', reject);
            resolve();
        });
    });

    const address = httpServer.address() as AddressInfo | null;
    if (!address) {
        throw new Error('Controlled Codex app-server did not expose a loopback address.');
    }

    return {
        endpoint: `ws://127.0.0.1:${address.port}`,
        requests,
        protocolViolations,
        getRequests: (method) => requests.filter((request) => request.method === method),
        close: async () => {
            for (const client of webSocketServer.clients) {
                client.terminate();
            }
            await new Promise<void>((resolve) => webSocketServer.close(() => resolve()));
            await closeServer(httpServer);
        },
    };
}
