// remcli — общие примитивы UI (shadcn/ui-стиль).
// Статусные цвета/анимации — tailwind config из design/README.md; токены — tokens.css.
import * as React from "react";
import { Check, ChevronDown, ChevronRight, Loader2, Square } from "lucide-react";

export type AgentId = "claude" | "codex" | "gemini" | "cursor";
export type Status = "running" | "thinking" | "permission" | "idle" | "offline" | "error";

/* ---------- AgentIcon ---------- */
const AGENT: Record<AgentId, { tag: string; cls: string }> = {
  claude: { tag: "cl", cls: "bg-[#D97757]/15 text-[#C05B3C] dark:text-[#E8916F]" },
  codex:  { tag: "cx", cls: "bg-teal-400/10 text-teal-700 dark:text-teal-300" },
  gemini: { tag: "gm", cls: "bg-blue-400/10 text-blue-600 dark:text-blue-300" },
  cursor: { tag: "cu", cls: "bg-zinc-400/10 text-zinc-600 dark:text-zinc-300" },
};
export function AgentIcon({ agent, className = "size-8 rounded-lg text-xs" }: { agent: AgentId; className?: string }) {
  return (
    <span className={`flex shrink-0 items-center justify-center font-mono font-bold ${AGENT[agent].cls} ${className}`}>
      {AGENT[agent].tag}
    </span>
  );
}

/* ---------- StatusDot / StatusBadge ---------- */
export const STATUS_LABEL: Record<Status, string> = {
  running: "работает", thinking: "думает", permission: "ждёт разрешения",
  idle: "ожидает", offline: "офлайн", error: "ошибка",
};
export function StatusDot({ status, className = "size-2" }: { status: Status; className?: string }) {
  const map: Record<Status, string> = {
    running: "bg-status-running animate-pulse-run",
    thinking: "bg-status-thinking animate-pulse-think",
    permission: "bg-status-permission",
    idle: "bg-status-idle",
    offline: "border-[1.5px] border-status-offline bg-transparent",
    error: "bg-status-error",
  };
  return <span className={`inline-block shrink-0 rounded-full ${map[status]} ${className}`} />;
}
export function StatusBadge({ status }: { status: Status }) {
  const tint: Record<Status, string> = {
    running: "bg-status-running/10 text-status-running",
    thinking: "bg-status-thinking/10 text-status-thinking",
    permission: "bg-status-permission/10 text-status-permission",
    idle: "bg-muted text-muted-foreground",
    offline: "bg-muted text-muted-foreground",
    error: "bg-status-error/10 text-status-error",
  };
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10.5px] ${tint[status]}`}>
      <StatusDot status={status} className="size-1.5" />
      {STATUS_LABEL[status]}
    </span>
  );
}

/* ---------- SessionCard ---------- */
export function SessionCard(props: {
  agent: AgentId; path: string; message: string; status: Status; time?: string; onClick?: () => void;
}) {
  const { agent, path, message, status, time, onClick } = props;
  const frame =
    status === "permission"
      ? "border-status-permission/40 bg-gradient-to-r from-status-permission/10 to-card"
      : status === "running" || status === "thinking"
        ? "border-accent/35 bg-card"
        : status === "offline"
          ? "border-border bg-card opacity-55"
          : "border-border bg-card";
  const msgCls =
    status === "permission" ? "text-status-permission font-medium"
    : status === "running" ? "text-status-running"
    : status === "thinking" ? "text-status-thinking"
    : "text-muted-foreground";
  return (
    <button onClick={onClick} className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left ${frame}`}>
      <AgentIcon agent={agent} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-mono text-[13px] font-semibold">{path}</span>
        <span className={`truncate text-xs ${msgCls}`}>{message}</span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <StatusDot status={status} />
        {time && <span className="font-mono text-[10px] text-muted-foreground">{time}</span>}
      </span>
    </button>
  );
}

