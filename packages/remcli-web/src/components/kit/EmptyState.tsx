// remcli — EmptyState (перенос design/screens/components.tsx; лого — из public/logo.svg).
import * as React from "react";

export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: React.ReactNode }) {
    return (
        <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border bg-card/50 px-5 py-7">
            <img src="/logo.svg" alt="" className="size-9 opacity-50" />
            <span className="text-[13.5px] font-semibold">{title}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{hint}</span>
            {action}
        </div>
    );
}
