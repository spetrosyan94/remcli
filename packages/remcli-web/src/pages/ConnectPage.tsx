// remcli-web — Onboarding / Подключение (design/screens/connect.tsx, connect-states.html).
// Реальный флоу P2P: hash из QR-ссылки демона (/terminal/connect#base64({k,v})) → авто-коннект;
// камера getUserMedia + BarcodeDetector (фолбэк — вставка полной connection URL);
// startProtocolClient + live-статус сокета → редирект на / либо состояние error.
import * as React from "react";
import { Link2, Loader2, QrCode, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { Caret, Logo } from "@/components/kit";
import { t } from "@/lib/i18n";
import {
    logoutProtocolClient,
    decodePairingKey,
    getStoredConnection,
    parseConnectData,
    parseConnectUrl,
    startProtocolClient,
    useConnectionStatus,
    type P2PQRPayload,
} from "@/lib/protocol";

type ConnectState = "idle" | "scanning" | "connecting" | "error" | "manual";

const CONNECT_TIMEOUT_MS = 15_000;
const SCAN_INTERVAL_MS = 350;
const TIMEOUT_ADDRESS_PLACEHOLDER = "{address}";
const FIXTURE_CONNECT_STATES = new Set<ConnectState>(["scanning", "error", "manual"]);
const FIXTURE_ERROR_PAYLOAD: P2PQRPayload = {
    mode: "p2p",
    host: "192.0.2.1",
    port: 61921,
    key: "fixture-connect-key",
    v: 1,
};

function readFixtureConnectState(search: string): ConnectState | null {
    const parameters = new URLSearchParams(search);
    if (parameters.get("fixtures") !== "1") return null;

    const value = parameters.get("connectFixture");
    return value && FIXTURE_CONNECT_STATES.has(value as ConnectState)
        ? value as ConnectState
        : null;
}

function splitTimeoutMessage(template: string): { prefix: string; suffix: string } {
    const marker = "{address}";
    const markerIndex = template.indexOf(marker);
    if (markerIndex === -1) return { prefix: template, suffix: "" };

    return {
        prefix: template.slice(0, markerIndex),
        suffix: template.slice(markerIndex + marker.length).trimStart(),
    };
}

/* ---------- BarcodeDetector (нет в lib.dom — минимальная типизация) ---------- */

interface DetectedBarcode {
    rawValue: string;
}

interface QrDetector {
    detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}

type QrDetectorCtor = new (options?: { formats?: string[] }) => QrDetector;

function createQrDetector(): QrDetector | null {
    const ctor = (window as Window & { BarcodeDetector?: QrDetectorCtor }).BarcodeDetector;
    if (!ctor) return null;
    try {
        return new ctor({ formats: ["qr_code"] });
    } catch {
        return null;
    }
}

function hasCameraApi(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

/** Адрес для отображения в состояниях connecting/error. */
function payloadTarget(payload: P2PQRPayload): string {
    return payload.port === 0 ? payload.host : `${payload.host}:${payload.port}`;
}

export function ConnectPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const connectionStatus = useConnectionStatus();
    const fixtureState = readFixtureConnectState(location.search);
    // Упавший restore приходит без pairing key в history.state. Повтор использует
    // только локально сохранённый credential, который уже принадлежит устройству.
    const restoreFailed = (location.state as { restoreFailed?: boolean } | null)?.restoreFailed === true;
    const failedPayload = React.useMemo(() => {
        if (!restoreFailed) return null;
        const stored = getStoredConnection();
        if (!stored) return null;
        try {
            return {
                mode: "p2p" as const,
                host: stored.host,
                port: stored.port,
                key: stored.key,
                v: decodePairingKey(stored.key).version,
            };
        } catch {
            return null;
        }
    }, [restoreFailed]);
    const [state, setState] = React.useState<ConnectState>(fixtureState ?? (failedPayload ? "error" : "idle"));
    const [payload, setPayload] = React.useState<P2PQRPayload | null>(failedPayload ?? (fixtureState === "error" ? FIXTURE_ERROR_PAYLOAD : null));
    const [connectionLink, setConnectionLink] = React.useState("");
    const [manualError, setManualError] = React.useState<string | null>(null);
    const [scannerNotice, setScannerNotice] = React.useState<string | null>(null);
    const videoRef = React.useRef<HTMLVideoElement | null>(null);
    const connectionAttemptRef = React.useRef(0);

    const target = payload ? payloadTarget(payload) : "";
    const timeoutMessage = splitTimeoutMessage(t("connect.error.timeout", { address: TIMEOUT_ADDRESS_PLACEHOLDER }));

    const beginConnect = React.useCallback((next: P2PQRPayload) => {
        connectionAttemptRef.current += 1;
        setPayload(next);
        setState("connecting");
    }, []);

    // QR-ссылка демона: /connect#… или /terminal/connect#… — читаем hash и сразу подключаемся.
    React.useEffect(() => {
        if (window.location.hash.length <= 1) return;
        const parsed = parseConnectUrl(window.location.href);
        // Убираем секрет из адресной строки и истории
        window.history.replaceState(null, "", window.location.pathname);
        if (parsed) beginConnect(parsed);
    }, [beginConnect]);

    // Подключение: стартуем протокол-клиент при входе в состояние connecting.
    React.useEffect(() => {
        if (state !== "connecting" || !payload) return;
        const attempt = connectionAttemptRef.current;
        let isActive = true;
        startProtocolClient(payload).catch(() => {
            if (!isActive || connectionAttemptRef.current !== attempt) return;
            logoutProtocolClient();
            setState("error");
        });
        return () => {
            isActive = false;
        };
    }, [state, payload]);

    // Live-статус сокета: connected → Home; error/таймаут → состояние error.
    React.useEffect(() => {
        if (state !== "connecting") return undefined;
        const attempt = connectionAttemptRef.current;
        const isCurrentAttempt = () => connectionAttemptRef.current === attempt;
        if (connectionStatus === "connected") {
            navigate("/", { replace: true });
            return undefined;
        }
        if (connectionStatus === "error" && isCurrentAttempt()) {
            logoutProtocolClient();
            setState("error");
            return undefined;
        }
        const timeoutId = window.setTimeout(() => {
            if (!isCurrentAttempt()) return;
            logoutProtocolClient();
            setState("error");
        }, CONNECT_TIMEOUT_MS);
        return () => window.clearTimeout(timeoutId);
    }, [state, connectionStatus, navigate, payload]);

    // Камера-скан: getUserMedia + BarcodeDetector, опрос кадров по таймеру.
    React.useEffect(() => {
        if (state !== "scanning") return undefined;
        if (fixtureState === "scanning") return undefined;
        const detector = createQrDetector();
        if (!detector || !hasCameraApi()) {
            setScannerNotice(t("connect.scanner.unsupported"));
            setState("manual");
            return undefined;
        }
        let isActive = true;
        let stream: MediaStream | null = null;
        let intervalId = 0;
        const stop = () => {
            window.clearInterval(intervalId);
            stream?.getTracks().forEach((track) => track.stop());
        };
        navigator.mediaDevices
            .getUserMedia({ video: { facingMode: "environment" } })
            .then((mediaStream) => {
                if (!isActive) {
                    mediaStream.getTracks().forEach((track) => track.stop());
                    return;
                }
                stream = mediaStream;
                const video = videoRef.current;
                if (!video) return;
                video.srcObject = mediaStream;
                void video.play().catch(() => undefined);
                intervalId = window.setInterval(() => {
                    detector
                        .detect(video)
                        .then((codes) => {
                            if (!isActive) return;
                            for (const code of codes) {
                                const parsed = parseConnectData(code.rawValue);
                                if (parsed) {
                                    isActive = false;
                                    stop();
                                    beginConnect(parsed);
                                    return;
                                }
                            }
                        })
                        .catch(() => undefined); // кадр ещё не готов — пропускаем
                }, SCAN_INTERVAL_MS);
            })
            .catch(() => {
                if (!isActive) return;
                setScannerNotice(t("connect.scanner.cameraDenied"));
                setState("manual");
            });
        return () => {
            isActive = false;
            stop();
        };
    }, [state, beginConnect]);

    const startManualConnect = () => {
        const parsed = parseConnectUrl(connectionLink);
        if (!parsed) {
            setManualError(t("connect.manual.invalid"));
            return;
        }
        setManualError(null);
        beginConnect(parsed);
    };

    return (
        <div className="flex min-h-dvh flex-col bg-background pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-foreground">
            {/* центр: знак + промис */}
            <div className="flex flex-1 flex-col items-center justify-center px-8">
                <Logo className="size-[72px] text-foreground" label="remcli" />
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
                            <video
                                ref={videoRef}
                                autoPlay
                                playsInline
                                muted
                                className="absolute inset-0 size-full object-cover"
                            />
                            <div className="relative size-[150px] rounded-[18px] border-2 border-accent/80 shadow-[0_0_0_2000px_rgba(0,0,0,0.45)]" />
                            <span className="absolute bottom-3 font-mono text-[10px] text-muted-foreground">{t("connect.scanner.hint")}</span>
                            <button
                                onClick={() => setState("idle")}
                                className="absolute right-3 top-3 flex size-11 items-center justify-center rounded-[10px] border border-border bg-card/80 text-muted-foreground"
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
                        <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="truncate text-[13.5px] font-semibold">{t("connect.connectingTo")} {target}</span>
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
                            {timeoutMessage.prefix}<span className="break-all">{target}</span>
                            {timeoutMessage.suffix && <><br />{timeoutMessage.suffix}</>}<br />{t("connect.error.hint")}
                        </p>
                        <div className="flex gap-2">
                            <button onClick={() => setState("connecting")} className="h-11 flex-1 rounded-[9px] bg-primary text-[13px] font-semibold text-primary-foreground">{t("connect.retry")}</button>
                            <button onClick={() => setState("scanning")} className="h-11 flex-1 rounded-[9px] border border-border text-[13px] font-medium text-muted-foreground">{t("connect.rescan")}</button>
                        </div>
                    </div>
                )}

                {state === "manual" && (
                    <form
                        className="mt-8 flex w-full flex-col gap-2.5 rounded-2xl border border-border bg-card px-4 py-4"
                        onSubmit={(event) => {
                            event.preventDefault();
                            startManualConnect();
                        }}
                    >
                        <span className="text-[13px] font-semibold">{t("connect.manual.title")}</span>
                        {scannerNotice && (
                            <p className="font-mono text-[11px] leading-relaxed text-status-permission">{scannerNotice}</p>
                        )}
                        <p id="connection-link-hint" className="font-mono text-[11px] leading-relaxed text-muted-foreground">{t("connect.manual.hint")}</p>
                        <div className="flex h-11 min-w-0 items-center gap-2 rounded-[10px] border border-input bg-muted px-3 transition-[border-color,box-shadow] duration-[var(--dur-micro)] ease-[var(--ease-out)] focus-within:border-accent focus-within:ring-[3px] focus-within:ring-accent/15">
                            <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
                            <input
                                aria-label={t("connect.manual.linkPlaceholder")}
                                aria-describedby="connection-link-hint"
                                autoCapitalize="none"
                                autoComplete="off"
                                autoCorrect="off"
                                className="h-11 min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground"
                                inputMode="url"
                                placeholder={t("connect.manual.linkPlaceholder")}
                                spellCheck={false}
                                type="text"
                                value={connectionLink}
                                onChange={(event) => {
                                    setConnectionLink(event.target.value);
                                    setManualError(null);
                                }}
                            />
                        </div>
                        {manualError && (
                            <p className="font-mono text-[11px] text-status-error">{manualError}</p>
                        )}
                        <button type="submit" className="h-11 rounded-[10px] bg-primary text-sm font-semibold text-primary-foreground">{t("connect.manual.submit")}</button>
                    </form>
                )}
            </div>

            {/* нижние действия — зона большого пальца */}
            <div className="flex flex-col gap-2.5 px-5 pb-3.5">
                <button onClick={() => setState("scanning")} className="flex h-[52px] items-center justify-center gap-2.5 rounded-xl bg-primary text-base font-semibold text-primary-foreground">
                    <QrCode className="size-[17px]" /> {t("connect.scanQr")}
                </button>
                <button onClick={() => setState("manual")} className="h-12 rounded-xl border border-border text-sm font-medium text-muted-foreground">{t("connect.enterManually")}</button>
                <span className="mt-0.5 text-center font-mono text-[10px] text-muted-foreground">{t("connect.footerHint")}</span>
            </div>
        </div>
    );
}
