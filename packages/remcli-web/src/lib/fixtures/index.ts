/**
 * Fixture-режим — офлайн-режим для визуальных тестов и ИИ-аудита (PLAN.md, этап 6.6).
 *
 * Включение: открыть приложение с ?fixtures=1 — флаг сохраняется в localStorage
 * (remcli-fixtures=1) и переживает роутинг/перезагрузку; выключение: ?fixtures=0.
 * Гвард — одна точка входа: client.ts вызывает initFixturesIfEnabled() при
 * инициализации модуля, до первого рендера React.
 *
 * В этом режиме приложение НЕ подключается к демону:
 * - стор наполняется детерминированными данными (./data.ts, фиксированные времена);
 * - fetch к FIXTURE_ENDPOINT перехватывается и отвечает локально (zen-задачи в KV,
 *   статусы TTS/Whisper/concierge, concierge chat, /health);
 * - spawn/resume agent session создаёт локальную session в store, без machine RPC;
 * - кнопки работают без сети: allow/deny убирают permission-карточку локально
 *   (fixtureAnswerPermission), отправка сообщения — локальное эхо (client.ts).
 */

import {
    FIXTURE_BASE_TIME,
    FIXTURE_CHAT_MESSAGES,
    FIXTURE_CHAT_SESSION_ID,
    FIXTURE_CONCIERGE_CHAT_RESPONSE,
    FIXTURE_CONCIERGE_FEED,
    FIXTURE_CONCIERGE_STATUS,
    FIXTURE_LINEAGE_CHILD_MESSAGES,
    FIXTURE_LINEAGE_CHILD_SESSION_ID,
    FIXTURE_LINEAGE_FOREIGN_PARENT_MESSAGES,
    FIXTURE_LINEAGE_FOREIGN_PARENT_SESSIONS,
    FIXTURE_LINEAGE_PARENT_MESSAGES,
    FIXTURE_LINEAGE_PARENT_SESSION_ID,
    FIXTURE_LINEAGE_SESSIONS,
    FIXTURE_MACHINES,
    FIXTURE_SESSIONS,
    FIXTURE_ZEN_TASKS,
    type FixtureConciergeFeedEntry
} from '@/lib/fixtures/data';
import type { NormalizedMessage } from '@/lib/protocol/messages';
import type {
    CodexCapabilitiesSnapshot,
    CursorCapabilitiesSnapshot,
    DirectoryListing,
    RecentDirectory,
    SpawnSessionOptions,
    SpawnSessionResult,
} from '@/lib/protocol/socket';
import { RecentDirectoriesRpcError } from '@/lib/protocol/socket';
import { useProtocolStore } from '@/lib/protocol/store';
import type { AgentKind, AgentSessionInfo, Session, SessionMetadata } from '@/lib/protocol/types';

export { FIXTURE_CHAT_SESSION_ID };

/** Фиксированная латентность пилюли соединения в fixture-режиме («p2p · 12ms»). */
export const FIXTURE_LATENCY_MS = 12;

const FIXTURE_FLAG_KEY = 'remcli-fixtures';

/** Псевдо-эндпоинт REST: запросы к нему перехватываются installFetchInterceptor. */
const FIXTURE_ENDPOINT = 'http://remcli-fixtures.invalid';

const CURSOR_ACCOUNT_MODEL_LABELS = [
    'Cursor account model · fixture 01',
    'Cursor account model · fixture 02',
    'Cursor account model · fixture 03',
    'Cursor account model · fixture 04',
    'Cursor account model · fixture 05',
    'Cursor account model · fixture 06',
    'Cursor account model · fixture 07',
    'Cursor account model · fixture 08',
] as const;

// ─── Детект флага (?fixtures=1 / localStorage) ───────────────────

function readFixtureFlag(): boolean {
    if (typeof window === 'undefined') return false;
    try {
        const param = new URLSearchParams(window.location.search).get('fixtures');
        if (param === '1') {
            localStorage.setItem(FIXTURE_FLAG_KEY, '1');
            return true;
        }
        if (param === '0') {
            localStorage.removeItem(FIXTURE_FLAG_KEY);
            return false;
        }
        return localStorage.getItem(FIXTURE_FLAG_KEY) === '1';
    } catch {
        return false;
    }
}

// ─── Локальный REST (fetch-перехват) ─────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

// Zen-задачи живут в «KV» перехватчика: add/toggle на ZenPage работают без сети
let zenTasksValue = JSON.stringify(FIXTURE_ZEN_TASKS);
let zenTasksVersion = 1;
let spawnedSessionCounter = 0;
let fixtureResumeRetryAttempts = 0;
let fixtureCodexCapabilityRejectionAttempts = 0;
let fixtureCursorResumeSpawnAttempts = 0;

interface FixtureLineageMetricsState {
    refreshSessionsCalls: number;
    reconnects: number;
    parentHistoryLoads: number;
    sentSessionIds: string[];
}

let fixtureLineageMetricsState: FixtureLineageMetricsState | null = null;

