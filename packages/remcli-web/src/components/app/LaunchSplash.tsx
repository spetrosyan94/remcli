// remcli-web — сплэш запуска (design/DESIGN.md §Splash, MOTION.md §9 + §8).
// Показывается РОВНО в двух случаях (решение принимается один раз, при инициализации модуля):
//   (а) переход по QR-ссылке /terminal/connect#… — пока ConnectPage поднимает протокол-клиент;
//   (б) холодный старт с сохранённым подключением — на время restoreProtocolClient (RequireConnection).
// НЕ показывается при обычной навигации (модуль уже инициализирован) и в fixture-режиме
// (isClientStarted() === true до первого рендера — стор уже готов).
//
// Анимация знака — CSS-only, тайминги сняты с design/'04 Motion.dc.html' (§9):
// шевроны съезжаются к центру за 380ms ease-out (эхо −8px → opacity 0.26, основной +7px),
// затем курсор-блок мигает 2 раза steps(1) (итого интро ≤1.4s) и продолжает медленный
// blink 1.2s. Исчезновение — fade 250ms (§8 Splash→Home) кривой --ease-out.
import * as React from "react";
import { useNavigate } from "react-router";
import {
    isClientStarted,
    parseConnectUrl,
    restoreCredentials,
    stopProtocolClient,
    useConnectionStatus,
} from "@/lib/protocol";

/** Минимальное время показа — сплэш не должен мелькать (MOTION.md §9). */
const SPLASH_MIN_VISIBLE_MS = 600;
/** Fade в целевой экран (MOTION.md §8: Splash→Home fade 250ms). */
const SPLASH_FADE_MS = 250;
/** Страховка от зависания: чуть больше CONNECT_TIMEOUT_MS ConnectPage (15s). */
const SPLASH_TIMEOUT_MS = 16_000;

type SplashReason = "qr-connect" | "restore";

/**
 * Причина показа сплэша — вычисляется один раз при загрузке модуля (холодный старт),
 * до первого рендера и до того, как ConnectPage сотрёт hash из адресной строки.
 */
function detectSplashReason(): SplashReason | null {
    if (typeof window === "undefined") return null;
    // Fixture-режим: client.ts инициализирует стор до первого рендера — сплэш не нужен
    if (isClientStarted()) return null;
    const path = window.location.pathname;
    if (path === "/connect" || path === "/terminal/connect") {
        return parseConnectUrl(window.location.href) ? "qr-connect" : null;
    }
    // Холодный старт app-роута: RequireConnection запустит restoreProtocolClient
    return restoreCredentials() !== null ? "restore" : null;
}

const splashReason = detectSplashReason();

/* Тайминги §9 в процентах интро 1.4s: съезд шевронов 0–380ms (~27%),
   курсор 400–1400ms мигает 2 раза steps(1); после интро — blink 1.2s. */
const SPLASH_CSS = `
@keyframes rcSplashEcho {
    0% { transform: translateX(-8px); opacity: 0; }
    27%, 100% { transform: translateX(0); opacity: 0.26; }
}
@keyframes rcSplashMain {
    0% { transform: translateX(7px); opacity: 0; }
    27%, 100% { transform: translateX(0); opacity: 1; }
}
@keyframes rcSplashCur {
    0%, 28% { opacity: 0; }
    29%, 46% { opacity: 1; }
    47%, 64% { opacity: 0; }
    65%, 100% { opacity: 1; }
}
@keyframes rcSplashBlink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
}
.rc-splash-echo { animation: rcSplashEcho 1.4s cubic-bezier(0.22, 1, 0.36, 1) both; }
.rc-splash-main { animation: rcSplashMain 1.4s cubic-bezier(0.22, 1, 0.36, 1) both; }
.rc-splash-cursor { animation: rcSplashCur 1.4s steps(1) both, rcSplashBlink 1.2s steps(2) 1.4s infinite; }
@media (prefers-reduced-motion: reduce) {
    .rc-splash-echo, .rc-splash-main, .rc-splash-cursor { animation: none; }
    .rc-splash-echo { opacity: 0.26; }
}
`;

