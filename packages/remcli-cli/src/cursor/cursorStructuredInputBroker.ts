import { randomUUID } from 'node:crypto';

import type {
    AgentState,
    CodexStructuredRequestField,
    CursorStructuredInputResponse,
    CursorStructuredInputResponseResult,
    CursorStructuredPlan,
    CursorStructuredPlanPhase,
    CursorStructuredPlanTodo,
    CursorStructuredRequestState,
} from '@/api/types';

export type CursorStructuredMethod = 'cursor/ask_question' | 'cursor/create_plan';

interface CursorStructuredRpcManager {
    registerHandler<TRequest, TResponse>(
        method: string,
        handler: (request: TRequest) => Promise<TResponse>,
    ): void;
}

export interface CursorStructuredSession {
    rpcHandlerManager: CursorStructuredRpcManager;
    updateAgentState(handler: (state: AgentState) => AgentState): void;
}

export interface CursorStructuredRequestContext {
    method: CursorStructuredMethod;
    params: Record<string, unknown>;
    nativeSessionId: string;
    turnGeneration: number;
}

export interface CursorStructuredInputBrokerOptions {
    timeoutMs?: number;
    now?: () => number;
    onWarning?: (message: string) => void;
}

interface PendingRequest {
    requestKey: string;
    nativeKey: string;
    nativeSessionId: string;
    turnGeneration: number;
    toolCallId: string;
    state: CursorStructuredRequestState;
    timeout: NodeJS.Timeout;
    promise: Promise<Record<string, unknown>>;
    resolve: (result: Record<string, unknown>) => void;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 256;
const MAX_PROMPT_LENGTH = 4 * 1024;
const MAX_TEXT_LENGTH = 32 * 1024;
const MAX_QUESTIONS = 12;
const MAX_OPTIONS = 20;
const MAX_TODOS = 100;
const MAX_PHASES = 20;
const MAX_RESOLVED_REQUESTS = 256;
const UNSAFE_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const QUESTION_KEYS = new Set(['id', 'prompt', 'options', 'allowMultiple']);
const OPTION_KEYS = new Set(['id', 'label']);
const ASK_KEYS = new Set(['toolCallId', 'title', 'questions']);
const TODO_KEYS = new Set(['id', 'content', 'status']);
const PHASE_KEYS = new Set(['name', 'todos']);
const PLAN_KEYS = new Set(['toolCallId', 'name', 'overview', 'plan', 'todos', 'isProject', 'phases']);

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw new Error('Invalid Cursor structured request.');
    }
}

function requiredString(value: Record<string, unknown>, key: string, maxLength: number): string {
    const candidate = value[key];
    if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > maxLength) {
        throw new Error('Invalid Cursor structured request.');
    }
    return candidate;
}

function optionalString(value: Record<string, unknown>, key: string, maxLength: number): string | undefined {
    const candidate = value[key];
    if (candidate === undefined || candidate === null) return undefined;
    if (typeof candidate !== 'string' || candidate.length > maxLength) {
        throw new Error('Invalid Cursor structured request.');
    }
    return candidate;
}

function validateId(id: string): string {
    if (UNSAFE_IDS.has(id)) throw new Error('Invalid Cursor structured request.');
    return id;
}

function parseTodo(value: unknown): CursorStructuredPlanTodo {
    if (!isRecord(value)) throw new Error('Invalid Cursor structured request.');
    assertAllowedKeys(value, TODO_KEYS);
    const status = value.status;
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed' && status !== 'cancelled') {
        throw new Error('Invalid Cursor structured request.');
    }
    return {
        id: validateId(requiredString(value, 'id', MAX_ID_LENGTH)),
        content: requiredString(value, 'content', MAX_TITLE_LENGTH),
        status,
    };
}

function parseTodos(value: unknown): CursorStructuredPlanTodo[] {
    if (!Array.isArray(value) || value.length > MAX_TODOS) {
        throw new Error('Invalid Cursor structured request.');
    }
    const todos = value.map(parseTodo);
    const ids = new Set(todos.map((todo) => todo.id));
    if (ids.size !== todos.length) throw new Error('Invalid Cursor structured request.');
    return todos;
}