const FIXTURE_RESUME_RESPONSE_DELAY_MS = 1_000;
const FIXTURE_LONG_RESUME_ROW_COUNT = 24;
const FIXTURE_LONG_CHAT_PATH = `/Users/dev/projects/remcli/${'nested-directory/'.repeat(36)}calculate.js:195`;
const FIXTURE_LONG_CHAT_LINK = `https://en.wikipedia.org/wiki/Function_(mathematics)?trace=${'trace-segment-'.repeat(36)}`;
const FIXTURE_CURSOR_RESUME_NATIVE_SESSION_ID = 'fixture-cursor-native-lifecycle';
const FIXTURE_CURSOR_RESUME_SESSION: AgentSessionInfo = {
    sessionId: FIXTURE_CURSOR_RESUME_NATIVE_SESSION_ID,
    agent: 'cursor',
    projectPath: '/Users/dev/projects/remcli',
    lastModified: FIXTURE_BASE_TIME - 30_000,
    firstMessage: 'Проверить Cursor lifecycle и продолжить с тем же контекстом',
    messageCount: 8,
    createdAt: FIXTURE_BASE_TIME - 6 * 60_000,
    sessionName: 'Cursor lifecycle review',
};
const FIXTURE_CURSOR_OPAQUE_RESUME_SESSIONS: AgentSessionInfo[] = [
    {
        sessionId: '019f7dd8-9c4c-7b7c-9a89-abcdef123456',
        agent: 'cursor',
        projectPath: '/Users/dev/projects/remcli',
        lastModified: FIXTURE_BASE_TIME - 45_000,
        firstMessage: null,
        messageCount: 14,
        createdAt: FIXTURE_BASE_TIME - 8 * 60_000,
        sessionName: null,
    },
    {
        sessionId: '019f7dd8-9c4c-7b7c-9a89-abcdef123457',
        agent: 'cursor',
        projectPath: '/Users/dev/projects/webapp',
        lastModified: FIXTURE_BASE_TIME - 3 * 60_000,
        firstMessage: null,
        messageCount: 6,
        createdAt: FIXTURE_BASE_TIME - 12 * 60_000,
        sessionName: null,
    },
    {
        sessionId: '019f7dd8-9c4c-7b7c-9a89-abcdef123458',
        agent: 'cursor',
        projectPath: '/Users/dev/projects/api-server',
        lastModified: FIXTURE_BASE_TIME - 18 * 60_000,
        firstMessage: null,
        messageCount: 21,
        createdAt: FIXTURE_BASE_TIME - 24 * 60_000,
        sessionName: null,
    },
    {
        sessionId: '019f7dd8-9c4c-7b7c-9a89-abcdef123459',
        agent: 'cursor',
        projectPath: '/Users/dev/projects/remcli/packages/remcli-web',
        lastModified: FIXTURE_BASE_TIME - 32 * 60_000,
        firstMessage: null,
        messageCount: 3,
        createdAt: FIXTURE_BASE_TIME - 40 * 60_000,
        sessionName: null,
    },
];
const FIXTURE_ENDED_CURSOR_CHAT_SESSION_ID = 'fixture-cursor-ended-chat';
const FIXTURE_ENDED_CURSOR_CHAT_SESSION: Session = {
    id: FIXTURE_ENDED_CURSOR_CHAT_SESSION_ID,
    seq: 90,
    createdAt: FIXTURE_BASE_TIME - 12 * 60_000,
    updatedAt: FIXTURE_BASE_TIME - 60_000,
    active: false,
    activeAt: FIXTURE_BASE_TIME - 60_000,
    metadata: {
        path: '/Users/dev/projects/remcli',
        host: 'macbook-pro.local',
        homeDir: '/Users/dev',
        remcliHomeDir: '/Users/dev/.remcli',
        machineId: 'fx-machine-online',
        flavor: 'cursor',
        startedBy: 'daemon',
        name: 'Cursor chat resume',
        agentSessionId: 'fixture-cursor-chat-native',
        cursorSessionId: 'fixture-cursor-chat-native',
        summary: {
            text: 'Остановленная Cursor-сессия для Chat Resume',
            updatedAt: FIXTURE_BASE_TIME - 60_000,
        },
    },
    metadataVersion: 1,
    agentState: {
        controlledByUser: false,
        requests: {},
        completedRequests: {},
    },
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: FIXTURE_BASE_TIME - 60_000,
};

function fixtureQueryParameter(name: string): string | null {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get(name);
}

function fixtureSessions(): Session[] {
    return fixtureQueryParameter('chatResume') === 'cursor'
        ? [...FIXTURE_SESSIONS, FIXTURE_ENDED_CURSOR_CHAT_SESSION]
        : [...FIXTURE_SESSIONS];
}

type LineageFixtureScenario = 'recovery' | 'reconnect-callback' | 'stable-parent' | 'unavailable' | 'foreign-parent';

function lineageFixtureScenario(): LineageFixtureScenario | null {
    const value = fixtureQueryParameter('lineageFixture');
    return value === 'recovery'
        || value === 'reconnect-callback'
        || value === 'stable-parent'
        || value === 'unavailable'
        || value === 'foreign-parent'
        ? value
        : null;
}

function getFixtureLineageMetricsState(): FixtureLineageMetricsState | null {
    if (!readFixtureFlag() || !lineageFixtureScenario()) return null;
    if (fixtureLineageMetricsState) return fixtureLineageMetricsState;

    fixtureLineageMetricsState = {
        refreshSessionsCalls: 0,
        reconnects: 0,
        parentHistoryLoads: 0,
        sentSessionIds: []
    };
    return fixtureLineageMetricsState;
}

function waitForFixtureResumeResponse(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, FIXTURE_RESUME_RESPONSE_DELAY_MS));
}

function lineageSessionsForScenario(scenario: LineageFixtureScenario): readonly Session[] {
    return scenario === 'foreign-parent'
        ? FIXTURE_LINEAGE_FOREIGN_PARENT_SESSIONS
        : FIXTURE_LINEAGE_SESSIONS;
}

function fixtureSessionSnapshot(
    scenario: LineageFixtureScenario,
    refreshSessionsCalls: number,
): Session[] {
    const shouldReturnChildOnlySnapshot = scenario === 'recovery'
        || (scenario === 'reconnect-callback' && refreshSessionsCalls < 2);
    const lineageSessions = lineageSessionsForScenario(scenario)
        .filter((session) => !shouldReturnChildOnlySnapshot || session.id === FIXTURE_LINEAGE_CHILD_SESSION_ID);

    return [...fixtureSessions(), ...lineageSessions].map((session) => structuredClone(session));
}

