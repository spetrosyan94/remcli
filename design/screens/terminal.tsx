// remcli — Терминал сессии (см. 03 Screens 1g). ВСЕГДА тёмный, независимо от темы.
import * as React from "react";
import { ArrowLeft, CornerDownLeft } from "lucide-react";
import { Caret } from "./components";

export default function TerminalScreen() {
  return (
    // принудительный dark: класс dark + свой фон #050507
    <div className="dark flex h-dvh flex-col bg-[#050507] pt-[env(safe-area-inset-top)] text-foreground">
      <header className="flex items-center gap-2.5 border-b border-border px-3.5 pb-2.5">
        <button aria-label="Назад" className="flex size-[38px] items-center justify-center rounded-[10px]">
          <ArrowLeft className="size-[17px]" />
        </button>
        <div className="flex flex-1 flex-col">
          <span className="font-mono text-[13.5px] font-semibold">~/dev/remcli</span>
          <span className="font-mono text-[10px] text-muted-foreground">pty · zsh · 80×24</span>
        </div>
        <span className="flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/[0.08] px-2.5 py-1 font-mono text-[10px] text-accent">
          <span className="size-1.5 rounded-full bg-status-running" /> live
        </span>
      </header>

      {/* вывод */}
      <main className="flex-1 overflow-y-auto px-4 py-3.5 font-mono text-[11.5px] leading-[1.75] text-zinc-300">
        <div><span className="text-emerald-400">➜ remcli</span> <span className="text-cyan-400">git:(main)</span> pnpm test -- --run crypto</div>
        <div className="text-zinc-500"> RUN  v2.1.4 ~/dev/remcli</div>
        <div> <span className="text-emerald-400">✓</span> src/crypto.test.ts <span className="text-zinc-500">(9)</span> 412ms</div>
        <div> <span className="text-emerald-400">✓</span> src/tunnel.test.ts <span className="text-zinc-500">(3)</span> 96ms</div>
        <div className="text-zinc-500"> Tests  <span className="text-emerald-400">12 passed</span> (12) · 1.42s</div>
        <div className="mt-2"><span className="text-emerald-400">➜ remcli</span> <span className="text-cyan-400">git:(main)</span> git status -s</div>
        <div><span className="text-amber-400"> M</span> src/transport/webrtc.ts</div>
        <div><span className="text-emerald-400">??</span> src/seal.ts</div>
        <div className="mt-2"><span className="text-emerald-400">➜ remcli</span> <span className="text-cyan-400">git:(main)</span><Caret /></div>
      </main>

      {/* ввод команды + быстрые клавиши */}
      <footer className="border-t border-border px-3.5 pb-[max(12px,env(safe-area-inset-bottom))] pt-2">
        <div className="flex items-center gap-2">
          <div className="flex h-11 flex-1 items-center gap-2 rounded-xl border border-input bg-card px-3 font-mono text-[13px]">
            <span className="text-emerald-400">$</span>
            <input className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground" placeholder="команда…" />
          </div>
          <button aria-label="Выполнить" className="flex size-11 items-center justify-center rounded-xl bg-secondary">
            <CornerDownLeft className="size-4" />
          </button>
        </div>
        <div className="mt-2 flex gap-1.5 font-mono text-[10.5px] text-muted-foreground">
          {["tab", "ctrl+c", "↑", "esc"].map((k) => (
            <button key={k} className="rounded-[7px] border border-border bg-card px-2.5 py-1.5">{k}</button>
          ))}
        </div>
      </footer>
    </div>
  );
}
