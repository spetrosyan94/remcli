import type { AgentId } from "@/components/kit";
import type { PermissionMode } from "@/lib/protocol";

export const PERMISSIONS_BY_AGENT: Record<AgentId, PermissionMode[]> = {
    claude: ["manual", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"],
    codex: ["read-only", "workspace-write", "danger-full-access"],
    gemini: ["default", "auto_edit", "plan", "yolo"],
    cursor: ["agent", "plan", "ask", "force", "auto-review"],
};

const PERMISSION_LABELS: Partial<Record<PermissionMode, string>> = {
    manual: "manual",
    acceptEdits: "acceptEdits",
    bypassPermissions: "bypassPermissions",
    dontAsk: "dontAsk",
    auto_edit: "auto_edit",
    "auto-review": "auto-review",
};

export function getAgentPermissionModes(agent: AgentId): PermissionMode[] {
    return PERMISSIONS_BY_AGENT[agent];
}

export function getAgentPermissionLabel(_agent: AgentId, mode: PermissionMode): string {
    return PERMISSION_LABELS[mode] ?? mode;
}

export function getDefaultPermissionMode(agent: AgentId): PermissionMode {
    if (agent === "codex") return "workspace-write";
    if (agent === "claude") return "manual";
    if (agent === "cursor") return "agent";
    const modes = getAgentPermissionModes(agent);
    return modes.includes("default") ? "default" : modes[0];
}

export function isAgentPermissionMode(agent: AgentId, mode: PermissionMode): boolean {
    return getAgentPermissionModes(agent).includes(mode);
}

export function normalizeAgentPermissionMode(agent: AgentId, mode: PermissionMode | undefined): PermissionMode {
    if (mode && isAgentPermissionMode(agent, mode)) return mode;
    return getDefaultPermissionMode(agent);
}
