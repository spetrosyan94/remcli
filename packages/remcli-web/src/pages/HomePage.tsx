// remcli-web — Home / Сессии. Мобайл — по design/screens/home.tsx (разметка 1:1),
// десктоп ≥1024 — сайдбар 288px по design/pages/desktop.html (grid-cols-[288px_1fr]).
// Данные — живой P2P-стор (@/lib/protocol): машины, сессии, live-статусы (session-alive),
// permission-наверх, Skeleton при загрузке, ConnectionBanner при разрыве, stop-session с Dialog.
// Сайдбар и общие хелперы (группировка, баннер, стоп-диалог) — @/components/app/SessionsSidebar.
import * as React from "react";
import { ChevronRight, Monitor, Plus, Search, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";
import { ConnectionBanner, EmptyState, Logo, SessionCard, StatusDot } from "@/components/kit";
import {
    connectionPillLabel,
    openCommandPalette,
    SessionsSidebar,
    StopOverlayButton,
    StopSessionDialog,
    useConnectionBanner,
    useMachineGroups,
    type MachineGroup,
    type StopControls,
    type StopTarget,
} from "@/components/app/SessionsSidebar";
import {
    formatTimeLabel,
    sessionAgent,
    sessionMessage,
    sessionPath,
    sessionStatus,
} from "@/components/app/sessionDisplay";
import { Skeleton } from "@/components/ui/skeleton";
import { t, tPlural } from "@/lib/i18n";
import {
    fetchConciergeStatus,
    getRestConfig,
    useConnectionStatus,
    useLatencyMs,
} from "@/lib/protocol";

function sessionsCountLabel(count: number): string {
    return `${count} ${tPlural("home.sessions", count)}`;
}

/* ---------- Консьерж: карточка в пустом состоянии (GET /v1/concierge/status) ---------- */

function useConciergeAvailable(): boolean {
    const status = useConnectionStatus();
    const [isAvailable, setIsAvailable] = React.useState(false);
    React.useEffect(() => {
        if (status !== "connected") return undefined;
        const config = getRestConfig();
        if (!config) return undefined;
        let isCancelled = false;
        fetchConciergeStatus(config)
            .then((concierge) => { if (!isCancelled) setIsAvailable(concierge.enabled && concierge.available); })
            .catch(() => { if (!isCancelled) setIsAvailable(false); });
        return () => { isCancelled = true; };
    }, [status]);
    return isAvailable;
}

function ConciergeCard() {
    const navigate = useNavigate();
    return (
        <button
            onClick={() => navigate("/concierge")}
            className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left"
        >
            <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-accent/10">
                <Sparkles className="size-4 text-accent" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-mono text-[12.5px] font-semibold">{t("concierge.title")}</span>
                <span className="truncate text-[11px] text-muted-foreground">{t("concierge.empty.hint")}</span>
            </span>
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />
        </button>
    );
}

/** Грейс после connected: пока initial fetch в полёте, показываем Skeleton, а не EmptyState. */
function useInitialGraceOver(): boolean {
    const status = useConnectionStatus();
    const [isOver, setIsOver] = React.useState(false);
    React.useEffect(() => {
        if (status !== "connected") return undefined;
        const timeoutId = window.setTimeout(() => setIsOver(true), 1500);
        return () => window.clearTimeout(timeoutId);
    }, [status]);
    return isOver;
}

export function HomePage() {
    const groups = useMachineGroups();
    const isConciergeAvailable = useConciergeAvailable();
    const [stopTarget, setStopTarget] = React.useState<StopTarget | null>(null);
    const controls: StopControls = {
        requestStop: (session, machineId) => setStopTarget({ session, machineId }),
    };
    return (
        <>
            <MobileHome groups={groups} controls={controls} isConciergeAvailable={isConciergeAvailable} />
            <DesktopHome />
            <StopSessionDialog target={stopTarget} onClose={() => setStopTarget(null)} />
        </>
    );
}

/* ---------- Мобайл <1024 (design/screens/home.tsx) ---------- */

function MobileHome({ groups, controls, isConciergeAvailable }: {
    groups: MachineGroup[];
    controls: StopControls;
    isConciergeAvailable: boolean;
}) {
    const navigate = useNavigate();
    const connectionStatus = useConnectionStatus();
    const latencyMs = useLatencyMs();
    const banner = useConnectionBanner();
    const isGraceOver = useInitialGraceOver();
    const isConnected = connectionStatus === "connected";
    const sessionCount = groups.reduce((sum, group) => sum + group.sessions.length, 0);
    const isEmpty = sessionCount === 0;
    const showSkeleton = isEmpty && groups.length === 0 && (connectionStatus === "connecting" || (isConnected && !isGraceOver));
    return (
        <div className="flex min-h-0 flex-1 flex-col lg:hidden">
            {/* шапка */}
            <header className="flex items-center gap-2.5 px-5 pb-3 pt-2.5">
                <Logo className="size-[22px] text-foreground" />
                <span className="font-mono text-base font-semibold">{t("app.name")}</span>
                <span className={`ml-auto flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${isConnected ? "border-accent/25 bg-accent/[0.08]" : "border-border bg-card"}`}>
                    <StatusDot status={isConnected ? "running" : "error"} className="size-1.5" />
                    <span className={`font-mono text-[10px] ${isConnected ? "text-accent" : "text-muted-foreground"}`}>
                        {connectionPillLabel(isConnected, latencyMs)}
                    </span>
                </span>
                <button
                    aria-label={t("home.searchAria")}
                    onClick={openCommandPalette}
                    className="flex size-11 items-center justify-center rounded-[10px] border border-border transition-[background-color,border-color,transform] active:scale-[0.96]"
                >
                    <Search className="size-[15px] text-muted-foreground" />
                </button>
            </header>

            {/* список машин и сессий */}
            <main className="flex flex-1 flex-col gap-2 overflow-y-auto px-4">
                {banner && <ConnectionBanner state={banner} />}
                {showSkeleton ? (
                    <div className="flex flex-col gap-2 pt-1.5">
                        <Skeleton className="h-4 w-40 bg-muted" />
                        {[0, 1, 2].map((index) => (
                            <Skeleton key={index} className="h-[66px] rounded-xl bg-muted" />
                        ))}
                    </div>
                ) : isEmpty ? (
                    <div className="mt-10 flex flex-col gap-4">
                        <EmptyState
                            title={t("home.empty.title")}
                            hint={t("home.empty.hint")}
                            action={
                                <button
                                    onClick={() => navigate("/new")}
                                    className="h-11 rounded-[9px] bg-primary px-4 text-[13px] font-semibold text-primary-foreground transition-transform active:scale-[0.96]"
                                >
                                    {t("home.newSession")}
                                </button>
                            }
                        />
                        {isConciergeAvailable && (
                            <div className="mx-auto w-full max-w-xs">
                                <ConciergeCard />
                            </div>
                        )}
                    </div>
                ) : (
                    groups.map((group, index) => (
                        <MachineSection key={group.key} group={group} controls={controls} isFirst={index === 0} />
                    ))
                )}
            </main>

            {/* FAB */}
            <button
                onClick={() => navigate("/new")}
                className="absolute bottom-[104px] right-4 flex h-[52px] items-center gap-2 rounded-2xl bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-xl shadow-black/40"
            >
                <Plus className="size-4" /> {t("home.fab")}
            </button>
        </div>
    );
}

function MachineSection({ group, controls, isFirst }: { group: MachineGroup; controls: StopControls; isFirst: boolean }) {
    const navigate = useNavigate();
    return (
        <>
            {group.isOnline ? (
                <div className={`flex items-center gap-2 px-1 font-mono text-[11px] text-muted-foreground ${isFirst ? "pt-1.5" : "pt-2.5"}`}>
                    <Monitor className="size-3" /> {group.name} <span className="text-status-running">{t("home.machine.online")}</span>
                    <span className="ml-auto text-muted-foreground/50">{sessionsCountLabel(group.sessions.length)}</span>
                </div>
            ) : (
                <div className={`flex items-center gap-2 px-1 font-mono text-[11px] text-muted-foreground/60 ${isFirst ? "pt-1.5" : "pt-2.5"}`}>
                    <Monitor className="size-3" /> {group.name}{" "}
                    <span>{t("home.machine.offline")}{group.lastSeenLabel ? ` · ${group.lastSeenLabel}` : ""}</span>
                </div>
            )}
            {group.sessions.map((session) => {
                const status = sessionStatus(session);
                return (
                    <div key={session.id} className="group relative">
                        <SessionCard
                            agent={sessionAgent(session)}
                            path={sessionPath(session)}
                            message={sessionMessage(session)}
                            status={status}
                            time={formatTimeLabel(session.activeAt)}
                            hasTrailingAction={status !== "offline"}
                            onClick={() => navigate(`/session/${session.id}`)}
                        />
                        {status !== "offline" && (
                            <StopOverlayButton onClick={() => controls.requestStop(session, group.rpcMachineId)} />
                        )}
                    </div>
                );
            })}
        </>
    );
}

/* ---------- Десктоп ≥1024 (design/pages/desktop.html, 3a): сайдбар 288px + правая зона ---------- */

function DesktopHome() {
    return (
        <div className="hidden min-h-0 flex-1 lg:grid lg:grid-cols-[288px_1fr]">
            <SessionsSidebar />
            <section className="flex min-h-0 flex-col items-center justify-center px-6">
                <div className="w-full max-w-sm">
                    <EmptyState title={t("home.desktop.pick.title")} hint={t("home.desktop.pick.hint")} />
                </div>
            </section>
        </div>
    );
}
