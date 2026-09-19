import { randomUUID } from 'node:crypto';

import type {
    AgentState,
    CodexStructuredFieldDefault,
    CodexStructuredFieldType,
    CodexStructuredRequestField,
    CodexStructuredRequestKind,
    CodexStructuredRequestOption,
    CodexStructuredRequestState,
    CodexStructuredStringFormat,
} from '@/api/types';

export type CodexStructuredJsonRpcId = string | number;

export type CodexStructuredInputResponseAction = 'submit' | 'decline' | 'cancel';

export interface CodexStructuredInputResponse {
    requestKey: string;
    submissionId: string;
    action: CodexStructuredInputResponseAction;
    answers?: Record<string, string[]>;
    content?: Record<string, unknown>;
}

export interface CodexStructuredInputResponseResult {
    status: 'submitted' | 'already-resolved';
}

export interface CodexStructuredUrlRequest {
    requestKey: string;
}

export interface CodexStructuredUrlResult {
    url: string;
}

export interface CodexMcpUrlPermissionRequest {
    requestKey: string;
    permissionInput: {
        kind: 'mcp-url';
        requestKey: string;
        threadId: string;
        turnId: string | null;
        serverName: string;
        mode: 'url';
        message: string;
        url: string;
        displayUrl: string;
        elicitationId: string;
    };
}

interface CodexStructuredInputRpcManager {
    registerHandler<TRequest, TResponse>(
        method: string,
        handler: (request: TRequest) => Promise<TResponse>,
    ): void;
}

export interface CodexStructuredInputSession {
    rpcHandlerManager: CodexStructuredInputRpcManager;
    updateAgentState(handler: (state: AgentState) => AgentState): void;
}

export interface CodexStructuredServerRequestContext {
    method: 'item/tool/requestUserInput' | 'mcpServer/elicitation/request';
    nativeRequestId: CodexStructuredJsonRpcId;
    params: unknown;
    transportGeneration: number;
    isCurrentScope: (method: CodexStructuredServerRequestContext['method'], params: unknown) => boolean;
    respond: (
        nativeRequestId: CodexStructuredJsonRpcId,
        result: unknown,
        transportGeneration: number,
    ) => boolean;
}

export interface CodexStructuredResolvedNotification {
    threadId: string;
    nativeRequestId: CodexStructuredJsonRpcId;
    transportGeneration: number;
}

export interface CodexStructuredInputBrokerOptions {
    timeoutMs?: number;
    now?: () => number;
    onWarning?: (message: string) => void;
}

interface PendingStructuredRequest {
    requestKey: string;
    method: CodexStructuredServerRequestContext['method'];
    nativeRequestId: CodexStructuredJsonRpcId;
    transportGeneration: number;
    threadId: string;
    turnId: string | null;
    itemId: string | null;
    state: CodexStructuredRequestState;
    timeout: NodeJS.Timeout;
    respond: CodexStructuredServerRequestContext['respond'];
    rawUrl?: string;
}

interface ResolvedStructuredRequest {
    requestKey: string;
    submissionId: string | null;
    method: CodexStructuredServerRequestContext['method'];
    nativeRequestId: CodexStructuredJsonRpcId;
    transportGeneration: number;
    threadId: string;
    turnId: string | null;
    itemId: string | null;
    resolvedAt: number;
}

interface NormalizedStructuredRequest {
    kind: CodexStructuredRequestKind;
    threadId: string;
    turnId: string | null;
    itemId: string | null;
    state: Omit<CodexStructuredRequestState, 'requestKey' | 'createdAt' | 'deadlineAt'>;
    timeoutMs: number;
    rawUrl?: string;
}

interface NormalizedToolQuestion {
    field: CodexStructuredRequestField;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 4096;
const MAX_FIELD_ID_LENGTH = 128;
const MAX_FIELD_LABEL_LENGTH = 256;
const MAX_FIELD_DESCRIPTION_LENGTH = 2048;
const MAX_OPTION_COUNT = 50;
const MAX_OPTION_LABEL_LENGTH = 256;
const MAX_SCHEMA_FIELDS = 32;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_ANSWER_VALUES = 50;
const MAX_RESOLVED_REQUESTS = 256;
const STRING_FORMATS = new Set<CodexStructuredStringFormat>(['email', 'uri', 'date', 'date-time']);
const UNSAFE_FIELD_IDS = new Set(['__proto__', 'constructor', 'prototype']);

const STRUCTURED_WARNING = 'Codex requested structured input, but Remcli rejected the request.';
const MCP_ROOT_SCHEMA_KEYS = new Set(['type', 'properties', 'required']);
const MCP_FIELD_SCHEMA_KEYS = new Set([
    'type',
    'title',
    'description',
    'default',
    'enum',
    'enumNames',
    'oneOf',
    'format',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'items',
    'minItems',
    'maxItems',
]);
const MCP_ARRAY_ITEM_SCHEMA_KEYS = new Set(['type', 'enum', 'anyOf']);

function assertAllowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
    for (const key of Object.keys(record)) {
        if (!allowed.has(key)) throw new Error('Invalid structured input request.');
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredString(record: Record<string, unknown>, key: string, maxLength: number): string {
    const value = record[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
        throw new Error('Invalid structured input request.');
    }
    return value;
}

function readOptionalString(record: Record<string, unknown>, key: string, maxLength: number): string | undefined {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string' || value.length > maxLength) {
        throw new Error('Invalid structured input request.');
    }
    return value;
}

function readBoundedInteger(
    record: Record<string, unknown>,
    key: string,
    minimum: number,
    maximum: number,
): number | undefined {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error('Invalid structured input request.');
    }
    return value;
}

