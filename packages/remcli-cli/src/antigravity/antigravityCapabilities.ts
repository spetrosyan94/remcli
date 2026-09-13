import { createHash } from 'node:crypto';

import {
    buildAntigravityCurrentModelCommand,
    buildAntigravityModelsCommand,
    buildAntigravityVersionCommand,
    ANTIGRAVITY_MIN_SUPPORTED_VERSION,
    ANTIGRAVITY_SUPPORTED_MAJOR,
    runAntigravityCommand,
    type AntigravityCommandRunner,
    type AntigravityExecutionMode,
} from './antigravityCli';

const DEFAULT_TTL_MS = 5 * 60 * 1_000;
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MODEL_SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const EFFORTS = ['low', 'medium', 'high'] as const;
export type AntigravityReasoningEffort = typeof EFFORTS[number];
export type AntigravityCapabilityErrorCode = 'unavailable' | 'expired' | 'unsupported_selection';

export interface AntigravityModelCapability {
    id: string;
    displayName: string;
    supportedReasoningEfforts: AntigravityReasoningEffort[];
    runtimeModels: Partial<Record<AntigravityReasoningEffort, string>>;
    defaultReasoningEffort?: AntigravityReasoningEffort;
    isDefault: boolean;
}

export interface AntigravityExecutionConfig {
    /** Exact account-visible slug passed to `agy --model`; never a family alias. */
    model: string;
    reasoningEffort?: AntigravityReasoningEffort;
    catalogVersion: string;
}

export interface AntigravityCapabilitiesSnapshot {
    agent: 'antigravity';
    status: 'ready' | 'unavailable';
    fetchedAt: number | null;
    expiresAt: number | null;
    catalogVersion: string | null;
    cliVersion: string | null;
    models: AntigravityModelCapability[];
    executionModes: AntigravityExecutionMode[];
    supportsDangerouslySkipPermissions: boolean;
    errorCode?: AntigravityCapabilityErrorCode;
}

export interface AntigravityCatalogSource {
    version: string;
    modelsOutput: string;
    currentModelOutput: string;
}

export interface AntigravityCapabilitiesServiceOptions {
    readCatalog?: () => Promise<AntigravityCatalogSource>;
    run?: AntigravityCommandRunner;
    now?: () => number;
    cacheTtlMs?: number;
}

interface CachedCapabilities { snapshot: AntigravityCapabilitiesSnapshot; }

export class AntigravityCapabilitiesError extends Error {
    constructor(readonly code: AntigravityCapabilityErrorCode) {
        super(`Antigravity capability selection rejected: ${code}.`);
        this.name = 'AntigravityCapabilitiesError';
    }
}

export function parseAntigravityModels(output: string): Array<{ slug: string; displayName: string }> {
    if (typeof output !== 'string' || output.length === 0) throw new Error('Antigravity model catalog is empty.');
    const entries = new Map<string, { slug: string; displayName: string }>();
    for (const line of output.split(/\r?\n/)) {
        if (line === '') continue;
        const fields = line.split('\t');
        if (fields.length !== 2) throw new Error('Antigravity model catalog is not tab-separated.');
        const slug = fields[0];
        const displayName = fields[1];
        if (!MODEL_SLUG_PATTERN.test(slug) || displayName.trim() !== displayName || displayName === '') {
            throw new Error('Antigravity model catalog contains an invalid entry.');
        }
        if (entries.has(slug)) throw new Error('Antigravity model catalog contains a duplicate model.');
        entries.set(slug, { slug, displayName });
    }
    if (entries.size === 0) throw new Error('Antigravity model catalog is empty.');
    return [...entries.values()];
}

