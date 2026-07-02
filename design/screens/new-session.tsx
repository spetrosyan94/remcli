// remcli — Новая сессия (см. 03 Screens 1d) · повторный сценарий = 2-3 тапа
import * as React from "react";
import { ChevronDown, RotateCcw, X } from "lucide-react";
import { AgentIcon, Segmented, type AgentId } from "./components";

const AGENTS: { id: AgentId; name: string; kind: string }[] = [
  { id: "claude", name: "Claude", kind: "code" },
  { id: "codex", name: "Codex", kind: "cli" },
  { id: "gemini", name: "Gemini", kind: "cli" },
  { id: "cursor", name: "Cursor", kind: "agent" },
];

export default function NewSessionScreen() {
  const [agent, setAgent] = React.useState<AgentId>("claude");
  const [mode, setMode] = React.useState("ask");
  return (
    <div className="flex min-h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
      <header className="flex items-center px-5 pb-3 pt-1.5">
        <h1 className="text-xl font-semibold">Новая сессия</h1>
        <button aria-label="Закрыть" className="ml-auto flex size-[38px] items-center justify-center rounded-[10px] border border-border">
          <X className="size-4 text-muted-foreground" />
        </button>
      </header>

      <main className="flex flex-1 flex-col gap-4.5 overflow-y-auto px-5 [&>*]:shrink-0">
        {/* машина */}
        <button className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3">
          <span className="w-[52px] text-left font-mono text-[10px] text-muted-foreground/70">машина</span>
          <span className="font-mono text-[13px] font-semibold">mbp.local</span>
          <span className="size-1.5 rounded-full bg-status-running" />
          <ChevronDown className="ml-auto size-3 text-muted-foreground" />
        </button>

        {/* агент — 4 карточки */}
        <section className="flex flex-col gap-2">
          <span className="font-mono text-[10px] text-muted-foreground/70">агент</span>
          <div className="grid grid-cols-2 gap-2">
            {AGENTS.map((a) => (
              <button key={a.id} onClick={() => setAgent(a.id)}
                className={`flex items-center gap-2.5 rounded-xl border bg-card p-3 text-left ${agent === a.id ? "border-accent ring-[3px] ring-accent/10" : "border-border"}`}>
                <AgentIcon agent={a.id} className="size-[30px] rounded-lg text-[11px]" />
                <span className="flex flex-col">
                  <span className="text-[13px] font-semibold">{a.name}</span>
                  <span className="font-mono text-[9.5px] text-muted-foreground">{a.kind}</span>
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* модель + режим разрешений */}
        <div className="flex gap-2">
          <section className="flex flex-[1.2] flex-col gap-2">
            <span className="font-mono text-[10px] text-muted-foreground/70">модель</span>
            <button className="flex h-11 items-center rounded-[10px] border border-input bg-muted px-3 font-mono text-xs">
              opus-4.1 <ChevronDown className="ml-auto size-3 text-muted-foreground" />
            </button>
          </section>
          <section className="flex flex-[1.6] flex-col gap-2">
            <span className="font-mono text-[10px] text-muted-foreground/70">разрешения</span>
            <Segmented options={["safe", "ask", "auto"]} value={mode} onChange={setMode} />
          </section>
        </div>

        {/* директория — недавние + ввод */}
        <section className="flex flex-col gap-2">
          <span className="font-mono text-[10px] text-muted-foreground/70">директория · недавние</span>
          <div className="overflow-hidden rounded-xl border border-border">
            <button className="flex w-full items-center gap-2.5 bg-secondary px-3.5 py-3 font-mono text-[12.5px]">
              <span className="text-accent">›</span> ~/dev/remcli
              <span className="ml-auto text-[10px] text-muted-foreground/70">2 ч назад</span>
            </button>
            <button className="flex w-full items-center gap-2.5 border-t border-border bg-card px-3.5 py-3 font-mono text-[12.5px] text-muted-foreground">
              <span className="text-muted-foreground/40">›</span> ~/dev/api-gateway
              <span className="ml-auto text-[10px] text-muted-foreground/70">вчера</span>
            </button>
            <button className="flex w-full items-center gap-2.5 border-t border-border bg-card px-3.5 py-3 font-mono text-[12.5px] text-muted-foreground/70">
              <span>+</span> другая директория…
            </button>
          </div>
        </section>

        {/* resume: открывает bottom-sheet со списком прошлых сессий агента (rc-42 · сегодня 12:41 …) */}
        <button className="flex h-10 items-center justify-center gap-2 rounded-[10px] border border-dashed border-border font-mono text-[11.5px] text-muted-foreground">
          <RotateCcw className="size-3" /> продолжить прошлую сессию claude…
        </button>
      </main>

      <footer className="px-5 pb-[max(14px,env(safe-area-inset-bottom))] pt-3">
        <button className="h-[52px] w-full rounded-xl bg-accent text-base font-semibold text-accent-foreground">
          Запустить claude в ~/dev/remcli
        </button>
      </footer>
    </div>
  );
}
