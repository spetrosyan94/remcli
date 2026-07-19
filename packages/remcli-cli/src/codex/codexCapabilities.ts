import { createHash } from 'node:crypto';

import {
    CodexAppServerClient,
    type CodexAppServerConfigRequirements,
    type CodexAppServerModel,
    type CodexAppServerModelListPage,
} from './codexAppServerClient';
import {
    isCodexAppServerStateUsable,
    type CodexAppServerStateSnapshot,
} from './codexAppServerHost';
import type { CodexApprovalPolicy, CodexSandbox } from './types';
import { logger } from '@/ui/logger';

const CAPABILITIES_TTL_MS = 5 * 60 * 1_000;
const MAX_MODEL_LIST_PAGES = 32;
const DEFAULT_PERMISSION_MODES: CodexSandbox[] = [
    'read-only',
    'workspace-write',
    'danger-full-access',
];
const DEFAULT_APPROVAL_POLICIES: CodexApprovalPolicy[] = [
    'untrusted',
    'on-request',
    'never',
];

/** Provider-defined value; it is checked against the live model capability. */
export type CodexReasoningEffort = string;
export type CodexCapabilityErrorCode = 'unavailable' | 'expired' | 'unsupported_selection' | 'policy_denied';

export interface CodexExecutionConfig {
    model: string;
    /** Omitted only when the selected provider model exposes no reasoning choices. */
    reasoningEffort?: CodexReasoningEffort;
    catalogVersion: string;
}

export interface CodexModelCapability {
    id: string;
    displayName: string;
    defaultReasoningEffort?: CodexReasoningEffort;
    supportedReasoningEfforts: CodexReasoningEffort[];
    isDefault: boolean;
}

export interface CodexCapabilitiesSnapshot {
    agent: 'codex';
    status: 'ready' | 'unavailable';
    fetchedAt: number | null;
    expiresAt: number | null;
    catalogVersion: string | null;
    models: CodexModelCapability[];
    permissionModes: CodexSandbox[];
    approvalPolicies: CodexApprovalPolicy[];
    errorCode?: CodexCapabilityErrorCode;
}

export interface CodexCapabilityClient {
    listModels(cursor?: string): Promise<CodexAppServerModelListPage>;
    readConfigRequirements(): Promise<CodexAppServerConfigRequirements>;
    disconnect(): Promise<void>;
}

export interface CodexCapabilitiesServiceOptions {
    getAppServerState: () => CodexAppServerStateSnapshot | null | undefined;
    createClient?: (endpoint: string) => CodexCapabilityClient;
    now?: () => number;
    cacheTtlMs?: number;
    isStateUsable?: (state: CodexAppServerStateSnapshot | null | undefined) => Promise<boolean>;
}

interface CachedCapabilities {
    sourceKey: string;
    snapshot: CodexCapabilitiesSnapshot;
}

export class CodexCapabilitiesError extends Error {
    constructor(readonly code: CodexCapabilityErrorCode) {
        super(`Codex capability selection rejected: ${code}.`);
        this.name = 'CodexCapabilitiesError';
    }
}

function mapSandboxMode(value: string): CodexSandbox | null {
    switch (value) {
        case 'readOnly':
        case 'read-only':
            return 'read-only';
        case 'workspaceWrite':
        case 'workspace-write':
            return 'workspace-write';
        case 'dangerFullAccess':
        case 'danger-full-access':
            return 'danger-full-access';
        default:
            return null;
    }
}

function resolvePermissionModes(requirements: CodexAppServerConfigRequirements): CodexSandbox[] {
    if (!requirements.allowedSandboxModes) {
        return [...DEFAULT_PERMISSION_MODES];
    }
    const modes = requirements.allowedSandboxModes
        .map(mapSandboxMode)
        .filter((mode): mode is CodexSandbox => mode !== null);
    return [...new Set(modes)];
}

function mapApprovalPolicy(value: string): CodexApprovalPolicy | null {
    switch (value) {
        case 'unlessTrusted':
        case 'untrusted':
            return 'untrusted';
        case 'onRequest':
        case 'on-request':
            return 'on-request';
        case 'never':
            return 'never';
        default:
            return null;
    }
}

function resolveApprovalPolicies(requirements: CodexAppServerConfigRequirements): CodexApprovalPolicy[] {
    if (!requirements.allowedApprovalPolicies) {
        return [...DEFAULT_APPROVAL_POLICIES];
    }
    const normalizedPolicies = requirements.allowedApprovalPolicies.map(mapApprovalPolicy);
    if (normalizedPolicies.some((policy) => policy === null)) {
        return [];
    }
    const policies = normalizedPolicies.filter(
        (policy): policy is CodexApprovalPolicy => policy !== null,
    );
    return [...new Set(policies)];
}

