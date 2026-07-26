/**
 * Runtime boundary for encrypted machine-RPC session spawn requests.
 *
 * The request arrives from an untrusted client. This module turns it into a
 * provider-discriminated product request before any provider adapter or
 * process-spawning code can observe it.
 */

import type { ClaudePermissionMode, GeminiPermissionMode, PermissionMode } from '@/api/types';
import { isClaudePermissionMode } from '@/claude/utils/permissionMode';
import type { CodexExecutionConfig } from '@/codex/codexCapabilities';
import type { CodexSandbox } from '@/codex/types';
import {
    isCursorExecutionMode,
    isCursorSandboxMode,
    type CursorLaunchControls,
} from '@/cursor/cursorLaunchControls';
import type { CursorExecutionConfig } from '@/cursor/cursorCapabilities';
import type { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

const PROVIDER_AGENTS = ['claude', 'codex', 'cursor', 'gemini'] as const;
const SPAWN_TRANSPORT_ENVELOPE_TYPE = 'spawn-in-directory';
const COMMON_REQUEST_KEYS = new Set([
    'agent',
    'directory',
    'sessionId',
    'machineId',
    'approvedNewDirectoryCreation',
    'token',
    'environmentVariables',
    'resumeSessionId',
    'resumeSessionName',
]);
const CODEX_REQUEST_KEYS = new Set([...COMMON_REQUEST_KEYS, 'permissionMode', 'codexExecution']);
const CURSOR_REQUEST_KEYS = new Set([...COMMON_REQUEST_KEYS, 'cursorExecution', 'cursorLaunchControls']);
const GENERIC_REQUEST_KEYS = new Set([...COMMON_REQUEST_KEYS, 'permissionMode']);
const CODEX_EXECUTION_KEYS = new Set(['model', 'catalogVersion', 'reasoningEffort']);
const CURSOR_EXECUTION_KEYS = new Set(['model', 'catalogVersion']);
const CURSOR_LAUNCH_CONTROL_KEYS = new Set([
    'executionMode',
    'force',
    'autoReview',
    'sandbox',
    'approveMcps',
]);
const ENVIRONMENT_VARIABLE_KEYS = new Set([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_MODEL',
    'TMUX_SESSION_NAME',
    'TMUX_TMPDIR',
]);

type ProviderAgent = typeof PROVIDER_AGENTS[number];
type SpawnEnvironmentVariables = NonNullable<SpawnSessionOptions['environmentVariables']>;

interface CommonProviderSpawnRequest {
    directory: string;
    sessionId?: string;
    machineId?: string;
    approvedNewDirectoryCreation?: boolean;
    token?: string;
    environmentVariables?: SpawnEnvironmentVariables;
    resumeSessionId?: string;
    resumeSessionName?: string;
}

export interface ClaudeSpawnRequest extends CommonProviderSpawnRequest {
    agent: 'claude';
    permissionMode?: ClaudePermissionMode;
}

export interface CodexSpawnRequest extends CommonProviderSpawnRequest {
    agent: 'codex';
    permissionMode: CodexSandbox;
    codexExecution: CodexExecutionConfig;
}

export interface CursorSpawnRequest extends CommonProviderSpawnRequest {
    agent: 'cursor';
    cursorExecution: CursorExecutionConfig;
    cursorLaunchControls: CursorLaunchControls;
}

export interface GeminiSpawnRequest extends CommonProviderSpawnRequest {
    agent: 'gemini';
    permissionMode?: GeminiPermissionMode;
}

export type ProviderSpawnRequest = ClaudeSpawnRequest | CodexSpawnRequest | CursorSpawnRequest | GeminiSpawnRequest;

export class ProviderSpawnRequestError extends Error {
    constructor(message = 'Invalid provider spawn request.') {
        super(message);
        this.name = 'ProviderSpawnRequestError';
    }
}

function throwProviderNativeValidationError(agent: ProviderAgent, value: object): never {
    if (agent === 'codex') {
        throw new ProviderSpawnRequestError('Codex requires a current model, reasoning, and permission selection.');
    }
    if (agent === 'cursor') {
        if (Object.prototype.hasOwnProperty.call(value, 'permissionMode')) {
            throw new ProviderSpawnRequestError('Cursor launch controls must not use the generic permissionMode field.');
        }
        throw new ProviderSpawnRequestError('Cursor requires a current model and validated launch controls.');
    }
    throw new ProviderSpawnRequestError();
}

function isPlainDataRecord(value: unknown): value is object {
    try {
        return Boolean(value)
            && typeof value === 'object'
            && !Array.isArray(value)
            && Object.getPrototypeOf(value) === Object.prototype;
    } catch {
        return false;
    }
}

function hasOnlyAllowedDataProperties(value: object, allowedKeys: Set<string>): boolean {
    try {
        return Reflect.ownKeys(value).every((key) => {
            if (typeof key !== 'string' || !allowedKeys.has(key)) return false;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return descriptor !== undefined && descriptor.enumerable === true && 'value' in descriptor;
        });
    } catch {
        return false;
    }
}

function readOwnDataProperty(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && descriptor.enumerable === true && 'value' in descriptor
        ? descriptor.value
        : undefined;
}

/**
 * The encrypted machine-RPC transport owns `type`; provider contracts do not.
 * Copying only data properties prevents it from becoming provider input while
 * retaining the same fail-closed treatment for accessors and foreign keys.
 */
function stripSpawnTransportEnvelope(value: object): object | null {
    if (readRequiredNonEmptyString(value, 'type') !== SPAWN_TRANSPORT_ENVELOPE_TYPE) {
        return null;
    }

    const providerRequest: Record<string, unknown> = {};
    try {
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string') return null;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return null;
            if (key === 'type') continue;
            Object.defineProperty(providerRequest, key, {
                value: descriptor.value,
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    } catch {
        return null;
    }

    return providerRequest;
}

function readRequiredNonEmptyString(value: object, key: string): string | null {
    const property = readOwnDataProperty(value, key);
    return typeof property === 'string' && property.length > 0 ? property : null;
}

function readOptionalNonEmptyString(value: object, key: string): string | undefined | null {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    return readRequiredNonEmptyString(value, key);
}

function readOptionalBoolean(value: object, key: string): boolean | undefined | null {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    const property = readOwnDataProperty(value, key);
    return typeof property === 'boolean' ? property : null;
}

function isKnownPermissionMode(value: unknown): value is PermissionMode {
    return value === 'manual'
        || value === 'acceptEdits'
        || value === 'bypassPermissions'
        || value === 'plan'
        || value === 'auto'
        || value === 'dontAsk'
        || value === 'read-only'
        || value === 'workspace-write'
        || value === 'danger-full-access'
        || value === 'auto_edit';
}

function isProviderAgent(value: unknown): value is ProviderAgent {
    return typeof value === 'string' && (PROVIDER_AGENTS as readonly string[]).includes(value);
}

function isGeminiProviderPermissionMode(value: unknown): value is GeminiPermissionMode {
    return value === 'manual' || value === 'auto_edit' || value === 'plan';
}

function isCodexSandbox(value: unknown): value is CodexSandbox {
    return value === 'read-only'
        || value === 'workspace-write'
        || value === 'danger-full-access';
}

function isNonEmptyStringDataProperty(value: object, key: string): boolean {
    return readRequiredNonEmptyString(value, key) !== null;
}

function isOptionalNonEmptyStringDataProperty(value: object, key: string): boolean {
    return !Object.prototype.hasOwnProperty.call(value, key)
        || readRequiredNonEmptyString(value, key) !== null;
}

function parseCodexExecutionConfig(value: unknown): CodexExecutionConfig | null {
    if (!isPlainDataRecord(value)
        || !hasOnlyAllowedDataProperties(value, CODEX_EXECUTION_KEYS)
        || !isNonEmptyStringDataProperty(value, 'model')
        || !isNonEmptyStringDataProperty(value, 'catalogVersion')
        || !isOptionalNonEmptyStringDataProperty(value, 'reasoningEffort')) {
        return null;
    }
    const model = readRequiredNonEmptyString(value, 'model');
    const catalogVersion = readRequiredNonEmptyString(value, 'catalogVersion');
    const reasoningEffort = readOptionalNonEmptyString(value, 'reasoningEffort');
    if (!model || !catalogVersion || reasoningEffort === null) return null;
    return {
        model,
        catalogVersion,
        ...(reasoningEffort ? { reasoningEffort } : {}),
    };
}

function parseCursorExecutionConfig(value: unknown): CursorExecutionConfig | null {
    if (!isPlainDataRecord(value)
        || !hasOnlyAllowedDataProperties(value, CURSOR_EXECUTION_KEYS)
        || !isNonEmptyStringDataProperty(value, 'model')
        || !isNonEmptyStringDataProperty(value, 'catalogVersion')) {
        return null;
    }
    const model = readRequiredNonEmptyString(value, 'model');
    const catalogVersion = readRequiredNonEmptyString(value, 'catalogVersion');
    return model && catalogVersion ? { model, catalogVersion } : null;
}

function parseCursorLaunchControls(value: unknown): CursorLaunchControls | null {
    if (!isPlainDataRecord(value)
        || !hasOnlyAllowedDataProperties(value, CURSOR_LAUNCH_CONTROL_KEYS)) {
        return null;
    }
    const executionMode = readOwnDataProperty(value, 'executionMode');
    const force = readOwnDataProperty(value, 'force');
    const autoReview = readOwnDataProperty(value, 'autoReview');
    const sandbox = readOwnDataProperty(value, 'sandbox');
    const approveMcps = readOwnDataProperty(value, 'approveMcps');
    if (!isCursorExecutionMode(executionMode)
        || typeof force !== 'boolean'
        || typeof autoReview !== 'boolean'
        || !isCursorSandboxMode(sandbox)
        || typeof approveMcps !== 'boolean') {
        return null;
    }
    return {
        executionMode,
        force,
        autoReview,
        sandbox,
        approveMcps,
    };
}

function readEnvironmentVariables(value: object): SpawnEnvironmentVariables | undefined | null {
    if (!Object.prototype.hasOwnProperty.call(value, 'environmentVariables')) return undefined;
    const environmentVariables = readOwnDataProperty(value, 'environmentVariables');
    if (!isPlainDataRecord(environmentVariables)
        || !hasOnlyAllowedDataProperties(environmentVariables, ENVIRONMENT_VARIABLE_KEYS)) {
        return null;
    }

    const result: SpawnEnvironmentVariables = {};
    for (const key of ENVIRONMENT_VARIABLE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(environmentVariables, key)) continue;
        const variable = readOwnDataProperty(environmentVariables, key);
        if (typeof variable !== 'string') return null;
        switch (key) {
            case 'ANTHROPIC_BASE_URL':
                result.ANTHROPIC_BASE_URL = variable;
                break;
            case 'ANTHROPIC_AUTH_TOKEN':
                result.ANTHROPIC_AUTH_TOKEN = variable;
                break;
            case 'ANTHROPIC_MODEL':
                result.ANTHROPIC_MODEL = variable;
                break;
            case 'TMUX_SESSION_NAME':
                result.TMUX_SESSION_NAME = variable;
                break;
            case 'TMUX_TMPDIR':
                result.TMUX_TMPDIR = variable;
                break;
        }
    }
    return result;
}

function parseCommonRequest(value: object): CommonProviderSpawnRequest | null {
    const directory = readRequiredNonEmptyString(value, 'directory');
    const sessionId = readOptionalNonEmptyString(value, 'sessionId');
    const machineId = readOptionalNonEmptyString(value, 'machineId');
    const approvedNewDirectoryCreation = readOptionalBoolean(value, 'approvedNewDirectoryCreation');
    const token = readOptionalNonEmptyString(value, 'token');
    const resumeSessionId = readOptionalNonEmptyString(value, 'resumeSessionId');
    const resumeSessionName = readOptionalNonEmptyString(value, 'resumeSessionName');
    const environmentVariables = readEnvironmentVariables(value);
    if (directory === null
        || sessionId === null
        || machineId === null
        || approvedNewDirectoryCreation === null
        || token === null
        || resumeSessionId === null
        || resumeSessionName === null
        || environmentVariables === null) {
        return null;
    }

    return {
        directory,
        ...(sessionId ? { sessionId } : {}),
        ...(machineId ? { machineId } : {}),
        ...(approvedNewDirectoryCreation !== undefined ? { approvedNewDirectoryCreation } : {}),
        ...(token ? { token } : {}),
        ...(environmentVariables ? { environmentVariables } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(resumeSessionName ? { resumeSessionName } : {}),
    };
}

function parseAgent(value: object): ProviderAgent | null {
    const agent = readRequiredNonEmptyString(value, 'agent');
    return isProviderAgent(agent) ? agent : null;
}

/**
 * Parse and copy the encrypted RPC payload into the provider-native product
 * contract. Any unknown field, inherited value, accessor, or foreign provider
 * control fails before capability checks or session spawning.
 */
export function parseProviderSpawnRequest(value: unknown): ProviderSpawnRequest {
    if (!isPlainDataRecord(value)) throw new ProviderSpawnRequestError();

    const providerRequest = stripSpawnTransportEnvelope(value);
    if (!providerRequest) throw new ProviderSpawnRequestError();

    const agent = parseAgent(providerRequest);
    if (!agent) throw new ProviderSpawnRequestError();

    const allowedKeys = agent === 'codex'
        ? CODEX_REQUEST_KEYS
        : agent === 'cursor'
            ? CURSOR_REQUEST_KEYS
            : GENERIC_REQUEST_KEYS;
    if (!hasOnlyAllowedDataProperties(providerRequest, allowedKeys)) {
        if (agent === 'cursor' && Object.prototype.hasOwnProperty.call(providerRequest, 'permissionMode')) {
            throwProviderNativeValidationError(agent, providerRequest);
        }
        throw new ProviderSpawnRequestError();
    }

    const common = parseCommonRequest(providerRequest);
    if (!common) throwProviderNativeValidationError(agent, providerRequest);

    if (agent === 'codex') {
        const permissionMode = readOwnDataProperty(providerRequest, 'permissionMode');
        const codexExecution = parseCodexExecutionConfig(readOwnDataProperty(providerRequest, 'codexExecution'));
        if (!isCodexSandbox(permissionMode) || !codexExecution) {
            throwProviderNativeValidationError(agent, providerRequest);
        }
        return { ...common, agent, permissionMode, codexExecution };
    }

    if (agent === 'cursor') {
        const cursorExecution = readOwnDataProperty(providerRequest, 'cursorExecution');
        const cursorLaunchControls = parseCursorLaunchControls(readOwnDataProperty(providerRequest, 'cursorLaunchControls'));
        const parsedCursorExecution = parseCursorExecutionConfig(cursorExecution);
        if (!parsedCursorExecution || !cursorLaunchControls) {
            throwProviderNativeValidationError(agent, providerRequest);
        }
        return { ...common, agent, cursorExecution: parsedCursorExecution, cursorLaunchControls };
    }

    if (!Object.prototype.hasOwnProperty.call(providerRequest, 'permissionMode')) {
        return { ...common, agent };
    }
    const permissionMode = readOwnDataProperty(providerRequest, 'permissionMode');
    if (agent === 'claude'
        && isKnownPermissionMode(permissionMode)
        && isClaudePermissionMode(permissionMode)) {
        return { ...common, agent, permissionMode };
    }
    if (agent === 'gemini'
        && isGeminiProviderPermissionMode(permissionMode)) {
        return { ...common, agent, permissionMode };
    }
    throw new ProviderSpawnRequestError();
}