function readBoundedNumber(
    record: Record<string, unknown>,
    key: string,
    minimum: number,
    maximum: number,
): number | undefined {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
        throw new Error('Invalid structured input request.');
    }
    return value;
}

function readScope(params: Record<string, unknown>, turnRequired: boolean): { threadId: string; turnId: string | null } {
    const threadId = readRequiredString(params, 'threadId', MAX_FIELD_ID_LENGTH);
    const turnValue = params.turnId;
    if (turnRequired && (typeof turnValue !== 'string' || turnValue.length === 0 || turnValue.length > MAX_FIELD_ID_LENGTH)) {
        throw new Error('Invalid structured input request.');
    }
    if (!turnRequired && turnValue !== null && (
        typeof turnValue !== 'string' || turnValue.length === 0 || turnValue.length > MAX_FIELD_ID_LENGTH
    )) {
        throw new Error('Invalid structured input request.');
    }
    return { threadId, turnId: typeof turnValue === 'string' ? turnValue : null };
}

function parseOptions(value: unknown, optionLabels?: unknown): CodexStructuredRequestOption[] {
    const options: CodexStructuredRequestOption[] = [];
    if (value === undefined) return options;
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPTION_COUNT) {
        throw new Error('Invalid structured input request.');
    }
    if (optionLabels !== undefined && !Array.isArray(optionLabels)) {
        throw new Error('Invalid structured input request.');
    }
    const labels = Array.isArray(optionLabels) ? optionLabels : [];
    for (let index = 0; index < value.length; index += 1) {
        const optionValue = value[index];
        const label = labels[index];
        if (typeof optionValue !== 'string' || optionValue.length === 0 || optionValue.length > MAX_OPTION_LABEL_LENGTH) {
            throw new Error('Invalid structured input request.');
        }
        if (label !== undefined && (typeof label !== 'string' || label.length > MAX_OPTION_LABEL_LENGTH)) {
            throw new Error('Invalid structured input request.');
        }
        options.push({ value: optionValue, label: typeof label === 'string' && label.length > 0 ? label : optionValue });
    }

    if (options.length === 0) return options;
    const values = new Set<string>();
    for (const option of options) {
        if (values.has(option.value)) throw new Error('Invalid structured input request.');
        values.add(option.value);
    }
    return options;
}

function parseConstOptions(value: unknown): CodexStructuredRequestOption[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_OPTION_COUNT) {
        throw new Error('Invalid structured input request.');
    }
    const options: CodexStructuredRequestOption[] = [];
    const values = new Set<string>();
    for (const entry of value) {
        if (!isRecord(entry)) throw new Error('Invalid structured input request.');
        const optionValue = entry.const;
        const label = entry.title;
        if (
            typeof optionValue !== 'string'
            || optionValue.length === 0
            || optionValue.length > MAX_OPTION_LABEL_LENGTH
            || typeof label !== 'string'
            || label.length === 0
            || label.length > MAX_OPTION_LABEL_LENGTH
            || values.has(optionValue)
        ) {
            throw new Error('Invalid structured input request.');
        }
        values.add(optionValue);
        options.push({ value: optionValue, label });
    }
    return options;
}

function normalizeSelectionOptions(schema: Record<string, unknown>): CodexStructuredRequestOption[] {
    if (schema.enum !== undefined) {
        return parseOptions(schema.enum, schema.enumNames);
    }
    if (schema.oneOf !== undefined) {
        return parseConstOptions(schema.oneOf);
    }
    return [];
}

function validateHttpsUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_MESSAGE_LENGTH) {
        throw new Error('Invalid structured input request.');
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error('Invalid structured input request.');
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') {
        throw new Error('Invalid structured input request.');
    }
    return value;
}

function createSafeDisplayUrl(rawUrl: string): string {
    const url = new URL(rawUrl);
    url.search = '';
    url.hash = '';
    return url.toString();
}

