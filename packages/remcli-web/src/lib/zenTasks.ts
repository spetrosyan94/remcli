// remcli-web — задачи Zen в localStorage.
// Демон P2P отдаёт /v1/kv* только как заглушки (GET — пустой список, POST — no-op,
// см. packages/remcli-cli/src/daemon/p2p/p2pRestRoutes.ts), поэтому синхронизация
// через KV невозможна — храним локально. Форма записи совместима с TodoItem
// из remcli-app sources/-zen/model/ops.ts для будущей миграции на KV.

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

const STORAGE_KEY = 'remcli-zen-tasks';

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

export function loadZenTasks(): ZenTask[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isZenTask);
    } catch {
        return [];
    }
}

function saveZenTasks(tasks: ZenTask[]): ZenTask[] {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
    } catch {
        // квота/приватный режим — молча оставляем состояние в памяти страницы
    }
    return tasks;
}

/** Добавляет задачу в начало списка; возвращает новый список. */
export function addZenTask(title: string): ZenTask[] {
    const now = Date.now();
    const task: ZenTask = { id: generateTaskId(), title, isDone: false, createdAt: now, updatedAt: now };
    return saveZenTasks([task, ...loadZenTasks()]);
}

/** Переключает выполненность; возвращает новый список. */
export function toggleZenTask(id: string): ZenTask[] {
    const now = Date.now();
    return saveZenTasks(loadZenTasks().map((task) => {
        if (task.id !== id) return task;
        const isDone = !task.isDone;
        return {
            ...task,
            isDone,
            updatedAt: now,
            completedAt: isDone ? now : undefined
        };
    }));
}

/** Привязывает задачу к созданной сессии; возвращает новый список. */
export function linkZenTaskSession(id: string, sessionId: string): ZenTask[] {
    const now = Date.now();
    return saveZenTasks(loadZenTasks().map((task) =>
        task.id === id ? { ...task, sessionId, updatedAt: now } : task
    ));
}