type SplashPhase = "visible" | "leaving" | "hidden";
type SplashOutcome = "pending" | "ready" | "failed";

export function LaunchSplash() {
    const navigate = useNavigate();
    const connectionStatus = useConnectionStatus();
    const [phase, setPhase] = React.useState<SplashPhase>(splashReason ? "visible" : "hidden");
    const [outcome, setOutcome] = React.useState<SplashOutcome>("pending");
    const shownAtRef = React.useRef(Date.now());
    const hasSeenConnectingRef = React.useRef(false);

    // Готовность/падение — по live-статусу сокета (никаких искусственных задержек):
    // connected → стор готов; error → упало; connecting→disconnected — клиент остановлен
    // (напр. таймаут ConnectPage вызвал logout) — тоже провал.
    React.useEffect(() => {
        if (!splashReason || outcome !== "pending") return;
        if (connectionStatus === "connecting") {
            hasSeenConnectingRef.current = true;
            return;
        }
        if (connectionStatus === "connected") {
            setOutcome("ready");
        } else if (connectionStatus === "error" || (connectionStatus === "disconnected" && hasSeenConnectingRef.current)) {
            setOutcome("failed");
        }
    }, [connectionStatus, outcome]);

    // Страховка: подключение не завершилось ни успехом, ни ошибкой — не зависаем.
    React.useEffect(() => {
        if (!splashReason) return undefined;
        const timeoutId = window.setTimeout(() => {
            setOutcome((current) => (current === "pending" ? "failed" : current));
        }, SPLASH_TIMEOUT_MS);
        return () => window.clearTimeout(timeoutId);
    }, []);

    // Итог: выдерживаем минимум 600ms показа, затем fade 250ms.
    // Упавший restore уводит на /connect с ошибкой (payload — для кнопки «повторить»);
    // при qr-connect ConnectPage уже показывает своё состояние error под сплэшем.
    React.useEffect(() => {
        if (outcome === "pending" || phase !== "visible") return undefined;
        const waitMs = Math.max(0, SPLASH_MIN_VISIBLE_MS - (Date.now() - shownAtRef.current));
        const leaveId = window.setTimeout(() => {
            if (outcome === "failed" && splashReason === "restore") {
                stopProtocolClient();
                // Do not put the pairing key into browser history state. ConnectPage
                // re-reads the already persisted local credential when retrying.
                navigate("/connect", { replace: true, state: { restoreFailed: true } });
            }
            setPhase("leaving");
        }, waitMs);
        return () => window.clearTimeout(leaveId);
    }, [outcome, phase, navigate]);

    React.useEffect(() => {
        if (phase !== "leaving") return undefined;
        const hideId = window.setTimeout(() => setPhase("hidden"), SPLASH_FADE_MS);
        return () => window.clearTimeout(hideId);
    }, [phase]);

    if (phase === "hidden") return null;

    return (
        <div
            aria-hidden
            className={`fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-background transition-opacity ease-[cubic-bezier(0.22,1,0.36,1)] duration-[250ms] motion-reduce:duration-[120ms] ${
                phase === "leaving" ? "pointer-events-none opacity-0" : "opacity-100"
            }`}
        >
            <style>{SPLASH_CSS}</style>
            {/* Знак 52px — геометрия kit/Logo (design/assets/logo-mono.svg), части анимируются раздельно */}
            <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className="size-[52px] text-foreground">
                <path d="M5.5 10.8 L10.7 16 L5.5 21.2" stroke="currentColor" strokeWidth="3.2" className="rc-splash-echo" />
                <path d="M12.2 9.3 L18.9 16 L12.2 22.7" stroke="currentColor" strokeWidth="3.2" className="rc-splash-main" />
                <rect x="21.6" y="19.5" width="6" height="3.2" className="fill-accent rc-splash-cursor" />
            </svg>
            <span className="font-mono text-[13px] font-semibold">remcli</span>
            <span className="absolute bottom-[calc(env(safe-area-inset-bottom)+24px)] font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                P2P · E2E · NO CLOUD
            </span>
        </div>
    );
}
