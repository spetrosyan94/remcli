// remcli-web — Home / Сессии. Мобайл — по design/screens/home.tsx (разметка 1:1),
// десктоп ≥1024 — сайдбар 288px по design/pages/desktop.html (grid-cols-[288px_1fr]).
// Данные — живой P2P-стор (@/lib/protocol): машины, сессии, live-статусы (session-alive),
// permission-наверх, Skeleton при загрузке, ConnectionBanner при разрыве, stop-session с Dialog.
import * as React from "react";
import { ChevronRight, Monitor, Plus, Search, Sparkles, Square } from "lucide-react";
import { NavLink, useNavigate } from "react-router";
import { toast } from "sonner";
import { ConnectionBanner, EmptyState, Logo, statusLabel, AgentIcon, SessionCard, StatusDot } from "@/components/kit";
import type { Status } from "@/components/kit";
import {
    formatTimeLabel,
    machineName,
    sessionAgent,
    sessionMessage,
    sessionPath,
    sessionStatus,
} from "@/components/app/sessionDisplay";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { t, tPlural } from "@/lib/i18n";
import {
    fetchConciergeStatus,
    getRestConfig,
    machineStopSession,
    useConnectionStatus,
    useLatencyMs,
    useMachines,
    useSessions,
    type Session,
} from "@/lib/protocol";

/** ⌘K-палитра живёт в shell и слушает keydown на document — открываем её синтетическим событием. */
function openCommandPalette() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
}

/** permission всегда поднимается наверх списка (DESIGN.md §Карта статусов) */
function sortPermissionFirst(list: Session[]): Session[] {
    return [...list].sort(
        (a, b) => Number(sessionStatus(b) === "permission") - Number(sessionStatus(a) === "permission"),
    );
}

function sessionsCountLabel(count: number): string {
    return `${count} ${tPlural("home.sessions", count)}`;
}

/** Текст пилюли соединения: «p2p · 12ms» (эталон design/screens/home.tsx);
 * латентность — GET /health раз в ~30s (стор протокола), до первого замера — «p2p». */
function connectionPillLabel(isConnected: boolean, latencyMs: number | null): string {
    if (!isConnected) return t("status.offline");
    return latencyMs !== null ? `${t("home.connection.p2p")} · ${latencyMs}ms` : t("home.connection.p2p");
}

/** ~/dev/remcli → remcli (компактные строки сайдбара, desktop.html) */
function shortDirName(path: string): string {
    return path.split("/").filter(Boolean).pop() ?? path;
}

/* ---------- Группировка сессий по машинам ---------- */

interface MachineGroup {
    key: string;
    name: string;
    isOnline: boolean;
    lastSeenLabel: string | null;
    /** id машины в сторе демона — адресат machine-RPC (stop-session). null — RPC недоступен. */
    rpcMachineId: string | null;
    sessions: Session[];
}

function useMachineGroups(): MachineGroup[] {
    const machines = useMachines();
    const sessions = useSessions();
    return React.useMemo(() => {
        const groups: MachineGroup[] = machines.map((machine) => ({
            key: machine.id,
            name: machineName(machine),
            isOnline: machine.active,
            lastSeenLabel: machine.active ? null : formatTimeLabel(machine.activeAt),
            rpcMachineId: machine.id,
            sessions: [],
        }));
        const byId = new Map(groups.map((group) => [group.key, group]));
        // P2P: session.metadata.machineId — персистентный UUID из settings CLI, а машина
        // в сторе демона живёт под эфемерным `machine-${pid}-…`, поэтому дополнительно
        // матчим по host из метаданных, предпочитая онлайн-машину.
        const byHost = new Map<string, MachineGroup>();
        machines.forEach((machine, index) => {
            const host = machine.metadata?.host;
            if (!host) return;
            const current = byHost.get(host);
            if (!current || (machine.active && !current.isOnline)) {
                byHost.set(host, groups[index]);
            }
        });
        // Сессии без известной машины группируем по host из метаданных;
        // RPC для них адресуем единственной онлайн-машине, если она одна.
        const activeMachines = machines.filter((machine) => machine.active);
        const fallbackRpcMachineId = activeMachines.length === 1 ? activeMachines[0].id : null;
        const orphans = new Map<string, MachineGroup>();
        for (const session of sessions) {
            const machineId = session.metadata?.machineId;
            const host = session.metadata?.host;
            const group = (machineId ? byId.get(machineId) : undefined) ?? (host ? byHost.get(host) : undefined);
            if (group) {
                group.sessions.push(session);
                continue;
            }
            const orphanHost = host ?? "unknown";
            let orphan = orphans.get(orphanHost);
            if (!orphan) {
                orphan = {
                    key: `host:${orphanHost}`,
                    name: orphanHost,
                    isOnline: false,
                    lastSeenLabel: null,
                    rpcMachineId: fallbackRpcMachineId,
                    sessions: [],
                };
                orphans.set(orphanHost, orphan);
            }
            orphan.sessions.push(session);
            orphan.isOnline = orphan.isOnline || session.active;
        }
        const all = [...groups, ...orphans.values()];
        for (const group of all) {
            group.sessions = sortPermissionFirst(group.sessions);
        }
        return all;
    }, [machines, sessions]);
}

