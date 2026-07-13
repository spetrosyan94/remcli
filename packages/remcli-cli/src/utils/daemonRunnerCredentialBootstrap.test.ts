import { beforeEach, describe, expect, it, vi } from 'vitest';

interface BootstrapTestState {
    callOrder: string[];
    credentials: Map<string, string>;
    handoffResults: Array<{ error?: string }>;
}

const testState = vi.hoisted(() => {
    const state: BootstrapTestState = {
        callOrder: [],
        credentials: new Map(),
        handoffResults: [],
    };

    return {
        state,
        reset(): void {
            state.callOrder = [];
            state.credentials.clear();
            state.handoffResults = [];
        },
    };
});

vi.mock('@/daemon/controlClient', () => ({
    notifyDaemonSessionStarted: vi.fn(async (sessionId: string) => {
        testState.state.callOrder.push('handoff');
        const result = testState.state.handoffResults.shift() ?? {};
        if (!result.error) {
            testState.state.credentials.set(sessionId, 'runner-credential');
        }
        return result;
    }),
}));

vi.mock('@/daemon/p2p/p2pRunnerCredentials', () => ({
    forgetSessionRunnerCredential: vi.fn((sessionId: string) => {
        testState.state.credentials.delete(sessionId);
    }),
    getSessionRunnerCredential: vi.fn((sessionId: string) => testState.state.credentials.get(sessionId)),
}));

vi.mock('@/utils/time', () => ({
    delay: vi.fn(async () => undefined),
}));

import {
    createDaemonRunnerSessionConsumer,
    reportTerminalSessionStarted,
} from './daemonRunnerCredentialBootstrap';

const metadata = {
    path: '/workspace',
    host: 'test-host',
    homeDir: '/home/test',
    remcliHomeDir: '/home/test/.remcli',
    remcliLibDir: '/workspace/remcli',
    remcliToolsDir: '/workspace/remcli/tools',
};

const daemonRunnerAgents = ['Claude', 'Codex', 'Gemini', 'Cursor'] as const;

describe('daemon runner credential bootstrap', () => {
    beforeEach(() => {
        testState.reset();
    });

    it.each(daemonRunnerAgents)('%s creates its consumer only after the owner-bound handoff', async (agentName) => {
        const session = await createDaemonRunnerSessionConsumer({
            agentName,
            sessionId: `${agentName.toLowerCase()}-session`,
            metadata,
            createSessionConsumer: () => {
                testState.state.callOrder.push('consumer');
                return { id: 'consumer' };
            },
        });

        expect(session).toEqual({ id: 'consumer' });
        expect(testState.state.callOrder).toEqual(['handoff', 'consumer']);
    });

    it.each(daemonRunnerAgents)('%s does not create a legacy consumer after failed handoff retries', async (agentName) => {
        testState.state.handoffResults = [
            { error: 'session-webhook-rejected' },
            { error: 'session-webhook-rejected' },
            { error: 'session-webhook-rejected' },
        ];
        const createSessionConsumer = vi.fn(() => ({ id: 'consumer' }));

        const session = await createDaemonRunnerSessionConsumer({
            agentName,
            sessionId: `${agentName.toLowerCase()}-session`,
            metadata,
            createSessionConsumer,
        });

        expect(session).toBeNull();
        expect(testState.state.callOrder).toEqual(['handoff', 'handoff', 'handoff']);
        expect(createSessionConsumer).not.toHaveBeenCalled();
    });

    it('retries a rejected handoff and creates the consumer only after the daemon credential arrives', async () => {
        testState.state.handoffResults = [
            { error: 'session-webhook-rejected' },
            {},
        ];

        const session = await createDaemonRunnerSessionConsumer({
            agentName: 'Codex',
            sessionId: 'codex-retry-session',
            metadata,
            createSessionConsumer: () => {
                testState.state.callOrder.push('consumer');
                return { id: 'consumer' };
            },
        });

        expect(session).toEqual({ id: 'consumer' });
        expect(testState.state.callOrder).toEqual(['handoff', 'handoff', 'consumer']);
    });

    it('keeps a terminal-started session best-effort', async () => {
        testState.state.handoffResults = [{ error: 'daemon-unavailable' }];

        await reportTerminalSessionStarted({
            agentName: 'Claude',
            sessionId: 'terminal-session',
            metadata,
        });

        expect(testState.state.callOrder).toEqual(['handoff']);
    });
});
