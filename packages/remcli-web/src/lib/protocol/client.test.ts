import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiMessage, ApiSession } from '@/lib/protocol/types';

function installFixtureGlobals() {
    const storage = new Map<string, string>();
    const localStorageMock = {
        getItem: vi.fn((key: string) => storage.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => { storage.set(key, value); }),
        removeItem: vi.fn((key: string) => { storage.delete(key); }),
        clear: vi.fn(() => { storage.clear(); }),
    };
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));

    vi.stubGlobal('localStorage', localStorageMock);
    vi.stubGlobal('window', {
        location: { search: '?fixtures=1' },
        fetch: fetchMock,
    });
}

describe('protocol client message meta', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('does not send a model reset unless a model override is explicit', async () => {
        vi.resetModules();
        installFixtureGlobals();

        const { sendSessionMessage } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');

        await sendSessionMessage('fx-offline', 'Привет', { permissionMode: 'workspace-write' });

        const messages = useProtocolStore.getState().sessionMessages['fx-offline']?.messages ?? [];
        const lastMessage = messages.at(-1);
        expect(lastMessage).toMatchObject({
            role: 'user',
            content: { type: 'text', text: 'Привет' },
            meta: {
                sentFrom: 'web',
                permissionMode: 'workspace-write',
            },
        });
        expect(lastMessage?.meta).not.toHaveProperty('model');
    });

    it('sends explicit null model as a deliberate reset', async () => {
        vi.resetModules();
        installFixtureGlobals();

        const { sendSessionMessage } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');

        await sendSessionMessage('fx-offline', 'Сбрось модель', {
            permissionMode: 'workspace-write',
            model: null,
        });

        const messages = useProtocolStore.getState().sessionMessages['fx-offline']?.messages ?? [];
        const lastMessage = messages.at(-1);
        expect(lastMessage?.meta).toMatchObject({
            sentFrom: 'web',
            permissionMode: 'workspace-write',
            model: null,
        });
    });

    it('routes fixture session spawn through the client wrapper instead of encrypted machine RPC', async () => {
        vi.resetModules();
        installFixtureGlobals();

        const { machineSpawnNewSession, useProtocolStore } = await import('@/lib/protocol');

        const result = await machineSpawnNewSession({
            machineId: 'fx-machine-online',
            directory: '~/projects/remcli',
            agent: 'codex',
        });

        expect(result.type).toBe('success');
        if (result.type !== 'success') return;

        const session = useProtocolStore.getState().sessions[result.sessionId];
        expect(session).toMatchObject({
            id: result.sessionId,
            active: true,
            metadata: {
                path: '/Users/dev/projects/remcli',
                machineId: 'fx-machine-online',
                flavor: 'codex',
                codexSessionId: expect.stringContaining('fixture-codex-'),
            },
        });
    });

    it('routes fixture resumable agent sessions through the client wrapper', async () => {
        vi.resetModules();
        installFixtureGlobals();

        const { machineListAgentSessions } = await import('@/lib/protocol');

        const sessions = await machineListAgentSessions('fx-machine-online', 'codex', undefined, 5);

        expect(sessions).toContainEqual(expect.objectContaining({
            sessionId: 'fixture-codex-fx-running',
            agent: 'codex',
            projectPath: '/Users/dev/projects/webapp',
            sessionName: 'webapp',
        }));
    });
});

