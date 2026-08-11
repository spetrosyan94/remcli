import type { AgentId } from "@/components/kit";
import { isProviderAvailable } from "@/lib/providerAvailability";
import type { Machine, Session } from "@/lib/protocol";

export type HomeSessionFilter = "attention" | "active" | "completed";

export interface MachineGroup {
    key: string;
    name: string;
    isOnline: boolean;
    lastSeenLabel: string | null;
    rpcMachineId: string | null;
    sessions: Session[];
}

export interface HomeQuickResumeCandidate {
    session: Session;
    machine: Machine;
    agent: Extract<AgentId, "codex" | "cursor">;
    nativeSessionId: string;
    directory: string;
    sessionName: string | null;
    cursorModel: string | null;
}

function explicitSessionAgent(session: Session): AgentId | null {
    const agent = session.metadata?.flavor;
    return agent === "claude" || agent === "codex" || agent === "cursor" || agent === "gemini"
        ? agent
        : null;
}

export function agentSessionIdOf(session: Session | null, agent: AgentId): string | undefined {
    const meta = session?.metadata;
    if (!meta) return undefined;
    if (agent === "codex") return meta.codexSessionId ?? meta.agentSessionId;
    if (agent === "gemini") return meta.geminiSessionId ?? meta.agentSessionId;
    if (agent === "cursor") return meta.cursorSessionId ?? meta.agentSessionId;
    return meta.claudeSessionId ?? meta.agentSessionId;
}

function hasPendingSessionPermission(session: Session): boolean {
    const requests = session.agentState?.requests;
    if (!requests) return false;

    const completedRequests = session.agentState?.completedRequests ?? {};
    return Object.keys(requests).some((requestId) => completedRequests[requestId] === undefined);
}

export function needsHomeAttention(session: Session): boolean {
    return hasPendingSessionPermission(session) || session.metadata?.executionOutcome?.kind === "error";
}

/** Lifecycle category for Home. This intentionally does not reuse presentation-only sessionStatus(). */
export function homeSessionCategory(session: Session): HomeSessionFilter {
    if (needsHomeAttention(session)) return "attention";
    return session.active && session.presence === "online" ? "active" : "completed";
}

export function filterMachineGroups(groups: readonly MachineGroup[], filter: HomeSessionFilter): MachineGroup[] {
    return groups.flatMap((group) => {
        const sessions = group.sessions.filter((session) => homeSessionCategory(session) === filter);
        return sessions.length > 0 ? [{ ...group, sessions }] : [];
    });
}

/**
 * Resume never uses a generic single-machine fallback. Sessions with a persisted machine ID
 * require an exact online match; hostname matching is reserved for legacy sessions with no ID.
 */
export function resolveOnlineMachineForResume(session: Session, machines: readonly Machine[]): Machine | null {
    const metadata = session.metadata;
    if (!metadata) return null;

    if (metadata.machineId) {
        return machines.find((machine) => machine.id === metadata.machineId && machine.active) ?? null;
    }

    if (!metadata.host) return null;
    const hostMatches = machines.filter((machine) => machine.active && machine.metadata?.host === metadata.host);
    return hostMatches.length === 1 ? hostMatches[0] : null;
}

function hasActiveNativeWrapper(session: Session, sessions: readonly Session[], agent: AgentId, nativeSessionId: string): boolean {
    return sessions.some((other) => (
        other.id !== session.id
        && other.active
        && other.presence === "online"
        && explicitSessionAgent(other) === agent
        && agentSessionIdOf(other, agent) === nativeSessionId
    ));
}

function hasStoredResumeExecution(session: Session, agent: Extract<AgentId, "codex" | "cursor">): boolean {
    return agent === "codex"
        ? session.metadata?.codexExecution !== undefined
        : Boolean(session.metadata?.cursorExecution?.model.trim());
}

function compareNewestFirst(left: HomeQuickResumeCandidate, right: HomeQuickResumeCandidate): number {
    const updatedAtDelta = right.session.updatedAt - left.session.updatedAt;
    if (updatedAtDelta !== 0) return updatedAtDelta;
    const activeAtDelta = right.session.activeAt - left.session.activeAt;
    if (activeAtDelta !== 0) return activeAtDelta;
    return left.session.id < right.session.id ? -1 : left.session.id > right.session.id ? 1 : 0;
}

export function getHomeQuickResumeCandidate(input: {
    sessions: readonly Session[];
    machines: readonly Machine[];
    isConnected: boolean;
}): HomeQuickResumeCandidate | null {
    if (!input.isConnected) return null;

    const candidates: HomeQuickResumeCandidate[] = [];
    for (const session of input.sessions) {
        if (homeSessionCategory(session) !== "completed") continue;

        const agent = explicitSessionAgent(session);
        if ((agent !== "codex" && agent !== "cursor") || !isProviderAvailable(agent)) continue;

        const directory = session.metadata?.path?.trim();
        const nativeSessionId = agentSessionIdOf(session, agent);
        if (!directory || !nativeSessionId || !hasStoredResumeExecution(session, agent)) continue;
        if (hasActiveNativeWrapper(session, input.sessions, agent, nativeSessionId)) continue;

        const machine = resolveOnlineMachineForResume(session, input.machines);
        if (!machine) continue;

        candidates.push({
            session,
            machine,
            agent,
            nativeSessionId,
            directory,
            sessionName: session.metadata?.name?.trim() || null,
            cursorModel: agent === "cursor"
                ? session.metadata?.cursorExecution?.model.trim() || null
                : null,
        });
    }

    return candidates.sort(compareNewestFirst)[0] ?? null;
}
