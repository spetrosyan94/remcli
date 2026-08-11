import { Loader2, RotateCcw } from "lucide-react";
import { AgentIcon, Segmented } from "@/components/kit";
import { sessionPath } from "@/components/app/sessionDisplay";
import type { HomeQuickResumeCandidate, HomeSessionFilter } from "@/lib/homeSessionTriage";
import { t } from "@/lib/i18n";

const HOME_FILTERS: HomeSessionFilter[] = ["attention", "active", "completed"];

function homeFilterLabel(filter: HomeSessionFilter): string {
    if (filter === "attention") return t("home.filter.attention");
    if (filter === "active") return t("home.filter.active");
    return t("home.filter.completed");
}

export interface HomeSessionTriageControlsProps {
    filter: HomeSessionFilter;
    onFilterChange: (filter: HomeSessionFilter) => void;
    quickResumeCandidate: HomeQuickResumeCandidate | null;
    isResuming: boolean;
    onQuickResume: () => void;
    compact?: boolean;
}

export function HomeSessionTriageControls({
    filter,
    onFilterChange,
    quickResumeCandidate,
    isResuming,
    onQuickResume,
    compact = false,
}: HomeSessionTriageControlsProps) {
    const filterControl = (
        <div role="group" aria-label={t("home.filter.label")}>
            <Segmented
                options={HOME_FILTERS}
                value={filter}
                onChange={(value) => onFilterChange(value as HomeSessionFilter)}
                getLabel={(value) => homeFilterLabel(value as HomeSessionFilter)}
            />
        </div>
    );

    if (compact) {
        return (
            <div className="flex flex-col gap-2 px-3 pb-2">
                <div className="[&>div]:h-10 [&>div]:rounded-lg [&>div]:text-[9.5px] [&_button]:px-2 [&_button]:text-[9.5px]">
                    {filterControl}
                </div>
                {quickResumeCandidate && <QuickResumeCard candidate={quickResumeCandidate} isResuming={isResuming} onResume={onQuickResume} compact />}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-2">
            {filterControl}
            {quickResumeCandidate && <QuickResumeCard candidate={quickResumeCandidate} isResuming={isResuming} onResume={onQuickResume} />}
        </div>
    );
}

function QuickResumeCard({
    candidate,
    isResuming,
    onResume,
    compact = false,
}: {
    candidate: HomeQuickResumeCandidate;
    isResuming: boolean;
    onResume: () => void;
    compact?: boolean;
}) {
    const path = sessionPath(candidate.session);
    return (
        <section
            data-home-quick-resume
            aria-busy={isResuming}
            className={`flex min-w-0 items-center gap-2 rounded-[10px] border border-border bg-card ${compact ? "min-h-[52px] px-2 py-1.5" : "min-h-[60px] px-2.5 py-2"}`}
        >
            <AgentIcon agent={candidate.agent} className={compact ? "size-5 rounded-[6px] text-[8px]" : "size-[26px] rounded-[7px] text-[9px]"} />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={`font-mono text-muted-foreground ${compact ? "text-[8px]" : "text-[9px]"}`}>{t("home.quickResume.latest")}</span>
                <span className={`truncate font-mono font-semibold text-foreground ${compact ? "text-[9.5px]" : "text-[11px]"}`}>{path}</span>
            </span>
            <button
                type="button"
                onClick={onResume}
                disabled={isResuming}
                className={`flex shrink-0 items-center justify-center gap-1 rounded-[8px] border border-accent/35 bg-accent/[0.08] font-semibold text-accent transition-[background-color,border-color,color,transform] active:scale-[0.96] disabled:cursor-wait disabled:opacity-60 disabled:active:scale-100 ${compact ? "h-10 px-2 text-[9.5px]" : "h-11 px-2.5 text-[11px]"}`}
            >
                {isResuming ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
                <span>{isResuming ? t("home.quickResume.starting") : t("home.quickResume.action")}</span>
            </button>
        </section>
    );
}