function isValidCalendarDate(value: string): boolean {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

function validateStringFormat(format: CodexStructuredStringFormat, value: string): boolean {
    switch (format) {
        case 'email':
            return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
        case 'uri':
            try {
                const uri = new URL(value);
                return uri.protocol.length > 1 && !/\s/.test(value);
            } catch {
                return false;
            }
        case 'date':
            return isValidCalendarDate(value);
        case 'date-time': {
            const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
            if (!match || !isValidCalendarDate(match[1])) return false;
            const hour = Number(match[2]);
            const minute = Number(match[3]);
            const second = Number(match[4]);
            const offsetHour = match[6] === undefined ? 0 : Number(match[6]);
            const offsetMinute = match[7] === undefined ? 0 : Number(match[7]);
            return hour <= 23
                && minute <= 59
                && second <= 59
                && offsetHour <= 23
                && offsetMinute <= 59
                && Number.isFinite(Date.parse(value));
        }
    }
}

function validateOptionValue(field: CodexStructuredRequestField, value: string): boolean {
    const options = field.options ?? [];
    return options.some((option) => option.value === value) || field.allowOther === true;
}

function validateFieldValue(field: CodexStructuredRequestField, value: unknown): CodexStructuredFieldDefault {
    switch (field.type) {
        case 'text': {
            if (typeof value !== 'string') throw new Error('Invalid structured input response.');
            if (field.minLength !== undefined && value.length < field.minLength) throw new Error('Invalid structured input response.');
            if (field.maxLength !== undefined && value.length > field.maxLength) throw new Error('Invalid structured input response.');
            if (field.format !== undefined && !validateStringFormat(field.format, value)) {
                throw new Error('Invalid structured input response.');
            }
            return value;
        }
        case 'number': {
            if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid structured input response.');
            if (field.minimum !== undefined && value < field.minimum) throw new Error('Invalid structured input response.');
            if (field.maximum !== undefined && value > field.maximum) throw new Error('Invalid structured input response.');
            return value;
        }
        case 'integer': {
            if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error('Invalid structured input response.');
            if (field.minimum !== undefined && value < field.minimum) throw new Error('Invalid structured input response.');
            if (field.maximum !== undefined && value > field.maximum) throw new Error('Invalid structured input response.');
            return value;
        }
        case 'boolean':
            if (typeof value !== 'boolean') throw new Error('Invalid structured input response.');
            return value;
        case 'select':
            if (typeof value !== 'string' || !validateOptionValue(field, value)) throw new Error('Invalid structured input response.');
            return value;
        case 'multiselect': {
            if (!Array.isArray(value) || !value.every((entry): entry is string => typeof entry === 'string')) {
                throw new Error('Invalid structured input response.');
            }
            if (field.minItems !== undefined && value.length < field.minItems) throw new Error('Invalid structured input response.');
            if (field.maxItems !== undefined && value.length > field.maxItems) throw new Error('Invalid structured input response.');
            const values = new Set<string>();
            for (const entry of value) {
                if (values.has(entry) || !validateOptionValue(field, entry)) throw new Error('Invalid structured input response.');
                values.add(entry);
            }
            return [...value];
        }
    }
}

function normalizeTimeout(params: Record<string, unknown>, defaultTimeoutMs: number): number {
    const value = params.autoResolutionMs;
    if (value === null || value === undefined) return defaultTimeoutMs;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_TIMEOUT_MS) {
        throw new Error('Invalid structured input request.');
    }
    return value;
}

function normalizeToolQuestion(question: unknown): NormalizedToolQuestion {
    if (!isRecord(question)) throw new Error('Invalid structured input request.');
    const id = readRequiredString(question, 'id', MAX_FIELD_ID_LENGTH);
    if (UNSAFE_FIELD_IDS.has(id)) throw new Error('Invalid structured input request.');
    const header = readRequiredString(question, 'header', MAX_FIELD_LABEL_LENGTH);
    const prompt = readRequiredString(question, 'question', MAX_FIELD_DESCRIPTION_LENGTH);
    if (typeof question.isOther !== 'boolean' || typeof question.isSecret !== 'boolean') {
        throw new Error('Invalid structured input request.');
    }

    const options = question.options === null || question.options === undefined
        ? []
        : Array.isArray(question.options)
            ? question.options.map((option) => {
                if (!isRecord(option)) throw new Error('Invalid structured input request.');
                const label = readRequiredString(option, 'label', MAX_OPTION_LABEL_LENGTH);
                const description = readRequiredString(option, 'description', MAX_OPTION_LABEL_LENGTH);
                return {
                    value: label,
                    label,
                    description,
                };
            })
            : (() => { throw new Error('Invalid structured input request.'); })();
    if (options.length > MAX_OPTION_COUNT) throw new Error('Invalid structured input request.');
    const values = new Set<string>();
    for (const option of options) {
        if (values.has(option.value)) throw new Error('Invalid structured input request.');
        values.add(option.value);
    }

    return {
        field: {
            id,
            type: options.length > 0 ? 'select' : 'text',
            label: header,
            description: prompt,
            required: true,
            isSecret: question.isSecret,
            ...(question.isOther ? { allowOther: true } : {}),
            ...(options.length > 0 ? { options } : {}),
        },
    };
}

function normalizeToolRequest(
    params: Record<string, unknown>,
    defaultTimeoutMs: number,
): NormalizedStructuredRequest {
    const scope = readScope(params, true);
    const itemId = readRequiredString(params, 'itemId', MAX_FIELD_ID_LENGTH);
    const message = Array.isArray(params.questions)
        ? 'Codex requested input.'
        : 'Codex requested input.';
    if (!Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > 3) {
        throw new Error('Invalid structured input request.');
    }
    if (typeof params.isBlocking !== 'boolean') throw new Error('Invalid structured input request.');
    const fields = params.questions.map(normalizeToolQuestion).map(({ field }) => field);
    const fieldIds = new Set<string>();
    for (const field of fields) {
        if (fieldIds.has(field.id)) throw new Error('Invalid structured input request.');
        fieldIds.add(field.id);
    }
    return {
        kind: 'tool-input',
        threadId: scope.threadId,
        turnId: scope.turnId,
        itemId,
        state: {
            kind: 'tool-input',
            message,
            fields,
            isBlocking: params.isBlocking,
        },
        timeoutMs: normalizeTimeout(params, defaultTimeoutMs),
    };
}

