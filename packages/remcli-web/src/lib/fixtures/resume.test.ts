import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    fixtureListAgentSessions,
    fixtureListRecentDirectories,
    fixtureSpawnNewSession,
} from '@/lib/fixtures';
import {
    FIXTURE_CHAT_MESSAGES,
    FIXTURE_CHAT_SESSION_ID,
    FIXTURE_MACHINES,
    FIXTURE_SESSIONS,
} from '@/lib/fixtures/data';
import type { NormalizedMessage } from '@/lib/protocol/messages';
import { useProtocolStore } from '@/lib/protocol/store';

let buildFeed: typeof import('@/pages/ChatPage').buildFeed;

const FIXTURE_DIRECTORY = '/Users/dev/projects/remcli';

function messageTexts(messages: NormalizedMessage[]): string[] {
    return messages.flatMap((message) => {
        if (message.role === 'user') return [message.content.text];
        if (message.role === 'agent') {
            return message.content.flatMap((content) => content.type === 'text' ? [content.text] : []);
        }
        return message.content.type === 'message' ? [message.content.message] : [];
    });
}

function getSpawnedSessionId(result: Awaited<ReturnType<typeof fixtureSpawnNewSession>>): string {
    expect(result.type).toBe('success');
    if (result.type !== 'success') throw new Error('Fixture session was not spawned');
    return result.sessionId;
}