const FIXTURE_UNKNOWN_RESUME_HISTORY: readonly NormalizedMessage[] = [{
    id: 'fixture-unknown-resume-history',
    localId: null,
    seq: 1,
    createdAt: FIXTURE_BASE_TIME,
    isSidechain: false,
    role: 'agent',
    content: [{
        type: 'text',
        text: 'Контекст fixture-сессии недоступен. Продолжаю с чистого шага.',
        uuid: 'fixture-unknown-resume-history',
        parentUUID: null
    }]
}];

const FIXTURE_DIRECTORY_CHILDREN: Record<string, string[]> = {
    '/Users/dev': ['projects', 'Downloads', '.config'],
    '/Users/dev/projects': ['remcli', 'webapp', 'api-server', 'docs', 'mobile'],
    '/Users/dev/projects/remcli': ['packages', 'src', 'design', 'restricted', '.claude'],
    '/Users/dev/projects/remcli/packages': ['remcli-web', 'remcli-cli'],
    '/Users/dev/projects/remcli/packages/remcli-web': ['src', 'public'],
    '/Users/dev/projects/remcli/packages/remcli-web/src': ['components', 'lib', 'pages', 'styles'],
    '/Users/dev/projects/remcli/src': ['daemon', 'protocol'],
    '/Users/dev/projects/remcli/design': ['screens', 'pages', 'assets'],
    '/Users/dev/projects/webapp': ['src', 'tests'],
    '/Users/dev/projects/api-server': ['src', 'migrations'],
    '/Users/dev/projects/docs': ['guides', 'api'],
    '/Users/dev/projects/mobile': ['app', 'assets'],
    '/home/ci': ['releases', 'workspaces'],
    '/home/ci/releases': ['pipeline'],
    '/home/ci/releases/pipeline': ['jobs', 'logs']
};

const FIXTURE_RECENT_DIRECTORIES: readonly RecentDirectory[] = [
    {
        canonicalPath: '/Users/dev/projects/remcli',
        displayPath: '~/projects/remcli',
        lastUsedAt: FIXTURE_BASE_TIME,
    },
    {
        canonicalPath: '/Users/dev/projects/webapp',
        displayPath: '~/projects/webapp',
        lastUsedAt: FIXTURE_BASE_TIME - 1 * 60_000,
    },
    {
        canonicalPath: '/Users/dev/projects/api-server',
        displayPath: '~/projects/api-server',
        lastUsedAt: FIXTURE_BASE_TIME - 2 * 60_000,
    },
    {
        canonicalPath: '/Users/dev/projects/docs',
        displayPath: '~/projects/docs',
        lastUsedAt: FIXTURE_BASE_TIME - 30 * 60_000,
    },
];

function createFixtureRecentDirectoriesByMachine(): Map<string, RecentDirectory[]> {
    return new Map(FIXTURE_MACHINES.map((machine) => [
        machine.id,
        machine.id === 'fx-machine-online'
            ? FIXTURE_RECENT_DIRECTORIES.map((directory) => ({ ...directory }))
            : [],
    ]));
}

let fixtureRecentDirectoriesByMachine = createFixtureRecentDirectoriesByMachine();

function trimTrailingSlash(path: string): string {
    if (path === '/') return path;
    return path.endsWith('/') ? path.replace(/\/+$/, '') : path;
}

function fixtureParentPath(path: string): string | null {
    if (path === '/') return null;
    const index = path.lastIndexOf('/');
    if (index <= 0) return '/';
    return path.slice(0, index);
}

function fixtureDisplayPath(path: string, homePath: string): string {
    if (path === homePath) return '~';
    if (path.startsWith(`${homePath}/`)) return `~${path.slice(homePath.length)}`;
    return path;
}

function normalizeFixtureDirectoryPath(path: string | undefined, homePath: string): string {
    if (!path || path === '~') return homePath;
    if (path.startsWith('~/')) return `${homePath}/${path.slice(2)}`;
    return trimTrailingSlash(path);
}

function isAgentKind(value: string | null | undefined): value is AgentKind {
    return value === 'claude' || value === 'codex' || value === 'cursor' || value === 'gemini';
}

function fixtureSessionAgent(session: Session): AgentKind {
    const flavor = session.metadata?.flavor;
    return isAgentKind(flavor) ? flavor : 'claude';
}

function fixtureSessionName(path: string): string {
    const trimmed = trimTrailingSlash(path);
    if (trimmed === '/') return '/';
    return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed;
}

function fixtureNativeSessionId(agent: AgentKind, sessionId: string): string {
    return `fixture-${agent}-${sessionId}`;
}

function providerSessionMetadata(agent: AgentKind, nativeSessionId: string): Partial<SessionMetadata> {
    if (agent === 'codex') return { codexSessionId: nativeSessionId };
    if (agent === 'cursor') return { cursorSessionId: nativeSessionId };
    if (agent === 'gemini') return { geminiSessionId: nativeSessionId };
    return { claudeSessionId: nativeSessionId };
}

function fixtureSessionResumeIds(session: Session): string[] {
    const metadata = session.metadata;
    if (!metadata) return [];

    const agent = fixtureSessionAgent(session);
    const providerSessionId = agent === 'codex'
        ? metadata.codexSessionId
        : agent === 'cursor'
            ? metadata.cursorSessionId
            : agent === 'gemini'
                ? metadata.geminiSessionId
                : metadata.claudeSessionId;

    return [
        providerSessionId,
        metadata.agentSessionId,
        fixtureNativeSessionId(agent, session.id)
    ].filter((sessionId): sessionId is string => Boolean(sessionId));
}

