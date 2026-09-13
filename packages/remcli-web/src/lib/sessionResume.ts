import type { AgentId } from "@/components/kit";
import { getCodexResumeSelection } from "@/lib/codexCapabilities";
import { agentSessionIdOf } from "@/lib/homeSessionTriage";
import { isProviderAvailable } from "@/lib/providerAvailability";
import type {
    AgentSessionInfo,
    AntigravityCapabilitiesSnapshot,
    AntigravityExecutionConfig,
    AntigravityLaunchControls,
    AntigravitySessionExecution,
    CodexCapabilitiesSnapshot,
    Session,
    SpawnSessionOptions,
    SpawnSessionResult,
} from "@/lib/protocol";

export interface CursorResumeNavigationState {
    cursorResume: {
        machineId: string;
        directory: string;
        resumeSessionId: string;
        resumeSessionName: string | null;
        cursorModel: string;
    };
}

export { agentSessionIdOf };

export function buildCursorResumeNavigationState(input: {
    machineId: string;
    directory: string;
    resumeSessionId: string;
    resumeSessionName?: string;
    cursorModel: string;
}): CursorResumeNavigationState {
    return {
        cursorResume: {
            machineId: input.machineId,
            directory: input.directory,
            resumeSessionId: input.resumeSessionId,
            resumeSessionName: input.resumeSessionName?.trim() || null,
            cursorModel: input.cursorModel,
        },
    };
}

export type ResumeAction = "deferred" | "cursor-navigation" | "machine-spawn";

export function getProviderResumeAction(agent: AgentId): ResumeAction {
    if (!isProviderAvailable(agent)) return "deferred";
    return agent === "cursor" ? "cursor-navigation" : "machine-spawn";
}

export type CodexResumeResult =
    | { type: "success"; sessionId: string }
    | { type: "capabilities-unavailable" }
    | { type: "configuration-unavailable" }
    | { type: "spawn-error"; errorMessage: string };

export interface CodexResumeDependencies {
    getCapabilities: (machineId: string, forceRefresh: boolean) => Promise<CodexCapabilitiesSnapshot>;
    spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    refreshSessions: () => Promise<void>;
    hasSession: (sessionId: string) => boolean;
    sleep?: (milliseconds: number) => Promise<void>;
}

export interface AntigravityResumeDependencies {
    getCapabilities: (machineId: string, forceRefresh: boolean) => Promise<AntigravityCapabilitiesSnapshot>;
    spawn: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    refreshSessions: () => Promise<void>;
    hasSession: (sessionId: string) => boolean;
    sleep?: (milliseconds: number) => Promise<void>;
}

export const SAFE_ANTIGRAVITY_RESUME_CONTROLS: AntigravityLaunchControls = {
    mode: "default",
    dangerouslySkipPermissions: false,
    sandbox: false,
};

const DEFAULT_RESUME_POLL_ATTEMPTS = 10;
const DEFAULT_RESUME_POLL_DELAY_MS = 400;

function defaultSleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

async function waitForSpawnedSession(
    sessionId: string,
    dependencies: Pick<CodexResumeDependencies, "refreshSessions" | "hasSession" | "sleep">,
): Promise<boolean> {
    const sleep = dependencies.sleep ?? defaultSleep;
    for (let attempt = 0; attempt < DEFAULT_RESUME_POLL_ATTEMPTS && !dependencies.hasSession(sessionId); attempt += 1) {
        await dependencies.refreshSessions().catch(() => undefined);
        if (dependencies.hasSession(sessionId)) break;
        await sleep(DEFAULT_RESUME_POLL_DELAY_MS);
    }
    return dependencies.hasSession(sessionId);
}

export function getAntigravityResumeExecution(
    capabilities: AntigravityCapabilitiesSnapshot,
    stored: AntigravitySessionExecution,
): AntigravityExecutionConfig | null {
    if (capabilities.status !== "ready" || !capabilities.catalogVersion) return null;

    for (const model of capabilities.models) {
        if (stored.reasoningEffort === undefined) {
            if (model.supportedReasoningEfforts.length === 0 && model.id === stored.model) {
                return { model: model.id, catalogVersion: capabilities.catalogVersion };
            }
            continue;
        }
        if (!model.supportedReasoningEfforts.includes(stored.reasoningEffort)) continue;
        const runtimeModel = model.runtimeModels[stored.reasoningEffort];
        if (runtimeModel === stored.model) {
            return {
                model: runtimeModel,
                reasoningEffort: stored.reasoningEffort,
                catalogVersion: capabilities.catalogVersion,
            };
        }
    }
    return null;
}

export type StoredAntigravityResumeExecutionResolution =
    | { type: "not-found" }
    | { type: "configuration-unavailable" }
    | { type: "ready"; execution: AntigravityExecutionConfig };

/** Resolve a resume row back to its newest trusted Remcli wrapper and replay its exact model tuple. */
export function resolveStoredAntigravityResumeExecution(
    capabilities: AntigravityCapabilitiesSnapshot,
    remcliSessions: readonly Session[],
    machineId: string,
    target: Pick<AgentSessionInfo, "sessionId" | "projectPath">,
): StoredAntigravityResumeExecutionResolution {
    const source = remcliSessions
        .filter((session) => {
            const metadata = session.metadata;
            return metadata?.flavor === "antigravity"
                && metadata.machineId === machineId
                && metadata.path === target.projectPath
                && Boolean(metadata.antigravityExecution)
                && agentSessionIdOf(session, "antigravity") === target.sessionId;
        })
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];

    if (!source?.metadata?.antigravityExecution) return { type: "not-found" };
    const execution = getAntigravityResumeExecution(capabilities, source.metadata.antigravityExecution);
    return execution
        ? { type: "ready", execution }
        : { type: "configuration-unavailable" };
}