function normalizeMcpField(
    id: string,
    rawSchema: unknown,
    required: boolean,
    strictSchema: boolean,
): CodexStructuredRequestField {
    if (!isRecord(rawSchema)) throw new Error('Invalid structured input request.');
    if (UNSAFE_FIELD_IDS.has(id)) throw new Error('Invalid structured input request.');
    if (strictSchema) assertAllowedKeys(rawSchema, MCP_FIELD_SCHEMA_KEYS);
    const label = readOptionalString(rawSchema, 'title', MAX_FIELD_LABEL_LENGTH) ?? id;
    const description = readOptionalString(rawSchema, 'description', MAX_FIELD_DESCRIPTION_LENGTH);
    const rawType = rawSchema.type;
    const options = normalizeSelectionOptions(rawSchema);
    let type: CodexStructuredFieldType;
    let fieldOptions: CodexStructuredRequestOption[] | undefined;

    if (rawType === 'string') {
        type = options.length > 0 ? 'select' : 'text';
        fieldOptions = options.length > 0 ? options : undefined;
    } else if (rawType === 'number' || rawType === 'integer') {
        if (options.length > 0) throw new Error('Invalid structured input request.');
        type = rawType;
    } else if (rawType === 'boolean') {
        if (options.length > 0) throw new Error('Invalid structured input request.');
        type = 'boolean';
    } else if (rawType === 'array') {
        if (!isRecord(rawSchema.items)) {
            throw new Error('Invalid structured input request.');
        }
        if (strictSchema) assertAllowedKeys(rawSchema.items, MCP_ARRAY_ITEM_SCHEMA_KEYS);
        if (rawSchema.items.type !== undefined && rawSchema.items.type !== 'string') {
            throw new Error('Invalid structured input request.');
        }
        const itemOptions = rawSchema.items.enum !== undefined
            ? parseOptions(rawSchema.items.enum)
            : rawSchema.items.anyOf !== undefined
                ? parseConstOptions(rawSchema.items.anyOf)
                : [];
        if (itemOptions.length === 0) throw new Error('Invalid structured input request.');
        type = 'multiselect';
        fieldOptions = itemOptions;
    } else {
        throw new Error('Invalid structured input request.');
    }

    const field: CodexStructuredRequestField = {
        id,
        type,
        label,
        ...(description ? { description } : {}),
        required,
        ...(fieldOptions ? { options: fieldOptions } : {}),
    };
    if (type !== 'text' && rawSchema.format !== undefined) {
        throw new Error('Invalid structured input request.');
    }
    if (type === 'text') {
        const rawFormat = rawSchema.format;
        if (rawFormat !== undefined) {
            if (typeof rawFormat !== 'string' || !STRING_FORMATS.has(rawFormat as CodexStructuredStringFormat)) {
                throw new Error('Invalid structured input request.');
            }
            field.format = rawFormat as CodexStructuredStringFormat;
        }
        const minLength = readBoundedInteger(rawSchema, 'minLength', 0, MAX_MESSAGE_LENGTH);
        const maxLength = readBoundedInteger(rawSchema, 'maxLength', 0, MAX_MESSAGE_LENGTH);
        if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) throw new Error('Invalid structured input request.');
        if (minLength !== undefined) field.minLength = minLength;
        if (maxLength !== undefined) field.maxLength = maxLength;
    }
    if (type === 'number' || type === 'integer') {
        const minimum = readBoundedNumber(rawSchema, 'minimum', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
        const maximum = readBoundedNumber(rawSchema, 'maximum', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
        if (minimum !== undefined && maximum !== undefined && minimum > maximum) throw new Error('Invalid structured input request.');
        if (minimum !== undefined) field.minimum = minimum;
        if (maximum !== undefined) field.maximum = maximum;
    }
    if (type === 'multiselect') {
        const minItems = readBoundedInteger(rawSchema, 'minItems', 0, MAX_OPTION_COUNT);
        const maxItems = readBoundedInteger(rawSchema, 'maxItems', 0, MAX_OPTION_COUNT);
        if (minItems !== undefined && maxItems !== undefined && minItems > maxItems) throw new Error('Invalid structured input request.');
        if (minItems !== undefined) field.minItems = minItems;
        if (maxItems !== undefined) field.maxItems = maxItems;
    }
    if (rawSchema.default !== undefined) {
        field.defaultValue = validateFieldValue(field, rawSchema.default);
    }
    return field;
}

function normalizeMcpFormRequest(
    params: Record<string, unknown>,
    defaultTimeoutMs: number,
    strictSchema = false,
): NormalizedStructuredRequest {
    const scope = readScope(params, false);
    const serverName = readRequiredString(params, 'serverName', MAX_FIELD_LABEL_LENGTH);
    const message = readRequiredString(params, 'message', MAX_MESSAGE_LENGTH);
    if (!isRecord(params.requestedSchema)) throw new Error('Invalid structured input request.');
    const schemaText = JSON.stringify(params.requestedSchema);
    if (typeof schemaText !== 'string' || Buffer.byteLength(schemaText, 'utf8') > MAX_SCHEMA_BYTES) {
        throw new Error('Invalid structured input request.');
    }
    const schema = params.requestedSchema;
    if (strictSchema) assertAllowedKeys(schema, MCP_ROOT_SCHEMA_KEYS);
    if (schema.type !== 'object' || !isRecord(schema.properties)) throw new Error('Invalid structured input request.');
    const propertyEntries = Object.entries(schema.properties);
    if (propertyEntries.length > MAX_SCHEMA_FIELDS) throw new Error('Invalid structured input request.');
    const requiredValues = schema.required === undefined
        ? []
        : Array.isArray(schema.required)
            ? schema.required
            : (() => { throw new Error('Invalid structured input request.'); })();
    if (requiredValues.length > MAX_SCHEMA_FIELDS || !requiredValues.every((value): value is string => typeof value === 'string')) {
        throw new Error('Invalid structured input request.');
    }
    const requiredSet = new Set<string>();
    for (const value of requiredValues) {
        if (value.length === 0 || value.length > MAX_FIELD_ID_LENGTH || requiredSet.has(value)) {
            throw new Error('Invalid structured input request.');
        }
        requiredSet.add(value);
    }
    const fields = propertyEntries.map(([id, schemaValue]) => {
        if (id.length === 0 || id.length > MAX_FIELD_ID_LENGTH || requiredSet.has(id) && schemaValue === undefined) {
            throw new Error('Invalid structured input request.');
        }
        return normalizeMcpField(id, schemaValue, requiredSet.has(id), strictSchema);
    });
    for (const requiredId of requiredSet) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, requiredId)) {
            throw new Error('Invalid structured input request.');
        }
    }
    return {
        kind: 'mcp-form',
        threadId: scope.threadId,
        turnId: scope.turnId,
        itemId: null,
        state: {
            kind: 'mcp-form',
            message,
            fields,
            serverName,
            isBlocking: true,
        },
        timeoutMs: normalizeTimeout(params, defaultTimeoutMs),
    };
}

