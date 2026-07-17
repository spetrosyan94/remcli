// remcli — PermissionCard (перенос design/screens/components.tsx, разметка 1:1).
// Мобайл (<lg) — стековый вариант; десктоп (lg+) — компактная однострочная разметка
// по design/pages/desktop.html: команда + Разрешить/Запретить (34px) + хинт «A — всегда».
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
    const allowClass = danger ? "bg-status-error text-destructive-foreground" : "bg-accent text-accent-foreground";
    return (
        <div className={`animate-permission-glow overflow-hidden rounded-xl border shadow-lg shadow-black/5 transition-[background-color,border-color,box-shadow] duration-[250ms] ease-[var(--ease-out)] ${c.frame}`}>
            <div className={`flex items-center gap-2 border-b px-3 py-2.5 ${c.head}`}>
                <span className={`size-[7px] rounded-full ${c.dot}`} />
                <span className="font-mono text-[11px] font-semibold">
                    {danger ? t("permission.danger") : `${t("permission.title")} · ${tool.toLowerCase()}`}
                </span>
                {time && <span className="ml-auto font-mono text-[10px] text-muted-foreground">{time}</span>}
            </div>

            {/* мобайл: команда блоком + крупные кнопки + «всегда» отдельной строкой */}
            <div className="lg:hidden">
                <div className="m-3 rounded-lg border border-border bg-zinc-950 px-3 py-2.5 font-mono text-xs leading-relaxed text-zinc-200">
                    <span className={danger ? "text-status-error" : "text-emerald-400"}>$</span> {command}
                    {comment && <div className="text-zinc-400"># {comment}</div>}
                </div>
                <div className="flex gap-2 px-3 pb-3">
                    <button onClick={onAllow}
                        className={`h-12 flex-[1.4] cursor-pointer rounded-[11px] text-sm font-semibold ${allowClass}`}>
                        {allowLabel ?? t("permission.allow")}
                    </button>
                    <button onClick={onDeny}
                        className="h-12 flex-1 cursor-pointer rounded-[11px] border border-destructive/35 text-sm font-medium text-destructive">
                        {t("permission.deny")}
                    </button>
                </div>
                {!danger && alwaysLabel && (
                    <button onClick={onAlways}
                        className="flex h-12 w-full cursor-pointer items-center justify-center truncate px-3 text-center font-mono text-[11px] text-muted-foreground">
                        {alwaysLabel}
                    </button>
                )}
            </div>

            {/* десктоп: однострочный компактный вариант (desktop.html) */}
            <div className="hidden items-center gap-3.5 px-3.5 py-[11px] lg:flex">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/85"
                    title={comment ? `# ${comment}` : undefined}>
                    <span className={danger ? "text-status-error" : "text-emerald-400"}>$</span> {command}
                    {comment && <span className="text-muted-foreground"> # {comment}</span>}
                </span>
                <button onClick={onAllow}
                    className={`h-[34px] shrink-0 cursor-pointer rounded-lg px-[18px] text-[13px] font-semibold transition-colors duration-[120ms] ${allowClass}`}>
                    {allowLabel ?? t("permission.allow")}
                </button>
                <button onClick={onDeny}
                    className="h-[34px] shrink-0 cursor-pointer rounded-lg border border-destructive/35 px-3.5 text-[13px] font-medium text-destructive transition-colors duration-[120ms] hover:bg-destructive/10">
                    {t("permission.deny")}
                </button>
                {!danger && alwaysLabel && (
                    <button onClick={onAlways} title={alwaysLabel}
                        className="shrink-0 cursor-pointer font-mono text-[10px] text-muted-foreground transition-colors duration-[120ms] hover:text-foreground">
                        {t("permission.alwaysHint")}
                    </button>
                )}
            </div>
        </div>
    );
}
