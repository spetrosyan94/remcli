// remcli-web — детерминированные данные fixture-режима (см. ./index.ts).
// Все времена — константы от FIXTURE_BASE_TIME (никаких Date.now): скриншоты
// визуальных тестов и ИИ-аудита должны быть воспроизводимыми.
import type { NormalizedMessage } from '@/lib/protocol/messages';
import type { Machine, Session } from '@/lib/protocol/types';
import type { ZenTask } from '@/lib/zenTasks';

/** 2026-06-15T10:00:00Z — базовая точка времени всех фикстур. */
export const FIXTURE_BASE_TIME = 1781517600000;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const T = FIXTURE_BASE_TIME;

/** Сессия «полного покрытия» чата: все состояния ленты на одном экране. */
export const FIXTURE_CHAT_SESSION_ID = 'fx-chat';

// ─── Машины: online + offline ────────────────────────────────────

export const FIXTURE_MACHINES: Machine[] = [
    {
        id: 'fx-machine-online',
        seq: 1,
        createdAt: T - 24 * HOUR,
        updatedAt: T,
        active: true,
        activeAt: T,
        metadata: {
            host: 'macbook-pro.local',
            platform: 'darwin',
            remcliCliVersion: '1.4.0',
            remcliHomeDir: '/Users/dev/.remcli',
            homeDir: '/Users/dev',
            username: 'dev',
            arch: 'arm64'
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1
    },
    {
        id: 'fx-machine-offline',
        seq: 2,
        createdAt: T - 48 * HOUR,
        updatedAt: T - 2 * HOUR,
        active: false,
        activeAt: T - 2 * HOUR,
        metadata: {
            host: 'build-server',
            platform: 'linux',
            remcliCliVersion: '1.4.0',
            remcliHomeDir: '/home/ci/.remcli',
            homeDir: '/home/ci',
            username: 'ci',
            arch: 'x64'
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1
    }
];

// ─── Сессии: все 6 статусов UI-кита ──────────────────────────────
// running/thinking/permission/idle — живые; offline — на выключенной машине;
// error — живая сессия с error-summary (протокол не различает error на списке,
// данные дают семантически «упавшую» сессию для будущего маппинга).

interface SessionSeed {
    id: string;
    seq: number;
    path: string;
    flavor?: string;
    machineId: string;
    host: string;
    homeDir: string;
    active: boolean;
    activeAt: number;
    thinking?: boolean;
    summary?: string;
    requests?: NonNullable<NonNullable<Session['agentState']>['requests']>;
}

function makeSession(seed: SessionSeed): Session {
    return {
        id: seed.id,
        seq: seed.seq,
        createdAt: seed.activeAt - HOUR,
        updatedAt: seed.activeAt,
        active: seed.active,
        activeAt: seed.activeAt,
        metadata: {
            path: seed.path,
            host: seed.host,
            homeDir: seed.homeDir,
            machineId: seed.machineId,
            flavor: seed.flavor ?? null,
            name: seed.path.split('/').pop(),
            claudeSessionId: `${seed.id}-agent`,
            summary: seed.summary ? { text: seed.summary, updatedAt: seed.activeAt } : undefined
        },
        metadataVersion: 1,
        agentState: {
            controlledByUser: false,
            requests: seed.requests ?? {},
            completedRequests: {}
        },
        agentStateVersion: 1,
        thinking: seed.thinking ?? false,
        thinkingAt: seed.thinking ? seed.activeAt : 0,
        presence: seed.active ? 'online' : seed.activeAt
    };
}

export const FIXTURE_SESSIONS: Session[] = [
    // permission (карточки разрешений живут в agentState.requests этой сессии)
    makeSession({
        id: FIXTURE_CHAT_SESSION_ID,
        seq: 10,
        path: '/Users/dev/projects/remcli',
        machineId: 'fx-machine-online',
        host: 'macbook-pro.local',
        homeDir: '/Users/dev',
        active: true,
        activeAt: T,
        thinking: true, // стриминг-индикатор (ThinkingRow) под лентой
        summary: 'Чиню parser.ts: баланс скобок',
        requests: {
            'fx-perm-normal': {
                tool: 'Bash',
                arguments: { command: 'npm install left-pad', description: 'Установить зависимость для parser.ts' },
                createdAt: T - 2 * MINUTE
            },
            'fx-perm-danger': {
                tool: 'Bash',
                arguments: { command: 'rm -rf node_modules && npm ci', description: 'Переустановить зависимости с нуля' },
                createdAt: T - MINUTE
            }
        }
    }),
    // running: живая, агент работает (без thinking-флага)
    makeSession({
        id: 'fx-running',
        seq: 11,
        path: '/Users/dev/projects/webapp',
        flavor: 'codex',
        machineId: 'fx-machine-online',
        host: 'macbook-pro.local',
        homeDir: '/Users/dev',
        active: true,
        activeAt: T - MINUTE,
        summary: 'npm test: прогон 214 тестов'
    }),
    // thinking: живая, агент думает
    makeSession({
        id: 'fx-thinking',
        seq: 12,
        path: '/Users/dev/projects/api-server',
        flavor: 'gemini',
        machineId: 'fx-machine-online',
        host: 'macbook-pro.local',
        homeDir: '/Users/dev',
        active: true,
        activeAt: T - 2 * MINUTE,
        thinking: true
    }),
    // idle: живая, ждёт ввода
    makeSession({
        id: 'fx-idle',
        seq: 13,
        path: '/Users/dev/projects/docs',
        machineId: 'fx-machine-online',
        host: 'macbook-pro.local',
        homeDir: '/Users/dev',
        active: true,
        activeAt: T - 30 * MINUTE,
        summary: 'Готово: обновил README и changelog'
    }),
    // error: живая сессия с упавшей командой в summary
    makeSession({
        id: 'fx-error',
        seq: 14,
        path: '/Users/dev/projects/mobile',
        flavor: 'cursor',
        machineId: 'fx-machine-online',
        host: 'macbook-pro.local',
        homeDir: '/Users/dev',
        active: true,
        activeAt: T - 45 * MINUTE,
        summary: 'Error: build failed (exit 1)'
    }),
    // offline: завершённая сессия на выключенной машине
    makeSession({
        id: 'fx-offline',
        seq: 15,
        path: '/home/ci/releases/pipeline',
        machineId: 'fx-machine-offline',
        host: 'build-server',
        homeDir: '/home/ci',
        active: false,
        activeAt: T - 3 * HOUR
    })
];

// ─── Чат «полного покрытия» (fx-chat) ────────────────────────────
// user → агент-текст → tool-call success (свёрнут) → tool-call error (развёрнут)
// → DiffView → агент-текст → tool-call running; permission-карточки — из
// agentState.requests сессии, стриминг-индикатор — из session.thinking.

export const FIXTURE_CHAT_MESSAGES: NormalizedMessage[] = [
    {
        id: 'fx-m01',
        localId: null,
        seq: 1,
        createdAt: T - 10 * MINUTE,
        isSidechain: false,
        role: 'user',
        content: { type: 'text', text: 'Проверь тесты и почини баг с балансом скобок в parser.ts' }
    },
    {
        id: 'fx-m02',
        localId: null,
        seq: 2,
        createdAt: T - 9 * MINUTE,
        isSidechain: false,
        role: 'agent',
        content: [{
            type: 'text',
            text: 'Смотрю parser.ts и прогоняю линтер, чтобы найти место с дисбалансом скобок.',
            uuid: 'fx-u02',
            parentUUID: null
        }]
    },
    // tool-call success — свёрнут по умолчанию, разворачивается по клику
    {
        id: 'fx-m03',
        localId: null,
        seq: 3,
        createdAt: T - 8 * MINUTE,
        isSidechain: false,
        role: 'agent',
        content: [{
            type: 'tool-call',
            id: 'fx-tc-read',
            name: 'Read',
            input: { file_path: 'src/parser.ts' },
            description: null,
            uuid: 'fx-u03',
            parentUUID: null
        }]
    },
    {
        id: 'fx-m04',
        localId: null,
        seq: 4,
        createdAt: T - 8 * MINUTE + 5_000,
        isSidechain: false,
        role: 'agent',
        content: [{
            type: 'tool-result',
            tool_use_id: 'fx-tc-read',
            content: 'export function parse(input: string) {\n    let depth = 0;\n    for (const token of tokenize(input)) {\n        if (token === ")") depth--;\n    }\n    return depth === 0;\n}',
            is_error: false,
            uuid: 'fx-u04',
            parentUUID: null
        }]
    },
    // tool-call error — развёрнут по умолчанию, с errorText
    {
        id: 'fx-m05',
        localId: null,
        seq: 5,
        createdAt: T - 7 * MINUTE,
        isSidechain: false,
        role: 'agent',
        content: [{
            type: 'tool-call',
            id: 'fx-tc-lint',
            name: 'Bash',
            input: { command: 'npm run lint' },
            description: null,
            uuid: 'fx-u05',
            parentUUID: null
        }]
    },
    {
        id: 'fx-m06',
        localId: null,
        seq: 6,
        createdAt: T - 7 * MINUTE + 8_000,
        isSidechain: false,
        role: 'agent',
        content: [{
            type: 'tool-result',
            tool_use_id: 'fx-tc-lint',
            content: 'src/parser.ts:42:13  error  depth may go below zero  no-unbalanced-parens\n1 problem (1 error, 0 warnings)',
            is_error: true,
            uuid: 'fx-u06',
            parentUUID: null
        }]
    },
    // DiffView — Edit с old_string/new_string
    {
        id: 'fx-m07',
        localId: null,
        seq: 7,
        createdAt: T - 6 * MINUTE,
        isSidechain: false,
        role: 'agent',
        content: [{
            type: 'tool-call',
            id: 'fx-tc-edit',
            name: 'Edit',
            input: {
                file_path: 'src/parser.ts',
                old_string: 'if (token === ")") depth--;',
                new_string: 'if (token === ")") depth = Math.max(0, depth - 1);'
            },
            description: null,
            uuid: 'fx-u07',
            parentUUID: null
        }]
    },
    {
        id: 'fx-m08',
        localId: null,
        seq: 8,
        createdAt: T - 5 * MINUTE,
        isSidechain: false,
        role: 'agent',
        content: [{
            type: 'text',
            text: 'Поправил баланс скобок в parser.ts, перезапускаю тесты.',
            uuid: 'fx-u08',
            parentUUID: null
        }]
    },
    // tool-call running — без tool-result (спиннер выполняющейся команды)
    {
        id: 'fx-m09',
        localId: null,
        seq: 9,
        createdAt: T - 4 * MINUTE,
        isSidechain: false,
        role: 'agent',
        content: [{
            type: 'tool-call',
            id: 'fx-tc-test',
            name: 'Bash',
            input: { command: 'npm test' },
            description: null,
            uuid: 'fx-u09',
            parentUUID: null
        }]
    }
];

// ─── Zen-задачи: активная (со связанной сессией) + выполненная ───

export const FIXTURE_ZEN_TASKS: ZenTask[] = [
    {
        id: 'fx-zen-active',
        title: 'Показать латентность в пилюле соединения',
        isDone: false,
        createdAt: T - 2 * HOUR,
        updatedAt: T - HOUR,
        sessionId: 'fx-running'
    },
    {
        id: 'fx-zen-done',
        title: 'Починить прыжок скролла при подгрузке истории чата',
        isDone: true,
        createdAt: T - 5 * HOUR,
        updatedAt: T - 3 * HOUR,
        completedAt: T - 3 * HOUR
    }
];
