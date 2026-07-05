import type { AgentId } from "@/components/kit";
import type { PermissionMode } from "@/lib/protocol";

export const PERMISSIONS_BY_AGENT: Record<AgentId, PermissionMode[]> = {
    claude: ["plan", "default", "acceptEdits", "bypassPermissions"],
    codex: ["read-only", "default", "safe-yolo", "yolo"],
    gemini: ["read-only", "default", "safe-yolo", "yolo"],
    cursor: ["read-only", "plan", "default", "yolo"],
};

export function getAgentPermissionModes(agent: AgentId): PermissionMode[] {
    return PERMISSIONS_BY_AGENT[agent];
}

export function getDefaultPermissionMode(agent: AgentId): PermissionMode {
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
