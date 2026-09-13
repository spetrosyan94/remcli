import type { AgentId } from "@/components/kit/types";

export type ProviderAvailability = "available" | "deferred";

export const PROVIDER_AVAILABILITY: Readonly<Record<AgentId, { status: ProviderAvailability }>> = {
    claude: { status: "deferred" },
    codex: { status: "available" },
    antigravity: { status: "available" },
    cursor: { status: "available" },
    unknown: { status: "deferred" },
};

export function isProviderAvailable(agent: AgentId): boolean {
    return PROVIDER_AVAILABILITY[agent].status === "available";
}
