// remcli — SessionCard (перенос design/screens/components.tsx, разметка 1:1).
import { AgentIcon } from "@/components/kit/AgentIcon";
import { StatusDot } from "@/components/kit/StatusBadge";
import type { AgentId, Status } from "@/components/kit/types";

export function SessionCard(props: {
    agent: AgentId; path: string; message: string; status: Status; time?: string; hasTrailingAction?: boolean; onClick?: () => void;
}) {
    const { agent, path, message, status, time, hasTrailingAction, onClick } = props;
    const frame =
        status === "permission"
            ? "border-status-permission/40 bg-gradient-to-r from-status-permission/10 to-card [--status-glow-color:hsl(var(--status-permission)_/_0.24)]"
            : status === "running"
                ? "border-accent/35 bg-card [--status-glow-color:hsl(var(--status-running)_/_0.2)]"
                : status === "thinking"
                    ? "border-accent/35 bg-card [--status-glow-color:hsl(var(--status-thinking)_/_0.2)]"
                    : status === "offline"
                        ? "border-border bg-card opacity-55 [--status-glow-color:hsl(var(--status-offline)_/_0.12)]"
                        : "border-border bg-card [--status-glow-color:hsl(var(--status-idle)_/_0.12)]";
    const msgCls =
        status === "permission" ? "text-status-permission font-medium"
        : status === "running" ? "text-status-running"
        : status === "thinking" ? "text-status-thinking"
        : "text-muted-foreground";
    return (
        <button key={status} onClick={onClick} className={`flex w-full animate-status-glow items-center gap-3 rounded-xl border p-3 text-left transition-[background-color,border-color,color,box-shadow,opacity] duration-[250ms] ease-[var(--ease-out)] ${hasTrailingAction ? "pr-20" : ""} ${frame}`}>
            <AgentIcon agent={agent} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate font-mono text-[13px] font-semibold">{path}</span>
                <span className={`truncate text-xs ${msgCls}`}>{message}</span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
                <StatusDot status={status} />
                {time && <span className="font-mono text-[10px] text-muted-foreground">{time}</span>}
            </span>
        </button>
    );
}
