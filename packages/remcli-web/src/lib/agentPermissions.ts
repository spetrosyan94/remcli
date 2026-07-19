import type { AgentId } from "@/components/kit";
import type { PermissionMode } from "@/lib/protocol";

export const PERMISSIONS_BY_AGENT: Record<Exclude<AgentId, "cursor">, PermissionMode[]> = {
    claude: ["manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"],
    codex: ["read-only", "workspace-write", "danger-full-access"],
    gemini: ["manual", "auto_edit", "plan"],
};

const PERMISSION_LABELS: Partial<Record<PermissionMode, string>> = {
    manual: "manual",
    acceptEdits: "acceptEdits",
    bypassPermissions: "bypassPermissions",
    dontAsk: "dontAsk",
    auto_edit: "auto_edit",
};

export function getAgentPermissionModes(agent: AgentId): PermissionMode[] {
    return agent === "cursor" ? [] : PERMISSIONS_BY_AGENT[agent];
}

export function getAgentPermissionLabel(_agent: AgentId, mode: PermissionMode): string {
    return PERMISSION_LABELS[mode] ?? mode;
}

export function getDefaultPermissionMode(agent: Exclude<AgentId, "cursor">): PermissionMode {
    if (agent === "codex") return "workspace-write";
    if (agent === "claude") return "manual";
    const modes = getAgentPermissionModes(agent);
    return modes[0];
}

export function isAgentPermissionMode(agent: AgentId, mode: PermissionMode): boolean {
    return getAgentPermissionModes(agent).includes(mode);
}

export function normalizeAgentPermissionMode(
    agent: Exclude<AgentId, "cursor">,
    mode: PermissionMode | undefined,
): PermissionMode {
    if (mode && isAgentPermissionMode(agent, mode)) return mode;
    return getDefaultPermissionMode(agent);
}