function fixtureResumeSourceSession(resumeSessionId: string): Session | undefined {
    return Object.values(useProtocolStore.getState().sessions)
        .filter((session) => fixtureSessionResumeIds(session).includes(resumeSessionId))
        .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)[0];
}

function cloneFixtureHistory(messages: readonly NormalizedMessage[], sessionId: string): NormalizedMessage[] {
    return messages.map((message, index) => {
        const copiedMessage = structuredClone(message);
        const messageNumber = index + 1;
        return {
            ...copiedMessage,
            id: `${sessionId}-message-${messageNumber}`,
            localId: copiedMessage.localId ? `${sessionId}-local-${messageNumber}` : null
        };
    });
}

function fixtureChatMessages(): NormalizedMessage[] {
    if (fixtureQueryParameter('chatFixture') !== 'long') return FIXTURE_CHAT_MESSAGES;

    return [
        ...FIXTURE_CHAT_MESSAGES,
        {
            id: 'fixture-long-user-message',
            localId: null,
            seq: 11,
            createdAt: FIXTURE_BASE_TIME - 3 * 60_000,
            isSidechain: false,
            role: 'user',
            content: { type: 'text', text: `Long path: ${FIXTURE_LONG_CHAT_PATH}` },
        },
        {
            id: 'fixture-long-agent-message',
            localId: null,
            seq: 12,
            createdAt: FIXTURE_BASE_TIME - 2 * 60_000,
            isSidechain: false,
            role: 'agent',
            content: [{
                type: 'text',
                text: [
                    `Follow [CommonMark destination](${FIXTURE_LONG_CHAT_LINK}).`,
                    '',
                    `Inline code: \`${FIXTURE_LONG_CHAT_PATH}\`.`,
                    '',
                    '```ts',
                    `const fixturePath = "${FIXTURE_LONG_CHAT_PATH}";`,
                    '```',
                ].join('\n'),
                uuid: 'fixture-long-agent-message',
                parentUUID: null,
            }],
        },
    ];
}

async function handleFixtureRequest(path: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (path === '/health') {
        return jsonResponse({ status: 'ok', mode: 'fixtures' });
    }
    if (path.startsWith('/v1/kv/') && method === 'GET') {
        const key = decodeURIComponent(path.slice('/v1/kv/'.length));
        if (key === 'zen-tasks') {
            return jsonResponse({ key, value: zenTasksValue, version: zenTasksVersion });
        }
        return jsonResponse({ error: 'Key not found' }, 404);
    }
    if (path === '/v1/kv' && method === 'POST') {
        const raw = typeof init?.body === 'string' ? init.body : '{}';
        let mutations: Array<{ key: string; value: string | null }> = [];
        try {
            mutations = (JSON.parse(raw) as { mutations?: Array<{ key: string; value: string | null }> }).mutations ?? [];
        } catch {
            // некорректное тело — отвечаем пустым success ниже
        }
        const results = mutations.map((mutation) => {
            if (mutation.key === 'zen-tasks' && mutation.value !== null) {
                zenTasksValue = mutation.value;
                zenTasksVersion += 1;
            }
            return { key: mutation.key, version: zenTasksVersion };
        });
        return jsonResponse({ success: true, results });
    }
    if (path === '/v1/tts/status') {
        return jsonResponse({ available: true, provider: 'edge', voices: ['fixture-voice'] });
    }
    if (path === '/v1/whisper/status') {
        return jsonResponse({ available: true, model: 'base', modelDownloaded: true });
    }
    if (path === '/v1/concierge/status') {
        return jsonResponse(FIXTURE_CONCIERGE_STATUS);
    }
    if (path === '/v1/concierge/chat') {
        if (method !== 'POST') {
            return jsonResponse({ error: 'Method not allowed' }, 405);
        }
        return jsonResponse(FIXTURE_CONCIERGE_CHAT_RESPONSE);
    }
    return jsonResponse({ error: `No fixture for ${method} ${path}` }, 404);
}

function installFetchInterceptor(): void {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(FIXTURE_ENDPOINT)) {
            return handleFixtureRequest(url.slice(FIXTURE_ENDPOINT.length), init);
        }
        return originalFetch(input, init);
    };
}

// ─── Публичное API (используется только client.ts) ───────────────

/**
 * Точка входа fixture-режима: при включённом флаге наполняет стор
 * детерминированными данными и перехватывает fetch. Возвращает true,
 * если режим активен — client.ts гвардит по этому значению все сетевые входы.
 */
