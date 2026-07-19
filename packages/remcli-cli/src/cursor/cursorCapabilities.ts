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

const CAPABILITIES_TTL_MS = 60 * 1_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
const DISCOVERY_MAX_BUFFER_BYTES = 256 * 1_024;
const DISCOVERY_FORCE_KILL_DELAY_MS = 250;
const CURSOR_EXECUTABLE_CANDIDATES = ['agent', 'cursor-agent'] as const;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODEL_LINE_PATTERN = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s+-\s+(.+?)$/;
const DEFAULT_SUFFIXES = [' (default)', ' (current, default)'] as const;
const UNKNOWN_DEFAULT_STATUS_MARKER_PATTERN = /\(.*\b(?:current|default)\b.*\)$/i;

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
}

export interface CursorModelListResult {
    executable: string;
    output: string;
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

function createCatalogVersion(models: CursorModelCapability[]): string {
    const payload = JSON.stringify(models.map((model) => ({
        id: model.id,
        displayName: model.displayName,
        isDefault: model.isDefault,
    })));
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
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
): CursorCapabilitiesSnapshot {
    const models = parseCursorModelList(output);
    const fetchedAt = now();
    return {
        agent: 'cursor',
        status: 'ready',
        fetchedAt,
        expiresAt: fetchedAt + cacheTtlMs,
        catalogVersion: createCatalogVersion(models),
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

function runCursorModelsCommand(executable: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, ['models'], {
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
            rejectOnce(new Error('Cursor CLI model discovery timed out.'));
        }, DISCOVERY_TIMEOUT_MS);
        timeout.unref();

        child.stdout.on('data', (chunk: Buffer) => {
            if (didSettle) return;
            outputBytes += chunk.length;
            if (outputBytes > DISCOVERY_MAX_BUFFER_BYTES) {
                terminateWithFallback();
                rejectOnce(new Error('Cursor CLI model discovery exceeded the output limit.'));
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
                rejectOnce(new Error('Cursor CLI model discovery failed.'));
                return;
            }
            resolveOnce(Buffer.concat(outputChunks).toString('utf8'));
        });
    });
}

function isExecutableNotFound(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function readModelListFromCli(): Promise<CursorModelListResult> {
    let lastNotFoundError: Error | null = null;

    for (const executable of CURSOR_EXECUTABLE_CANDIDATES) {
        try {
            return { executable, output: await runCursorModelsCommand(executable) };
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
    private inFlight: Promise<CursorCapabilitiesSnapshot> | null = null;

    constructor(options: CursorCapabilitiesServiceOptions = {}) {
        this.readModelList = options.readModelList ?? readModelListFromCli;
        this.now = options.now ?? Date.now;
        this.cacheTtlMs = options.cacheTtlMs ?? CAPABILITIES_TTL_MS;
    }

    async getCapabilities(forceRefresh: boolean = false): Promise<CursorCapabilitiesSnapshot> {
        const cached = this.cached;
        if (!forceRefresh
            && cached
            && cached.snapshot.status === 'ready'
            && cached.snapshot.expiresAt !== null
            && cached.snapshot.expiresAt > this.now()) {
            return cached.snapshot;
        }

        if (this.inFlight) return await this.inFlight;

        let refresh: Promise<CursorCapabilitiesSnapshot>;
        refresh = this.refresh().finally(() => {
            if (this.inFlight === refresh) {
                this.inFlight = null;
            }
        });
        this.inFlight = refresh;
        return await refresh;
    }

    async validateSelection(execution: CursorExecutionConfig | undefined): Promise<void> {
        validateCursorExecution(await this.getCapabilities(true), execution, this.now());
    }

    private async refresh(): Promise<CursorCapabilitiesSnapshot> {
        try {
            const source = await this.readModelList();
            const snapshot = createCursorCapabilitiesSnapshot(
                source.output,
                this.now,
                this.cacheTtlMs,
            );
            this.cached = { snapshot };
            logger.debug(`[CursorCapabilities] refreshed ${snapshot.models.length} account-visible models.`);
            return snapshot;
        } catch {
            this.cached = null;
            logger.debug('[CursorCapabilities] discovery unavailable.');
            return unavailableSnapshot('unavailable');
        }
    }
}
