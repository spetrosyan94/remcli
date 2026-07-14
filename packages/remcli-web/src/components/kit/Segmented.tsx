// remcli — Segmented (перенос design/screens/components.tsx, разметка 1:1).

interface SegmentedProps {
    options: string[];
    value: string;
    onChange?: (v: string) => void;
    getLabel?: (v: string) => string;
    shouldFitContent?: boolean;
}

export function Segmented({ options, value, onChange, getLabel = (v) => v, shouldFitContent = false }: SegmentedProps) {
    return (
        <div className="flex h-12 min-w-0 items-stretch rounded-[10px] bg-muted p-0.5 font-mono text-[11px]">
            {options.map((o) => (
                <button key={o} onClick={() => onChange?.(o)} aria-pressed={o === value} title={getLabel(o)}
                    className={`flex ${shouldFitContent ? "shrink-0" : "min-w-0 flex-1"} items-center justify-center rounded-lg px-3.5 active:scale-[0.96] transition-[background-color,box-shadow,color,transform] ${o === value ? "bg-background font-semibold shadow-sm dark:bg-zinc-700/60" : "text-muted-foreground"}`}>
                    <span className="truncate">{getLabel(o)}</span>
                </button>
            ))}
        </div>
    );
}
