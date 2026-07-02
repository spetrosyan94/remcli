// remcli — DiffView (перенос design/screens/components.tsx, разметка 1:1).

export interface DiffLine {
    t: "ctx" | "add" | "del";
    text: string;
}

export function DiffView({ file, added, removed, lines }: { file: string; added: number; removed: number; lines: DiffLine[] }) {
    const row: Record<DiffLine["t"], string> = {
        ctx: "text-muted-foreground",
        add: "bg-status-running/10 text-emerald-700 dark:text-emerald-300",
        del: "bg-status-error/10 text-red-700 dark:text-red-300",
    };
    return (
        <div className="overflow-hidden rounded-[9px] border border-border font-mono text-[11.5px]">
            <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
                <span>{file}</span>
                <span className="ml-auto text-status-running">+{added}</span>
                <span className="text-status-error">−{removed}</span>
            </div>
            <div className="bg-background py-1 leading-[1.75]">
                {lines.map((l, i) => (
                    <div key={i} className={`px-3 ${row[l.t]}`}>
                        {l.t === "add" ? "+" : l.t === "del" ? "−" : " "} {l.text}
                    </div>
                ))}
            </div>
        </div>
    );
}
