/**
 * Cursor account-visible model discovery and daemon-side selection validation.
 *
 * Cursor currently publishes `agent models` as a text list, rather than a
 * separate machine-readable reasoning API. This boundary keeps that opaque
 * provider list inside the daemon and exposes only normalized model rows.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { logger } from '@/ui/logger';
import {
    CURSOR_EXECUTABLE_CANDIDATES,
    isCursorExecutable,
    type CursorExecutable,
} from './cursorCli';

const CAPABILITIES_TTL_MS = 60 * 1_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
const DISCOVERY_MAX_BUFFER_BYTES = 256 * 1_024;
const DISCOVERY_FORCE_KILL_DELAY_MS = 250;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODEL_LINE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(.+?)$/;
const DEFAULT_SUFFIXES = [' (default)', ' (current, default)'] as const;
const UNKNOWN_DEFAULT_STATUS_MARKER_PATTERN = /\(.*\b(?:current|default)\b.*\)$/i;
const CLI_VERSION_MAX_LENGTH = 256;
const CLI_FINGERPRINT_PATTERN = /^[a-f0-9]{16}$/;

export type CursorCapabilityErrorCode = 'unavailable' | 'expired' | 'unsupported_selection';

export interface CursorExecutionConfig {
    model: string;
    catalogVersion: string;
}

export interface CursorModelCapability {
    id: string;
    displayName: string;
    isDefault: boolean;
}

export interface CursorCapabilitiesSnapshot {
    agent: 'cursor';
    status: 'ready' | 'unavailable';
    fetchedAt: number | null;
    expiresAt: number | null;
    catalogVersion: string | null;
    models: CursorModelCapability[];
    errorCode?: CursorCapabilityErrorCode;
}

export interface CursorCapabilitiesServiceOptions {
    readModelList?: () => Promise<CursorModelListResult>;
    now?: () => number;
    cacheTtlMs?: number;
}

interface CachedCapabilities {
    snapshot: CursorCapabilitiesSnapshot;
    runner: CursorRunnerIdentity | null;
}

export interface CursorModelListResult {
    executable: CursorExecutable;
    output: string;
    version: string;
}

/** Opaque identity bound to the fresh account-visible model catalog. */
export interface CursorRunnerIdentity {
    executable: CursorExecutable;
    cliFingerprint: string;
}

/** Fresh daemon-only Cursor selection used by internal spawn callers. */
export interface CursorDaemonSelection {
    execution: CursorExecutionConfig;
    runner: CursorRunnerIdentity;
}

export class CursorCapabilitiesError extends Error {
    constructor(readonly code: CursorCapabilityErrorCode) {
        super(`Cursor capability selection rejected: ${code}.`);
        this.name = 'CursorCapabilitiesError';
    }
}

function unavailableSnapshot(code: CursorCapabilityErrorCode): CursorCapabilitiesSnapshot {
    return {
        agent: 'cursor',
        status: 'unavailable',
        fetchedAt: null,
        expiresAt: null,
        catalogVersion: null,
        models: [],
        errorCode: code,
    };
}

function createCursorCliFingerprint(executable: CursorExecutable, version: string): string {
    const normalizedVersion = version.trim();
    if (!normalizedVersion
        || normalizedVersion.length > CLI_VERSION_MAX_LENGTH
        || /[\u0000-\u001f]/.test(normalizedVersion)) {
        throw new Error('Cursor CLI returned an unsupported version value.');
    }

    return createHash('sha256')
        .update(`${executable}\u0000${normalizedVersion}`)
        .digest('hex')
        .slice(0, 16);
}