function resolveApprovalPolicyForPermissionMode(permissionMode: CodexSandbox): CodexApprovalPolicy {
    return permissionMode === 'danger-full-access' ? 'never' : 'on-request';
}

function toModelCapability(model: CodexAppServerModel): CodexModelCapability {
    const supportedReasoningEfforts = model.supportedReasoningEfforts
        .map((effort) => effort.reasoningEffort)
        .filter((effort) => effort !== '');
    const uniqueEfforts = [...new Set(supportedReasoningEfforts)];
    const defaultReasoningEffort = model.defaultReasoningEffort && uniqueEfforts.includes(model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : undefined;
    return {
        id: model.id,
        displayName: model.displayName,
        ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
        supportedReasoningEfforts: uniqueEfforts,
        isDefault: model.isDefault,
    };
}

function createCatalogVersion(
    models: CodexModelCapability[],
    permissionModes: CodexSandbox[],
    approvalPolicies: CodexApprovalPolicy[],
): string {
    const normalized = models
        .map((model) => ({
            id: model.id,
            defaultReasoningEffort: model.defaultReasoningEffort,
            supportedReasoningEfforts: [...model.supportedReasoningEfforts].sort(),
            isDefault: model.isDefault,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
    const payload = JSON.stringify({
        normalized,
        permissionModes: [...permissionModes].sort(),
        approvalPolicies: [...approvalPolicies].sort(),
    });
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function sourceKey(state: CodexAppServerStateSnapshot): string | null {
    if (!state.codexAppServerEndpoint) return null;
    return `${state.codexAppServerEndpoint}:${state.codexAppServerPid ?? 'unknown'}`;
}

function unavailableSnapshot(code: CodexCapabilityErrorCode): CodexCapabilitiesSnapshot {
    return {
        agent: 'codex',
        status: 'unavailable',
        fetchedAt: null,
        expiresAt: null,
        catalogVersion: null,
        models: [],
        permissionModes: [],
        approvalPolicies: [],
        errorCode: code,
    };
}

export async function fetchCodexCapabilities(
    client: Pick<CodexCapabilityClient, 'listModels' | 'readConfigRequirements'>,
    now: () => number = Date.now,
    cacheTtlMs: number = CAPABILITIES_TTL_MS,
): Promise<CodexCapabilitiesSnapshot> {
    const models: CodexAppServerModel[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let pageNumber = 0; pageNumber < MAX_MODEL_LIST_PAGES; pageNumber += 1) {
        const page = await client.listModels(cursor);
        models.push(...page.data);
        if (!page.nextCursor) break;
        if (seenCursors.has(page.nextCursor)) {
            throw new Error('Codex app-server repeated a model-list cursor.');
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
        if (pageNumber === MAX_MODEL_LIST_PAGES - 1) {
            throw new Error('Codex app-server model-list pagination exceeded the safety limit.');
        }
    }

    const requirements = await client.readConfigRequirements();
    const normalizedModels = models.map(toModelCapability);
    if (normalizedModels.length === 0) {
        throw new Error('Codex app-server did not provide any provider-visible models.');
    }

    const permissionModes = resolvePermissionModes(requirements);
    if (permissionModes.length === 0) {
        throw new Error('Codex app-server policy does not allow any Remcli permission mode.');
    }
    const approvalPolicies = resolveApprovalPolicies(requirements);
    if (approvalPolicies.length === 0) {
        throw new Error('Codex app-server policy does not allow any Remcli approval policy.');
    }

    const fetchedAt = now();
    return {
        agent: 'codex',
        status: 'ready',
        fetchedAt,
        expiresAt: fetchedAt + cacheTtlMs,
        catalogVersion: createCatalogVersion(normalizedModels, permissionModes, approvalPolicies),
        models: normalizedModels,
        permissionModes,
        approvalPolicies,
    };
}

export function getDefaultCodexExecution(snapshot: CodexCapabilitiesSnapshot): CodexExecutionConfig | null {
    if (snapshot.status !== 'ready' || !snapshot.catalogVersion) return null;
    const model = snapshot.models.find((item) => item.isDefault) ?? snapshot.models[0];
    if (!model) return null;
    if (model.supportedReasoningEfforts.length > 0 && !model.defaultReasoningEffort) {
        return null;
    }
    return {
        model: model.id,
        ...(model.defaultReasoningEffort ? { reasoningEffort: model.defaultReasoningEffort } : {}),
        catalogVersion: snapshot.catalogVersion,
    };
}

export function validateCodexExecution(
    snapshot: CodexCapabilitiesSnapshot,
    execution: CodexExecutionConfig | undefined,
    sandbox: CodexSandbox,
    approvalPolicy: CodexApprovalPolicy,
): void {
    if (snapshot.status !== 'ready' || !snapshot.catalogVersion || !execution) {
        throw new CodexCapabilitiesError('unavailable');
    }
    if (snapshot.catalogVersion !== execution.catalogVersion) {
        throw new CodexCapabilitiesError('expired');
    }
    const model = snapshot.models.find((item) => item.id === execution.model);
    if (!model) {
        throw new CodexCapabilitiesError('unsupported_selection');
    }
    if (
        (model.supportedReasoningEfforts.length === 0 && execution.reasoningEffort !== undefined)
        || (model.supportedReasoningEfforts.length > 0
            && (!execution.reasoningEffort || !model.supportedReasoningEfforts.includes(execution.reasoningEffort)))
    ) {
        throw new CodexCapabilitiesError('unsupported_selection');
    }
    if (!snapshot.permissionModes.includes(sandbox) || !snapshot.approvalPolicies.includes(approvalPolicy)) {
        throw new CodexCapabilitiesError('policy_denied');
    }
}

/** Daemon-owned cache around the shared loopback Codex app-server. */
export class CodexCapabilitiesService {
    private readonly createClient: (endpoint: string) => CodexCapabilityClient;
    private readonly now: () => number;
    private readonly cacheTtlMs: number;
    private readonly isStateUsable: (state: CodexAppServerStateSnapshot | null | undefined) => Promise<boolean>;
    private cached: CachedCapabilities | null = null;
    private readonly inFlight = new Map<string, Promise<CodexCapabilitiesSnapshot>>();

    constructor(private readonly options: CodexCapabilitiesServiceOptions) {
        this.createClient = options.createClient ?? ((endpoint) => new CodexAppServerClient({ endpoint }));
        this.now = options.now ?? Date.now;
        this.cacheTtlMs = options.cacheTtlMs ?? CAPABILITIES_TTL_MS;
        this.isStateUsable = options.isStateUsable ?? isCodexAppServerStateUsable;
    }

    async getCapabilities(forceRefresh: boolean = false): Promise<CodexCapabilitiesSnapshot> {
        const state = this.options.getAppServerState();
        const currentSourceKey = state ? sourceKey(state) : null;
        if (!currentSourceKey || !state || !await this.isStateUsable(state)) {
            this.cached = null;
            return unavailableSnapshot('unavailable');
        }

        const cached = this.cached;
        if (!forceRefresh
            && cached?.sourceKey === currentSourceKey
            && cached.snapshot.status === 'ready'
            && cached.snapshot.expiresAt !== null
            && cached.snapshot.expiresAt > this.now()) {
            return cached.snapshot;
        }

        const existingRefresh = this.inFlight.get(currentSourceKey);
        if (existingRefresh) {
            return await existingRefresh;
        }

        let refresh: Promise<CodexCapabilitiesSnapshot>;
        refresh = this.refresh(currentSourceKey, state).finally(() => {
            if (this.inFlight.get(currentSourceKey) === refresh) {
                this.inFlight.delete(currentSourceKey);
            }
        });
        this.inFlight.set(currentSourceKey, refresh);
        return await refresh;
    }

    async validateSelection(
        execution: CodexExecutionConfig | undefined,
        permissionMode: CodexSandbox,
    ): Promise<void> {
        const snapshot = await this.getCapabilities();
        validateCodexExecution(
            snapshot,
            execution,
            permissionMode,
            resolveApprovalPolicyForPermissionMode(permissionMode),
        );
    }

    private async refresh(
        currentSourceKey: string,
        state: CodexAppServerStateSnapshot,
    ): Promise<CodexCapabilitiesSnapshot> {
        const endpoint = state.codexAppServerEndpoint;
        if (!endpoint) return unavailableSnapshot('unavailable');

        const client = this.createClient(endpoint);
        try {
            const snapshot = await fetchCodexCapabilities(client, this.now, this.cacheTtlMs);
            if (this.isCurrentSource(currentSourceKey)) {
                this.cached = { sourceKey: currentSourceKey, snapshot };
            }
            logger.debug(`[CodexCapabilities] refreshed ${snapshot.models.length} provider-visible models.`);
            return snapshot;
        } catch {
            if (this.isCurrentSource(currentSourceKey)) {
                this.cached = null;
            }
            logger.debug('[CodexCapabilities] discovery unavailable.');
            return unavailableSnapshot('unavailable');
        } finally {
            await client.disconnect().catch(() => undefined);
        }
    }

    private isCurrentSource(currentSourceKey: string): boolean {
        const state = this.options.getAppServerState();
        return Boolean(state && sourceKey(state) === currentSourceKey);
    }
}
