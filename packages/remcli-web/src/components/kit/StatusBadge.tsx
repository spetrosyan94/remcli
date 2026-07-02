// remcli — StatusDot / StatusBadge (перенос design/screens/components.tsx, разметка 1:1).
import { t } from "@/lib/i18n";
import type { Status } from "@/components/kit/types";

export const STATUS_LABEL: Record<Status, string> = {
    running: t("status.running"),
    thinking: t("status.thinking"),
    permission: t("status.permission"),
    idle: t("status.idle"),
    offline: t("status.offline"),
    error: t("status.error"),
};

export function StatusDot({ status, className = "size-2" }: { status: Status; className?: string }) {
    const map: Record<Status, string> = {
        running: "bg-status-running animate-pulse-run",
        thinking: "bg-status-thinking animate-pulse-think",
        permission: "bg-status-permission",
        idle: "bg-status-idle",
        offline: "border-[1.5px] border-status-offline bg-transparent",
        error: "bg-status-error",
    };
    return <span className={`inline-block shrink-0 rounded-full ${map[status]} ${className}`} />;
}

export function StatusBadge({ status }: { status: Status }) {
    const tint: Record<Status, string> = {
        running: "bg-status-running/10 text-status-running",
        thinking: "bg-status-thinking/10 text-status-thinking",
        permission: "bg-status-permission/10 text-status-permission",
        idle: "bg-muted text-muted-foreground",
        offline: "bg-muted text-muted-foreground",
        error: "bg-status-error/10 text-status-error",
    };
    return (
        <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10.5px] ${tint[status]}`}>
            <StatusDot status={status} className="size-1.5" />
            {STATUS_LABEL[status]}
        </span>
    );
}
