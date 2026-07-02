// remcli — ListenButton / TTS (перенос design/screens/components.tsx, разметка 1:1).
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";

export function ListenButton({ state = "idle", time }: { state?: "idle" | "synth" | "playing" | "error"; time?: string }) {
    const base = "inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 font-mono text-[10.5px]";
    if (state === "playing")
        return (
            <button className={`${base} border-accent/35 bg-accent/10 text-accent`}>
                <span className="flex h-[11px] items-end gap-0.5">
                    {[0, 1, 2].map((i) => (
                        <span key={i} className="w-[2.5px] origin-bottom animate-bar bg-current" style={{ height: "100%", animationDelay: `${-i * 0.2}s` }} />
                    ))}
                </span>
                {time ?? "0:12"} · {t("tts.stop")}
            </button>
        );
    if (state === "synth")
        return <button className={`${base} border-border text-muted-foreground`}><Loader2 className="size-3 animate-spin text-accent" />{t("tts.synth")}</button>;
    if (state === "error")
        return <button className={`${base} border-status-error/35 text-status-error`}>{t("tts.unavailable")}</button>;
    return (
        <button className={`${base} border-border text-muted-foreground`}>
            <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 4.5v3h2.5L7.5 10V2L4.5 4.5H2Z" fill="currentColor" /></svg>
            {t("tts.listen")}
        </button>
    );
}
