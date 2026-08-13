// remcli-web — Home / Сессии. Мобайл — по design/screens/home.tsx (разметка 1:1),
// десктоп ≥1024 — сайдбар 288px по design/pages/desktop.html (grid-cols-[288px_1fr]).
// Данные — живой P2P-стор (@/lib/protocol): машины, сессии, live-статусы (session-alive),
// permission-наверх, Skeleton при загрузке, ConnectionBanner при разрыве, stop-session с Dialog.
// Сайдбар и общие хелперы (группировка, баннер, стоп-диалог) — @/components/app/SessionsSidebar.
import * as React from "react";
import { ChevronRight, Monitor, Plus, Search, Sparkles } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { ConnectionBanner, EmptyState, Logo, SessionCard, StatusDot } from "@/components/kit";
import { HomeSessionTriageControls } from "@/components/app/HomeSessionTriage";
import {
    connectionPillLabel,
    ConciergeStateIndicator,
    openCommandPalette,
    SessionsSidebar,
    StopOverlayButton,
    StopSessionDialog,
    useConnectionBanner,
    useMachineGroups,
    type MachineGroup,
    type HomeTriageState,
    type StopControls,
    type StopTarget,
    type TConciergeHomeState,
} from "@/components/app/SessionsSidebar";
import {
    formatTimeLabel,
    sessionAgent,
    sessionMessage,
    sessionPath,
    sessionStatus,
} from "@/components/app/sessionDisplay";
import { filterMachineGroups, getHomeQuickResumeCandidate, type HomeSessionFilter } from "@/lib/homeSessionTriage";
import { buildCursorResumeNavigationState, resumeCodexSession } from "@/lib/sessionResume";
import { Skeleton } from "@/components/ui/skeleton";
import { t, tPlural } from "@/lib/i18n";
import { canStopSession, type IStopMachineTarget } from "@/lib/sessionCapabilities";
import {
    fetchConciergeStatus,
    getRestConfig,
    machineGetCodexCapabilities,
    machineSpawnNewSession,
    refreshSessions,
    useConnectionStatus,
    useLatencyMs,
    useMachines,
    useProtocolStore,
    useSessions,
} from "@/lib/protocol";

function sessionsCountLabel(count: number): string {
    return `${count} ${tPlural("home.sessions", count)}`;
}

/* ---------- Консьерж: карточка в пустом состоянии (GET /v1/concierge/status) ---------- */

function useConciergeState(): TConciergeHomeState {
    const status = useConnectionStatus();
    const [conciergeState, setConciergeState] = React.useState<TConciergeHomeState>("checking");
    React.useEffect(() => {
        if (status !== "connected") {
            setConciergeState(status === "connecting" ? "checking" : "unavailable");
            return undefined;
        }
        const config = getRestConfig();
        if (!config) {
            setConciergeState("unavailable");
            return undefined;
        }
        let isCancelled = false;
        setConciergeState("checking");
        fetchConciergeStatus(config)
            .then((concierge) => {
                if (!isCancelled) setConciergeState(concierge.enabled && concierge.available ? "available" : "unavailable");
            })
            .catch(() => { if (!isCancelled) setConciergeState("unavailable"); });
        return () => { isCancelled = true; };
    }, [status]);
    if (status === "connecting") return "checking";
    if (status !== "connected") return "unavailable";
    return conciergeState;
}

