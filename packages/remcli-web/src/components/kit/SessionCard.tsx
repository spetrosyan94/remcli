// remcli — SessionCard (перенос design/screens/components.tsx, разметка 1:1).
import { AgentIcon } from "@/components/kit/AgentIcon";
import { StatusDot } from "@/components/kit/StatusBadge";
import type { AgentId, Status } from "@/components/kit/types";

export function SessionCard(props: {
    agent: AgentId; path: string; message: string; status: Status; time?: string; onClick?: () => void;
}) {
    const { agent, path, message, status, time, onClick } = props;
    const frame =
        status === "permission"
            ? "border-status-permission/40 bg-gradient-to-r from-status-permission/10 to-card"
            : status === "running" || status === "thinking"
                ? "border-accent/35 bg-card"
                : status === "offline"
                    ? "border-border bg-card opacity-55"
                    : "border-border bg-card";
    const msgCls =
        status === "permission" ? "text-status-permission font-medium"
        : status === "running" ? "text-status-running"
        : status === "thinking" ? "text-status-thinking"
        : "text-muted-foreground";
    return (
        <button onClick={onClick} className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${frame}`}>
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
