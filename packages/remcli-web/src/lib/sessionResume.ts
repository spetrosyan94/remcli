import type { AgentId } from "@/components/kit";
import { getCodexResumeSelection } from "@/lib/codexCapabilities";
import { agentSessionIdOf } from "@/lib/homeSessionTriage";
import { isProviderAvailable } from "@/lib/providerAvailability";
import type { CodexCapabilitiesSnapshot, Session, SpawnSessionOptions, SpawnSessionResult } from "@/lib/protocol";

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

const DEFAULT_RESUME_POLL_ATTEMPTS = 10;
const DEFAULT_RESUME_POLL_DELAY_MS = 400;

function defaultSleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
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

    const sleep = dependencies.sleep ?? defaultSleep;
    for (let attempt = 0; attempt < DEFAULT_RESUME_POLL_ATTEMPTS && !dependencies.hasSession(result.sessionId); attempt += 1) {
        await dependencies.refreshSessions().catch(() => undefined);
        if (dependencies.hasSession(result.sessionId)) break;
        await sleep(DEFAULT_RESUME_POLL_DELAY_MS);
    }

    if (!dependencies.hasSession(result.sessionId)) {
        return { type: "spawn-error", errorMessage: "" };
    }

    return { type: "success", sessionId: result.sessionId };
}
