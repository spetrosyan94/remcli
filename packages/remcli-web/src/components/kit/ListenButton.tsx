// remcli — ListenButton / TTS (перенос design/screens/components.tsx, разметка 1:1).
// Подключение к живому TTS: onClick прокидывает toggle из useTts (src/lib/voice/tts.ts).
import { Loader2, Volume2 } from "lucide-react";
import { t } from "@/lib/i18n";

export function ListenButton({ state = "idle", time, onClick }: {
    state?: "idle" | "synth" | "playing" | "error";
    time?: string;
    onClick?: () => void;
}) {
    // hover/нажатия — 120ms (MOTION.md --dur-micro)
    const base = "inline-flex h-11 w-[104px] shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border px-3 font-mono text-[10.5px] transition-[color,border-color,background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] motion-reduce:active:scale-100 motion-reduce:transition-opacity lg:h-[30px] lg:px-2.5";
    const content = "inline-flex min-w-0 items-center gap-1.5 animate-in fade-in duration-[150ms] motion-reduce:animate-none";
    if (state === "playing")
        return (
            <button type="button" onClick={onClick} className={`${base} border-accent/35 bg-accent/10 text-accent`}>
                <span className={content}>
                  <span className="flex shrink-0 items-end gap-0.5">
                    {[0.6, 0.75, 0.9].map((duration, i) => (
                        <span key={duration} className="h-[11px] w-[2.5px] origin-bottom animate-bar motion-reduce:animate-none bg-current" style={{ animationDuration: `${duration}s`, animationDelay: `${-i * 0.15}s` }} />
                    ))}
                  </span>
                  <span className="truncate">{time ?? "0:12"} · {t("tts.stop")}</span>
                </span>
            </button>
        );
    if (state === "synth")
        return <button type="button" onClick={onClick} className={`${base} border-border text-muted-foreground`}><span className={content}><Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none text-accent" />{t("tts.synth")}</span></button>;
    if (state === "error")
        return <button type="button" onClick={onClick} className={`${base} border-status-error/35 text-status-error`}><span className={content}>{t("tts.unavailable")}</span></button>;
    return (
        <button type="button" onClick={onClick} className={`${base} border-border text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground`}>
            <span className={content}><Volume2 className="size-3 shrink-0" />{t("tts.listen")}</span>
        </button>
    );
}
