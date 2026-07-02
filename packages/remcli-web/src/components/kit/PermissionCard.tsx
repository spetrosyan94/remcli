// remcli — PermissionCard (перенос design/screens/components.tsx, разметка 1:1).
import * as React from "react";
import { t } from "@/lib/i18n";

export function PermissionCard(props: {
    tool: string; command: React.ReactNode; comment?: string; danger?: boolean;
    allowLabel?: string; alwaysLabel?: string; time?: string;
    onAllow?: () => void; onDeny?: () => void; onAlways?: () => void;
}) {
    const { tool, command, comment, danger, allowLabel, alwaysLabel, time, onAllow, onDeny, onAlways } = props;
    const c = danger
        ? { frame: "border-status-error/50 bg-status-error/[0.06]", head: "border-status-error/25 text-status-error", dot: "bg-status-error" }
        : { frame: "border-status-permission/45 bg-status-permission/[0.06]", head: "border-status-permission/20 text-status-permission", dot: "bg-status-permission" };
    return (
        <div className={`overflow-hidden rounded-xl border shadow-lg shadow-black/5 ${c.frame}`}>
            <div className={`flex items-center gap-2 border-b px-3 py-2.5 ${c.head}`}>
                <span className={`size-[7px] rounded-full ${c.dot}`} />
                <span className="font-mono text-[11px] font-semibold">
                    {danger ? t("permission.danger") : `${t("permission.title")} · ${tool}`}
                </span>
                {time && <span className="ml-auto font-mono text-[10px] text-muted-foreground">{time}</span>}
            </div>
            <div className="m-3 rounded-lg border border-border bg-zinc-950 px-3 py-2.5 font-mono text-xs leading-relaxed text-zinc-200">
                <span className={danger ? "text-status-error" : "text-emerald-400"}>$</span> {command}
                {comment && <div className="text-zinc-500"># {comment}</div>}
            </div>
            <div className="flex gap-2 px-3 pb-3">
                <button onClick={onAllow}
                    className={`h-11 flex-[1.4] rounded-[11px] text-sm font-semibold ${danger ? "bg-status-error text-white" : "bg-accent text-accent-foreground"}`}>
                    {allowLabel ?? t("permission.allow")}
                </button>
                <button onClick={onDeny} className="h-11 flex-1 rounded-[11px] border border-destructive/35 text-sm font-medium text-destructive">
                    {t("permission.deny")}
                </button>
            </div>
            {!danger && alwaysLabel && (
                <button onClick={onAlways} className="w-full pb-3 text-center font-mono text-[11px] text-muted-foreground">
                    {alwaysLabel}
                </button>
            )}
        </div>
    );
}