function parsePhases(value: unknown): CursorStructuredPlanPhase[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.length > MAX_PHASES) {
        throw new Error('Invalid Cursor structured request.');
    }
    return value.map((entry) => {
        if (!isRecord(entry)) throw new Error('Invalid Cursor structured request.');
        assertAllowedKeys(entry, PHASE_KEYS);
        return { name: requiredString(entry, 'name', MAX_TITLE_LENGTH), todos: parseTodos(entry.todos) };
    });
}

function normalizeQuestion(params: Record<string, unknown>, timeoutMs: number, now: number): Omit<PendingRequest, 'requestKey' | 'nativeKey' | 'nativeSessionId' | 'turnGeneration' | 'timeout' | 'promise' | 'resolve'> {
    assertAllowedKeys(params, ASK_KEYS);
    const toolCallId = validateId(requiredString(params, 'toolCallId', MAX_ID_LENGTH));
    const title = optionalString(params, 'title', MAX_TITLE_LENGTH);
    if (!Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > MAX_QUESTIONS) {
        throw new Error('Invalid Cursor structured request.');
    }
    const fields: CodexStructuredRequestField[] = params.questions.map((question) => {
        if (!isRecord(question)) throw new Error('Invalid Cursor structured request.');
        assertAllowedKeys(question, QUESTION_KEYS);
        const id = validateId(requiredString(question, 'id', MAX_ID_LENGTH));
        if (!Array.isArray(question.options) || question.options.length === 0 || question.options.length > MAX_OPTIONS) {
            throw new Error('Invalid Cursor structured request.');
        }
        const options = question.options.map((option) => {
            if (!isRecord(option)) throw new Error('Invalid Cursor structured request.');
            assertAllowedKeys(option, OPTION_KEYS);
            return {
                value: validateId(requiredString(option, 'id', MAX_ID_LENGTH)),
                label: requiredString(option, 'label', MAX_TITLE_LENGTH),
            };
        });
        if (new Set(options.map((option) => option.value)).size !== options.length) {
            throw new Error('Invalid Cursor structured request.');
        }
        if (question.allowMultiple !== undefined && typeof question.allowMultiple !== 'boolean') {
            throw new Error('Invalid Cursor structured request.');
        }
        return {
            id,
            type: question.allowMultiple === true ? 'multiselect' : 'select',
            label: requiredString(question, 'prompt', MAX_PROMPT_LENGTH),
            required: true,
            options,
            ...(question.allowMultiple === true ? { minItems: 1 } : {}),
        };
    });
    if (new Set(fields.map((field) => field.id)).size !== fields.length) {
        throw new Error('Invalid Cursor structured request.');
    }
    return {
        toolCallId,
        state: {
            requestKey: '',
            kind: 'cursor-question',
            message: title ?? 'Cursor needs your input.',
            fields,
            isBlocking: true,
            createdAt: now,
            deadlineAt: now + timeoutMs,
        },
    };
}

function normalizePlan(params: Record<string, unknown>, timeoutMs: number, now: number): Omit<PendingRequest, 'requestKey' | 'nativeKey' | 'nativeSessionId' | 'turnGeneration' | 'timeout' | 'promise' | 'resolve'> {
    assertAllowedKeys(params, PLAN_KEYS);
    const toolCallId = validateId(requiredString(params, 'toolCallId', MAX_ID_LENGTH));
    const name = optionalString(params, 'name', MAX_TITLE_LENGTH);
    const overview = optionalString(params, 'overview', MAX_TEXT_LENGTH);
    const markdown = requiredString(params, 'plan', MAX_TEXT_LENGTH);
    if (params.isProject !== undefined && typeof params.isProject !== 'boolean') {
        throw new Error('Invalid Cursor structured request.');
    }
    const phases = parsePhases(params.phases);
    const plan: CursorStructuredPlan = {
        ...(name ? { name } : {}),
        ...(overview ? { overview } : {}),
        markdown,
        todos: parseTodos(params.todos),
        ...(phases ? { phases } : {}),
        ...(typeof params.isProject === 'boolean' ? { isProject: params.isProject } : {}),
    };
    return {
        toolCallId,
        state: {
            requestKey: '',
            kind: 'cursor-plan',
            message: overview ?? name ?? 'Cursor proposed a plan.',
            fields: [],
            plan,
            isBlocking: true,
            createdAt: now,
            deadlineAt: now + timeoutMs,
        },
    };
}

