// remcli — AgentIcon (перенос design/screens/components.tsx, разметка 1:1).
import type { AgentId } from "@/components/kit/types";

const AGENT: Record<AgentId, { tag: string; cls: string }> = {
    claude: { tag: "cl", cls: "bg-[#D97757]/15 text-[#9A4A2D] dark:text-[#E8916F]" },
    codex: { tag: "cx", cls: "bg-teal-400/10 text-teal-700 dark:text-teal-300" },
    gemini: { tag: "gm", cls: "bg-blue-400/10 text-blue-600 dark:text-blue-300" },
    cursor: { tag: "cu", cls: "bg-zinc-400/10 text-zinc-600 dark:text-zinc-300" },
};

export function AgentIcon({ agent, className = "size-8 rounded-lg text-xs" }: { agent: AgentId; className?: string }) {
    return (
        <span className={`flex shrink-0 items-center justify-center font-mono font-bold ${AGENT[agent].cls} ${className}`}>
            {AGENT[agent].tag}
        </span>
    );
}
