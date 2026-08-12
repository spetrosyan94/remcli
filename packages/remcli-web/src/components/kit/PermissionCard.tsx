// remcli — PermissionCard (перенос design/screens/components.tsx, разметка 1:1).
// Мобайл (<lg) — стековый вариант; десктоп (lg+) — компактная однострочная разметка
// по design/pages/desktop.html: команда + Разрешить/Запретить (34px) + хинт «A — всегда».
import * as React from "react";
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";

type PermissionResponseState = "idle" | "sending" | "error";

function PermissionResponseFeedback({
    onRetry,
    state,
}: {
    onRetry?: () => void;
    state: PermissionResponseState;
}) {
    if (state === "sending") {
        return (
            <div role="status" aria-live="polite" data-permission-response="sending"
                className="flex min-h-9 items-center gap-2 border-t border-status-permission/20 px-3 py-2 font-mono text-[11px] text-status-permission animate-in fade-in duration-[var(--dur-micro)]">
                <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                <span className="min-w-0 break-words">{t("permission.sending")}</span>
            </div>
        );
    }

    if (state === "error") {
        return (
            <div role="alert" aria-live="assertive" data-permission-response="error"
                className="flex min-h-10 items-center gap-2 border-t border-status-error/25 px-3 py-2 font-mono text-[11px] text-status-error animate-in fade-in duration-[var(--dur-micro)]">
                <span className="min-w-0 flex-1 break-words">{t("permission.responseFailed")}</span>
                {onRetry && (
                    <button type="button" onClick={onRetry}
                        className="inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-lg border border-status-error/45 px-2.5 font-mono text-[10.5px] font-semibold text-status-error transition-[background-color,border-color,color,transform] duration-[var(--dur-micro)] hover:bg-status-error/10 active:scale-[0.96] lg:h-8 lg:min-w-0">
                        {t("permission.retry")}
                    </button>
                )}
            </div>
        );
    }

    return null;
}

export function PermissionCard(props: {
    tool: string; command: React.ReactNode; comment?: string; danger?: boolean;
    allowLabel?: string; alwaysLabel?: string; time?: string;
    onAllow?: () => void; onDeny?: () => void; onAlways?: () => void;
    onRetry?: () => void; responseState?: PermissionResponseState;
}) {
    const {
        tool, command, comment, danger, allowLabel, alwaysLabel, time,
        onAllow, onDeny, onAlways, onRetry, responseState = "idle",
    } = props;
    const isSubmitting = responseState === "sending";
    const c = danger
        ? { frame: "border-status-error/50 bg-status-error/[0.06]", head: "border-status-error/25 text-status-error", dot: "bg-status-error" }
        : { frame: "border-status-permission/45 bg-status-permission/[0.06]", head: "border-status-permission/20 text-status-permission", dot: "bg-status-permission" };
    const allowClass = danger ? "bg-status-error text-destructive-foreground" : "bg-accent text-accent-foreground";
    return (
        <div aria-busy={isSubmitting || undefined} data-permission-response-state={responseState}
            className={`animate-permission-glow overflow-hidden rounded-xl border shadow-lg shadow-black/5 transition-[background-color,border-color,box-shadow] duration-[250ms] ease-[var(--ease-out)] ${c.frame}`}>
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
                    <button type="button" onClick={onAllow} disabled={isSubmitting}
                        className={`h-12 flex-[1.4] cursor-pointer rounded-[11px] text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-55 ${allowClass}`}>
                        {allowLabel ?? t("permission.allow")}
                    </button>
                    <button type="button" onClick={onDeny} disabled={isSubmitting}
                        className="h-12 flex-1 cursor-pointer rounded-[11px] border border-destructive/35 text-sm font-medium text-destructive disabled:cursor-not-allowed disabled:opacity-55">
                        {t("permission.deny")}
                    </button>
                </div>
                {!danger && alwaysLabel && (
                    <button type="button" onClick={onAlways} disabled={isSubmitting}
                        className="flex h-12 w-full cursor-pointer items-center justify-center truncate px-3 text-center font-mono text-[11px] text-muted-foreground disabled:cursor-not-allowed disabled:opacity-55">
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
                <button type="button" onClick={onAllow} disabled={isSubmitting}
                    className={`h-[34px] shrink-0 cursor-pointer rounded-lg px-[18px] text-[13px] font-semibold transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:opacity-55 ${allowClass}`}>
                    {allowLabel ?? t("permission.allow")}
                </button>
                <button type="button" onClick={onDeny} disabled={isSubmitting}
                    className="h-[34px] shrink-0 cursor-pointer rounded-lg border border-destructive/35 px-3.5 text-[13px] font-medium text-destructive transition-colors duration-[120ms] hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:bg-transparent">
                    {t("permission.deny")}
                </button>
                {!danger && alwaysLabel && (
                    <button type="button" onClick={onAlways} disabled={isSubmitting} title={alwaysLabel}
                        className="shrink-0 cursor-pointer font-mono text-[10px] text-muted-foreground transition-colors duration-[120ms] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:text-muted-foreground">
                        {t("permission.alwaysHint")}
                    </button>
                )}
            </div>
            <PermissionResponseFeedback state={responseState} onRetry={onRetry} />
        </div>
    );
}