function ConciergeCard({ state }: { state: TConciergeHomeState }) {
    const navigate = useNavigate();
    const hint = state === "checking"
        ? t("concierge.checking")
        : state === "available"
            ? t("concierge.empty.hint")
            : t("concierge.unavailable");
    const tone = state === "checking"
        ? "border-status-thinking/35 bg-gradient-to-r from-status-thinking/[0.08] via-card to-card shadow-[0_6px_20px_hsl(var(--status-thinking)/0.08)]"
        : state === "unavailable"
            ? "border-status-error/35 bg-gradient-to-r from-status-error/[0.08] via-card to-card shadow-[0_6px_20px_hsl(var(--status-error)/0.08)]"
            : "border-accent/35 bg-gradient-to-r from-accent/[0.1] via-card to-card shadow-[0_6px_20px_hsl(var(--accent)/0.08)]";
    return (
        <button
            type="button"
            data-home-system-card="jarvis"
            data-home-system-card-state={state}
            aria-label={t("concierge.title")}
            aria-busy={state === "checking"}
            onClick={() => navigate("/concierge")}
            className={`group flex min-h-[60px] w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-[background-color,border-color,box-shadow,transform] hover:border-accent/50 hover:shadow-[0_8px_24px_hsl(var(--accent)/0.12)] active:scale-[0.96] motion-reduce:active:scale-100 motion-reduce:transition-none ${tone}`}
        >
            <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-foreground/10 ring-1 ring-inset ring-foreground/10">
                <Sparkles className="size-4 text-foreground" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-mono text-[12.5px] font-semibold">{t("concierge.title")}</span>
                <span className="truncate text-[11px] text-muted-foreground">{hint}</span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
                <ConciergeStateIndicator state={state} />
                <ChevronRight className="size-3.5 transition-transform group-hover:translate-x-0.5 motion-reduce:group-hover:translate-x-0" />
            </span>
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
    const allGroups = useMachineGroups();
    const sessions = useSessions();
    const machines = useMachines();
    const connectionStatus = useConnectionStatus();
    const navigate = useNavigate();
    const conciergeState = useConciergeState();
    const [filter, setFilter] = React.useState<HomeSessionFilter>("active");
    const [isResuming, setIsResuming] = React.useState(false);
    const resumeGateRef = React.useRef(false);
    const [stopTarget, setStopTarget] = React.useState<StopTarget | null>(null);
    const groups = React.useMemo(() => filterMachineGroups(allGroups, filter), [allGroups, filter]);
    const quickResumeCandidate = React.useMemo(() => getHomeQuickResumeCandidate({
        sessions,
        machines,
        isConnected: connectionStatus === "connected",
    }), [connectionStatus, machines, sessions]);
    const resumeLatest = React.useCallback(async () => {
        if (!quickResumeCandidate || resumeGateRef.current) return;

        resumeGateRef.current = true;
        setIsResuming(true);
        try {
            if (quickResumeCandidate.agent === "cursor") {
                if (!quickResumeCandidate.cursorModel) {
                    toast.error(t("chat.resumeConfigurationUnavailable"));
                    return;
                }
                navigate("/new", {
                    state: buildCursorResumeNavigationState({
                        machineId: quickResumeCandidate.machine.id,
                        directory: quickResumeCandidate.directory,
                        resumeSessionId: quickResumeCandidate.nativeSessionId,
                        resumeSessionName: quickResumeCandidate.sessionName ?? undefined,
                        cursorModel: quickResumeCandidate.cursorModel,
                    }),
                });
                return;
            }

            const result = await resumeCodexSession(quickResumeCandidate.session, quickResumeCandidate.machine.id, {
                getCapabilities: machineGetCodexCapabilities,
                spawn: (options) => machineSpawnNewSession(options),
                refreshSessions,
                hasSession: (sessionId) => Boolean(useProtocolStore.getState().sessions[sessionId]),
            });
            if (result.type === "capabilities-unavailable") {
                toast.error(t("new.capabilitiesUnavailable"));
                return;
            }
            if (result.type === "configuration-unavailable") {
                toast.error(t("chat.resumeConfigurationUnavailable"));
                return;
            }
            if (result.type === "spawn-error") {
                toast.error(result.errorMessage || t("chat.resumeFailed"));
                return;
            }
            navigate(`/session/${result.sessionId}`);
        } finally {
            resumeGateRef.current = false;
            setIsResuming(false);
        }
    }, [navigate, quickResumeCandidate]);
    const triage: HomeTriageState = {
        filter,
        onFilterChange: setFilter,
        quickResumeCandidate,
        isResuming,
        onQuickResume: () => { void resumeLatest(); },
    };
    const controls: StopControls = {
        requestStop: (session, machine) => {
            if (!canStopSession(session, machine)) return;
            setStopTarget({ session, machine });
        },
    };
    return (
        <>
            <MobileHome
                groups={groups}
                allSessionCount={sessions.length}
                controls={controls}
                triage={triage}
                conciergeState={conciergeState}
            />
            <DesktopHome groups={groups} triage={triage} conciergeState={conciergeState} />
            <StopSessionDialog target={stopTarget} onClose={() => setStopTarget(null)} />
        </>
    );
}

/* ---------- Мобайл <1024 (design/screens/home.tsx) ---------- */

function MobileHome({ groups, allSessionCount, controls, triage, conciergeState }: {
    groups: MachineGroup[];
    allSessionCount: number;
    controls: StopControls;
    triage: HomeTriageState;
    conciergeState: TConciergeHomeState;
}) {
    const navigate = useNavigate();
    const connectionStatus = useConnectionStatus();
    const latencyMs = useLatencyMs();
    const banner = useConnectionBanner();
    const isGraceOver = useInitialGraceOver();
    const isConnected = connectionStatus === "connected";
    const sessionCount = groups.reduce((sum, group) => sum + group.sessions.length, 0);
    const isEmpty = allSessionCount === 0;
    const isFilterEmpty = !isEmpty && sessionCount === 0;
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
                <ConciergeCard state={conciergeState} />
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
                    </div>
                ) : (
                    <>
                        <HomeSessionTriageControls
                            filter={triage.filter}
                            onFilterChange={triage.onFilterChange}
                            quickResumeCandidate={triage.quickResumeCandidate}
                            isResuming={triage.isResuming}
                            onQuickResume={triage.onQuickResume}
                        />
                        {isFilterEmpty ? (
                            <div className="py-10 text-center" role="status">
                                <p className="font-mono text-[11px] text-muted-foreground">{t("home.filter.empty")}</p>
                            </div>
                        ) : groups.map((group, index) => (
                            <MachineSection key={group.key} group={group} controls={controls} isFirst={index === 0} />
                        ))}
                    </>
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
    const stopMachine: IStopMachineTarget = {
        id: group.rpcMachineId,
        isActive: group.isOnline,
    };
    return (
        <>
            {group.isOnline ? (
                <div className={`flex items-center gap-2 px-1 font-mono text-[11px] text-muted-foreground ${isFirst ? "pt-1.5" : "pt-2.5"}`}>
                    <Monitor className="size-3" /> {group.name} <span className="text-status-running">{t("home.machine.online")}</span>
                    <span className="ml-auto text-muted-foreground">{sessionsCountLabel(group.sessions.length)}</span>
                </div>
            ) : (
                <div className={`flex items-center gap-2 px-1 font-mono text-[11px] text-muted-foreground ${isFirst ? "pt-1.5" : "pt-2.5"}`}>
                    <Monitor className="size-3" /> {group.name}{" "}
                    <span>{t("home.machine.offline")}{group.lastSeenLabel ? ` · ${group.lastSeenLabel}` : ""}</span>
                </div>
            )}
            {group.sessions.map((session) => {
                const status = sessionStatus(session);
                const canStop = canStopSession(session, stopMachine);
                return (
                    <div key={session.id} className="group relative">
                        <SessionCard
                            agent={sessionAgent(session)}
                            path={sessionPath(session)}
                            message={sessionMessage(session)}
                            status={status}
                            time={formatTimeLabel(session.activeAt)}
                            hasTrailingAction={canStop}
                            onClick={() => navigate(`/session/${session.id}`)}
                        />
                        {canStop && (
                            <StopOverlayButton onClick={() => controls.requestStop(session, stopMachine)} />
                        )}
                    </div>
                );
            })}
        </>
    );
}

/* ---------- Десктоп ≥1024 (design/pages/desktop.html, 3a): сайдбар 288px + правая зона ---------- */

function DesktopHome({ groups, triage, conciergeState }: {
    groups: MachineGroup[];
    triage: HomeTriageState;
    conciergeState: TConciergeHomeState;
}) {
    return (
        <div className="hidden min-h-0 flex-1 lg:grid lg:grid-cols-[288px_1fr]">
            <SessionsSidebar groups={groups} homeTriage={triage} conciergeState={conciergeState} />
            <section className="flex min-h-0 flex-col items-center justify-center px-6">
                <div className="w-full max-w-sm">
                    <EmptyState title={t("home.desktop.pick.title")} hint={t("home.desktop.pick.hint")} />
                </div>
            </section>
        </div>
    );
}
