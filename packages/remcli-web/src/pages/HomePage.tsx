// remcli-web — Home / Сессии. Мобайл — по design/screens/home.tsx (разметка 1:1),
// десктоп ≥1024 — сайдбар 288px по design/pages/desktop.html (grid-cols-[288px_1fr]).
// Шапку/safe-area/таб-бар даёт TabLayout; данные — @/mocks/fixtures.
import { Monitor, Plus, Search } from "lucide-react";
import { NavLink, useNavigate } from "react-router";
import { AgentIcon, EmptyState, STATUS_LABEL, SessionCard, StatusDot } from "@/components/kit";
import type { Status } from "@/components/kit";
import { t } from "@/lib/i18n";
import { connectionInfo, machines, sessions } from "@/mocks/fixtures";
import type { MockMachine, MockSession } from "@/mocks/fixtures";

/** ⌘K-палитра живёт в shell и слушает keydown на document — открываем её синтетическим событием. */
function openCommandPalette() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
}

/** permission всегда поднимается наверх списка (DESIGN.md §Карта статусов) */
function sortPermissionFirst(list: MockSession[]): MockSession[] {
    return [...list].sort((a, b) => Number(b.status === "permission") - Number(a.status === "permission"));
}

function sessionsCountLabel(count: number): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    const word =
        mod10 === 1 && mod100 !== 11 ? t("home.sessions.one")
        : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? t("home.sessions.few")
        : t("home.sessions.many");
    return `${count} ${word}`;
}

/** ~/dev/remcli → remcli (компактные строки сайдбара, desktop.html) */
function shortDirName(path: string): string {
    return path.split("/").filter(Boolean).pop() ?? path;
}

/** "p2p · 12ms" → "12ms" (в сайдбаре пилюля короче, desktop.html) */
function shortLatencyLabel(label: string): string {
    return label.split("·").pop()?.trim() ?? label;
}

interface MachineGroup {
    machine: MockMachine;
    sessions: MockSession[];
}

const machineGroups: MachineGroup[] = machines.map((machine) => ({
    machine,
    sessions: sortPermissionFirst(sessions.filter((session) => session.machineId === machine.id)),
}));

export function HomePage() {
    return (
        <>
            <MobileHome />
            <DesktopHome />
        </>
    );
}

/* ---------- Мобайл <1024 (design/screens/home.tsx) ---------- */

function MobileHome() {
    const navigate = useNavigate();
    const isEmpty = sessions.length === 0;
    return (
        <div className="flex min-h-0 flex-1 flex-col lg:hidden">
            {/* шапка */}
            <header className="flex items-center gap-2.5 px-5 pb-3 pt-2.5">
                <img src="/logo.svg" alt="" className="size-[22px]" />
                <span className="font-mono text-base font-semibold">{t("app.name")}</span>
                <span className="ml-auto flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/[0.08] px-2.5 py-1">
                    <StatusDot status="running" className="size-1.5" />
                    <span className="font-mono text-[10px] text-accent">{connectionInfo.latencyLabel}</span>
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
                {isEmpty ? (
                    <div className="mt-10">
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
                    </div>
                ) : (
                    machineGroups.map(({ machine, sessions: machineSessions }, index) => (
                        <MachineSection key={machine.id} machine={machine} sessions={machineSessions} isFirst={index === 0} />
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

function MachineSection({ machine, sessions: machineSessions, isFirst }: MachineGroup & { isFirst: boolean }) {
    const navigate = useNavigate();
    return (
        <>
            {machine.isOnline ? (
                <div className={`flex items-center gap-2 px-1 font-mono text-[11px] text-muted-foreground ${isFirst ? "pt-1.5" : "pt-2.5"}`}>
                    <Monitor className="size-3" /> {machine.name} <span className="text-status-running">{t("home.machine.online")}</span>
                    <span className="ml-auto text-muted-foreground/50">{sessionsCountLabel(machineSessions.length)}</span>
                </div>
            ) : (
                <div className={`flex items-center gap-2 px-1 font-mono text-[11px] text-muted-foreground/60 ${isFirst ? "pt-1.5" : "pt-2.5"}`}>
                    <Monitor className="size-3" /> {machine.name}{" "}
                    <span>{t("home.machine.offline")}{machine.lastSeenLabel ? ` · ${machine.lastSeenLabel}` : ""}</span>
                </div>
            )}
            {machineSessions.map((session) => (
                <SessionCard
                    key={session.id}
                    agent={session.agent}
                    path={session.path}
                    message={session.message}
                    status={session.status}
                    time={session.timeLabel}
                    onClick={() => navigate(`/session/${session.id}`)}
                />
            ))}
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

function DesktopHome() {
    const navigate = useNavigate();
    return (
        <div className="hidden min-h-0 flex-1 lg:grid lg:grid-cols-[288px_1fr]">
            <aside className="flex min-h-0 flex-col border-r border-border bg-card/50">
                <div className="flex items-center gap-[9px] px-4 pb-3 pt-4">
                    <img src="/logo.svg" alt="" className="size-5" />
                    <span className="font-mono text-sm font-semibold">{t("app.name")}</span>
                    <span className="ml-auto flex items-center gap-[5px]">
                        <StatusDot status="running" className="size-1.5" />
                        <span className="font-mono text-[9.5px] text-accent">{shortLatencyLabel(connectionInfo.latencyLabel)}</span>
                    </span>
                </div>
                <button
                    aria-label={t("home.searchAria")}
                    onClick={openCommandPalette}
                    className="mx-3 mb-2.5 flex h-[34px] items-center gap-2 rounded-lg border border-border bg-card px-2.5 text-xs text-muted-foreground"
                >
                    <Search className="size-3" /> {t("home.search")}
                    <kbd className="ml-auto rounded border border-border px-[5px] py-px font-mono text-[9.5px] text-muted-foreground/60">⌘K</kbd>
                </button>
                <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 py-1">
                    {machineGroups.map(({ machine, sessions: machineSessions }, index) => (
                        <SidebarMachineSection key={machine.id} machine={machine} sessions={machineSessions} isFirst={index === 0} />
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

function SidebarMachineSection({ machine, sessions: machineSessions, isFirst }: MachineGroup & { isFirst: boolean }) {
    const navigate = useNavigate();
    return (
        <>
            <div className={`px-2.5 pb-0.5 font-mono text-[9.5px] ${machine.isOnline ? "text-muted-foreground/70" : "text-muted-foreground/50"} ${isFirst ? "pt-1" : "pt-2.5"}`}>
                {machine.name} · {machine.isOnline ? t("home.machine.online") : t("home.machine.offline")}
            </div>
            {machineSessions.map((session) => (
                <button
                    key={session.id}
                    onClick={() => navigate(`/session/${session.id}`)}
                    className={`flex w-full items-center gap-[9px] rounded-[9px] px-2.5 py-[9px] text-left ${sidebarRowFrame(session.status)}`}
                >
                    <AgentIcon agent={session.agent} className="size-6 rounded-[7px] text-[10px]" />
                    <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-mono text-[11.5px] font-semibold">{shortDirName(session.path)}</span>
                        <span className={`truncate text-[10.5px] ${SIDEBAR_STATUS_TEXT[session.status]}`}>{STATUS_LABEL[session.status]}</span>
                    </span>
                    <StatusDot status={session.status} className="size-[7px]" />
                </button>
            ))}
        </>
    );
}
