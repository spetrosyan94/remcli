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
 *   статусы TTS/Whisper/concierge, /health);
 * - кнопки работают без сети: allow/deny убирают permission-карточку локально
 *   (fixtureAnswerPermission), отправка сообщения — локальное эхо (client.ts).
 */

import {
    FIXTURE_CHAT_MESSAGES,
    FIXTURE_CHAT_SESSION_ID,
    FIXTURE_MACHINES,
    FIXTURE_SESSIONS,
    FIXTURE_ZEN_TASKS
} from '@/lib/fixtures/data';
import { useProtocolStore } from '@/lib/protocol/store';

export { FIXTURE_CHAT_SESSION_ID };

/** Фиксированная латентность пилюли соединения в fixture-режиме («p2p · 12ms»). */
export const FIXTURE_LATENCY_MS = 12;

const FIXTURE_FLAG_KEY = 'remcli-fixtures';

/** Псевдо-эндпоинт REST: запросы к нему перехватываются installFetchInterceptor. */
const FIXTURE_ENDPOINT = 'http://remcli-fixtures.invalid';

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
        return jsonResponse({ enabled: false, available: false, model: null });
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
    const store = useProtocolStore.getState();
    store.applyMachines(FIXTURE_MACHINES);
    store.applySessions(FIXTURE_SESSIONS);
    store.applyMessages(FIXTURE_CHAT_SESSION_ID, FIXTURE_CHAT_MESSAGES, { markLoaded: true });
    store.setConnectionStatus('connected');
    store.setAuthenticated(true);
    store.setLatency(FIXTURE_LATENCY_MS);
    return true;
}

/** REST-конфиг fixture-режима: все запросы уйдут в fetch-перехватчик. */
export function fixtureRestConfig(): { endpoint: string; token: string } {
    return { endpoint: FIXTURE_ENDPOINT, token: 'fixtures' };
}

/** «Загрузка» истории: сообщения уже в сторе — только пометить isLoaded. */
export function fixtureLoadSessionMessages(sessionId: string): { total: number; hasMore: boolean } {
    const store = useProtocolStore.getState();
    store.applyMessages(sessionId, [], { markLoaded: true });
    return {
        total: store.sessionMessages[sessionId]?.messages.length ?? 0,
        hasMore: false
    };
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
