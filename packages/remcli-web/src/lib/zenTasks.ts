// remcli-web — задачи Zen в KV демона (/v1/kv, ключ 'zen-tasks').
// Значение — JSON-массив ZenTask. OCC: мутации ретраятся при version-mismatch —
// transform применяется заново к свежему серверному списку (merge).
// Миграция: задачи из localStorage (remcli-zen-tasks) заливаются на демон при
// первом чтении, если ключа там ещё нет, затем localStorage очищается.
// Live-синк между устройствами: subscribeZenTasks — kv-batch-update от демона.

import {
    getRestConfig,
    kvGet,
    kvMutate,
    subscribeKvChanges,
    type KvChange,
    type RestConfig
} from '@/lib/protocol';

export interface ZenTask {
    id: string;
    title: string;
    isDone: boolean;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
    /** id живой сессии remcli, если задача взята в работу */
    sessionId?: string;
}

const KV_KEY = 'zen-tasks';
const LEGACY_STORAGE_KEY = 'remcli-zen-tasks';
const MAX_MUTATE_RETRIES = 3;

// Последнее известное серверное состояние — база для OCC-мутаций
let knownVersion = -1;
let knownTasks: ZenTask[] = [];

function generateTaskId(): string {
    return `z-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isZenTask(value: unknown): value is ZenTask {
    if (typeof value !== 'object' || value === null) return false;
    const task = value as Record<string, unknown>;
    return typeof task.id === 'string'
        && typeof task.title === 'string'
        && typeof task.isDone === 'boolean'
        && typeof task.createdAt === 'number'
        && typeof task.updatedAt === 'number';
}

function parseTasks(raw: string | null): ZenTask[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isZenTask);
    } catch {
        return [];
    }
}

function requireRestConfig(): RestConfig {
    const config = getRestConfig();
    if (!config) {
        throw new Error('Not connected to the daemon');
    }
    return config;
}

/**
 * OCC-мутация списка задач: применяем transform к последнему известному
 * состоянию; при version-mismatch берём серверные value/version из ответа 409
 * и применяем transform заново (merge через повторное применение намерения).
 */
async function mutateZenTasks(transform: (tasks: ZenTask[]) => ZenTask[]): Promise<ZenTask[]> {
    const config = requireRestConfig();
    for (let attempt = 0; attempt < MAX_MUTATE_RETRIES; attempt++) {
        const next = transform(knownTasks);
        const result = await kvMutate(config, [{ key: KV_KEY, value: JSON.stringify(next), version: knownVersion }]);
        if (result.success) {
            knownVersion = result.results[0]?.version ?? knownVersion + 1;
            knownTasks = next;
            return next;
        }
        const conflict = result.errors.find((error) => error.key === KV_KEY) ?? result.errors[0];
        if (!conflict) {
            throw new Error('KV mutate failed without error details');
        }
        knownVersion = conflict.version;
        knownTasks = parseTasks(conflict.value);
    }
    throw new Error(`Failed to update zen tasks after ${MAX_MUTATE_RETRIES} retries`);
}

// ─── Миграция localStorage → KV ──────────────────────────────────

function readLegacyTasks(): ZenTask[] {
    try {
        return parseTasks(localStorage.getItem(LEGACY_STORAGE_KEY));
    } catch {
        return [];
    }
}

function clearLegacyTasks(): void {
    try {
        localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
        // приватный режим — не критично
    }
}

/** Серверный список + легаси-задачи, которых на сервере ещё нет (dedupe по id). */
function mergeLegacyTasks(server: ZenTask[], legacy: ZenTask[]): ZenTask[] {
    const knownIds = new Set(server.map((task) => task.id));
    return [...legacy.filter((task) => !knownIds.has(task.id)), ...server];
}

// ─── Публичное API ───────────────────────────────────────────────

/**
 * Загружает задачи с демона. Если ключа на демоне нет, а в localStorage
 * остались задачи старого формата — заливает их на демон и чистит localStorage.
 */
export async function loadZenTasks(): Promise<ZenTask[]> {
    const config = requireRestConfig();
    const item = await kvGet(config, KV_KEY);
    if (item) {
        knownVersion = item.version;
        knownTasks = parseTasks(item.value);
        return knownTasks;
    }
    knownVersion = -1;
    knownTasks = [];
    const legacy = readLegacyTasks();
    if (legacy.length > 0) {
        const migrated = await mutateZenTasks((tasks) => mergeLegacyTasks(tasks, legacy));
        clearLegacyTasks();
        return migrated;
    }
    return [];
}

/** Добавляет задачу в начало списка; возвращает новый список. */
export async function addZenTask(title: string): Promise<ZenTask[]> {
    const now = Date.now();
    const task: ZenTask = { id: generateTaskId(), title, isDone: false, createdAt: now, updatedAt: now };
    return mutateZenTasks((tasks) => [task, ...tasks]);
}

/** Переключает выполненность; возвращает новый список. */
export async function toggleZenTask(id: string): Promise<ZenTask[]> {
    return mutateZenTasks((tasks) => tasks.map((task) => {
        if (task.id !== id) return task;
        const now = Date.now();
        const isDone = !task.isDone;
        return {
            ...task,
            isDone,
            updatedAt: now,
            completedAt: isDone ? now : undefined
        };
    }));
}

/**
 * Привязывает задачу к созданной сессии. Best-effort fire-and-forget:
 * вызывается из NewSessionPage без ожидания — ошибки глотаем.
 */
export function linkZenTaskSession(id: string, sessionId: string): void {
    void mutateZenTasks((tasks) => tasks.map((task) =>
        task.id === id ? { ...task, sessionId, updatedAt: Date.now() } : task
    )).catch(() => undefined);
}

/**
 * Live-синк: обновления ключа zen-tasks с других устройств (kv-batch-update).
 * Возвращает функцию отписки.
 */
export function subscribeZenTasks(listener: (tasks: ZenTask[]) => void): () => void {
    return subscribeKvChanges((changes: KvChange[]) => {
        for (const change of changes) {
            if (change.key !== KV_KEY) continue;
            if (change.version <= knownVersion) continue; // наше же (или устаревшее) изменение
            knownVersion = change.version;
            knownTasks = parseTasks(change.value);
            listener(knownTasks);
        }
    });
}