function createCatalogVersion(models: CursorModelCapability[], runner: CursorRunnerIdentity): string {
    const payload = JSON.stringify({
        runner: runner.cliFingerprint,
        models: models.map((model) => ({
            id: model.id,
            displayName: model.displayName,
            isDefault: model.isDefault,
        })),
    });
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function createDefaultCursorRunnerIdentity(): CursorRunnerIdentity {
    return {
        executable: 'agent',
        cliFingerprint: createCursorCliFingerprint('agent', 'test-default'),
    };
}

function createCursorRunnerIdentity(source: CursorModelListResult): CursorRunnerIdentity {
    return {
        executable: source.executable,
        cliFingerprint: createCursorCliFingerprint(source.executable, source.version),
    };
}

export function isCursorRunnerIdentity(value: unknown): value is CursorRunnerIdentity {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (Object.getPrototypeOf(value) !== Object.prototype) return false;

        const record = value as Record<string, unknown>;
        return Reflect.ownKeys(record).length === 2
            && Object.prototype.hasOwnProperty.call(record, 'executable')
            && Object.prototype.hasOwnProperty.call(record, 'cliFingerprint')
            && isCursorExecutable(record.executable)
            && typeof record.cliFingerprint === 'string'
            && CLI_FINGERPRINT_PATTERN.test(record.cliFingerprint);
    } catch {
        return false;
    }
}

function readCursorModelLine(line: string): CursorModelCapability | null {
    const match = MODEL_LINE_PATTERN.exec(line.trim());
    if (!match) return null;

    const [, id, rawDisplayName] = match;
    if (!MODEL_ID_PATTERN.test(id)) return null;

    const defaultSuffix = DEFAULT_SUFFIXES.find((suffix) => rawDisplayName.endsWith(suffix));
    if (!defaultSuffix
        && UNKNOWN_DEFAULT_STATUS_MARKER_PATTERN.test(rawDisplayName)) {
        return null;
    }
    const isDefault = defaultSuffix !== undefined;
    const displayName = (defaultSuffix
        ? rawDisplayName.slice(0, -defaultSuffix.length)
        : rawDisplayName).trim();
    if (!displayName) return null;

    return { id, displayName, isDefault };
}

/** Parse the documented human-readable `agent models` list without returning raw CLI output. */
export function parseCursorModelList(output: string): CursorModelCapability[] {
    const models: CursorModelCapability[] = [];
    const modelIds = new Set<string>();
    let isInsideModelList = false;
    let hasModelListHeader = false;
    let hasModelListFooter = false;

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!hasModelListHeader) {
            if (line === '') continue;
            if (line !== 'Available models') {
                throw new Error('Cursor CLI returned an unsupported model-list header.');
            }
            hasModelListHeader = true;
            isInsideModelList = true;
            continue;
        }
        if (!isInsideModelList) {
            if (line !== '') {
                throw new Error('Cursor CLI returned unexpected output after the model list.');
            }
            continue;
        }
        if (line === '') continue;
        if (line.startsWith('Tip:')) {
            hasModelListFooter = true;
            isInsideModelList = false;
            continue;
        }

        const model = readCursorModelLine(line);
        if (!model) {
            throw new Error('Cursor CLI returned an unsupported model-list row.');
        }
        if (modelIds.has(model.id)) {
            throw new Error('Cursor CLI returned a duplicate model ID.');
        }
        modelIds.add(model.id);
        models.push(model);
    }

    if (!hasModelListHeader || models.length === 0) {
        throw new Error('Cursor CLI did not provide any account-visible models.');
    }
    if (!hasModelListFooter) {
        throw new Error('Cursor CLI did not finish the model list with a recognized footer.');
    }
    const defaults = models.filter((model) => model.isDefault);
    if (defaults.length !== 1) {
        throw new Error('Cursor CLI did not identify exactly one provider default model.');
    }

    return models;
}

export function createCursorCapabilitiesSnapshot(
    output: string,
    now: () => number = Date.now,
    cacheTtlMs: number = CAPABILITIES_TTL_MS,
    runner: CursorRunnerIdentity = createDefaultCursorRunnerIdentity(),
): CursorCapabilitiesSnapshot {
    const models = parseCursorModelList(output);
    const fetchedAt = now();
    return {
        agent: 'cursor',
        status: 'ready',
        fetchedAt,
        expiresAt: fetchedAt + cacheTtlMs,
        catalogVersion: createCatalogVersion(models, runner),
        models,
    };
}

