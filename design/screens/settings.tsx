// remcli — Настройки (см. 03 Screens 1i). Сгруппированные списки.
import * as React from "react";
import { ChevronRight, MoreHorizontal, QrCode } from "lucide-react";
import { Segmented, StatusDot } from "./components";

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <span className="px-1 font-mono text-[10px] text-muted-foreground/70">{label}</span>
      <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">{children}</div>
    </section>
  );
}
function Row({ label, value, chevron, children }: { label: string; value?: string; chevron?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-12 items-center gap-2.5 px-3.5 py-2.5">
      <span className="flex-1 text-[13.5px]">{label}</span>
      {value && <span className="font-mono text-xs text-muted-foreground">{value}</span>}
      {children}
      {chevron && <ChevronRight className="size-3 text-muted-foreground/60" />}
    </div>
  );
}

export default function SettingsScreen() {
  const [theme, setTheme] = React.useState("тьма");
  return (
    <div className="flex min-h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
      <header className="px-5 pb-3 pt-1.5"><h1 className="text-xl font-semibold">Настройки</h1></header>

      <main className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        <Group label="внешний вид">
          <Row label="Тема"><div className="w-44"><Segmented options={["свет", "тьма", "авто"]} value={theme} onChange={setTheme} /></div></Row>
          <Row label="Язык" value="Русский" chevron /> {/* 10 локалей */}
        </Group>

        <Group label="голос">
          <Row label="Провайдер TTS" value="system" chevron />
          <Row label="Голос" value="Milena · ru" chevron />
          <Row label="Автоозвучка ответов">
            <span className="relative h-[22px] w-9 rounded-full bg-border">
              <span className="absolute left-0.5 top-0.5 size-[18px] rounded-full bg-muted-foreground" />
            </span>
          </Row>
        </Group>

        <Group label="машины">
          <div className="flex min-h-12 items-center gap-2.5 px-3.5 py-2.5">
            <StatusDot status="running" className="size-[7px]" />
            <span className="flex-1 font-mono text-[12.5px]">mbp.local</span>
            <span className="font-mono text-[10px] text-muted-foreground/70">lan · 12ms</span>
            <MoreHorizontal className="size-4 text-muted-foreground/60" /> {/* переименовать / удалить */}
          </div>
          <div className="flex min-h-12 items-center gap-2.5 px-3.5 py-2.5">
            <StatusDot status="offline" className="size-[7px]" />
            <span className="flex-1 font-mono text-[12.5px] text-muted-foreground">studio-pc</span>
            <span className="font-mono text-[10px] text-muted-foreground/70">офлайн</span>
            <MoreHorizontal className="size-4 text-muted-foreground/60" />
          </div>
          <button className="flex min-h-12 w-full items-center gap-2.5 px-3.5 py-2.5 text-accent">
            <QrCode className="size-[13px]" />
            <span className="text-[13px] font-medium">Добавить машину по QR</span>
          </button>
        </Group>

        <Group label="о приложении">
          <Row label="Версия" value="0.4.2 · демон 0.4.2" />
        </Group>
      </main>
      {/* + таб-бар как в home.tsx (active="Настройки") */}
    </div>
  );
}