function cloneState(state: CursorStructuredRequestState): CursorStructuredRequestState {
    const base = {
        requestKey: state.requestKey,
        message: state.message,
        fields: state.fields.map((field) => ({
            ...field,
            ...(field.options ? { options: field.options.map((option) => ({ ...option })) } : {}),
        })),
        isBlocking: true as const,
        createdAt: state.createdAt,
        deadlineAt: state.deadlineAt,
    };
    if (state.kind === 'cursor-question') return { ...base, kind: 'cursor-question' };
    return {
        ...base,
        kind: 'cursor-plan',
        plan: {
            ...state.plan,
            todos: state.plan.todos.map((todo) => ({ ...todo })),
            ...(state.plan.phases ? {
                phases: state.plan.phases.map((phase) => ({
                    ...phase,
                    todos: phase.todos.map((todo) => ({ ...todo })),
                })),
            } : {}),
        },
    };
}

function cancelled(): Record<string, unknown> {
    return { outcome: { outcome: 'cancelled' } };
}

export class CursorStructuredInputBroker {
    private session: CursorStructuredSession;
    private sessionEpoch = 0;
    private readonly pending = new Map<string, PendingRequest>();
    private readonly pendingByNativeKey = new Map<string, PendingRequest>();
    private readonly resolvedByNativeKey = new Map<string, Record<string, unknown>>();
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private readonly onWarning: ((message: string) => void) | undefined;

