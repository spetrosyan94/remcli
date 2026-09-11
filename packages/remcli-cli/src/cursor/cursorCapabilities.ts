/**
 * Cursor ACP model discovery and daemon-side selection validation.
 *
 * The available catalog belongs to the authenticated ACP session. Do not use
 * the human-readable `agent models` output here: it can contain CLI variants
 * that the ACP transport cannot select.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import type { SessionModelState } from '@agentclientprotocol/sdk';
import { logger } from '@/ui/logger';
import {
    CURSOR_EXECUTABLE_CANDIDATES,
    isCursorExecutable,
    type CursorExecutable,
} from './cursorCli';
import { CursorAcpClient, type CursorAcpSession } from './cursorAcpClient';

const CAPABILITIES_TTL_MS = 60 * 1_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
const DISCOVERY_MAX_BUFFER_BYTES = 256 * 1_024;
const DISCOVERY_FORCE_KILL_DELAY_MS = 250;
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

export interface CursorAcpCatalogResult {
    executable: CursorExecutable;
    version: string;
    models: SessionModelState;
}

export interface CursorAcpCatalogClient {
    start(): Promise<Pick<CursorAcpSession, 'models'>>;
    dispose(): Promise<void>;
}

export interface CursorAcpCatalogClientFactory {
    (options: { command: CursorExecutable; cwd: string }): CursorAcpCatalogClient;
}

export interface CursorCapabilitiesServiceOptions {
    readCatalog?: () => Promise<CursorAcpCatalogResult>;
    now?: () => number;
    cacheTtlMs?: number;
}

interface CachedCapabilities {
    snapshot: CursorCapabilitiesSnapshot;
    runner: CursorRunnerIdentity | null;
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

function createCursorRunnerIdentity(source: CursorAcpCatalogResult): CursorRunnerIdentity {
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

/**
 * Keep only exact model IDs advertised by the active ACP session. The current
 * ACP selection is the sole default; multiple defaults would make spawn
 * behavior ambiguous and are rejected instead of guessed.
 */
export function normalizeCursorAcpModels(modelState: SessionModelState): CursorModelCapability[] {
    const availableModels = modelState?.availableModels;
    const currentModelId = modelState?.currentModelId;
    if (!Array.isArray(availableModels) || availableModels.length === 0
        || typeof currentModelId !== 'string'
        || currentModelId.trim() !== currentModelId
        || currentModelId === '') {
        throw new Error('Cursor ACP did not return a usable model catalog.');
    }

    const modelIds = new Set<string>();
    const models = availableModels.map((candidate) => {
        if (!candidate
            || typeof candidate.modelId !== 'string'
            || candidate.modelId.trim() !== candidate.modelId
            || candidate.modelId === ''
            || typeof candidate.name !== 'string'
            || candidate.name.trim() === '') {
            throw new Error('Cursor ACP returned an invalid model capability.');
        }
        if (modelIds.has(candidate.modelId)) {
            throw new Error('Cursor ACP returned a duplicate model ID.');
        }
        modelIds.add(candidate.modelId);
        return {
            id: candidate.modelId,
            displayName: candidate.name.trim(),
            isDefault: candidate.modelId === currentModelId,
        };
    });

    if (!modelIds.has(currentModelId) || models.filter((model) => model.isDefault).length !== 1) {
        throw new Error('Cursor ACP did not identify exactly one current model.');
    }

    return models;
}

export function createCursorCapabilitiesSnapshot(
    modelState: SessionModelState,
    now: () => number = Date.now,
    cacheTtlMs: number = CAPABILITIES_TTL_MS,
    runner: CursorRunnerIdentity = createDefaultCursorRunnerIdentity(),
): CursorCapabilitiesSnapshot {
    const models = normalizeCursorAcpModels(modelState);
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

function createCursorAcpCatalogClient(options: { command: CursorExecutable; cwd: string }): CursorAcpCatalogClient {
    return new CursorAcpClient(options);
}

async function readCatalogFromAcp(
    createClient: CursorAcpCatalogClientFactory = createCursorAcpCatalogClient,
): Promise<CursorAcpCatalogResult> {
    let lastNotFoundError: Error | null = null;

    for (const executable of CURSOR_EXECUTABLE_CANDIDATES) {
        try {
            const version = await runCursorVersionCommand(executable);
            const client = createClient({ command: executable, cwd: process.cwd() });
            try {
                const session = await client.start();
                if (!session.models) {
                    throw new Error('Cursor ACP did not return model capabilities.');
                }
                return { executable, version, models: session.models };
            } finally {
                try {
                    await client.dispose();
                } catch {
                    logger.debug('[CursorCapabilities] ACP discovery cleanup did not complete.');
                }
            }
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

/** Daemon-owned cache around the authenticated, exact Cursor ACP model catalog. */
export class CursorCapabilitiesService {
    private readonly readCatalog: () => Promise<CursorAcpCatalogResult>;
    private readonly now: () => number;
    private readonly cacheTtlMs: number;
    private cached: CachedCapabilities | null = null;
    private inFlight: Promise<CachedCapabilities> | null = null;

    constructor(options: CursorCapabilitiesServiceOptions = {}) {
        this.readCatalog = options.readCatalog ?? readCatalogFromAcp;
        this.now = options.now ?? Date.now;
        this.cacheTtlMs = options.cacheTtlMs ?? CAPABILITIES_TTL_MS;
    }

    async getCapabilities(forceRefresh: boolean = false): Promise<CursorCapabilitiesSnapshot> {
        return (await this.getCachedCapabilities(forceRefresh)).snapshot;
    }

    async validateSelection(execution: CursorExecutionConfig | undefined): Promise<CursorRunnerIdentity> {
        const cached = await this.getCachedCapabilities(false);
        validateCursorExecution(cached.snapshot, execution, this.now());
        if (!cached.runner) {
            throw new CursorCapabilitiesError('unavailable');
        }
        return cached.runner;
    }

    async getDefaultSelection(): Promise<CursorDaemonSelection | null> {
        const cached = await this.getCachedCapabilities(false);
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
            const source = await this.readCatalog();
            const runner = createCursorRunnerIdentity(source);
            const snapshot = createCursorCapabilitiesSnapshot(
                source.models,
                this.now,
                this.cacheTtlMs,
                runner,
            );
            this.cached = { snapshot, runner };
            logger.debug(`[CursorCapabilities] refreshed ${snapshot.models.length} ACP models.`);
            return this.cached;
        } catch {
            this.cached = null;
            logger.debug('[CursorCapabilities] discovery unavailable.');
            return { snapshot: unavailableSnapshot('unavailable'), runner: null };
        }
    }
}
