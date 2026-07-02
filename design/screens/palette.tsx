// remcli — Command Palette (⌘K / кнопка поиска). Оверлей поверх любого экрана.
// Реализация — shadcn <Command> в Dialog; появление: scale 0.98→1 + fade 160ms (MOTION.md §7).
import * as React from "react";
import { Plus, Search, Square, Terminal } from "lucide-react";
import { AgentIcon, Caret, StatusDot } from "./components";

export default function PaletteOverlay() {
  return (
    <div className="fixed inset-0 z-50 bg-black/55 pt-[calc(env(safe-area-inset-top)+22px)] backdrop-blur-[2px]">
      <div className="mx-3.5 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl shadow-black/60">
        {/* ввод */}
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
          <Search className="size-[15px] text-muted-foreground" />
          <span className="text-[15px]">deplo</span><Caret />
          <kbd className="ml-auto rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">esc</kbd>
        </div>

        <div className="p-1.5 pb-2">
          {/* сессии */}
          <div className="px-3 pb-1 pt-1.5 font-mono text-[9.5px] text-muted-foreground/70">сессии</div>
          <button className="flex w-full items-center gap-2.5 rounded-[9px] bg-secondary px-3 py-2.5 text-left">
            <AgentIcon agent="claude" className="size-6 rounded-[7px] text-[10px]" />
            <span className="flex-1 font-mono text-[12.5px]">
              ~/dev/<mark className="bg-transparent text-accent">deplo</mark>y-scripts
            </span>
            <StatusDot status="permission" className="size-[7px]" />
            <span className="font-mono text-[10px] text-muted-foreground/70">⏎</span>
          </button>

          {/* действия */}
          <div className="px-3 pb-1 pt-2.5 font-mono text-[9.5px] text-muted-foreground/70">действия</div>
          <button className="flex w-full items-center gap-2.5 rounded-[9px] px-3 py-2.5 text-left">
            <span className="flex size-6 items-center justify-center rounded-[7px] bg-secondary"><Plus className="size-3.5 text-muted-foreground" /></span>
            <span className="flex-1 text-[13px] text-foreground/85">Новая сессия…</span>
            <kbd className="font-mono text-[10px] text-muted-foreground/70">⌘N</kbd>
          </button>
          <button className="flex w-full items-center gap-2.5 rounded-[9px] px-3 py-2.5 text-left">
            <span className="flex size-6 items-center justify-center rounded-[7px] bg-secondary"><Terminal className="size-3.5 text-muted-foreground" /></span>
            <span className="flex-1 text-[13px] text-foreground/85">Открыть терминал deploy-scripts</span>
            <kbd className="font-mono text-[10px] text-muted-foreground/70">⌘T</kbd>
          </button>
          <button className="flex w-full items-center gap-2.5 rounded-[9px] px-3 py-2.5 text-left">
            <span className="flex size-6 items-center justify-center rounded-[7px] bg-secondary"><Square className="size-3 fill-status-error text-status-error" /></span>
            <span className="flex-1 text-[13px] text-foreground/85">Остановить все сессии</span>
          </button>
        </div>
      </div>
    </div>
  );
}
