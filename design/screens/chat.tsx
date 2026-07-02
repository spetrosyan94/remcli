// remcli — Чат сессии, главный экран (см. 03 Screens 1e/1f, light 2b, desktop 3a)
import * as React from "react";
import { ArrowLeft, ChevronDown, Mic, MoreHorizontal, Send } from "lucide-react";
import {
  AgentMeta, Caret, ConnectionBanner, DiffView, ListenButton,
  PermissionCard, ThinkingRow, ToolCallCard, UserMessage, VoiceRecordBar,
} from "./components";

type InputState = "text" | "recording" | "transcribing";

export default function ChatScreen({
  inputState = "text",
  connection = "ok",
  ended = false,
}: { inputState?: InputState; connection?: "ok" | "lost" | "restored"; ended?: boolean }) {
  return (
    <div className="flex h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
      {/* шапка: проект · агент/модель/статус · режим разрешений · меню */}
      <header className="flex items-center gap-2.5 border-b border-border px-3.5 pb-2.5">
        <button aria-label="Назад" className="flex size-[38px] items-center justify-center rounded-[10px]">
          <ArrowLeft className="size-[17px]" />
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-[13.5px] font-semibold">~/dev/remcli</span>
          <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
            <span className="size-1.5 animate-pulse-think rounded-full bg-status-thinking" />
            claude · opus-4.1 · думает
          </span>
        </div>
        <button className="flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 font-mono text-[10.5px]">
          ask <ChevronDown className="size-2.5 text-muted-foreground" />
        </button>
        <button aria-label="Меню" className="flex size-[38px] items-center justify-center rounded-[10px]">
          <MoreHorizontal className="size-[17px] text-muted-foreground" />
        </button>
      </header>

      {connection !== "ok" && (
        <div className="px-3.5 pt-2"><ConnectionBanner state={connection} /></div>
      )}

      {/* лента */}
      <main className="flex flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3.5 [scroll-behavior:smooth]">
        <UserMessage>Добавь шифрование в канал и прогони тесты</UserMessage>

        <div className="flex flex-col gap-2">
          <AgentMeta agent="claude">claude · 12:41</AgentMeta>
          <p className="text-sm leading-relaxed text-foreground/85">
            Смотрю текущий транспорт и оборачиваю отправку в{" "}
            <code className="rounded-[5px] bg-muted px-1 py-px font-mono text-[12.5px] text-emerald-700 dark:text-emerald-300">seal()</code>.
          </p>
          <ToolCallCard tool="Read" arg="src/transport/webrtc.ts" state="success" />
          <ToolCallCard tool="Bash" arg="pnpm test" state="running" expanded>
            RUN&nbsp;&nbsp;src/tunnel.test.ts<br />
            PASS src/crypto.test.ts <span className="text-status-running">12 passed</span>
            <Caret />
          </ToolCallCard>
          <DiffView
            file="src/transport/webrtc.ts" added={12} removed={4}
            lines={[
              { t: "ctx", text: " const chan = peer.channel;" },
              { t: "del", text: "chan.send(raw);" },
              { t: "add", text: "chan.send(seal(raw, key));" },
              { t: "add", text: 'metrics.bump("tx");' },
            ]}
          />
          <div className="flex gap-2">
            <ListenButton state="idle" />
            <button className="h-7 rounded-[7px] px-2.5 font-mono text-[10.5px] text-muted-foreground/60">копировать</button>
          </div>
        </div>

        {/* самый важный элемент — заметен мгновенно (вход: MOTION.md §6) */}
        <PermissionCard
          tool="bash" time="12:42"
          command="pnpm test -- --run crypto"
          comment="прогонит тесты шифрования"
          alwaysLabel="всегда разрешать pnpm test в этой сессии"
        />

        <ThinkingRow agent="claude" />

        {ended && (
          <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border bg-card/50 px-4 py-4">
            <span className="font-mono text-[11px] text-muted-foreground">— сессия завершена · exit 0 · 14:02 —</span>
            <div className="flex gap-2">
              <button className="h-9 rounded-[9px] bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground">↻ Продолжить</button>
              <button className="h-9 rounded-[9px] border border-border px-3.5 text-[13px] font-medium text-muted-foreground">В список</button>
            </div>
          </div>
        )}
      </main>

      {/* ввод: текст + диктовка + отправка */}
      <footer className="border-t border-border px-3.5 pb-[max(10px,env(safe-area-inset-bottom))] pt-2">
        {inputState === "text" ? (
          <div className="flex items-end gap-2">
            <textarea rows={1} placeholder="Сообщение агенту…"
              className="min-h-11 flex-1 resize-none rounded-xl border border-input bg-muted px-3.5 py-3 text-sm outline-none placeholder:text-muted-foreground focus:border-accent focus:ring-[3px] focus:ring-accent/15" />
            <button aria-label="Диктовка" className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border">
              <Mic className="size-4 text-muted-foreground" />
            </button>
            <button aria-label="Отправить" className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary">
              <Send className="size-4 text-primary-foreground" />
            </button>
          </div>
        ) : (
          <VoiceRecordBar state={inputState === "recording" ? "recording" : "transcribing"} />
        )}
      </footer>
    </div>
  );
}

/* Десктоп (3a): этот экран в правой колонке grid-cols-[288px_1fr];
   лента max-w-[720px] mx-auto; в PermissionCard добавляется хинт «A — всегда»;
   в шапке segmented safe/ask/auto разворачивается полностью + кнопка «терминал». */
