export type PermissionDecisionAction = "allow" | "deny" | "always";

export interface PermissionDecisionInput {
    action: PermissionDecisionAction;
    agent: string;
    command?: string;
    tool: string;
}

export type PermissionDecision =
    | {
        allowedTools?: string[];
        approved: true;
        decision?: "approved" | "approved_for_session";
    }
    | {
        approved: false;
        decision?: "abort";
    };

export interface PermissionDecisionGate {
    release(permissionId: string): void;
    tryAcquire(permissionId: string): boolean;
}

/** Maps a visible permission action to the provider-native RPC payload. */
export function createPermissionDecision(input: PermissionDecisionInput): PermissionDecision {
    const isCodex = input.agent === "codex";

    if (input.action === "deny") {
        return {
            approved: false,
            ...(isCodex ? { decision: "abort" as const } : {}),
        };
    }

    if (input.action === "always") {
        if (isCodex) {
            return { approved: true, decision: "approved_for_session" };
        }

        const toolIdentifier = input.tool === "Bash" && input.command
            ? `Bash(${input.command})`
            : input.tool;
        return { allowedTools: [toolIdentifier], approved: true };
    }

    return {
        approved: true,
        ...(isCodex ? { decision: "approved" as const } : {}),
    };
}

/** Keeps a repeated tap from issuing concurrent responses for one permission. */
export function createPermissionDecisionGate(): PermissionDecisionGate {
    const inFlightPermissionIds = new Set<string>();

    return {
        tryAcquire(permissionId) {
            if (inFlightPermissionIds.has(permissionId)) return false;
            inFlightPermissionIds.add(permissionId);
            return true;
        },
        release(permissionId) {
            inFlightPermissionIds.delete(permissionId);
        },
    };
}