describe('fixture resume history', () => {
    beforeAll(async () => {
        vi.stubGlobal('localStorage', {
            getItem: vi.fn(() => null),
            setItem: vi.fn(),
            removeItem: vi.fn(),
        });
        vi.stubGlobal('window', { location: { search: '' } });

        ({ buildFeed } = await import('@/pages/ChatPage'));
    });

    beforeEach(() => {
        const store = useProtocolStore.getState();
        store.reset();
        store.applyMachines(FIXTURE_MACHINES);
        store.applySessions(FIXTURE_SESSIONS);
        store.applyMessages(FIXTURE_CHAT_SESSION_ID, FIXTURE_CHAT_MESSAGES, { markLoaded: true });
    });

    afterAll(() => {
        useProtocolStore.getState().reset();
        vi.unstubAllGlobals();
    });

    it('copies prior fixture-created history into the resumed ChatPage feed without mutating the source', async () => {
        const sourceSessionId = getSpawnedSessionId(await fixtureSpawnNewSession({
            machineId: 'fx-machine-online',
            directory: FIXTURE_DIRECTORY,
            agent: 'codex',
        }));
        const sourceHistory: NormalizedMessage[] = [
            {
                id: 'source-user',
                localId: 'source-user-local',
                seq: 1,
                createdAt: 10,
                isSidechain: false,
                role: 'user',
                content: { type: 'text', text: 'Проверь контекст предыдущего шага.' },
            },
            {
                id: 'source-agent',
                localId: null,
                seq: 2,
                createdAt: 20,
                isSidechain: false,
                role: 'agent',
                content: [{
                    type: 'text',
                    text: 'Контекст сохранён и готов к продолжению.',
                    uuid: 'source-agent-uuid',
                    parentUUID: null,
                }],
            },
        ];
        const store = useProtocolStore.getState();
        store.applyMessages(sourceSessionId, sourceHistory, { markLoaded: true });
        const sourceBeforeResume = structuredClone(
            useProtocolStore.getState().sessionMessages[sourceSessionId]?.messages
        );
        const nativeSessionId = useProtocolStore.getState().sessions[sourceSessionId]?.metadata?.codexSessionId;

        expect(nativeSessionId).toBeTruthy();
        const resumedSessionId = getSpawnedSessionId(await fixtureSpawnNewSession({
            machineId: 'fx-machine-online',
            directory: FIXTURE_DIRECTORY,
            agent: 'codex',
            resumeSessionId: nativeSessionId,
        }));

        const resumedHistory = useProtocolStore.getState().sessionMessages[resumedSessionId]?.messages ?? [];

        expect(resumedSessionId).toMatch(/^fx-resume-codex-/);
        expect(messageTexts(resumedHistory)).toEqual(messageTexts(sourceHistory));
        expect(resumedHistory.map((message) => message.id)).not.toEqual(sourceHistory.map((message) => message.id));
        expect(resumedHistory[0]?.localId).not.toBe(sourceHistory[0]?.localId);
        expect(useProtocolStore.getState().sessionMessages[sourceSessionId]?.messages).toEqual(sourceBeforeResume);
        expect(buildFeed(resumedHistory, 'codex')).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'user', text: 'Проверь контекст предыдущего шага.' }),
            expect.objectContaining({
                kind: 'agent-group',
                texts: ['Контекст сохранён и готов к продолжению.'],
            }),
        ]));
    });

    it('copies seeded history for both direct-chat and resume-sheet session ids', async () => {
        const sourceSession = useProtocolStore.getState().sessions[FIXTURE_CHAT_SESSION_ID];
        const resumeSessionIds = [
            sourceSession?.metadata?.claudeSessionId,
            `fixture-claude-${FIXTURE_CHAT_SESSION_ID}`,
        ];

        for (const resumeSessionId of resumeSessionIds) {
            expect(resumeSessionId).toBeTruthy();
            if (!resumeSessionId) continue;

            const resumedSessionId = getSpawnedSessionId(await fixtureSpawnNewSession({
                machineId: 'fx-machine-online',
                directory: FIXTURE_DIRECTORY,
                agent: 'claude',
                resumeSessionId,
            }));
            const resumedHistory = useProtocolStore.getState().sessionMessages[resumedSessionId]?.messages ?? [];

            expect(messageTexts(resumedHistory)).toEqual(messageTexts(FIXTURE_CHAT_MESSAGES));
        }
    });

    it('shows deterministic initial context when the fixture resume id is unknown', async () => {
        const resumedSessionId = getSpawnedSessionId(await fixtureSpawnNewSession({
            machineId: 'fx-machine-online',
            directory: FIXTURE_DIRECTORY,
            agent: 'claude',
            resumeSessionId: 'fixture-unknown-session',
        }));
        const resumedHistory = useProtocolStore.getState().sessionMessages[resumedSessionId]?.messages ?? [];

        expect(messageTexts(resumedHistory)).toEqual([
            'Контекст fixture-сессии недоступен. Продолжаю с чистого шага.',
        ]);
        expect(buildFeed(resumedHistory, 'claude')).toEqual(expect.arrayContaining([
            expect.objectContaining({
                kind: 'agent-group',
                texts: ['Контекст fixture-сессии недоступен. Продолжаю с чистого шага.'],
            }),
        ]));
    });

    it('keeps fixture recent directories isolated by machine after a successful spawn', async () => {
        const offlineBefore = await fixtureListRecentDirectories('fx-machine-offline');
        const spawnedDirectory = '/Users/dev/projects/mobile';

        getSpawnedSessionId(await fixtureSpawnNewSession({
            machineId: 'fx-machine-online',
            directory: spawnedDirectory,
            agent: 'codex',
        }));

        await expect(fixtureListRecentDirectories('fx-machine-online')).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ canonicalPath: spawnedDirectory }),
        ]));
        await expect(fixtureListRecentDirectories('fx-machine-offline')).resolves.toEqual(offlineBefore);
    });

    it('serves opaque Cursor resume rows with project context and honors the requested limit', async () => {
        vi.stubGlobal('window', { location: { search: '?resumeFixture=cursor-opaque' } });

        try {
            const sessions = await fixtureListAgentSessions('fx-machine-online', 'cursor', undefined, 2);
            expect(sessions).toHaveLength(2);
            expect(sessions.every((session) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(session.sessionId))).toBe(true);
            expect(sessions.every((session) => session.sessionName === null && session.firstMessage === null)).toBe(true);
            expect(sessions.map((session) => session.projectPath)).toEqual([
                '/Users/dev/projects/remcli',
                '/Users/dev/projects/webapp',
            ]);

            await expect(fixtureListAgentSessions(
                'fx-machine-online',
                'cursor',
                '/Users/dev/projects/api-server',
                2,
            )).resolves.toEqual([
                expect.objectContaining({ projectPath: '/Users/dev/projects/api-server' }),
            ]);
            await expect(fixtureListAgentSessions('fx-machine-online', 'codex')).resolves.toEqual([]);
            await expect(fixtureListAgentSessions('fx-machine-offline', 'cursor')).resolves.toEqual([]);
        } finally {
            vi.stubGlobal('window', { location: { search: '' } });
        }
    });
});