/* ---------- Соединение: баннер разрыва/восстановления + skeleton первой загрузки ---------- */

function useConnectionBanner(): "lost" | "restored" | null {
    const status = useConnectionStatus();
    const [banner, setBanner] = React.useState<"lost" | "restored" | null>(null);
    const hadConnectedRef = React.useRef(false);
    const wasLostRef = React.useRef(false);
    React.useEffect(() => {
        if (status === "connected") {
            hadConnectedRef.current = true;
            if (!wasLostRef.current) return undefined;
            wasLostRef.current = false;
            setBanner("restored");
            const timeoutId = window.setTimeout(() => setBanner(null), 2500);
            return () => window.clearTimeout(timeoutId);
        }
        // Разрыв показываем только если уже были подключены (не при первом коннекте)
        if (hadConnectedRef.current) {
            wasLostRef.current = true;
            setBanner("lost");
        }
        return undefined;
    }, [status]);
    return banner;
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

/* ---------- Остановка сессии (RPC stop-session + Dialog-подтверждение) ---------- */

interface StopTarget {
    session: Session;
    /** id машины из стора демона: RPC-хендлер stop-session зарегистрирован под ним,
     * а не под персистентным session.metadata.machineId. */
    machineId: string | null;
}

interface StopControls {
    requestStop: (session: Session, machineId: string | null) => void;
}

function StopSessionDialog({ target, onClose }: { target: StopTarget | null; onClose: () => void }) {
    const confirmStop = async () => {
        if (!target) return;
        onClose();
        if (!target.machineId) {
            toast.error(t("home.stop.failed"));
            return;
        }
        try {
            await machineStopSession(target.machineId, target.session.id);
            toast.success(t("home.stop.done"));
        } catch {
            toast.error(t("home.stop.failed"));
        }
    };
    return (
        <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
            <DialogContent showCloseButton={false} className="max-w-sm rounded-2xl border-border bg-card">
                <DialogHeader>
                    <DialogTitle className="text-[15px]">{t("home.stop.title")}</DialogTitle>
                    <DialogDescription className="font-mono text-xs">
                        {target ? `${sessionPath(target.session)} · ` : ""}{t("home.stop.hint")}
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter className="gap-2">
                    <button onClick={onClose} className="h-10 flex-1 rounded-[9px] border border-border text-[13px] font-medium text-muted-foreground">
                        {t("common.cancel")}
                    </button>
                    <button onClick={() => void confirmStop()} className="h-10 flex-1 rounded-[9px] bg-status-error text-[13px] font-semibold text-white">
                        {t("home.stop.confirm")}
                    </button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** Кнопка «стоп» поверх карточки: на десктопе — по hover, на мобайле — всегда для живых сессий. */
function StopOverlayButton({ onClick }: { onClick: () => void }) {
    return (
        <button
            aria-label={t("home.stop.aria")}
            onClick={(event) => {
                event.stopPropagation();
                onClick();
            }}
            className="absolute right-12 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-[8px] border border-border bg-card text-status-error lg:opacity-0 lg:transition-opacity lg:group-hover:opacity-100 lg:group-focus-within:opacity-100"
        >
            <Square className="size-3 fill-status-error" />
        </button>
    );
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
            <DesktopHome groups={groups} controls={controls} />
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
                    className="flex size-[38px] items-center justify-center rounded-[10px] border border-border"
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
                                    className="h-9 rounded-[9px] bg-primary px-4 text-[13px] font-semibold text-primary-foreground"
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

const SIDEBAR_STATUS_TEXT: Record<Status, string> = {
    running: "text-status-running",
    thinking: "text-status-thinking",
    permission: "text-status-permission",
    idle: "text-muted-foreground",
    offline: "text-muted-foreground",
    error: "text-status-error",
};

function sidebarRowFrame(status: Status): string {
    if (status === "permission") {
        return "border border-status-permission/35 bg-gradient-to-r from-status-permission/[0.08] to-transparent";
    }
    if (status === "running" || status === "thinking") {
        return "border border-border bg-secondary/60";
    }
    if (status === "offline") {
        return "border border-transparent opacity-50";
    }
    return "border border-transparent";
}

function DesktopHome({ groups, controls }: { groups: MachineGroup[]; controls: StopControls }) {
    const navigate = useNavigate();
    const connectionStatus = useConnectionStatus();
    const latencyMs = useLatencyMs();
    const banner = useConnectionBanner();
    const isConnected = connectionStatus === "connected";
    return (
        <div className="hidden min-h-0 flex-1 lg:grid lg:grid-cols-[288px_1fr]">
            <aside className="flex min-h-0 flex-col border-r border-border bg-card/50">
                <div className="flex items-center gap-[9px] px-4 pb-3 pt-4">
                    <Logo className="size-5 text-foreground" />
                    <span className="font-mono text-sm font-semibold">{t("app.name")}</span>
                    <span className="ml-auto flex items-center gap-[5px]">
                        <StatusDot status={isConnected ? "running" : "error"} className="size-1.5" />
                        <span className={`font-mono text-[9.5px] ${isConnected ? "text-accent" : "text-muted-foreground"}`}>
                            {connectionPillLabel(isConnected, latencyMs)}
                        </span>
                    </span>
                </div>
                {banner && (
                    <div className="px-3 pb-2">
                        <ConnectionBanner state={banner} />
                    </div>
                )}
                <button
                    aria-label={t("home.searchAria")}
                    onClick={openCommandPalette}
                    className="mx-3 mb-2.5 flex h-[34px] items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-xs text-muted-foreground"
                >
                    <Search className="size-3" /> {t("home.search")}
                    <kbd className="ml-auto rounded border border-border px-[5px] py-px font-mono text-[9.5px] text-muted-foreground/60">⌘K</kbd>
                </button>
                <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-1">
                    {groups.map((group, index) => (
                        <SidebarMachineSection key={group.key} group={group} controls={controls} isFirst={index === 0} />
                    ))}
                </div>
                <div className="flex flex-col gap-2 p-3">
                    <button
                        onClick={() => navigate("/new")}
                        className="flex h-[38px] items-center justify-center gap-1.5 rounded-[9px] bg-primary text-[13px] font-semibold text-primary-foreground"
                    >
                        <Plus className="size-3.5" /> {t("home.newSession")}
                    </button>
                    <div className="flex items-center px-0.5 font-mono text-[10px] text-muted-foreground/70">
                        <NavLink to="/zen" className="hover:text-foreground">{t("tabs.tasks").toLowerCase()}</NavLink>
                        <NavLink to="/settings" className="ml-auto hover:text-foreground">{t("tabs.settings").toLowerCase()}</NavLink>
                    </div>
                </div>
            </aside>
            <section className="flex min-h-0 flex-col items-center justify-center px-6">
                <div className="w-full max-w-sm">
                    <EmptyState title={t("home.desktop.pick.title")} hint={t("home.desktop.pick.hint")} />
                </div>
            </section>
        </div>
    );
}

function SidebarMachineSection({ group, controls, isFirst }: { group: MachineGroup; controls: StopControls; isFirst: boolean }) {
    const navigate = useNavigate();
    return (
        <>
            <div className={`px-2.5 pb-0.5 font-mono text-[9.5px] ${group.isOnline ? "text-muted-foreground/70" : "text-muted-foreground/50"} ${isFirst ? "pt-1" : "pt-2.5"}`}>
                {group.name} · {group.isOnline ? t("home.machine.online") : t("home.machine.offline")}
            </div>
            {group.sessions.map((session) => {
                const status = sessionStatus(session);
                return (
                    <div key={session.id} className="group relative">
                        <button
                            onClick={() => navigate(`/session/${session.id}`)}
                            className={`flex w-full items-center gap-[9px] rounded-[9px] px-2.5 py-[9px] text-left ${sidebarRowFrame(status)}`}
                        >
                            <AgentIcon agent={sessionAgent(session)} className="size-6 rounded-[7px] text-[10px]" />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate font-mono text-[11.5px] font-semibold">{shortDirName(sessionPath(session))}</span>
                                <span className={`truncate text-[10.5px] ${SIDEBAR_STATUS_TEXT[status]}`}>{statusLabel(status)}</span>
                            </span>
                            <StatusDot status={status} className="size-[7px]" />
                        </button>
                        {status !== "offline" && (
                            <StopOverlayButton onClick={() => controls.requestStop(session, group.rpcMachineId)} />
                        )}
                    </div>
                );
            })}
        </>
    );
}