function normalizeModels(entries: Array<{ slug: string; displayName: string }>, currentSlug: string): AntigravityModelCapability[] {
    if (!MODEL_SLUG_PATTERN.test(currentSlug)) throw new Error('Antigravity current model is invalid.');
    if (!entries.some((entry) => entry.slug === currentSlug)) {
        throw new Error('Antigravity current model is not in the account-visible catalog.');
    }
    const byFamily = new Map<string, AntigravityModelCapability>();
    for (const entry of entries) {
        const slugMatch = /^(.*)-(low|medium|high)$/.exec(entry.slug);
        const displayMatch = /^(.*) \((Low|Medium|High)\)$/.exec(entry.displayName);
        const effort = slugMatch && displayMatch && slugMatch[2] === displayMatch[2].toLowerCase()
            ? slugMatch[2] as AntigravityReasoningEffort
            : undefined;
        const family = effort ? slugMatch![1] : entry.slug;
        const existing = byFamily.get(family);
        if (!existing) {
            byFamily.set(family, {
                id: family,
                displayName: effort ? displayMatch![1] : entry.displayName,
                supportedReasoningEfforts: effort ? [effort] : [],
                runtimeModels: effort ? { [effort]: entry.slug } : {},
                isDefault: false,
            });
        } else {
            if (!effort || existing.runtimeModels[effort]) throw new Error('Antigravity model family has a duplicate variant.');
            existing.supportedReasoningEfforts.push(effort);
            existing.runtimeModels[effort] = entry.slug;
        }
    }
    const defaultModel = [...byFamily.values()].find((model) => (
        (model.supportedReasoningEfforts.length === 0 && model.id === currentSlug)
        || Object.values(model.runtimeModels).includes(currentSlug)
    ));
    if (!defaultModel || [...byFamily.values()].filter((model) => model.id === defaultModel.id).length !== 1) {
        throw new Error('Antigravity current model is not in the account-visible catalog.');
    }
    defaultModel.isDefault = true;
    const defaultEffort = (Object.entries(defaultModel.runtimeModels).find(([, slug]) => slug === currentSlug)?.[0]) as AntigravityReasoningEffort | undefined;
    if (defaultEffort) defaultModel.defaultReasoningEffort = defaultEffort;
    for (const model of byFamily.values()) model.supportedReasoningEfforts.sort();
    return [...byFamily.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function catalogFingerprint(version: string, models: AntigravityModelCapability[]): string {
    return createHash('sha256').update(JSON.stringify({ version, models })).digest('hex').slice(0, 16);
}

export function createAntigravityCapabilitiesSnapshot(source: AntigravityCatalogSource, now: () => number = Date.now, cacheTtlMs = DEFAULT_TTL_MS): AntigravityCapabilitiesSnapshot {
    const versionMatch = VERSION_PATTERN.exec(source.version);
    if (!versionMatch) throw new Error('Antigravity CLI returned an invalid version.');
    const version = versionMatch.slice(1, 4).map(Number);
    const minimumVersion = ANTIGRAVITY_MIN_SUPPORTED_VERSION.split('.').map(Number);
    // Future releases in the supported major are accepted only while every
    // discovery response still satisfies the strict schemas below.
    const isCompatibleVersion = version[0] === ANTIGRAVITY_SUPPORTED_MAJOR
        && (version[1] > minimumVersion[1]
            || (version[1] === minimumVersion[1] && version[2] >= minimumVersion[2]))
        && !source.version.includes('-');
    if (!isCompatibleVersion) throw new Error('Unsupported Antigravity CLI version.');
    const currentModels = parseAntigravityModels(source.currentModelOutput);
    if (currentModels.length !== 1) throw new Error('Antigravity current model output must contain exactly one TSV entry.');
    const models = normalizeModels(parseAntigravityModels(source.modelsOutput), currentModels[0].slug);
    const fetchedAt = now();
    return {
        agent: 'antigravity', status: 'ready', fetchedAt, expiresAt: fetchedAt + cacheTtlMs,
        catalogVersion: catalogFingerprint(source.version, models), cliVersion: source.version,
        models, executionModes: ['default', 'accept-edits', 'plan'], supportsDangerouslySkipPermissions: true,
    };
}

export function getDefaultAntigravityExecution(snapshot: AntigravityCapabilitiesSnapshot): AntigravityExecutionConfig | null {
    if (snapshot.status !== 'ready' || !snapshot.catalogVersion) return null;
    const model = snapshot.models.find((item) => item.isDefault);
    if (!model) return null;
    const effort = model.defaultReasoningEffort;
    const runtimeModel = effort ? model.runtimeModels[effort] : model.id;
    return runtimeModel
        ? { model: runtimeModel, catalogVersion: snapshot.catalogVersion, ...(effort ? { reasoningEffort: effort } : {}) }
        : null;
}

export function validateAntigravityExecution(snapshot: AntigravityCapabilitiesSnapshot, execution: AntigravityExecutionConfig | undefined, now = Date.now()): void {
    if (snapshot.status !== 'ready' || !snapshot.catalogVersion || !execution) throw new AntigravityCapabilitiesError('unavailable');
    if (snapshot.expiresAt === null || snapshot.expiresAt <= now || snapshot.catalogVersion !== execution.catalogVersion) throw new AntigravityCapabilitiesError('expired');
    const model = snapshot.models.find((item) => (
        item.id === execution.model || Object.values(item.runtimeModels).includes(execution.model)
    ));
    if (!model) throw new AntigravityCapabilitiesError('unsupported_selection');
    if (model.id === execution.model && Object.keys(model.runtimeModels).length > 0) {
        throw new AntigravityCapabilitiesError('unsupported_selection');
    }
    if (execution.reasoningEffort !== undefined && model.runtimeModels[execution.reasoningEffort] !== execution.model) {
        throw new AntigravityCapabilitiesError('unsupported_selection');
    }
}

export class AntigravityCapabilitiesService {
    private cached: CachedCapabilities | null = null;
    private inFlight: Promise<CachedCapabilities> | null = null;
    private readonly readCatalog: () => Promise<AntigravityCatalogSource>;
    private readonly now: () => number;
    private readonly cacheTtlMs: number;

    constructor(options: AntigravityCapabilitiesServiceOptions = {}) {
        this.now = options.now ?? Date.now;
        this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_TTL_MS;
        const run = options.run ?? runAntigravityCommand;
        this.readCatalog = options.readCatalog ?? (async () => {
            const version = (await run(buildAntigravityVersionCommand(), 'version discovery')).stdout.trim();
            const modelsOutput = (await run(buildAntigravityModelsCommand(), 'model discovery')).stdout;
            const currentModelOutput = (await run(buildAntigravityCurrentModelCommand(), 'current model discovery')).stdout;
            return { version, modelsOutput, currentModelOutput };
        });
    }

    async getCapabilities(forceRefresh = false): Promise<AntigravityCapabilitiesSnapshot> {
        if (!forceRefresh && this.cached && this.cached.snapshot.expiresAt !== null && this.cached.snapshot.expiresAt > this.now()) return this.cached.snapshot;
        if (forceRefresh) this.cached = null;
        if (!this.inFlight) {
            this.inFlight = this.readCatalog().then((source) => ({ snapshot: createAntigravityCapabilitiesSnapshot(source, this.now, this.cacheTtlMs) }));
        }
        try {
            this.cached = await this.inFlight;
            return this.cached.snapshot;
        } catch {
            return {
                agent: 'antigravity', status: 'unavailable', fetchedAt: null, expiresAt: null,
                catalogVersion: null, cliVersion: null, models: [], executionModes: [],
                supportsDangerouslySkipPermissions: false, errorCode: 'unavailable',
            };
        } finally {
            this.inFlight = null;
        }
    }

    async validateSelection(execution: AntigravityExecutionConfig | undefined): Promise<AntigravityExecutionConfig> {
        validateAntigravityExecution(await this.getCapabilities(false), execution, this.now());
        return execution as AntigravityExecutionConfig;
    }
}
