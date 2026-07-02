// remcli — Onboarding / Подключение (см. 03 Screens 1a/1b)
// Состояния: idle · scanning · connecting · error · manual
import * as React from "react";
import { Loader2, QrCode } from "lucide-react";
import { Caret } from "./components";

type State = "idle" | "scanning" | "connecting" | "error" | "manual";

export default function ConnectScreen({ state = "idle" }: { state?: State }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-foreground">
      {/* центр: знак + промис */}
      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <img src="../assets/logo.svg" alt="remcli" className="size-[72px]" />
        <div className="mt-4 font-mono text-[26px] font-semibold">
          remcli<span className="text-accent">_</span>
        </div>
        <p className="mt-3 text-center text-[15px] leading-normal text-muted-foreground">
          Пульт для ваших AI-агентов.<br />Телефон — в руке, код — дома.
        </p>
        <div className="mt-8 flex flex-col gap-2.5 font-mono text-xs text-muted-foreground">
          <div><span className="mr-2 text-accent">›</span>P2P: телефон ↔ ваш компьютер, напрямую</div>
          <div><span className="mr-2 text-accent">›</span>E2E-шифрование всего трафика</div>
          <div><span className="mr-2 text-accent">›</span>Без облака и аккаунтов — QR и есть логин</div>
        </div>

        {state === "connecting" && (
          <div className="mt-8 flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-4">
            <Loader2 className="size-4 animate-spin text-accent" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[13.5px] font-semibold">Подключаемся к mbp.local</span>
              <span className="font-mono text-[11px] text-muted-foreground">рукопожатие → e2e-ключи → сессии<Caret /></span>
            </div>
          </div>
        )}

        {state === "error" && (
          <div className="mt-8 flex w-full flex-col gap-2.5 rounded-2xl border border-status-error/40 bg-status-error/[0.06] px-4 py-4">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-status-error" />
              <span className="text-[13.5px] font-semibold">Не удалось подключиться</span>
            </div>
            <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
              timeout: 10.0.1.14:7350 не отвечает.<br />Проверьте, что демон запущен и вы в одной сети.
            </p>
            <div className="flex gap-2">
              <button className="h-10 flex-1 rounded-[9px] bg-primary text-[13px] font-semibold text-primary-foreground">Повторить</button>
              <button className="h-10 flex-1 rounded-[9px] border border-border text-[13px] font-medium text-muted-foreground">Сканировать заново</button>
            </div>
          </div>
        )}

        {state === "manual" && (
          <div className="mt-8 flex w-full flex-col gap-2.5 rounded-2xl border border-border bg-card px-4 py-4">
            <span className="text-[13px] font-semibold">Ручной ввод</span>
            <input className="h-11 rounded-[10px] border border-input bg-muted px-3 font-mono text-[13px] outline-none placeholder:text-muted-foreground focus:border-accent focus:ring-[3px] focus:ring-accent/15" placeholder="адрес:порт" defaultValue="10.0.1.14:7350" />
            <input className="h-11 rounded-[10px] border border-input bg-muted px-3 font-mono text-[13px] outline-none placeholder:text-muted-foreground focus:border-accent focus:ring-[3px] focus:ring-accent/15" placeholder="ключ подключения" />
            <button className="h-11 rounded-[10px] bg-primary text-sm font-semibold text-primary-foreground">Подключиться</button>
          </div>
        )}
      </div>

      {/* нижние действия — зона большого пальца */}
      <div className="flex flex-col gap-2.5 px-5 pb-3.5">
        <button className="flex h-[52px] items-center justify-center gap-2.5 rounded-xl bg-primary text-base font-semibold text-primary-foreground">
          <QrCode className="size-[17px]" /> Сканировать QR-код
        </button>
        <button className="h-12 rounded-xl border border-border text-sm font-medium text-muted-foreground">Ввести адрес вручную</button>
        <span className="mt-0.5 text-center font-mono text-[10px] text-muted-foreground/50">демон: remcli serve · v0.4.2</span>
      </div>
    </div>
  );
}