export function getDefaultCursorExecution(snapshot: CursorCapabilitiesSnapshot): CursorExecutionConfig | null {
    if (snapshot.status !== 'ready' || !snapshot.catalogVersion) return null;
    const model = snapshot.models.find((item) => item.isDefault);
    return model ? { model: model.id, catalogVersion: snapshot.catalogVersion } : null;
}

export function validateCursorExecution(
    snapshot: CursorCapabilitiesSnapshot,
    execution: CursorExecutionConfig | undefined,
    now: number = Date.now(),
): void {
    if (snapshot.status !== 'ready' || !snapshot.catalogVersion || !execution) {
        throw new CursorCapabilitiesError('unavailable');
    }
    if (snapshot.expiresAt === null || snapshot.expiresAt <= now) {
        throw new CursorCapabilitiesError('expired');
    }
    if (snapshot.catalogVersion !== execution.catalogVersion) {
        throw new CursorCapabilitiesError('expired');
    }
    if (!snapshot.models.some((model) => model.id === execution.model)) {
        throw new CursorCapabilitiesError('unsupported_selection');
    }
}

function terminateChildProcess(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
    if (!child.pid) return;

    try {
        if (process.platform !== 'win32') {
            process.kill(-child.pid, signal);
            return;
        }
    } catch {
        // Fall back to signalling the direct process below.
    }

    try {
        child.kill(signal);
    } catch {
        // The process already exited between the checks.
    }
}

function runCursorTextCommand(
    executable: CursorExecutable,
    args: string[],
    operation: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, {
            detached: process.platform !== 'win32',
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const outputChunks: Buffer[] = [];
        let outputBytes = 0;
        let didSettle = false;
        let didTimeOut = false;
        let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
        let timeout: ReturnType<typeof setTimeout> | null = null;

        const clearTimeoutTimer = (): void => {
            if (!timeout) return;
            clearTimeout(timeout);
            timeout = null;
        };
        const clearAllTimers = (): void => {
            clearTimeoutTimer();
            if (forceKillTimer) {
                clearTimeout(forceKillTimer);
                forceKillTimer = null;
            }
        };
        const rejectOnce = (error: Error): void => {
            if (didSettle) return;
            didSettle = true;
            clearTimeoutTimer();
            reject(error);
        };
        const resolveOnce = (value: string): void => {
            if (didSettle) return;
            didSettle = true;
            clearAllTimers();
            resolve(value);
        };
        const terminateWithFallback = (): void => {
            terminateChildProcess(child, 'SIGTERM');
            forceKillTimer = setTimeout(() => terminateChildProcess(child, 'SIGKILL'), DISCOVERY_FORCE_KILL_DELAY_MS);
            forceKillTimer.unref();
        };
        timeout = setTimeout(() => {
            didTimeOut = true;
            terminateWithFallback();
            rejectOnce(new Error(`Cursor CLI ${operation} timed out.`));
        }, DISCOVERY_TIMEOUT_MS);
        timeout.unref();

        child.stdout.on('data', (chunk: Buffer) => {
            if (didSettle) return;
            outputBytes += chunk.length;
            if (outputBytes > DISCOVERY_MAX_BUFFER_BYTES) {
                terminateWithFallback();
                rejectOnce(new Error(`Cursor CLI ${operation} exceeded the output limit.`));
                return;
            }
            outputChunks.push(chunk);
        });
        child.stderr.on('data', () => undefined);
        child.once('error', (error) => rejectOnce(error));
        child.once('close', (exitCode) => {
            if (didTimeOut || didSettle) {
                clearAllTimers();
                return;
            }
            if (exitCode !== 0) {
                rejectOnce(new Error(`Cursor CLI ${operation} failed.`));
                return;
            }
            resolveOnce(Buffer.concat(outputChunks).toString('utf8'));
        });
    });
}

function runCursorModelsCommand(executable: CursorExecutable): Promise<string> {
    return runCursorTextCommand(executable, ['models'], 'model discovery');
}

function runCursorVersionCommand(executable: CursorExecutable): Promise<string> {
    return runCursorTextCommand(executable, ['--version'], 'version discovery');
}