    constructor(session: CursorStructuredSession, options: CursorStructuredInputBrokerOptions = {}) {
        this.session = session;
        this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 0), MAX_TIMEOUT_MS);
        this.now = options.now ?? Date.now;
        this.onWarning = options.onWarning;
        this.registerRpcHandler();
    }

    updateSession(session: CursorStructuredSession): void {
        this.sessionEpoch += 1;
        this.session = session;
        this.registerRpcHandler();
        this.publishState();
    }

    handleRequest(context: CursorStructuredRequestContext): Promise<Record<string, unknown>> {
        const nativeKey = `${context.nativeSessionId}:${context.turnGeneration}:${context.method}:${String(context.params.toolCallId ?? '')}`;
        const existing = this.pendingByNativeKey.get(nativeKey);
        if (existing) return existing.promise;
        const resolved = this.resolvedByNativeKey.get(nativeKey);
        if (resolved) return Promise.resolve(resolved);

        try {
            const createdAt = this.now();
            const normalized = context.method === 'cursor/ask_question'
                ? normalizeQuestion(context.params, this.timeoutMs, createdAt)
                : normalizePlan(context.params, this.timeoutMs, createdAt);
            const requestKey = randomUUID();
            let resolveNative!: (result: Record<string, unknown>) => void;
            const promise = new Promise<Record<string, unknown>>((resolve) => { resolveNative = resolve; });
            const timeout = setTimeout(() => {
                const pending = this.pending.get(requestKey);
                if (pending) this.settle(pending, cancelled(), 'timeout');
            }, this.timeoutMs);
            timeout.unref?.();
            const pending: PendingRequest = {
                requestKey,
                nativeKey,
                nativeSessionId: context.nativeSessionId,
                turnGeneration: context.turnGeneration,
                toolCallId: normalized.toolCallId,
                state: { ...normalized.state, requestKey },
                timeout,
                promise,
                resolve: resolveNative,
            };
            this.pending.set(requestKey, pending);
            this.pendingByNativeKey.set(nativeKey, pending);
            this.publishState();
            return promise;
        } catch {
            this.onWarning?.('Cursor structured request was invalid and was canceled.');
            return Promise.resolve(cancelled());
        }
    }

    clearForTurn(nativeSessionId: string, turnGeneration: number): void {
        for (const pending of Array.from(this.pending.values())) {
            if (pending.nativeSessionId === nativeSessionId && pending.turnGeneration === turnGeneration) {
                this.settle(pending, cancelled(), 'turn-ended');
            }
        }
    }

    clearAll(): void {
        for (const pending of Array.from(this.pending.values())) {
            this.settle(pending, cancelled(), 'session-cleanup');
        }
    }

    getPendingState(): CursorStructuredRequestState[] {
        return Array.from(this.pending.values(), (pending) => cloneState(pending.state));
    }

    private registerRpcHandler(): void {
        const epoch = this.sessionEpoch;
        this.session.rpcHandlerManager.registerHandler<CursorStructuredInputResponse, CursorStructuredInputResponseResult>(
            'cursor-structured-input-response',
            async (response) => this.handleResponse(response, epoch),
        );
    }

    private async handleResponse(response: CursorStructuredInputResponse, epoch: number): Promise<CursorStructuredInputResponseResult> {
        if (epoch !== this.sessionEpoch) return { status: 'already-resolved' };
        if (!isRecord(response)
            || typeof response.requestKey !== 'string'
            || typeof response.submissionId !== 'string'
            || response.submissionId.length === 0
            || response.submissionId.length > MAX_ID_LENGTH
            || (response.action !== 'submit' && response.action !== 'decline' && response.action !== 'cancel')) {
            throw new Error('Invalid Cursor structured response.');
        }
        const pending = this.pending.get(response.requestKey);
        if (!pending) return { status: 'already-resolved' };
        const result = this.nativeResult(pending, response);
        this.settle(pending, result, 'client-response');
        return { status: 'submitted' };
    }

    private nativeResult(pending: PendingRequest, response: CursorStructuredInputResponse): Record<string, unknown> {
        if (response.action === 'cancel') return cancelled();
        if (pending.state.kind === 'cursor-plan') {
            if (response.answers !== undefined) throw new Error('Invalid Cursor structured response.');
            return response.action === 'submit'
                ? { outcome: { outcome: 'accepted' } }
                : { outcome: { outcome: 'rejected' } };
        }
        if (response.action === 'decline') return { outcome: { outcome: 'skipped' } };
        if (!isRecord(response.answers)) throw new Error('Invalid Cursor structured response.');
        const fields = new Map(pending.state.fields.map((field) => [field.id, field]));
        if (Object.keys(response.answers).length !== fields.size) throw new Error('Invalid Cursor structured response.');
        const answers = pending.state.fields.map((field) => {
            const selected = response.answers?.[field.id];
            if (!Array.isArray(selected) || selected.length === 0 || selected.length > MAX_OPTIONS) {
                throw new Error('Invalid Cursor structured response.');
            }
            if (field.type === 'select' && selected.length !== 1) throw new Error('Invalid Cursor structured response.');
            const allowed = new Set((field.options ?? []).map((option) => option.value));
            if (new Set(selected).size !== selected.length || selected.some((id) => !allowed.has(id))) {
                throw new Error('Invalid Cursor structured response.');
            }
            return { questionId: field.id, selectedOptionIds: [...selected] };
        });
        return { outcome: { outcome: 'answered', answers } };
    }

    private settle(
        pending: PendingRequest,
        result: Record<string, unknown>,
        reason: 'client-response' | 'timeout' | 'turn-ended' | 'session-cleanup',
    ): void {
        if (this.pending.get(pending.requestKey) !== pending) return;
        this.pending.delete(pending.requestKey);
        this.pendingByNativeKey.delete(pending.nativeKey);
        clearTimeout(pending.timeout);
        this.resolvedByNativeKey.set(pending.nativeKey, result);
        while (this.resolvedByNativeKey.size > MAX_RESOLVED_REQUESTS) {
            const oldest = this.resolvedByNativeKey.keys().next().value;
            if (typeof oldest !== 'string') break;
            this.resolvedByNativeKey.delete(oldest);
        }
        this.publishState();
        pending.resolve(result);
        if (reason === 'timeout') this.onWarning?.('Cursor structured input timed out and was canceled.');
    }

    private publishState(): void {
        const requests = Object.fromEntries(
            Array.from(this.pending.values(), (pending) => [pending.requestKey, cloneState(pending.state)]),
        );
        this.session.updateAgentState((state) => ({
            ...state,
            ...(Object.keys(requests).length > 0
                ? { cursorStructuredRequests: requests }
                : { cursorStructuredRequests: undefined }),
        }));
    }
}
