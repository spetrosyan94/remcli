// remcli — Zen / Задачи (см. 03 Screens 1h). Самый тихий экран.
import * as React from "react";
import { Check, Play, Plus } from "lucide-react";
import { StatusDot } from "./components";

export default function ZenScreen() {
  return (
    <div className="flex min-h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
      <header className="flex items-baseline gap-2.5 px-5 pb-3 pt-1.5">
        <h1 className="text-xl font-semibold">Задачи</h1>
        <span className="font-mono text-[11px] text-muted-foreground/70">3 открыто</span>
      </header>

      <main className="flex flex-1 flex-col overflow-y-auto px-4">
        {/* задача со связанной живой сессией */}
        <div className="flex items-start gap-3 border-b border-border/60 px-2 py-3.5">
          <span className="mt-0.5 size-[18px] shrink-0 rounded-md border-[1.5px] border-muted-foreground/40" />
          <div className="flex flex-1 flex-col gap-2">
            <span className="text-[14.5px] leading-snug">Довести E2E-шифрование канала</span>
            <button className="flex w-fit items-center gap-1.5 rounded-[7px] border border-border bg-card px-2.5 py-1 font-mono text-[10.5px] text-muted-foreground">
              <StatusDot status="running" className="size-[5px]" /> ~/dev/remcli · claude
            </button>
          </div>
        </div>

        {/* задача без сессии → CTA «работать» (запускает new-session с prefill) */}
        <div className="flex items-start gap-3 border-b border-border/60 px-2 py-3.5">
          <span className="mt-0.5 size-[18px] shrink-0 rounded-md border-[1.5px] border-muted-foreground/40" />
          <div className="flex flex-1 flex-col gap-2">
            <span className="text-[14.5px] leading-snug">Ретраи при обрыве туннеля</span>
            <button className="flex h-8 w-fit items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground">
              <Play className="size-2.5 fill-current" /> Работать над задачей
            </button>
          </div>
        </div>

        <div className="flex items-start gap-3 border-b border-border/60 px-2 py-3.5">
          <span className="mt-0.5 size-[18px] shrink-0 rounded-md border-[1.5px] border-muted-foreground/40" />
          <span className="text-[14.5px] leading-snug">Обновить README по установке демона</span>
        </div>

        {/* выполненная */}
        <div className="flex items-start gap-3 px-2 py-3.5 opacity-45">
          <span className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-md bg-accent">
            <Check className="size-2.5 text-accent-foreground" strokeWidth={3} />
          </span>
          <span className="text-[14.5px] leading-snug text-muted-foreground line-through">Настроить QR-подключение по туннелю</span>
        </div>
      </main>

      <footer className="px-4 pb-3 pt-2.5">
        <div className="flex h-12 items-center gap-2.5 rounded-xl border border-border bg-card px-4 text-sm text-muted-foreground">
          <Plus className="size-3.5 text-accent" /> новая задача…
        </div>
      </footer>
      {/* + таб-бар как в home.tsx (active="Задачи") + safe-area */}
    </div>
  );
}
