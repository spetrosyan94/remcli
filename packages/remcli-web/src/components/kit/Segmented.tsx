// remcli — Segmented (перенос design/screens/components.tsx, разметка 1:1).

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

interface SegmentedProps {
    options: string[];
    value: string;
    onChange?: (v: string) => void;
    getLabel?: (v: string) => string;
    shouldFitContent?: boolean;
}

export function Segmented({ options, value, onChange, getLabel = (v) => v, shouldFitContent = false }: SegmentedProps) {
    return (
        <ToggleGroup
            type="single"
            value={value}
            onValueChange={(nextValue) => {
                if (nextValue) onChange?.(nextValue);
            }}
            className="flex h-12 w-full min-w-0 items-stretch rounded-[10px] bg-muted p-0.5 font-mono text-[11px]"
        >
            {options.map((o) => (
                <ToggleGroupItem
                    key={o}
                    value={o}
                    aria-label={getLabel(o)}
                    title={getLabel(o)}
                    className={`flex h-full ${shouldFitContent ? "shrink-0" : "min-w-0 flex-1"} items-center justify-center rounded-lg px-3.5 text-[11px] font-normal text-muted-foreground transition-[background-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] data-[state=on]:bg-background data-[state=on]:font-semibold data-[state=on]:text-foreground data-[state=on]:shadow-sm motion-reduce:active:scale-100 motion-reduce:transition-opacity dark:data-[state=on]:bg-zinc-700/60`}
                >
                    <span className="truncate">{getLabel(o)}</span>
                </ToggleGroupItem>
            ))}
        </ToggleGroup>
    );
}