export function initFixturesIfEnabled(): boolean {
    if (!readFixtureFlag()) return false;
    installFetchInterceptor();
    fixtureResumeRetryAttempts = 0;
    fixtureCodexCapabilityRejectionAttempts = 0;
    fixtureCursorResumeSpawnAttempts = 0;
    fixtureRecentDirectoriesByMachine = createFixtureRecentDirectoriesByMachine();
    getFixtureLineageMetricsState();
    const store = useProtocolStore.getState();
    store.applyMachines(FIXTURE_MACHINES);
    store.applySessions(fixtureSessions());
    store.applyMessages(FIXTURE_CHAT_SESSION_ID, fixtureChatMessages(), { markLoaded: true });
    if (fixtureQueryParameter('chatResume') === 'cursor') {
        store.applyMessages(FIXTURE_ENDED_CURSOR_CHAT_SESSION_ID, [], { markLoaded: true });
    }
    const lineageScenario = lineageFixtureScenario();
    if (lineageScenario === 'recovery') {
        // Start with a stale but trusted parent snapshot. The mounted ChatPage
        // refresh must replace it with the child-only snapshot before recovery
        // can reveal the parent again.
        store.applySessions(FIXTURE_LINEAGE_SESSIONS.slice());
        store.applyMessages(FIXTURE_LINEAGE_PARENT_SESSION_ID, FIXTURE_LINEAGE_PARENT_MESSAGES, { markLoaded: true });
        store.applyMessages(FIXTURE_LINEAGE_CHILD_SESSION_ID, FIXTURE_LINEAGE_CHILD_MESSAGES, { markLoaded: true });
    } else if (lineageScenario === 'reconnect-callback') {
        store.applySessions(FIXTURE_LINEAGE_SESSIONS.filter((session) => session.id === FIXTURE_LINEAGE_CHILD_SESSION_ID));
        store.applyMessages(FIXTURE_LINEAGE_CHILD_SESSION_ID, FIXTURE_LINEAGE_CHILD_MESSAGES, { markLoaded: true });
    } else if (lineageScenario === 'stable-parent' || lineageScenario === 'unavailable') {
        store.applySessions(lineageSessionsForScenario(lineageScenario).slice());
        store.applyMessages(FIXTURE_LINEAGE_CHILD_SESSION_ID, FIXTURE_LINEAGE_CHILD_MESSAGES, { markLoaded: true });
    } else if (lineageScenario === 'foreign-parent') {
        store.applySessions(lineageSessionsForScenario(lineageScenario).slice());
        store.applyMessages(FIXTURE_LINEAGE_CHILD_SESSION_ID, FIXTURE_LINEAGE_CHILD_MESSAGES, { markLoaded: true });
        store.applyMessages(FIXTURE_LINEAGE_PARENT_SESSION_ID, FIXTURE_LINEAGE_FOREIGN_PARENT_MESSAGES);
    }
    store.setConnectionStatus('connected');
    store.setAuthenticated(true);
    store.setLatency(FIXTURE_LATENCY_MS);
    return true;
}

export interface FixtureLineageMetrics {
    refreshSessionsCalls: number;
    reconnects: number;
    parentHistoryLoads: number;
    sentSessionIds: string[];
}

export function fixtureLineageMetrics(): FixtureLineageMetrics {
    const state = getFixtureLineageMetricsState();
    return {
        refreshSessionsCalls: state?.refreshSessionsCalls ?? 0,
        reconnects: state?.reconnects ?? 0,
        parentHistoryLoads: state?.parentHistoryLoads ?? 0,
        sentSessionIds: state ? [...state.sentSessionIds] : [],
    };
}

/** Record a fixture-mode session-list refresh for browser assertions. */
export function fixtureRefreshSessions(): void {
    const scenario = lineageFixtureScenario();
    const state = getFixtureLineageMetricsState();
    if (!scenario || !state) return;
    state.refreshSessionsCalls += 1;
    useProtocolStore.getState().replaceSessions(fixtureSessionSnapshot(scenario, state.refreshSessionsCalls));
}

/** Reveal the trusted parent in the recovery fixture without marking its history loaded. */
export function fixtureRevealLineageParent(): void {
    const state = getFixtureLineageMetricsState();
    if (lineageFixtureScenario() !== 'recovery' || !state) return;
    const store = useProtocolStore.getState();
    const parentSession = FIXTURE_LINEAGE_SESSIONS.find((session) => session.id === FIXTURE_LINEAGE_PARENT_SESSION_ID);
    if (!parentSession) return;
    store.applySessions([parentSession]);
    store.applyMessages(FIXTURE_LINEAGE_PARENT_SESSION_ID, FIXTURE_LINEAGE_PARENT_MESSAGES);
}

/** Record a fixture-mode reconnect event before notifying ChatPage listeners. */
export function fixtureRecordProtocolReconnect(): void {
    const state = getFixtureLineageMetricsState();
    if (state) state.reconnects += 1;
}

export function fixtureRecordSentSession(sessionId: string): void {
    const state = getFixtureLineageMetricsState();
    if (state) state.sentSessionIds.push(sessionId);
}

/** REST-конфиг fixture-режима: все запросы уйдут в fetch-перехватчик. */
export function fixtureRestConfig(): { endpoint: string; token: string } {
    return { endpoint: FIXTURE_ENDPOINT, token: 'fixtures' };
}