/** Verify that a spawned daemon runner still executes the capability-checked CLI. */
export async function verifyCursorRunnerIdentity(runner: CursorRunnerIdentity): Promise<boolean> {
    if (!isCursorRunnerIdentity(runner)) return false;

    try {
        const version = await runCursorVersionCommand(runner.executable);
        return createCursorCliFingerprint(runner.executable, version) === runner.cliFingerprint;
    } catch {
        return false;
    }
}

function isExecutableNotFound(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function readModelListFromCli(): Promise<CursorModelListResult> {
    let lastNotFoundError: Error | null = null;

    for (const executable of CURSOR_EXECUTABLE_CANDIDATES) {
        try {
            const [output, version] = await Promise.all([
                runCursorModelsCommand(executable),
                runCursorVersionCommand(executable),
            ]);
            return { executable, output, version };
        } catch (error) {
            if (isExecutableNotFound(error)) {
                lastNotFoundError = error instanceof Error ? error : new Error('Cursor CLI executable was not found.');
                continue;
            }
            throw error;
        }
    }

    throw lastNotFoundError ?? new Error('Cursor CLI executable was not found.');
}

/** Daemon-owned cache around the account-scoped Cursor CLI model command. */
export class CursorCapabilitiesService {
    private readonly readModelList: () => Promise<CursorModelListResult>;
    private readonly now: () => number;
    private readonly cacheTtlMs: number;
    private cached: CachedCapabilities | null = null;
    private inFlight: Promise<CachedCapabilities> | null = null;

    constructor(options: CursorCapabilitiesServiceOptions = {}) {
        this.readModelList = options.readModelList ?? readModelListFromCli;
        this.now = options.now ?? Date.now;
        this.cacheTtlMs = options.cacheTtlMs ?? CAPABILITIES_TTL_MS;
    }

    async getCapabilities(forceRefresh: boolean = false): Promise<CursorCapabilitiesSnapshot> {
        return (await this.getCachedCapabilities(forceRefresh)).snapshot;
    }

    async validateSelection(execution: CursorExecutionConfig | undefined): Promise<CursorRunnerIdentity> {
        const cached = await this.getCachedCapabilities(true);
        validateCursorExecution(cached.snapshot, execution, this.now());
        if (!cached.runner) {
            throw new CursorCapabilitiesError('unavailable');
        }
        return cached.runner;
    }

    async getDefaultSelection(): Promise<CursorDaemonSelection | null> {
        const cached = await this.getCachedCapabilities(true);
        const execution = getDefaultCursorExecution(cached.snapshot);
        if (!execution || !cached.runner) return null;
        validateCursorExecution(cached.snapshot, execution, this.now());
        return { execution, runner: cached.runner };
    }

    private async getCachedCapabilities(forceRefresh: boolean): Promise<CachedCapabilities> {
        const cached = this.cached;
        if (!forceRefresh
            && cached
            && cached.snapshot.status === 'ready'
            && cached.snapshot.expiresAt !== null
            && cached.snapshot.expiresAt > this.now()) {
            return cached;
        }

        if (this.inFlight) return await this.inFlight;

        let refresh: Promise<CachedCapabilities>;
        refresh = this.refresh().finally(() => {
            if (this.inFlight === refresh) {
                this.inFlight = null;
            }
        });
        this.inFlight = refresh;
        return await refresh;
    }

    private async refresh(): Promise<CachedCapabilities> {
        try {
            const source = await this.readModelList();
            const runner = createCursorRunnerIdentity(source);
            const snapshot = createCursorCapabilitiesSnapshot(
                source.output,
                this.now,
                this.cacheTtlMs,
                runner,
            );
            this.cached = { snapshot, runner };
            logger.debug(`[CursorCapabilities] refreshed ${snapshot.models.length} account-visible models.`);
            return this.cached;
        } catch {
            this.cached = null;
            logger.debug('[CursorCapabilities] discovery unavailable.');
            return { snapshot: unavailableSnapshot('unavailable'), runner: null };
        }
    }
}
