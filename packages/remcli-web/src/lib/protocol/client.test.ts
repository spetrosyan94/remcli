import { afterEach, describe, expect, it, vi } from 'vitest';

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