/** Deterministic capability contract for visual/browser fixtures only. */
export async function fixtureGetCodexCapabilities(): Promise<CodexCapabilitiesSnapshot> {
    const scenario = typeof window === 'undefined'
        ? null
        : new URLSearchParams(window.location.search).get('codexCapabilities');
    if (scenario === 'capability-rejection' && fixtureCodexCapabilityRejectionAttempts > 0) {
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (scenario === 'unavailable') {
        return {
            agent: 'codex',
            status: 'unavailable',
            fetchedAt: null,
            expiresAt: null,
            catalogVersion: null,
            models: [],
            permissionModes: [],
            errorCode: 'unavailable',
        };
    }
    if (scenario === 'choose-required') {
        return {
            agent: 'codex',
            status: 'ready',
            fetchedAt: FIXTURE_BASE_TIME,
            expiresAt: FIXTURE_BASE_TIME + (5 * 60 * 1_000),
            catalogVersion: 'fixture-codex-choose-required-v1',
            models: [{
                id: 'gpt-5.6-choose-required',
                displayName: 'GPT-5.6 Choose Required',
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
                isDefault: true,
            }],
            permissionModes: ['read-only', 'workspace-write', 'danger-full-access'],
        };
    }
    if (scenario === 'no-reasoning') {
        return {
            agent: 'codex',
            status: 'ready',
            fetchedAt: FIXTURE_BASE_TIME,
            expiresAt: FIXTURE_BASE_TIME + (5 * 60 * 1_000),
            catalogVersion: 'fixture-codex-no-reasoning-v1',
            models: [{
                id: 'gpt-5.6-no-reasoning',
                displayName: 'GPT-5.6 No Reasoning',
                supportedReasoningEfforts: [],
                isDefault: true,
            }],
            permissionModes: ['read-only', 'workspace-write', 'danger-full-access'],
        };
    }
    if (scenario === 'capability-rejection' && fixtureCodexCapabilityRejectionAttempts > 0) {
        return {
            agent: 'codex',
            status: 'ready',
            fetchedAt: FIXTURE_BASE_TIME + 1_000,
            expiresAt: FIXTURE_BASE_TIME + (5 * 60 * 1_000),
            catalogVersion: 'fixture-codex-refreshed-v2',
            models: [{
                id: 'gpt-5.6-refreshed',
                displayName: 'GPT-5.6-Refreshed',
                defaultReasoningEffort: 'high',
                supportedReasoningEfforts: ['low', 'high', 'ultra'],
                isDefault: true,
            }],
            permissionModes: ['read-only', 'workspace-write', 'danger-full-access'],
        };
    }
    if (scenario === 'capability-rejection') {
        return {
            agent: 'codex',
            status: 'ready',
            fetchedAt: FIXTURE_BASE_TIME,
            expiresAt: FIXTURE_BASE_TIME + (5 * 60 * 1_000),
            catalogVersion: 'fixture-codex-stale-v1',
            models: [{
                id: 'gpt-5.6-stale',
                displayName: 'GPT-5.6-Stale',
                defaultReasoningEffort: 'xhigh',
                supportedReasoningEfforts: ['low', 'xhigh'],
                isDefault: true,
            }],
            permissionModes: ['read-only', 'workspace-write', 'danger-full-access'],
        };
    }
    return {
        agent: 'codex',
        status: 'ready',
        fetchedAt: FIXTURE_BASE_TIME,
        expiresAt: FIXTURE_BASE_TIME + (5 * 60 * 1_000),
        catalogVersion: 'fixture-codex-v1',
        models: [
            {
                id: 'gpt-5.6-luna',
                displayName: 'GPT-5.6-Luna',
                defaultReasoningEffort: 'xhigh',
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
                isDefault: true,
            },
            {
                id: 'gpt-5.6-terra',
                displayName: 'GPT-5.6-Terra',
                defaultReasoningEffort: 'high',
                supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
                isDefault: false,
            },
        ],
        permissionModes: ['read-only', 'workspace-write', 'danger-full-access'],
    };
}

/** Deterministic Cursor catalog for visual/browser fixtures only. */
export async function fixtureGetCursorCapabilities(): Promise<CursorCapabilitiesSnapshot> {
    const scenario = typeof window === 'undefined'
        ? null
        : new URLSearchParams(window.location.search).get('cursorCapabilities');
    if (scenario === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (scenario === 'unavailable') {
        return {
            agent: 'cursor',
            status: 'unavailable',
            fetchedAt: null,
            expiresAt: null,
            catalogVersion: null,
            models: [],
            errorCode: 'unavailable',
        };
    }
    if (scenario === 'full') {
        return {
            agent: 'cursor',
            status: 'ready',
            fetchedAt: FIXTURE_BASE_TIME,
            expiresAt: FIXTURE_BASE_TIME + (5 * 60 * 1_000),
            catalogVersion: 'fixture-cursor-account-models-v1',
            models: CURSOR_ACCOUNT_MODEL_LABELS.map((displayName, index) => ({
                id: `cursor-account-model-${index + 1}`,
                displayName,
                isDefault: index === 0,
            })),
        };
    }
    return {
        agent: 'cursor',
        status: 'ready',
        fetchedAt: FIXTURE_BASE_TIME,
        expiresAt: FIXTURE_BASE_TIME + (5 * 60 * 1_000),
        catalogVersion: 'fixture-cursor-models-v1',
        models: [
            { id: 'auto', displayName: 'Auto', isDefault: true },
            {
                id: 'gpt-5.6-luna-xhigh',
                displayName: 'GPT-5.6 Luna 1M Extra High',
                isDefault: false,
            },
        ],
    };
}

export function isFixtureRestEndpoint(endpoint: string): boolean {
    return endpoint === FIXTURE_ENDPOINT;
}

export function fixtureConciergeFeed(): FixtureConciergeFeedEntry[] {
    return FIXTURE_CONCIERGE_FEED.map((entry) => ({
        ...entry,
        actions: entry.actions?.map((action) => ({ ...action }))
    }));
}

/** Fixture history loader exposes the recovered parent only after its central session snapshot arrives. */
export function fixtureLoadSessionMessages(sessionId: string): { total: number; hasMore: boolean } {
    const scenario = lineageFixtureScenario();
    const state = getFixtureLineageMetricsState();
    if (sessionId === FIXTURE_LINEAGE_PARENT_SESSION_ID && scenario && state) {
        state.parentHistoryLoads += 1;
        if (scenario === 'unavailable') {
            throw new Error('Fixture parent history unavailable');
        }
    }
    const store = useProtocolStore.getState();
    const messages = sessionId === FIXTURE_LINEAGE_PARENT_SESSION_ID
        && (scenario === 'reconnect-callback' || scenario === 'stable-parent')
        ? FIXTURE_LINEAGE_PARENT_MESSAGES
        : [];
    store.applyMessages(sessionId, messages, { markLoaded: true });
    return {
        total: store.sessionMessages[sessionId]?.messages.length ?? 0,
        hasMore: false
    };
}

/** Локальный directory browser для `/new?fixtures=1`: contract совпадает с daemon `list-directory`. */
export function fixtureListDirectory(machineId: string, path?: string): DirectoryListing {
    const machine = FIXTURE_MACHINES.find((item) => item.id === machineId);
    if (!machine?.metadata) {
        throw new Error(`Fixture machine not found: ${machineId}`);
    }

    const homePath = machine.metadata.homeDir;
    const currentPath = normalizeFixtureDirectoryPath(path, homePath);
    if (currentPath.endsWith('/restricted')) {
        throw new Error(`Unable to list directory "${currentPath}": permission denied.`);
    }

    const parentPath = fixtureParentPath(currentPath);
    const childNames = FIXTURE_DIRECTORY_CHILDREN[currentPath] ?? [];

    return {
        path: currentPath,
        displayPath: fixtureDisplayPath(currentPath, homePath),
        style: 'posix',
        separator: '/',
        home: {
            path: homePath,
            displayPath: '~'
        },
        parent: parentPath,
        parentDisplayPath: parentPath ? fixtureDisplayPath(parentPath, homePath) : null,
        entries: childNames.map((name) => {
            const entryPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
            return {
                name,
                path: entryPath,
                displayPath: fixtureDisplayPath(entryPath, homePath),
                type: 'directory',
                hidden: name.startsWith('.')
            };
        })
    };
}

/** Локальный machine-scoped MRU для `/new?fixtures=1`: shape совпадает с daemon RPC. */
export async function fixtureListRecentDirectories(machineId: string): Promise<RecentDirectory[]> {
    const machine = FIXTURE_MACHINES.find((item) => item.id === machineId);
    if (!machine?.metadata) {
        throw new RecentDirectoriesRpcError('unavailable', 'Recent directories are unavailable.');
    }

    const scenario = fixtureQueryParameter('recentDirectories');
    if (scenario === 'slow') {
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (scenario === 'error') {
        throw new RecentDirectoriesRpcError('unavailable', 'Recent directories are unavailable.');
    }
    if (scenario === 'empty') return [];

    return (fixtureRecentDirectoriesByMachine.get(machineId) ?? []).map((directory) => ({ ...directory }));
}

function fixtureLongResumeSessions(agent?: string): AgentSessionInfo[] {
    const sessionAgent = isAgentKind(agent) ? agent : 'codex';
    const longContext = 'long-session-context-'.repeat(18);

    return Array.from({ length: FIXTURE_LONG_RESUME_ROW_COUNT }, (_, index) => ({
        sessionId: `fixture-long-resume-${sessionAgent}-${index + 1}`,
        agent: sessionAgent,
        projectPath: `/Users/dev/projects/remcli/${'nested/'.repeat(24)}project-${index + 1}`,
        lastModified: FIXTURE_BASE_TIME - index * 60_000,
        firstMessage: null,
        messageCount: index + 1,
        createdAt: FIXTURE_BASE_TIME - (index + 1) * 60_000,
        sessionName: `Long resume session ${String(index + 1).padStart(2, '0')} · ${longContext}`,
    }));
}

/** Локальный список native agent sessions для resume-sheet; shape совпадает с daemon `list-agent-sessions`. */
export async function fixtureListAgentSessions(
    machineId: string,
    agent?: string,
    directory?: string,
    limit = 20
): Promise<AgentSessionInfo[]> {
    if (fixtureQueryParameter('resumeFixture') === 'cursor-lifecycle') {
        await waitForFixtureResumeResponse();
        return agent === 'cursor' ? [FIXTURE_CURSOR_RESUME_SESSION].slice(0, limit) : [];
    }

    if (fixtureQueryParameter('resumeFixture') === 'cursor-opaque') {
        if (machineId !== 'fx-machine-online' || (agent !== undefined && agent !== 'cursor')) {
            return [];
        }

        return FIXTURE_CURSOR_OPAQUE_RESUME_SESSIONS
            .filter((session) => !directory || session.projectPath === normalizeFixtureDirectoryPath(directory, '/Users/dev'))
            .sort((left, right) => right.lastModified - left.lastModified)
            .slice(0, limit);
    }

    if (fixtureQueryParameter('resumeFixture') === 'retry-long') {
        await waitForFixtureResumeResponse();
        fixtureResumeRetryAttempts += 1;
        if (fixtureResumeRetryAttempts === 1) {
            throw new Error('Fixture resume list rejected');
        }
        return fixtureLongResumeSessions(agent).slice(0, limit);
    }

    return FIXTURE_SESSIONS
        .filter((session) => session.metadata?.machineId === machineId)
        .filter((session) => {
            if (!agent) return true;
            return fixtureSessionAgent(session) === agent;
        })
        .filter((session) => {
            if (!directory) return true;
            const metadata = session.metadata;
            if (!metadata) return false;
            return metadata.path === normalizeFixtureDirectoryPath(directory, metadata.homeDir ?? '');
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((session) => {
            const sessionAgent = fixtureSessionAgent(session);
            const projectPath = session.metadata?.path ?? '';
            return {
                sessionId: fixtureNativeSessionId(sessionAgent, session.id),
                agent: sessionAgent,
                projectPath,
                lastModified: session.updatedAt,
                firstMessage: session.metadata?.summary?.text ?? null,
                messageCount: useProtocolStore.getState().sessionMessages[session.id]?.messages.length ?? 0,
                createdAt: session.createdAt,
                sessionName: session.metadata?.name ?? fixtureSessionName(projectPath)
            };
        });
}

/** Локальный spawn/remcli-session для fixture-mode: без machine encryption и daemon RPC. */
export async function fixtureSpawnNewSession(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
    const machine = FIXTURE_MACHINES.find((item) => item.id === options.machineId);
    if (!machine?.metadata) {
        return { type: 'error', errorMessage: `Fixture machine not found: ${options.machineId}` };
    }

    const capabilityScenario = fixtureQueryParameter('codexCapabilities');
    if (capabilityScenario === 'capability-rejection'
        && options.agent === 'codex'
        && fixtureCodexCapabilityRejectionAttempts === 0) {
        fixtureCodexCapabilityRejectionAttempts += 1;
        return {
            type: 'error',
            errorMessage: 'Codex capability selection rejected: unsupported_selection.',
        };
    }

    if (options.agent === 'cursor') {
        const capabilities = await fixtureGetCursorCapabilities();
        const isValidCursorExecution = capabilities.status === 'ready'
            && options.cursorExecution?.catalogVersion === capabilities.catalogVersion
            && capabilities.models.some((model) => model.id === options.cursorExecution?.model);
        if (!isValidCursorExecution) {
            return {
                type: 'error',
                errorMessage: 'Cursor capability selection rejected: unavailable.',
            };
        }
    }

    if (
        fixtureQueryParameter('resumeFixture') === 'cursor-lifecycle'
        && options.agent === 'cursor'
        && options.resumeSessionId === FIXTURE_CURSOR_RESUME_NATIVE_SESSION_ID
    ) {
        // A real daemon RPC is asynchronous. Keep the retry state observable
        // in Browser tests instead of collapsing it into one render frame.
        await waitForFixtureResumeResponse();
        if (fixtureCursorResumeSpawnAttempts === 0) {
            fixtureCursorResumeSpawnAttempts += 1;
            return {
                type: 'error',
                errorMessage: 'Cursor could not bind this native session. Retry the same session.',
            };
        }
    }

    const directory = normalizeFixtureDirectoryPath(options.directory, machine.metadata.homeDir);
    if (!FIXTURE_DIRECTORY_CHILDREN[directory] && !options.approvedNewDirectoryCreation) {
        return { type: 'requestToApproveDirectoryCreation', directory };
    }

    spawnedSessionCounter += 1;
    const agent = options.agent ?? 'claude';
    const nativeSessionId = options.resumeSessionId ?? fixtureNativeSessionId(agent, `spawn-${spawnedSessionCounter}`);
    const sessionIdPrefix = options.resumeSessionId ? 'fx-resume' : 'fx-spawn';
    const sessionId = `${sessionIdPrefix}-${agent}-${spawnedSessionCounter}`;
    const now = FIXTURE_BASE_TIME + 24 * 60 * 60 * 1000 + spawnedSessionCounter * 60_000;
    const summary = options.resumeSessionName
        ? { text: `Возобновлена ${options.resumeSessionName}`, updatedAt: now }
        : undefined;
    const metadata: SessionMetadata = {
        path: directory,
        host: machine.metadata.host,
        homeDir: machine.metadata.homeDir,
        remcliHomeDir: machine.metadata.remcliHomeDir,
        machineId: machine.id,
        flavor: agent,
        name: fixtureSessionName(directory),
        summary,
        agentSessionId: nativeSessionId,
        ...providerSessionMetadata(agent, nativeSessionId)
    };
    const session: Session = {
        id: sessionId,
        seq: 100 + spawnedSessionCounter,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata,
        metadataVersion: 1,
        agentState: {
            controlledByUser: false,
            requests: {},
            completedRequests: {}
        },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online'
    };

    const store = useProtocolStore.getState();
    const resumeSource = options.resumeSessionId
        ? fixtureResumeSourceSession(options.resumeSessionId)
        : undefined;
    const resumeHistory = options.resumeSessionId
        ? store.sessionMessages[resumeSource?.id ?? '']?.messages ?? FIXTURE_UNKNOWN_RESUME_HISTORY
        : [];
    store.applySessions([session]);
    store.applyMessages(sessionId, cloneFixtureHistory(resumeHistory, sessionId), { markLoaded: true });
    const machineRecentDirectories = fixtureRecentDirectoriesByMachine.get(options.machineId) ?? [];
    fixtureRecentDirectoriesByMachine.set(options.machineId, [
        {
            canonicalPath: directory,
            displayPath: fixtureDisplayPath(directory, machine.metadata.homeDir),
            lastUsedAt: now,
        },
        ...machineRecentDirectories.filter((item) => item.canonicalPath !== directory),
    ]);
    return { type: 'success', sessionId };
}

/** Локальная остановка сессии в fixture-mode: имитирует daemon RPC `stop-session`. */
export function fixtureStopSession(machineId: string, sessionId: string): { message: string } {
    const store = useProtocolStore.getState();
    const machine = store.machines[machineId];
    const session = store.sessions[sessionId];
    if (!machine) {
        throw new Error(`Fixture machine not found: ${machineId}`);
    }
    if (!session) {
        throw new Error(`Fixture session not found: ${sessionId}`);
    }
    const now = Math.max(session.updatedAt + 1_000, Date.now());
    store.applySessions([{
        ...session,
        updatedAt: now,
        active: false,
        thinking: false,
        presence: now
    }]);
    return { message: 'session stopped' };
}

/**
 * Локальный ответ на permission-запрос: карточка убирается из
 * agentState.requests (переезжает в completedRequests) без RPC.
 */
export function fixtureAnswerPermission(
    sessionId: string,
    permissionId: string,
    status: 'approved' | 'denied'
): void {
    const store = useProtocolStore.getState();
    const session = store.sessions[sessionId];
    const request = session?.agentState?.requests?.[permissionId];
    if (!session || !request) return;
    const requests = { ...session.agentState?.requests };
    delete requests[permissionId];
    store.applySessions([{
        ...session,
        agentState: {
            ...session.agentState,
            requests,
            completedRequests: {
                ...session.agentState?.completedRequests,
                [permissionId]: {
                    ...request,
                    status,
                    completedAt: (request.createdAt ?? 0) + 1_000
                }
            }
        }
    }]);
}
