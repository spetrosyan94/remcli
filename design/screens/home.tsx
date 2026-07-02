// remcli — Home / Сессии (см. 03 Screens 1c, light 2a, desktop 3a)
import * as React from "react";
import { ListTodo, Monitor, Plus, Search, SlidersHorizontal, Terminal } from "lucide-react";
import { EmptyState, SessionCard, StatusDot } from "./components";

export default function HomeScreen({ empty = false }: { empty?: boolean }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
      {/* шапка */}
      <header className="flex items-center gap-2.5 px-5 pb-3 pt-2.5">
        <img src="../assets/logo.svg" alt="" className="size-[22px]" />
        <span className="font-mono text-base font-semibold">remcli</span>
        <span className="ml-auto flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/[0.08] px-2.5 py-1">
          <StatusDot status="running" className="size-1.5" />
          <span className="font-mono text-[10px] text-accent">p2p · 12ms</span>
        </span>
        <button aria-label="Поиск (⌘K)" className="flex size-[38px] items-center justify-center rounded-[10px] border border-border">
          <Search className="size-[15px] text-muted-foreground" />
        </button>
      </header>

      {/* список машин и сессий */}
      <main className="flex flex-1 flex-col gap-2 overflow-y-auto px-4">
        {empty ? (
          <div className="mt-10">
            <EmptyState
              title="Нет активных сессий"
              hint="запустите агента — он появится здесь"
              action={<button className="h-9 rounded-[9px] bg-primary px-4 text-[13px] font-semibold text-primary-foreground">Новая сессия</button>}
            />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 px-1 pt-1.5 font-mono text-[11px] text-muted-foreground">
              <Monitor className="size-3" /> mbp.local <span className="text-status-running">online</span>
              <span className="ml-auto text-muted-foreground/50">3 сессии</span>
            </div>
            {/* permission всегда поднимается наверх */}
            <SessionCard agent="claude" path="~/dev/deploy-scripts" message="Просит разрешение: git push --force" status="permission" time="2 мин" />
            <SessionCard agent="claude" path="~/dev/remcli" message="Пишу WebRTC-транспорт…" status="running" time="сейчас" />
            <SessionCard agent="codex" path="~/dev/api-gateway" message="Тесты прошли, готовлю коммит…" status="idle" time="12:40" />
            <div className="flex items-center gap-2 px-1 pt-2.5 font-mono text-[11px] text-muted-foreground/60">
              <Monitor className="size-3" /> studio-pc <span>офлайн · вчера</span>
            </div>
            <SessionCard agent="gemini" path="~/exp/rag-index" message="машина недоступна" status="offline" time="вчера" />
          </>
        )}
      </main>

      {/* FAB */}
      <button className="absolute bottom-[104px] right-4 flex h-[52px] items-center gap-2 rounded-2xl bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-xl shadow-black/40">
        <Plus className="size-4" /> Сессия
      </button>

      {/* таб-бар + safe area */}
      <nav className="border-t border-border bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur">
        <div className="flex px-2 pt-2">
          <TabItem icon={<Terminal className="size-5" />} label="Сессии" active />
          <TabItem icon={<ListTodo className="size-5" />} label="Задачи" />
          <TabItem icon={<SlidersHorizontal className="size-5" />} label="Настройки" />
        </div>
      </nav>
    </div>
  );
}

function TabItem({ icon, label, active = false }: { icon: React.ReactNode; label: string; active?: boolean }) {
  return (
    <button className={`flex min-h-11 flex-1 flex-col items-center gap-0.5 py-1.5 ${active ? "text-foreground" : "text-muted-foreground"}`}>
      {icon}
      <span className={`text-[10px] ${active ? "font-semibold" : "font-medium"}`}>{label}</span>
    </button>
  );
}

/* Десктоп ≥1024 (3a): grid-cols-[288px_1fr]; сайдбар = этот же список сессий
   в компактных строках + поиск ⌘K + «Новая сессия» внизу; справа — chat.tsx. */