function normalizeMcpUrlRequest(
    params: Record<string, unknown>,
    defaultTimeoutMs: number,
): NormalizedStructuredRequest {
    const scope = readScope(params, false);
    const message = readRequiredString(params, 'message', MAX_MESSAGE_LENGTH);
    const serverName = readRequiredString(params, 'serverName', MAX_FIELD_LABEL_LENGTH);
    const url = validateHttpsUrl(params.url);
    const displayUrl = createSafeDisplayUrl(url);
    readRequiredString(params, 'elicitationId', MAX_FIELD_ID_LENGTH);
    return {
        kind: 'mcp-url',
        threadId: scope.threadId,
        turnId: scope.turnId,
        itemId: null,
        state: {
            kind: 'mcp-url',
            message: message.split(url).join(displayUrl),
            fields: [],
            serverName,
            displayUrl,
            isBlocking: true,
        },
        timeoutMs: normalizeTimeout(params, defaultTimeoutMs),
        rawUrl: url,
    };
}

function requestIdMatches(left: CodexStructuredJsonRpcId, right: CodexStructuredJsonRpcId): boolean {
    return typeof left === typeof right && left === right;
}

function failClosedResult(method: CodexStructuredServerRequestContext['method']): Record<string, unknown> {
    return method === 'item/tool/requestUserInput'
        ? { answers: {} }
        : { action: 'cancel', content: null, _meta: null };
}

function cloneState(state: CodexStructuredRequestState): CodexStructuredRequestState {
    return {
        ...state,
        fields: state.fields.map((field) => ({
            ...field,
            ...(field.options ? { options: field.options.map((option) => ({ ...option })) } : {}),
            ...(Array.isArray(field.defaultValue) ? { defaultValue: [...field.defaultValue] } : {}),
        })),
    };
}

export class CodexStructuredInputBroker {
    private session: CodexStructuredInputSession;
    private sessionEpoch = 0;
    private readonly pending = new Map<string, PendingStructuredRequest>();
    private readonly resolved = new Map<string, ResolvedStructuredRequest>();
    private readonly timeoutMs: number;
    private readonly now: () => number;
    private warningSink: ((message: string) => void) | undefined;
    private permissionWaiterCancelSink: ((requestKey: string) => void) | undefined;

