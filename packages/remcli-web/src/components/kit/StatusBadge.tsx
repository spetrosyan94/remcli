// remcli — StatusDot / StatusBadge (перенос design/screens/components.tsx, разметка 1:1).
import { t, type I18nKey } from "@/lib/i18n";
import type { Status } from "@/components/kit/types";

const STATUS_LABEL_KEY: Record<Status, I18nKey> = {
    running: "status.running",
    thinking: "status.thinking",
    permission: "status.permission",
    idle: "status.idle",
    offline: "status.offline",
    error: "status.error",
};

// t() вызывается при каждом рендере — подпись обновляется при смене языка без перезагрузки.
export function statusLabel(status: Status): string {
    return t(STATUS_LABEL_KEY[status]);
}

export function StatusDot({ status, className = "size-2" }: { status: Status; className?: string }) {
    const map: Record<Status, string> = {
        running: "bg-status-running animate-pulse-run [--status-glow-color:hsl(var(--status-running)_/_0.28)]",
        thinking: "bg-status-thinking animate-pulse-think [--status-glow-color:hsl(var(--status-thinking)_/_0.28)]",
        permission: "bg-status-permission [--status-glow-color:hsl(var(--status-permission)_/_0.3)]",
        idle: "bg-status-idle",
        offline: "border-[1.5px] border-status-offline bg-transparent",
        error: "bg-status-error [--status-glow-color:hsl(var(--status-error)_/_0.28)]",
    };
    return <span key={status} className={`inline-block shrink-0 rounded-full transition-[background-color,border-color,color,box-shadow,opacity] duration-[250ms] ease-[var(--ease-out)] ${map[status]} ${status !== "idle" && status !== "offline" ? "animate-status-glow" : ""} ${className}`} />;
}

export function StatusBadge({ status }: { status: Status }) {
    const tint: Record<Status, string> = {
        running: "bg-status-running/10 text-status-running [--status-glow-color:hsl(var(--status-running)_/_0.22)]",
        thinking: "bg-status-thinking/10 text-status-thinking [--status-glow-color:hsl(var(--status-thinking)_/_0.22)]",
        permission: "bg-status-permission/10 text-status-permission [--status-glow-color:hsl(var(--status-permission)_/_0.24)]",
        idle: "bg-muted text-muted-foreground [--status-glow-color:hsl(var(--status-idle)_/_0.14)]",
        offline: "bg-muted text-muted-foreground [--status-glow-color:hsl(var(--status-offline)_/_0.14)]",
        error: "bg-status-error/10 text-status-error [--status-glow-color:hsl(var(--status-error)_/_0.22)]",
    };
    return (
        <span key={status} className={`inline-flex animate-status-glow items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10.5px] transition-[background-color,border-color,color,box-shadow] duration-[250ms] ease-[var(--ease-out)] ${tint[status]}`}>
            <StatusDot status={status} className="size-1.5" />
            {statusLabel(status)}
        </span>
    );
}
