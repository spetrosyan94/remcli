// remcli — ToolCallCard (перенос design/screens/components.tsx, разметка 1:1).
import * as React from "react";
import { Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";

export function ToolCallCard(props: {
    tool: string; arg: string; state: "running" | "success" | "error";
    expanded?: boolean; children?: React.ReactNode; errorText?: string; onToggle?: () => void;
}) {
    const { tool, arg, state, expanded, children, errorText, onToggle } = props;
    const outputId = React.useId();
    const canToggle = Boolean(onToggle && children);

    const header = (
        <>
            {expanded ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
            <span className="text-muted-foreground">{tool}</span>
            <span className="flex-1 truncate">{arg}</span>
            {state === "running" && <Loader2 className="size-3.5 animate-spin text-accent" />}
            {state === "success" && <Check className="size-3.5 text-status-running" />}
            {state === "error" && <span className="text-[10.5px] text-status-error">{errorText ?? "exit 1"}</span>}
        </>
    );

    return (
        <div className={`overflow-hidden rounded-[9px] border bg-card ${state === "error" ? "border-status-error/35" : "border-border"}`}>
            {canToggle ? (
                <button
                    type="button"
                    onClick={onToggle}
                    aria-controls={outputId}
                    aria-expanded={Boolean(expanded)}
                    className="flex min-h-11 w-full items-center gap-2.5 px-3 py-2 text-left font-mono text-xs transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                >
                    {header}
                </button>
            ) : (
                <div className="flex items-center gap-2.5 px-3 py-2 font-mono text-xs">{header}</div>
            )}
            {expanded && children && (
                <div id={outputId} className="select-text border-t border-border bg-zinc-950 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-zinc-200">
                    {children}
                </div>
            )}
        </div>
    );
}