    constructor(session: CodexStructuredInputSession, options: CodexStructuredInputBrokerOptions = {}) {
        this.session = session;
        this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 0), MAX_TIMEOUT_MS);
        this.now = options.now ?? Date.now;
        this.warningSink = options.onWarning;
        this.registerRpcHandlers();
    }

    setWarningSink(onWarning: ((message: string) => void) | undefined): void {
        this.warningSink = onWarning;
    }

    setPermissionWaiterCancelSink(onCancel: ((requestKey: string) => void) | undefined): void {
        this.permissionWaiterCancelSink = onCancel;
    }

    updateSession(session: CodexStructuredInputSession): void {
        this.sessionEpoch += 1;
        this.session = session;
        this.registerRpcHandlers();
        this.publishState();
    }

    handleServerRequest(context: CodexStructuredServerRequestContext): void {
        if (!context.isCurrentScope(context.method, context.params)) {
            this.warn(STRUCTURED_WARNING);
            this.respondFailClosed(context);
            return;
        }

        try {
            if (!isRecord(context.params)) throw new Error('Invalid structured input request.');
            if (context.method === 'mcpServer/elicitation/request') {
                const mode = context.params.mode;
                if (mode !== 'form' && mode !== 'openai/form' && mode !== 'openaiForm') {
                    this.warn(STRUCTURED_WARNING);
                    this.respondFailClosed(context);
                    return;
                }
            }

            const normalized = context.method === 'item/tool/requestUserInput'
                ? normalizeToolRequest(context.params, this.timeoutMs)
                : normalizeMcpFormRequest(
                    context.params,
                    this.timeoutMs,
                    context.params.mode === 'openai/form' || context.params.mode === 'openaiForm',
                );
            this.addPending(context, normalized);
        } catch {
            this.warn(STRUCTURED_WARNING);
            this.respondFailClosed(context);
        }
    }

    registerMcpUrlRequest(context: CodexStructuredServerRequestContext): CodexMcpUrlPermissionRequest | null {
        if (
            context.method !== 'mcpServer/elicitation/request'
            || !context.isCurrentScope(context.method, context.params)
        ) {
            this.warn(STRUCTURED_WARNING);
            this.respondFailClosed(context);
            return null;
        }
        try {
            if (!isRecord(context.params) || context.params.mode !== 'url') {
                throw new Error('Invalid structured input request.');
            }
            const normalized = normalizeMcpUrlRequest(context.params, this.timeoutMs);
            const pending = this.addPending(context, normalized);
            const displayUrl = pending.state.displayUrl;
            if (!displayUrl) throw new Error('Invalid structured input request.');
            return {
                requestKey: pending.requestKey,
                permissionInput: {
                    kind: 'mcp-url',
                    requestKey: pending.requestKey,
                    threadId: pending.threadId,
                    turnId: pending.turnId,
                    serverName: pending.state.serverName ?? '',
                    mode: 'url',
                    message: pending.state.message,
                    url: displayUrl,
                    displayUrl,
                    elicitationId: readRequiredString(context.params, 'elicitationId', MAX_FIELD_ID_LENGTH),
                },
            };
        } catch {
            this.warn(STRUCTURED_WARNING);
            this.respondFailClosed(context);
            return null;
        }
    }

    resolveMcpUrlPermission(
        requestKey: string,
        decision: 'approved' | 'approved_for_session' | 'denied' | 'abort',
    ): CodexStructuredInputResponseResult {
        const pending = this.pending.get(requestKey);
        if (!pending || pending.state.kind !== 'mcp-url') return { status: 'already-resolved' };
        const action = decision === 'approved' || decision === 'approved_for_session'
            ? 'accept'
            : decision === 'denied'
                ? 'decline'
                : 'cancel';
        this.resolvePending(
            pending,
            null,
            'permission-response',
            true,
            { action, content: null, _meta: null },
        );
        return { status: 'submitted' };
    }

    handleServerRequestResolved(notification: CodexStructuredResolvedNotification): void {
        const matching = Array.from(this.pending.values()).filter((request) => (
            request.transportGeneration === notification.transportGeneration
            && request.threadId === notification.threadId
            && requestIdMatches(request.nativeRequestId, notification.nativeRequestId)
        ));
        if (matching.length !== 1) return;
        this.resolvePending(matching[0], null, 'server-resolved', false);
    }

    async handleResponse(response: CodexStructuredInputResponse): Promise<CodexStructuredInputResponseResult> {
        return this.handleResponseForEpoch(response, this.sessionEpoch);
    }

    private async handleResponseForEpoch(
        response: CodexStructuredInputResponse,
        epoch: number,
    ): Promise<CodexStructuredInputResponseResult> {
        if (epoch !== this.sessionEpoch) return { status: 'already-resolved' };
        if (!isRecord(response) || typeof response.requestKey !== 'string' || response.requestKey.length > MAX_FIELD_ID_LENGTH) {
            throw new Error('Invalid structured input response.');
        }
        const pending = this.pending.get(response.requestKey);
        if (!pending) return { status: 'already-resolved' };
        if (
            typeof response.submissionId !== 'string'
            || response.submissionId.length === 0
            || response.submissionId.length > MAX_FIELD_ID_LENGTH
            || (response.action !== 'submit' && response.action !== 'decline' && response.action !== 'cancel')
        ) {
            throw new Error('Invalid structured input response.');
        }

        const nativeResult = this.createNativeResponse(pending, response);
        if (!pending.respond(pending.nativeRequestId, nativeResult, pending.transportGeneration)) {
            throw new Error('Codex structured input response could not be delivered.');
        }
        this.resolvePending(pending, response.submissionId, 'client-response', false);
        return { status: 'submitted' };
    }

    clearForTurn(threadId: string, turnId: string, reason: 'turn-completed' | 'turn-interrupted' = 'turn-completed'): void {
        for (const pending of Array.from(this.pending.values())) {
            if (pending.threadId === threadId && pending.turnId === turnId) {
                this.resolvePending(pending, null, reason, true, failClosedResult(pending.method));
            }
        }
    }

    clearForTransport(transportGeneration: number, sendNativeResponse = false): void {
        for (const pending of Array.from(this.pending.values())) {
            if (pending.transportGeneration === transportGeneration) {
                this.resolvePending(
                    pending,
                    null,
                    'transport-disconnect',
                    sendNativeResponse,
                    failClosedResult(pending.method),
                );
            }
        }
    }

    clearAll(reason: 'session-cleanup' | 'session-swap' = 'session-cleanup'): void {
        for (const pending of Array.from(this.pending.values())) {
            this.resolvePending(pending, null, reason, true, failClosedResult(pending.method));
        }
    }

    getPendingState(): CodexStructuredRequestState[] {
        return Array.from(this.pending.values(), (request) => cloneState(request.state));
    }

    private addPending(
        context: CodexStructuredServerRequestContext,
        normalized: NormalizedStructuredRequest,
    ): PendingStructuredRequest {
        const requestKey = randomUUID();
        const createdAt = this.now();
        const state: CodexStructuredRequestState = {
            ...normalized.state,
            requestKey,
            createdAt,
            deadlineAt: createdAt + normalized.timeoutMs,
        };
        const timeout = setTimeout(() => {
            this.resolveByRequestKey(requestKey, null, 'timeout');
        }, normalized.timeoutMs);
        const pending: PendingStructuredRequest = {
            requestKey,
            method: context.method,
            nativeRequestId: context.nativeRequestId,
            transportGeneration: context.transportGeneration,
            threadId: normalized.threadId,
            turnId: normalized.turnId,
            itemId: normalized.itemId,
            state,
            timeout,
            respond: context.respond,
            ...(normalized.rawUrl ? { rawUrl: normalized.rawUrl } : {}),
        };
        this.pending.set(requestKey, pending);
        this.publishState();
        return pending;
    }

    private handleUrlRequest(request: CodexStructuredUrlRequest, epoch: number): CodexStructuredUrlResult {
        if (
            epoch !== this.sessionEpoch
            || !isRecord(request)
            || typeof request.requestKey !== 'string'
            || request.requestKey.length === 0
            || request.requestKey.length > MAX_FIELD_ID_LENGTH
        ) {
            throw new Error('Structured URL is not available.');
        }
        const pending = this.pending.get(request.requestKey);
        if (!pending || pending.state.kind !== 'mcp-url' || pending.rawUrl === undefined) {
            throw new Error('Structured URL is not available.');
        }
        return { url: pending.rawUrl };
    }

    private registerRpcHandlers(): void {
        const epoch = this.sessionEpoch;
        this.session.rpcHandlerManager.registerHandler<CodexStructuredInputResponse, CodexStructuredInputResponseResult>(
            'codex-structured-input-response',
            async (response) => await this.handleResponseForEpoch(response, epoch),
        );
        this.session.rpcHandlerManager.registerHandler<CodexStructuredUrlRequest, CodexStructuredUrlResult>(
            'codex-structured-input-url',
            async (request) => this.handleUrlRequest(request, epoch),
        );
    }

    private warn(message: string): void {
        this.warningSink?.(message);
    }

    private respondFailClosed(context: CodexStructuredServerRequestContext): void {
        try {
            context.respond(
                context.nativeRequestId,
                failClosedResult(context.method),
                context.transportGeneration,
            );
        } catch {
            // The transport may already be gone; the broker has no pending state to retain.
        }
    }

    private createNativeResponse(
        pending: PendingStructuredRequest,
        response: CodexStructuredInputResponse,
    ): Record<string, unknown> {
        if (
            pending.state.kind === 'mcp-url'
            && (response.answers !== undefined || response.content !== undefined)
        ) {
            throw new Error('Invalid structured input response.');
        }
        if (response.action !== 'submit') {
            return pending.method === 'item/tool/requestUserInput'
                ? { answers: {} }
                : { action: response.action === 'decline' ? 'decline' : 'cancel', content: null, _meta: null };
        }
        if (pending.state.kind === 'tool-input') {
            if (!isRecord(response.answers)) throw new Error('Invalid structured input response.');
            return { answers: this.normalizeToolAnswers(pending.state.fields, response.answers) };
        }
        if (pending.state.kind === 'mcp-url') {
            return { action: 'accept', content: null, _meta: null };
        }
        if (response.answers !== undefined && response.content !== undefined) {
            throw new Error('Invalid structured input response.');
        }
        const content = response.answers !== undefined
            ? this.normalizeFormAnswers(pending.state.fields, response.answers)
            : response.content !== undefined
                ? this.normalizeFormContent(pending.state.fields, response.content)
                : this.normalizeFormDefaults(pending.state.fields);
        return { action: 'accept', content, _meta: null };
    }

    private normalizeToolAnswers(
        fields: CodexStructuredRequestField[],
        answers: Record<string, unknown>,
    ): Record<string, { answers: string[] }> {
        const fieldById = new Map(fields.map((field) => [field.id, field]));
        for (const id of Object.keys(answers)) {
            if (!fieldById.has(id)) throw new Error('Invalid structured input response.');
        }
        const normalized: Record<string, { answers: string[] }> = {};
        for (const field of fields) {
            const value = answers[field.id];
            if (value === undefined) throw new Error('Invalid structured input response.');
            if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ANSWER_VALUES) {
                throw new Error('Invalid structured input response.');
            }
            if (!value.every((entry): entry is string => typeof entry === 'string' && entry.length <= MAX_MESSAGE_LENGTH)) {
                throw new Error('Invalid structured input response.');
            }
            if (field.type === 'select' && value.length !== 1) throw new Error('Invalid structured input response.');
            for (const entry of value) {
                if (!validateOptionValue(field, entry) && field.type !== 'text') {
                    throw new Error('Invalid structured input response.');
                }
            }
            normalized[field.id] = { answers: [...value] };
        }
        return normalized;
    }

    private normalizeFormAnswers(
        fields: CodexStructuredRequestField[],
        answers: Record<string, unknown>,
    ): Record<string, CodexStructuredFieldDefault> {
        const content: Record<string, CodexStructuredFieldDefault> = {};
        const fieldById = new Map(fields.map((field) => [field.id, field]));
        for (const id of Object.keys(answers)) {
            if (!fieldById.has(id)) throw new Error('Invalid structured input response.');
        }
        for (const field of fields) {
            const raw = answers[field.id];
            if (raw === undefined) {
                if (field.defaultValue !== undefined) {
                    content[field.id] = field.defaultValue;
                    continue;
                }
                if (field.required) throw new Error('Invalid structured input response.');
                continue;
            }
            if (
                !Array.isArray(raw)
                || raw.length > MAX_ANSWER_VALUES
                || (raw.length === 0 && field.type !== 'multiselect')
            ) {
                throw new Error('Invalid structured input response.');
            }
            if (!raw.every((entry): entry is string => typeof entry === 'string' && entry.length <= MAX_MESSAGE_LENGTH)) {
                throw new Error('Invalid structured input response.');
            }
            if (field.type === 'multiselect') {
                content[field.id] = validateFieldValue(field, raw);
            } else {
                if (raw.length !== 1) throw new Error('Invalid structured input response.');
                const stringValue = raw[0];
                if ((field.type === 'number' || field.type === 'integer') && stringValue.length === 0) {
                    throw new Error('Invalid structured input response.');
                }
                const value = field.type === 'number' || field.type === 'integer'
                    ? Number(stringValue)
                    : field.type === 'boolean'
                        ? stringValue === 'true' ? true : stringValue === 'false' ? false : stringValue
                        : stringValue;
                content[field.id] = validateFieldValue(field, value);
            }
        }
        return content;
    }

    private normalizeFormContent(
        fields: CodexStructuredRequestField[],
        content: Record<string, unknown>,
    ): Record<string, CodexStructuredFieldDefault> {
        const fieldById = new Map(fields.map((field) => [field.id, field]));
        for (const id of Object.keys(content)) {
            if (!fieldById.has(id)) throw new Error('Invalid structured input response.');
        }
        const normalized: Record<string, CodexStructuredFieldDefault> = {};
        for (const field of fields) {
            const value = content[field.id];
            if (value === undefined) {
                if (field.defaultValue !== undefined) normalized[field.id] = field.defaultValue;
                else if (field.required) throw new Error('Invalid structured input response.');
                continue;
            }
            normalized[field.id] = validateFieldValue(field, value);
        }
        return normalized;
    }

    private normalizeFormDefaults(fields: CodexStructuredRequestField[]): Record<string, CodexStructuredFieldDefault> {
        const content: Record<string, CodexStructuredFieldDefault> = {};
        for (const field of fields) {
            if (field.defaultValue !== undefined) content[field.id] = field.defaultValue;
            else if (field.required) throw new Error('Invalid structured input response.');
        }
        return content;
    }

    private resolveByRequestKey(
        requestKey: string,
        submissionId: string | null,
        reason: 'timeout',
    ): void {
        const pending = this.pending.get(requestKey);
        if (!pending) return;
        const nativeResult = failClosedResult(pending.method);
        this.resolvePending(pending, submissionId, reason, true, nativeResult);
    }

    private resolvePending(
        pending: PendingStructuredRequest,
        submissionId: string | null,
        reason: string,
        sendNativeResponse: boolean,
        nativeResult?: Record<string, unknown>,
    ): void {
        if (this.pending.get(pending.requestKey) !== pending) return;
        this.pending.delete(pending.requestKey);
        clearTimeout(pending.timeout);
        this.resolved.set(pending.requestKey, {
            requestKey: pending.requestKey,
            submissionId,
            method: pending.method,
            nativeRequestId: pending.nativeRequestId,
            transportGeneration: pending.transportGeneration,
            threadId: pending.threadId,
            turnId: pending.turnId,
            itemId: pending.itemId,
            resolvedAt: this.now(),
        });
        while (this.resolved.size > MAX_RESOLVED_REQUESTS) {
            const oldest = this.resolved.keys().next().value;
            if (typeof oldest !== 'string') break;
            this.resolved.delete(oldest);
        }
        if (pending.state.kind === 'mcp-url') {
            this.session.updateAgentState((currentState) => {
                if (!currentState.requests?.[pending.requestKey]) return currentState;
                const { [pending.requestKey]: _removed, ...remainingRequests } = currentState.requests;
                return { ...currentState, requests: remainingRequests };
            });
            if (reason !== 'permission-response') {
                this.permissionWaiterCancelSink?.(pending.requestKey);
            }
        }
        this.publishState();
        if (sendNativeResponse && nativeResult !== undefined) {
            try {
                pending.respond(pending.nativeRequestId, nativeResult, pending.transportGeneration);
            } catch {
                // Cleanup is authoritative even when the provider transport is already gone.
            }
        }
        if (reason === 'timeout') {
            this.warn('Codex structured input timed out and was canceled.');
        }
    }

    private publishState(): void {
        const requests = Object.fromEntries(
            Array.from(this.pending.values(), (request) => [request.requestKey, cloneState(request.state)]),
        );
        this.session.updateAgentState((currentState) => ({
            ...currentState,
            ...(Object.keys(requests).length > 0 ? { codexStructuredRequests: requests } : { codexStructuredRequests: undefined }),
        }));
    }

}
