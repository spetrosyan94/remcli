// remcli-web — Onboarding / Подключение по design/screens/connect.tsx (эталоны: pages/connect.html, connect-states.html).
// Состояния: idle · scanning · connecting · error · manual. Камера пока мок:
// «Сканировать QR-код» → имитация скана по таймеру → подключение → Home.
import * as React from "react";
import { Loader2, QrCode, X } from "lucide-react";
import { useNavigate } from "react-router";
import { Caret } from "@/components/kit";
import { t } from "@/lib/i18n";
import { connectMock, connectionInfo } from "@/mocks/fixtures";

type ConnectState = "idle" | "scanning" | "connecting" | "error" | "manual";

export function ConnectPage() {
    const navigate = useNavigate();
    const [state, setState] = React.useState<ConnectState>("idle");
    const [willFail, setWillFail] = React.useState(false);
    const [address, setAddress] = React.useState(connectMock.manualAddress);
    const [target, setTarget] = React.useState(connectMock.host);

    React.useEffect(() => {
        if (state === "scanning") {
            // мок камеры: «нашли» QR по таймеру
            const timerId = window.setTimeout(() => {
                setTarget(connectMock.host);
                setWillFail(false);
                setState("connecting");
            }, connectMock.scanDurationMs);
            return () => window.clearTimeout(timerId);
        }
        if (state === "connecting") {
            const timerId = window.setTimeout(() => {
                if (willFail) {
                    setState("error");
                } else {
                    navigate("/", { replace: true });
                }
            }, connectMock.connectDurationMs);
            return () => window.clearTimeout(timerId);
        }
        return undefined;
    }, [state, willFail, navigate]);

    const startManualConnect = () => {
        // мок: ручной адрес «не отвечает» → демонстрируем состояние error
        setTarget(address);
        setWillFail(true);
        setState("connecting");
    };

    const retryConnect = () => {
        // мок: повторная попытка успешна
        setWillFail(false);
        setState("connecting");
    };

    return (
        <div className="flex min-h-dvh flex-col bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-foreground">
            {/* центр: знак + промис */}
            <div className="flex flex-1 flex-col items-center justify-center px-8">
                <img src="/logo.svg" alt="remcli" className="size-[72px]" />
                <div className="mt-4 font-mono text-[26px] font-semibold">
                    remcli<span className="text-accent">_</span>
                </div>
                <p className="mt-3 text-center text-[15px] leading-normal text-muted-foreground">
                    {t("connect.tagline1")}<br />{t("connect.tagline2")}
                </p>
                <div className="mt-8 flex flex-col gap-2.5 font-mono text-xs text-muted-foreground">
                    <div><span className="mr-2 text-accent">›</span>{t("connect.feature.p2p")}</div>
                    <div><span className="mr-2 text-accent">›</span>{t("connect.feature.e2e")}</div>
                    <div><span className="mr-2 text-accent">›</span>{t("connect.feature.noCloud")}</div>
                </div>

                {state === "scanning" && (
                    <div className="mt-8 w-full overflow-hidden rounded-[20px] border border-border bg-background">
                        <div className="relative flex h-[210px] items-center justify-center bg-card">
                            <div className="absolute inset-0 bg-[repeating-linear-gradient(45deg,hsl(var(--muted))_0_14px,hsl(var(--card))_14px_28px)]" />
                            <div className="relative size-[150px] rounded-[18px] border-2 border-accent/80 shadow-[0_0_0_2000px_rgba(0,0,0,0.45)]" />
                            <span className="absolute bottom-3 font-mono text-[10px] text-muted-foreground">{t("connect.scanner.hint")}</span>
                            <button
                                onClick={() => setState("idle")}
                                className="absolute right-3 top-3 flex size-[34px] items-center justify-center rounded-[10px] border border-border bg-card/80 text-muted-foreground"
                                aria-label={t("connect.scanner.close")}
                            >
                                <X className="size-[15px]" />
                            </button>
                        </div>
                    </div>
                )}

                {state === "connecting" && (
                    <div className="mt-8 flex w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-4">
                        <Loader2 className="size-4 animate-spin text-accent" />
                        <div className="flex flex-col gap-0.5">
                            <span className="text-[13.5px] font-semibold">{t("connect.connectingTo")} {target}</span>
                            <span className="font-mono text-[11px] text-muted-foreground">{t("connect.handshake")}<Caret /></span>
                        </div>
                    </div>
                )}

                {state === "error" && (
                    <div className="mt-8 flex w-full flex-col gap-2.5 rounded-2xl border border-status-error/40 bg-status-error/[0.06] px-4 py-4">
                        <div className="flex items-center gap-2">
                            <span className="size-2 rounded-full bg-status-error" />
                            <span className="text-[13.5px] font-semibold">{t("connect.error.title")}</span>
                        </div>
                        <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                            {t("connect.error.timeout").replace("{address}", target)}<br />{t("connect.error.hint")}
                        </p>
                        <div className="flex gap-2">
                            <button onClick={retryConnect} className="h-10 flex-1 rounded-[9px] bg-primary text-[13px] font-semibold text-primary-foreground">{t("connect.retry")}</button>
                            <button onClick={() => setState("scanning")} className="h-10 flex-1 rounded-[9px] border border-border text-[13px] font-medium text-muted-foreground">{t("connect.rescan")}</button>
                        </div>
                    </div>
                )}

                {state === "manual" && (
                    <div className="mt-8 flex w-full flex-col gap-2.5 rounded-2xl border border-border bg-card px-4 py-4">
                        <span className="text-[13px] font-semibold">{t("connect.manual.title")}</span>
                        <input
                            className="h-11 rounded-[10px] border border-input bg-muted px-3 font-mono text-[13px] outline-none placeholder:text-muted-foreground focus:border-accent focus:ring-[3px] focus:ring-accent/15"
                            placeholder={t("connect.manual.addressPlaceholder")}
                            value={address}
                            onChange={(event) => setAddress(event.target.value)}
                        />
                        <input
                            className="h-11 rounded-[10px] border border-input bg-muted px-3 font-mono text-[13px] outline-none placeholder:text-muted-foreground focus:border-accent focus:ring-[3px] focus:ring-accent/15"
                            placeholder={t("connect.manual.keyPlaceholder")}
                        />
                        <button onClick={startManualConnect} className="h-11 rounded-[10px] bg-primary text-sm font-semibold text-primary-foreground">{t("connect.manual.submit")}</button>
                    </div>
                )}
            </div>

            {/* нижние действия — зона большого пальца */}
            <div className="flex flex-col gap-2.5 px-5 pb-3.5">
                <button onClick={() => setState("scanning")} className="flex h-[52px] items-center justify-center gap-2.5 rounded-xl bg-primary text-base font-semibold text-primary-foreground">
                    <QrCode className="size-[17px]" /> {t("connect.scanQr")}
                </button>
                <button onClick={() => setState("manual")} className="h-12 rounded-xl border border-border text-sm font-medium text-muted-foreground">{t("connect.enterManually")}</button>
                <span className="mt-0.5 text-center font-mono text-[10px] text-muted-foreground/50">{t("connect.daemonHint")}{connectionInfo.daemonVersion}</span>
            </div>
        </div>
    );
}