/**
 * Headless stream-json conversations are not appended to Antigravity's interactive
 * history.jsonl. Merge completed Remcli wrappers so every conversation started here
 * remains resumable without mutating provider-owned storage.
 */
export function mergeAntigravityResumeItems(
    nativeItems: readonly AgentSessionInfo[],
    remcliSessions: readonly Session[],
    machineId: string,
    directory?: string,
): AgentSessionInfo[] {
    const activeConversationIds = new Set<string>();
    for (const session of remcliSessions) {
        const metadata = session.metadata;
        if (metadata?.flavor !== "antigravity" || metadata.machineId !== machineId) continue;
        const conversationId = agentSessionIdOf(session, "antigravity");
        if (conversationId && session.active && session.presence === "online") {
            activeConversationIds.add(conversationId);
        }
    }

    const merged = new Map<string, AgentSessionInfo>();
    for (const item of nativeItems) {
        if (!activeConversationIds.has(item.sessionId)) merged.set(item.sessionId, item);
    }

    for (const session of remcliSessions) {
        const metadata = session.metadata;
        if (metadata?.flavor !== "antigravity"
            || metadata.machineId !== machineId
            || !metadata.antigravityExecution
            || !metadata.path
            || directory !== undefined && metadata.path !== directory) {
            continue;
        }
        const conversationId = agentSessionIdOf(session, "antigravity");
        if (!conversationId || activeConversationIds.has(conversationId)) continue;

        const localItem: AgentSessionInfo = {
            sessionId: conversationId,
            agent: "antigravity",
            projectPath: metadata.path,
            lastModified: session.updatedAt,
            firstMessage: null,
            messageCount: 0,
            createdAt: session.createdAt,
            sessionName: metadata.name?.trim() || null,
        };
        const nativeItem = merged.get(conversationId);
        merged.set(conversationId, nativeItem ? {
            ...nativeItem,
            projectPath: nativeItem.projectPath || localItem.projectPath,
            lastModified: Math.max(nativeItem.lastModified, localItem.lastModified),
            firstMessage: nativeItem.firstMessage ?? localItem.firstMessage,
            sessionName: nativeItem.sessionName ?? localItem.sessionName,
            createdAt: nativeItem.createdAt ?? localItem.createdAt,
        } : localItem);
    }

    return [...merged.values()].sort((left, right) => (
        right.lastModified - left.lastModified || left.sessionId.localeCompare(right.sessionId)
    ));
}

/**
 * Replays exactly the saved Codex execution tuple against a freshly fetched catalog. It never
 * substitutes the current default model, reasoning level, or access profile for an old session.
 */
export async function resumeCodexSession(
    session: Session,
    machineId: string,
    dependencies: CodexResumeDependencies,
): Promise<CodexResumeResult> {
    const metadata = session.metadata;
    const nativeSessionId = agentSessionIdOf(session, "codex");
    if (!metadata?.path || !nativeSessionId || !metadata.codexExecution) {
        return { type: "configuration-unavailable" };
    }

    let selection;
    try {
        selection = getCodexResumeSelection(
            await dependencies.getCapabilities(machineId, true),
            metadata.codexExecution,
        );
    } catch {
        return { type: "capabilities-unavailable" };
    }
    if (!selection) return { type: "configuration-unavailable" };

    let result: SpawnSessionResult;
    try {
        result = await dependencies.spawn({
            machineId,
            directory: metadata.path,
            agent: "codex",
            resumeSessionId: nativeSessionId,
            resumeSessionName: metadata.name,
            ...selection,
        });
    } catch {
        return { type: "spawn-error", errorMessage: "" };
    }
    if (result.type !== "success") {
        return result.type === "error"
            ? { type: "spawn-error", errorMessage: result.errorMessage }
            : { type: "configuration-unavailable" };
    }

    if (!await waitForSpawnedSession(result.sessionId, dependencies)) {
        return { type: "spawn-error", errorMessage: "" };
    }

    return { type: "success", sessionId: result.sessionId };
}

/** Resume one exact Antigravity conversation with its saved model tuple and safe controls. */
export async function resumeAntigravitySession(
    session: Session,
    machineId: string,
    dependencies: AntigravityResumeDependencies,
): Promise<CodexResumeResult> {
    const metadata = session.metadata;
    const conversationId = agentSessionIdOf(session, "antigravity");
    if (!metadata?.path || !conversationId || !metadata.antigravityExecution) {
        return { type: "configuration-unavailable" };
    }

    let execution: AntigravityExecutionConfig | null;
    try {
        execution = getAntigravityResumeExecution(
            await dependencies.getCapabilities(machineId, true),
            metadata.antigravityExecution,
        );
    } catch {
        return { type: "capabilities-unavailable" };
    }
    if (!execution) return { type: "configuration-unavailable" };

    let result: SpawnSessionResult;
    try {
        result = await dependencies.spawn({
            machineId,
            directory: metadata.path,
            agent: "antigravity",
            resumeSessionId: conversationId,
            resumeSessionName: metadata.name,
            antigravityExecution: execution,
            antigravityLaunchControls: SAFE_ANTIGRAVITY_RESUME_CONTROLS,
        });
    } catch {
        return { type: "spawn-error", errorMessage: "" };
    }
    if (result.type !== "success") {
        return result.type === "error"
            ? { type: "spawn-error", errorMessage: result.errorMessage }
            : { type: "configuration-unavailable" };
    }

    if (!await waitForSpawnedSession(result.sessionId, dependencies)) {
        return { type: "spawn-error", errorMessage: "" };
    }
    return { type: "success", sessionId: result.sessionId };
}