describe('protocol client reconnect lifecycle', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    it('forwards every socket reconnect to the mounted chat listener without retaining it after cleanup', async () => {
        let notifySocketReconnect: (() => void) | undefined;
        const onSocketReconnected = vi.fn((listener: () => void) => {
            notifySocketReconnect = listener;
            return vi.fn();
        });

        vi.stubGlobal('localStorage', {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
            clear: vi.fn(),
        });
        vi.stubGlobal('window', {
            location: { search: '' },
            setInterval: vi.fn(() => 1),
            clearInterval: vi.fn(),
        });
        vi.doMock('@/lib/protocol/connection', () => ({
            connectP2P: vi.fn(() => ({ endpoint: 'http://127.0.0.1:12345', token: 'test-token', secret: 'test-secret' })),
            disconnectP2P: vi.fn(),
            restoreCredentials: vi.fn(() => null),
        }));
        vi.doMock('@/lib/protocol/encryption', () => ({
            createEncryption: vi.fn(() => ({
                decryptEncryptionKey: vi.fn(() => null),
                openCipher: vi.fn(() => ({
                    encryptRaw: vi.fn(),
                    decryptRaw: vi.fn(),
                })),
            })),
        }));
        vi.doMock('@/lib/protocol/rest', () => ({
            deleteMachine: vi.fn(),
            fetchMachines: vi.fn(async () => []),
            fetchMessages: vi.fn(),
            fetchSessions: vi.fn(async () => []),
            measureHealthLatency: vi.fn(async () => null),
        }));
        vi.doMock('@/lib/protocol/socket', () => ({
            machineListAgentSessions: vi.fn(),
            machineListDirectory: vi.fn(),
            machineSpawnNewSession: vi.fn(),
            machineStopSession: vi.fn(),
            onSocketMessage: vi.fn(() => vi.fn()),
            onSocketReconnected,
            onSocketStatusChange: vi.fn(() => vi.fn()),
            sendEncryptedMessage: vi.fn(),
            sessionAllow: vi.fn(),
            sessionDeny: vi.fn(),
            socketConnect: vi.fn(),
            socketDisconnect: vi.fn(),
            socketEmitWithAck: vi.fn(),
        }));

        const { onProtocolReconnected, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        const refreshVisibleChat = vi.fn();
        const unsubscribe = onProtocolReconnected(refreshVisibleChat);
        notifySocketReconnect?.();
        notifySocketReconnect?.();

        expect(refreshVisibleChat).toHaveBeenCalledTimes(2);

        unsubscribe();
        notifySocketReconnect?.();
        expect(refreshVisibleChat).toHaveBeenCalledTimes(2);

        stopProtocolClient();
    });

    it('advances the raw message cursor through ignored meta records until history is exhausted', async () => {
        const rawRecords: Record<string, unknown> = {
            'message-visible': {
                role: 'user',
                content: { type: 'text', text: 'Visible terminal prompt' }
            },
            'message-summary-one': {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'summary', summary: 'Hidden summary', isMeta: true }
                }
            },
            'message-summary-two': {
                role: 'agent',
                content: {
                    type: 'output',
                    data: { type: 'summary', summary: 'Older hidden summary', isMeta: true }
                }
            }
        };
        const cipher = {
            encryptRaw: vi.fn(async () => ''),
            decryptRaw: vi.fn(async (value: string) => rawRecords[value] ?? null),
        };
        const session: ApiSession = {
            id: 'session-raw-cursor',
            seq: 1,
            metadata: 'session-metadata',
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: null,
            active: true,
            activeAt: 1000,
            createdAt: 1000,
            updatedAt: 1000,
        };
        const message = (id: string, seq: number): ApiMessage => ({
            id,
            seq,
            content: { t: 'encrypted', c: id },
            createdAt: seq * 1000,
        });
        const fetchMessages = vi.fn()
            .mockResolvedValueOnce({
                messages: [message('message-visible', 3), message('message-summary-one', 2)],
                total: 3,
                hasMore: true,
            })
            .mockResolvedValueOnce({
                messages: [message('message-summary-two', 1)],
                total: 3,
                hasMore: false,
            });

        vi.stubGlobal('localStorage', {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
            clear: vi.fn(),
        });
        vi.stubGlobal('window', {
            location: { search: '' },
            setInterval: vi.fn(() => 1),
            clearInterval: vi.fn(),
        });
        vi.doMock('@/lib/protocol/connection', () => ({
            connectP2P: vi.fn(() => ({ endpoint: 'http://127.0.0.1:12345', token: 'test-token', secret: 'test-secret' })),
            disconnectP2P: vi.fn(),
            restoreCredentials: vi.fn(() => null),
        }));
        vi.doMock('@/lib/protocol/encryption', () => ({
            createEncryption: vi.fn(() => ({
                decryptEncryptionKey: vi.fn(() => null),
                openCipher: vi.fn(() => cipher),
            })),
        }));
        vi.doMock('@/lib/protocol/rest', () => ({
            deleteMachine: vi.fn(),
            fetchMachines: vi.fn(async () => []),
            fetchMessages,
            fetchSessions: vi.fn(async () => [session]),
            measureHealthLatency: vi.fn(async () => null),
        }));
        vi.doMock('@/lib/protocol/socket', () => ({
            machineListAgentSessions: vi.fn(),
            machineListDirectory: vi.fn(),
            machineSpawnNewSession: vi.fn(),
            machineStopSession: vi.fn(),
            onSocketMessage: vi.fn(() => vi.fn()),
            onSocketReconnected: vi.fn(() => vi.fn()),
            onSocketStatusChange: vi.fn(() => vi.fn()),
            sendEncryptedMessage: vi.fn(),
            sessionAllow: vi.fn(),
            sessionDeny: vi.fn(),
            socketConnect: vi.fn(),
            socketDisconnect: vi.fn(),
            socketEmitWithAck: vi.fn(),
        }));

        const { loadSessionMessages, startProtocolClient, stopProtocolClient } = await import('@/lib/protocol/client');
        const { useProtocolStore } = await import('@/lib/protocol/store');
        await startProtocolClient({ mode: 'p2p', host: '127.0.0.1', port: 12345, key: 'test-key', v: 1 });

        const newestPage = await loadSessionMessages('session-raw-cursor');
        const olderPage = await loadSessionMessages('session-raw-cursor', { offset: newestPage.nextOffset });

        expect(newestPage).toMatchObject({ consumed: 2, nextOffset: 2, hasMore: true });
        expect(olderPage).toMatchObject({ consumed: 1, nextOffset: 3, hasMore: false });
        expect(fetchMessages).toHaveBeenLastCalledWith(
            expect.anything(),
            'session-raw-cursor',
            { offset: 2 }
        );
        expect(useProtocolStore.getState().sessionMessages['session-raw-cursor']?.messages)
            .toHaveLength(1);

        stopProtocolClient();
    });
});