/* ---------- PermissionCard ---------- */
export function PermissionCard(props: {
  tool: string; command: React.ReactNode; comment?: string; danger?: boolean;
  allowLabel?: string; alwaysLabel?: string; time?: string;
  onAllow?: () => void; onDeny?: () => void; onAlways?: () => void;
}) {
  const { tool, command, comment, danger, allowLabel, alwaysLabel, time, onAllow, onDeny, onAlways } = props;
  const c = danger
    ? { frame: "border-status-error/50 bg-status-error/[0.06]", head: "border-status-error/25 text-status-error", dot: "bg-status-error" }
    : { frame: "border-status-permission/45 bg-status-permission/[0.06]", head: "border-status-permission/20 text-status-permission", dot: "bg-status-permission" };
  return (
    <div className={`overflow-hidden rounded-xl border shadow-lg shadow-black/5 ${c.frame}`}>
      <div className={`flex items-center gap-2 border-b px-3 py-2.5 ${c.head}`}>
        <span className={`size-[7px] rounded-full ${c.dot}`} />
        <span className="font-mono text-[11px] font-semibold">
          {danger ? "опасная команда · необратимо" : `запрос разрешения · ${tool}`}
        </span>
        {time && <span className="ml-auto font-mono text-[10px] text-muted-foreground">{time}</span>}
      </div>
      <div className="m-3 rounded-lg border border-border bg-zinc-950 px-3 py-2.5 font-mono text-xs leading-relaxed text-zinc-200">
        <span className={danger ? "text-status-error" : "text-emerald-400"}>$</span> {command}
        {comment && <div className="text-zinc-500"># {comment}</div>}
      </div>
      <div className="flex gap-2 px-3 pb-3">
        <button onClick={onAllow}
          className={`h-11 flex-[1.4] rounded-[11px] text-sm font-semibold ${danger ? "bg-status-error text-white" : "bg-accent text-accent-foreground"}`}>
          {allowLabel ?? "Разрешить"}
        </button>
        <button onClick={onDeny} className="h-11 flex-1 rounded-[11px] border border-destructive/35 text-sm font-medium text-destructive">
          Запретить
        </button>
      </div>
      {!danger && alwaysLabel && (
        <button onClick={onAlways} className="w-full pb-3 text-center font-mono text-[11px] text-muted-foreground">
          {alwaysLabel}
        </button>
      )}
    </div>
  );
}

/* ---------- ToolCallCard ---------- */
export function ToolCallCard(props: {
  tool: string; arg: string; state: "running" | "success" | "error";
  expanded?: boolean; children?: React.ReactNode; errorText?: string;
}) {
  const { tool, arg, state, expanded, children, errorText } = props;
  return (
    <div className={`overflow-hidden rounded-[9px] border bg-card ${state === "error" ? "border-status-error/35" : "border-border"}`}>
      <div className="flex items-center gap-2.5 px-3 py-2 font-mono text-xs">
        {expanded ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />}
        <span className="text-muted-foreground">{tool}</span>
        <span className="flex-1 truncate">{arg}</span>
        {state === "running" && <Loader2 className="size-3.5 animate-spin text-accent" />}
        {state === "success" && <Check className="size-3.5 text-status-running" />}
        {state === "error" && <span className="text-[10.5px] text-status-error">{errorText ?? "exit 1"}</span>}
      </div>
      {expanded && children && (
        <div className="border-t border-border bg-zinc-950/60 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground dark:bg-zinc-950">
          {children}
        </div>
      )}
    </div>
  );
}

/* ---------- DiffView ---------- */
export type DiffLine = { t: "ctx" | "add" | "del"; text: string };
export function DiffView({ file, added, removed, lines }: { file: string; added: number; removed: number; lines: DiffLine[] }) {
  const row: Record<DiffLine["t"], string> = {
    ctx: "text-muted-foreground",
    add: "bg-status-running/10 text-emerald-700 dark:text-emerald-300",
    del: "bg-status-error/10 text-red-700 dark:text-red-300",
  };
  return (
    <div className="overflow-hidden rounded-[9px] border border-border font-mono text-[11.5px]">
      <div className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
        <span>{file}</span>
        <span className="ml-auto text-status-running">+{added}</span>
        <span className="text-status-error">−{removed}</span>
      </div>
      <div className="bg-background py-1 leading-[1.75]">
        {lines.map((l, i) => (
          <div key={i} className={`px-3 ${row[l.t]}`}>
            {l.t === "add" ? "+" : l.t === "del" ? "−" : "\u00A0"} {l.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------- Чат: метки и сообщения ---------- */
export function AgentMeta({ agent, children }: { agent: AgentId; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
      <AgentIcon agent={agent} className="size-[18px] rounded-[5px] text-[9px]" />
      {children}
    </div>
  );
}
export function UserMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="max-w-[85%] self-end rounded-2xl rounded-br-[4px] bg-secondary px-3.5 py-2 text-sm leading-normal">
      {children}
    </div>
  );
}
export function Caret({ thinking = false }: { thinking?: boolean }) {
  return (
    <span className={`ml-0.5 inline-block h-[15px] w-2 align-[-2px] ${thinking ? "animate-blink-think bg-status-thinking" : "animate-blink bg-accent"}`} />
  );
}
export function ThinkingRow({ agent }: { agent: AgentId }) {
  return (
    <div className="flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
      <AgentIcon agent={agent} className="size-[18px] rounded-[5px] text-[9px]" />
      думает <Caret thinking />
    </div>
  );
}

/* ---------- ListenButton (TTS) ---------- */
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
        {time ?? "0:12"} · стоп
      </button>
    );
  if (state === "synth")
    return <button className={`${base} border-border text-muted-foreground`}><Loader2 className="size-3 animate-spin text-accent" />синтез…</button>;
  if (state === "error")
    return <button className={`${base} border-status-error/35 text-status-error`}>tts недоступен</button>;
  return (
    <button className={`${base} border-border text-muted-foreground`}>
      <svg width="10" height="10" viewBox="0 0 12 12"><path d="M2 4.5v3h2.5L7.5 10V2L4.5 4.5H2Z" fill="currentColor" /></svg>
      слушать
    </button>
  );
}

/* ---------- VoiceRecordBar ---------- */
export function VoiceRecordBar({ state = "recording", seconds = "0:07" }: { state?: "recording" | "transcribing" | "error"; seconds?: string }) {
  if (state === "transcribing")
    return (
      <div className="flex h-[52px] items-center gap-3 rounded-xl border border-border bg-card px-3.5">
        <Loader2 className="size-3.5 animate-spin text-status-thinking" />
        <span className="font-mono text-xs text-muted-foreground">распознаём…</span>
        <button className="ml-auto font-mono text-[11px] text-muted-foreground/60">отмена</button>
      </div>
    );
  if (state === "error")
    return (
      <div className="flex h-[52px] items-center gap-3 rounded-xl border border-status-error/40 bg-status-error/[0.06] px-3.5">
        <span className="font-mono text-xs text-status-error">микрофон недоступен</span>
        <button className="ml-auto h-7 rounded-[7px] bg-secondary px-3 text-xs font-medium">повторить</button>
      </div>
    );
  return (
    <div className="flex h-[52px] items-center gap-3 rounded-xl border border-accent/35 bg-card px-3.5">
      <span className="size-[9px] animate-pulse-run rounded-full bg-status-error" />
      <span className="flex h-[22px] flex-1 items-center gap-[2.5px]">
        {[0.9, 0.7, 1.1, 0.8, 1, 0.75, 0.95, 0.85, 1.05, 0.9].map((d, i) => (
          <span key={i} className="w-[3px] origin-center animate-bar rounded-sm bg-accent" style={{ height: "100%", animationDuration: `${d}s`, animationDelay: `${-i * 0.1}s` }} />
        ))}
      </span>
      <span className="font-mono text-xs">{seconds}</span>
      <button className="flex size-[34px] items-center justify-center rounded-[9px] bg-status-error">
        <Square className="size-3 fill-background text-background" />
      </button>
    </div>
  );
}

/* ---------- ConnectionBanner ---------- */
export function ConnectionBanner({ state }: { state: "lost" | "restored" }) {
  if (state === "restored")
    return (
      <div className="flex items-center gap-2.5 rounded-[9px] border border-status-running/30 bg-status-running/[0.08] px-3 py-2">
        <Check className="size-3 text-status-running" />
        <span className="font-mono text-[11.5px] text-status-running">соединение восстановлено</span>
      </div>
    );
  return (
    <div className="flex items-center gap-2.5 rounded-[9px] border border-status-permission/30 bg-status-permission/[0.09] px-3 py-2">
      <Loader2 className="size-3 animate-spin text-status-permission" />
      <span className="font-mono text-[11.5px] text-status-permission">соединение потеряно · переподключаем…</span>
    </div>
  );
}

/* ---------- EmptyState ---------- */
export function EmptyState({ title, hint, action }: { title: string; hint: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border bg-card/50 px-5 py-7">
      <img src="../assets/logo.svg" alt="" className="size-9 opacity-50" />
      <span className="text-[13.5px] font-semibold">{title}</span>
      <span className="font-mono text-[11px] text-muted-foreground">{hint}</span>
      {action}
    </div>
  );
}

/* ---------- Segmented (режим разрешений и пр.) ---------- */
export function Segmented({ options, value, onChange }: { options: string[]; value: string; onChange?: (v: string) => void }) {
  return (
    <div className="flex h-10 items-stretch rounded-[10px] bg-muted p-[3px] font-mono text-[11px]">
      {options.map((o) => (
        <button key={o} onClick={() => onChange?.(o)}
          className={`flex flex-1 items-center justify-center rounded-lg px-3.5 ${o === value ? "bg-background font-semibold shadow-sm dark:bg-zinc-700/60" : "text-muted-foreground"}`}>
          {o}
        </button>
      ))}
    </div>
  );
}
