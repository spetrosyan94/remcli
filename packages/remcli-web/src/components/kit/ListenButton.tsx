// remcli — ListenButton / TTS (перенос design/screens/components.tsx, разметка 1:1).
// Подключение к живому TTS: onClick прокидывает toggle из useTts (src/lib/voice/tts.ts).
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";

export function ListenButton({ state = "idle", time, onClick }: {
    state?: "idle" | "synth" | "playing" | "error";
    time?: string;
    onClick?: () => void;
}) {
    // hover/нажатия — 120ms (MOTION.md --dur-micro)
    const base = "inline-flex h-11 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border px-3 font-mono text-[10.5px] transition-[color,border-color,background-color,width,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] lg:h-7 lg:px-2.5";
    if (state === "playing")
        return (
            <button onClick={onClick} className={`${base} min-w-[82px] border-accent/35 bg-accent/10 text-accent`}>
                <span className="flex animate-in fade-in duration-[150ms] items-end gap-0.5">
                    {[0.6, 0.75, 0.9].map((duration, i) => (
                        <span key={duration} className="h-[11px] w-[2.5px] origin-bottom animate-bar bg-current" style={{ animationDuration: `${duration}s`, animationDelay: `${-i * 0.15}s` }} />
                    ))}
                </span>
                <span className="animate-in fade-in duration-[150ms]">{time ?? "0:12"} · {t("tts.stop")}</span>
            </button>
        );
    if (state === "synth")
        return <button onClick={onClick} className={`${base} w-[92px] border-border text-muted-foreground`}><Loader2 className="size-3 animate-spin text-accent" />{t("tts.synth")}</button>;
    if (state === "error")
        return <button onClick={onClick} className={`${base} border-status-error/35 text-status-error`}>{t("tts.unavailable")}</button>;
    return (
        <button onClick={onClick} className={`${base} border-border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground`}>
            <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 4.5v3h2.5L7.5 10V2L4.5 4.5H2Z" fill="currentColor" /></svg>
            {t("tts.listen")}
        </button>
    );
}
