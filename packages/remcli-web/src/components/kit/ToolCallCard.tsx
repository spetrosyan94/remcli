// remcli — ToolCallCard (перенос design/screens/components.tsx, разметка 1:1).
import * as React from "react";
import { Check, ChevronDown, ChevronRight, Loader2 } from "lucide-react";

export function ToolCallCard(props: {
    tool: string; arg: string; state: "running" | "success" | "error";
    expanded?: boolean; children?: React.ReactNode; errorText?: string;
}) {
    const { tool, arg, state, expanded, children, errorText } = props;
    return (
        <div className={`overflow-hidden rounded-[9px] border bg-card ${state === "error" ? "border-status-error/35" : "border-border"}`}>
            <div className="flex items-center gap-2.5 px-3 py-2 font-mono text-xs">
                {expanded ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
                <span className="text-muted-foreground">{tool}</span>
                <span className="flex-1 truncate">{arg}</span>
                {state === "running" && <Loader2 className="size-3.5 animate-spin text-accent" />}
                {state === "success" && <Check className="size-3.5 text-status-running" />}
                {state === "error" && <span className="text-[10.5px] text-status-error">{errorText ?? "exit 1"}</span>}
            </div>
            {expanded && children && (
                <div className="select-text border-t border-border bg-zinc-950/60 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground dark:bg-zinc-950">
                    {children}
                </div>
            )}
        </div>
    );
}
