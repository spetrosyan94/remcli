// remcli — EmptyState (перенос design/screens/components.tsx; лого — инлайн kit/Logo, адаптивен к теме).
import * as React from "react";
import { Logo } from "@/components/kit/Logo";

export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: React.ReactNode }) {
    return (
        <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border bg-card/50 px-5 py-7">
            {/* MOTION.md §9: в пустых состояниях курсор-блок знака продолжает медленный blink 1.2s */}
            <Logo className="size-9 text-foreground opacity-50 [&_rect]:animate-[blink_1.2s_steps(2)_infinite] motion-reduce:[&_rect]:animate-none" />
            <span className="text-[13.5px] font-semibold">{title}</span>
            <span className="font-mono text-[11px] text-muted-foreground">{hint}</span>
            {action}
        </div>
    );
}
