// remcli — VoiceRecordBar (перенос design/screens/components.tsx, разметка 1:1).
// Подключение к живой записи: колбэки прокидывают useVoiceRecorder (src/lib/voice/recorder.ts).
import * as React from "react";
import { Loader2, Square } from "lucide-react";
import { t } from "@/lib/i18n";

export function VoiceRecordBar({ state = "recording", seconds = "0:07", onStop, onCancel, onRetry }: {
    state?: "recording" | "transcribing" | "error";
    seconds?: string;
    /** Стоп записи → распознавание (useVoiceRecorder.stopAndTranscribe). */
    onStop?: () => void;
    /** Отмена записи/распознавания (useVoiceRecorder.cancel). */
    onCancel?: () => void;
    /** Повторить после ошибки микрофона (useVoiceRecorder.reset + start). */
    onRetry?: () => void;
}) {
    const [isStopping, setIsStopping] = React.useState(false);

    React.useEffect(() => {
        if (state !== "recording") setIsStopping(false);
    }, [state]);

    const stopRecording = () => {
        if (isStopping) return;
        setIsStopping(true);
        onStop?.();
    };

    if (state === "transcribing")
        return (
            <div className="flex h-[52px] animate-voice-transcribe items-center gap-3 rounded-xl border border-border bg-card px-3.5">
                <Loader2 className="size-3.5 animate-spin text-status-thinking" />
                <span className="font-mono text-xs text-muted-foreground">{t("voice.transcribing")}</span>
                <button type="button" onClick={onCancel}
                    className="ml-auto h-11 rounded-[7px] px-3 font-mono text-[11px] text-muted-foreground/60 transition-[background-color,color,transform] duration-[120ms] hover:bg-muted hover:text-foreground active:scale-[0.96] lg:h-8">
                    {t("voice.cancel")}
                </button>
            </div>
        );
    if (state === "error")
        return (
            <div className="flex min-h-[52px] flex-wrap items-center gap-2 rounded-xl border border-status-error/40 bg-status-error/[0.06] px-3.5 py-1.5">
                <span className="min-w-0 flex-1 font-mono text-xs text-status-error">{t("voice.micUnavailable")}</span>
                <div className="ml-auto flex items-center gap-2">
                    <button type="button" onClick={onCancel}
                        className="h-11 rounded-[7px] px-3 font-mono text-[11px] text-muted-foreground/70 transition-[background-color,color,transform] duration-[120ms] hover:bg-muted hover:text-foreground active:scale-[0.96] lg:h-8">
                        {t("voice.cancel")}
                    </button>
                    <button type="button" onClick={onRetry}
                        className="h-11 rounded-[7px] bg-secondary px-3 text-xs font-medium transition-[background-color,opacity,transform] duration-[120ms] active:scale-[0.96] lg:h-8">
                        {t("voice.retry")}
                    </button>
                </div>
            </div>
        );
    return (
        <div className="flex h-[52px] items-center gap-3 rounded-xl border border-accent/35 bg-card px-3.5">
            <span className="size-[9px] animate-pulse-run rounded-full bg-status-error" />
            <span className="flex h-[22px] flex-1 items-center gap-[2.5px] transition-opacity duration-[150ms] ease-[var(--ease-out)]" style={{ opacity: isStopping ? 0 : 1 }}>
                {[0.9, 0.7, 1.1, 0.8, 1, 0.75, 0.95, 0.85, 1.05, 0.9].map((d, i) => (
                    <span key={i} className="w-[3px] origin-center animate-bar rounded-sm bg-accent transition-transform duration-[150ms] ease-[var(--ease-out)]" style={{ height: "100%", animationDuration: `${d}s`, animationDelay: `${-i * 0.1}s`, transform: isStopping ? "scaleY(0.05)" : undefined }} />
                ))}
            </span>
            <span className="font-mono text-xs">{seconds}</span>
            <button type="button" onClick={stopRecording} disabled={isStopping} aria-label={t("voice.stop")}
                className="flex size-11 shrink-0 items-center justify-center rounded-[10px] bg-status-error transition-[opacity,transform] duration-[120ms] active:scale-[0.96] disabled:opacity-70">
                <Square className="size-3 fill-background text-background" />
            </button>
        </div>
    );
}
