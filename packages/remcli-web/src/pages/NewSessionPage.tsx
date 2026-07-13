// remcli-web — Новая сессия (design/screens/new-session.tsx, живой P2P-протокол).
// Машина/сессии — из стора протокола; спавн — RPC spawn-remcli-session
// (payload как в remcli-cli/src/daemon/machineSocket.ts), resume-sheet —
// RPC list-agent-sessions, directory-picker — RPC list-directory.
// Модели/режимы — локальная web-конфигурация поверх daemon protocol.
import * as React from "react";
import { ArrowUp, ChevronDown, Folder, FolderOpen, Loader2, RotateCcw, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { AgentIcon, StatusDot, type AgentId } from "@/components/kit";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import {
    getAgentPermissionLabel,
    getAgentPermissionModes,
    getDefaultPermissionMode,
    normalizeAgentPermissionMode,
} from "@/lib/agentPermissions";
import { getIntlLocale, t } from "@/lib/i18n";
import {
    machineListDirectory,
    machineListAgentSessions,
    machineSpawnNewSession,
    refreshSessions,
    sendSessionMessage,
    useMachines,
    useProtocolStore,
    useSessions,
    type AgentSessionInfo,
    type DirectoryListing,
    type Machine,
    type PermissionMode,
    type SpawnSessionOptions,
    type SpawnSessionResult,
} from "@/lib/protocol";
import { linkZenTaskSession } from "@/lib/zenTasks";

type SheetKind = "machine" | "model" | "permission" | "resume" | "directory";

/* ---------- Конфигурация агентов ---------- */

interface AgentOption {
    id: AgentId;
    name: string;
    kind: string;
    models: string[];
}

const DEFAULT_MODEL_ID = "default";

export const AGENT_OPTIONS: AgentOption[] = [
    { id: "claude", name: "Claude", kind: "code", models: ["default", "sonnet", "opus", "haiku"] },
    { id: "codex", name: "Codex", kind: "cli", models: [DEFAULT_MODEL_ID, "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark"] },
    { id: "gemini", name: "Gemini", kind: "cli", models: ["gemini-2.5-pro", "gemini-3-pro", "gemini-3-flash"] },
    { id: "cursor", name: "Cursor", kind: "agent", models: ["default", "opus-4.6", "composer-1.5", "gemini-3-pro"] },
];

export function getModelOverride(model: string): string | null {
    return model !== DEFAULT_MODEL_ID ? model : null;
}

export function modelOverrideState(model: string, hasExplicitModelSelection: boolean): { model?: string | null } {
    return hasExplicitModelSelection ? { model: getModelOverride(model) } : {};
}

/* ---------- Хелперы ---------- */

function formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    if (diff < 60_000) return t("time.justNow");
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} ${t("time.min")}`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ${t("time.hour")}`;
    return new Date(timestamp).toLocaleDateString(getIntlLocale(), { day: "numeric", month: "short" });
}

function machineName(machine: Machine): string {
    return machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id;
}

function formatDirectoryError(error: unknown): string {
    const details = error instanceof Error ? error.message : String(error);
    return details ? `${t("new.dirError")} ${details}` : t("new.dirError");
}

interface RecentDir {
    path: string;
    lastUsedAt: number;
}

interface PendingDirectoryCreation {
    directory: string;
    options: SpawnSessionOptions;
    resume?: AgentSessionInfo;
}

interface DirectoryBackTarget {
    path: string;
    displayPath: string;
}

const RESUME_LIST_LIMIT = 20;

/* ---------- Разметка ---------- */

function SheetHeader({ title, tag }: { title: string; tag: string }) {
    return (
        <div className="flex items-center px-[18px] pb-2 pt-1">
            <DrawerTitle className="text-[14.5px] font-semibold">{title}</DrawerTitle>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">{tag}</span>
        </div>
    );
}

function SheetRow({ isActive, label, meta, onClick }: { isActive: boolean; label: string; meta?: React.ReactNode; onClick: () => void }) {
    return (
        <button onClick={onClick} className="flex w-full items-center gap-[11px] border-t border-border px-[18px] py-3 text-left">
            <span className={`flex-1 truncate font-mono text-[12.5px] ${isActive ? "text-foreground" : "text-muted-foreground"}`}>{label}</span>
            {meta}
        </button>
    );
}

const SHEET_CONTENT_CLASS =
    // rounded через тот же data-вариант, что в ui/drawer.tsx — иначе twMerge не схлопнет rounded-t-lg базы.
    "data-[vaul-drawer-direction=bottom]:rounded-t-[20px] border-border bg-card pb-[max(10px,env(safe-area-inset-bottom))] " +
    "[&>div:first-child]:mt-2 [&>div:first-child]:mb-1 [&>div:first-child]:h-[4.5px] [&>div:first-child]:w-[38px] [&>div:first-child]:bg-muted-foreground/40";

export function NewSessionPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const zenState = (location.state ?? null) as { zenTaskTitle?: string; zenTaskId?: string } | null;

    const machines = useMachines();
    const sessions = useSessions();

    const [machineId, setMachineId] = React.useState<string | null>(null);
    const [agent, setAgent] = React.useState<AgentId>("claude");
    const [model, setModel] = React.useState(AGENT_OPTIONS[0].models[0]);
    const [hasExplicitModelSelection, setHasExplicitModelSelection] = React.useState(false);
    const [mode, setMode] = React.useState<PermissionMode>(() => getDefaultPermissionMode("claude"));
    const [dir, setDir] = React.useState<string | null>(null);
    const [dirDisplayPath, setDirDisplayPath] = React.useState<string | null>(null);
    const [directoryRequestPath, setDirectoryRequestPath] = React.useState<string | undefined>(undefined);
    const [directoryListing, setDirectoryListing] = React.useState<DirectoryListing | null>(null);
    const [directoryError, setDirectoryError] = React.useState<string | null>(null);
    const [directoryBackTarget, setDirectoryBackTarget] = React.useState<DirectoryBackTarget | null>(null);
    const [directoryReloadKey, setDirectoryReloadKey] = React.useState(0);
    const [isDirectoryLoading, setIsDirectoryLoading] = React.useState(false);
    const [sheet, setSheet] = React.useState<SheetKind | null>(null);
    const [isSpawning, setIsSpawning] = React.useState(false);
    const [isApprovingDirectory, setIsApprovingDirectory] = React.useState(false);
    const [pendingDirectoryCreation, setPendingDirectoryCreation] = React.useState<PendingDirectoryCreation | null>(null);
    const [resumeItems, setResumeItems] = React.useState<AgentSessionInfo[] | null>(null);

    const machine = machines.find((m) => m.id === machineId) ?? machines[0] ?? null;
    const homeDir = machine?.metadata?.homeDir;
    const agentModels = AGENT_OPTIONS.find((a) => a.id === agent)?.models ?? [];
    const agentPermissionModes = getAgentPermissionModes(agent);
    const activeModeLabel = getAgentPermissionLabel(agent, mode);

    // недавние директории — из прошлых сессий выбранной машины (metadata.path)
    const recentDirs = React.useMemo<RecentDir[]>(() => {
        if (!machine) return [];
        const byPath = new Map<string, number>();
        for (const session of sessions) {
            const meta = session.metadata;
            if (!meta?.path) continue;
            if (meta.machineId && meta.machineId !== machine.id) continue;
            const known = byPath.get(meta.path) ?? 0;
            if (session.updatedAt > known) byPath.set(meta.path, session.updatedAt);
        }
        return [...byPath.entries()]
            .map(([path, lastUsedAt]) => ({ path, lastUsedAt }))
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
            .slice(0, 4);
    }, [machine, sessions]);

    const activeDir = dir ?? recentDirs[0]?.path ?? homeDir ?? "";
    const activeDirDisplayPath = dir ? (dirDisplayPath ?? dir) : (recentDirs[0]?.path ?? homeDir ?? "");
    const hasActiveDirInRecent = recentDirs.some((d) => d.path === activeDir);
    const shouldShowSelectedDir = activeDir !== "" && !hasActiveDirInRecent;
    const directoryHeaderPath = directoryListing?.path ?? directoryRequestPath ?? activeDir;
    const directoryHeaderDisplayPath = directoryListing?.displayPath
        ?? (directoryHeaderPath === activeDir ? activeDirDisplayPath : directoryHeaderPath);
    const canSelectDirectoryHeaderPath = directoryHeaderPath !== "" && !isDirectoryLoading && !directoryError && directoryListing !== null;
    const directoryParentPath = directoryListing?.parent ?? (directoryError ? directoryBackTarget?.path ?? null : null);
    const directoryParentDisplayPath = directoryListing?.parentDisplayPath ?? (directoryError ? directoryBackTarget?.displayPath ?? null : null);
    const directoryEntries = directoryListing?.entries ?? [];

    // resume-sheet: RPC list-agent-sessions с фильтром по агенту
    React.useEffect(() => {
        if (sheet !== "resume" || !machine) return;
        let isStale = false;
        setResumeItems(null);
        void machineListAgentSessions(machine.id, agent, undefined, RESUME_LIST_LIMIT).then((items) => {
            if (!isStale) setResumeItems(items);
        });
        return () => { isStale = true; };
    }, [sheet, machine, agent]);

    // directory-picker: RPC list-directory, stale responses ignored when user navigates fast.
    React.useEffect(() => {
        if (sheet !== "directory" || !machine) return;
        let isStale = false;
        setIsDirectoryLoading(true);
        setDirectoryError(null);
        setDirectoryListing(null);
        void machineListDirectory(machine.id, directoryRequestPath).then((listing) => {
            if (!isStale) setDirectoryListing(listing);
        }).catch((error: unknown) => {
            if (!isStale) setDirectoryError(formatDirectoryError(error));
        }).finally(() => {
            if (!isStale) setIsDirectoryLoading(false);
        });
        return () => { isStale = true; };
    }, [sheet, machine, directoryRequestPath, directoryReloadKey]);

    const selectAgent = (id: AgentId) => {
        setAgent(id);
        const nextModel = AGENT_OPTIONS.find((a) => a.id === id)?.models[0];
        if (nextModel) setModel(nextModel);
        setHasExplicitModelSelection(false);
        setMode(getDefaultPermissionMode(id));
    };

    const selectDir = (path: string, displayPath?: string) => {
        setDir(path);
        setDirDisplayPath(displayPath ?? null);
    };

    const openDirectoryPicker = () => {
        setDirectoryRequestPath(activeDir || homeDir || undefined);
        setDirectoryListing(null);
        setDirectoryError(null);
        setDirectoryBackTarget(null);
        setSheet("directory");
    };

    const navigateDirectory = (path: string) => {
        if (directoryListing) {
            setDirectoryBackTarget({
                path: directoryListing.path,
                displayPath: directoryListing.displayPath,
            });
        } else {
            setDirectoryBackTarget(null);
        }
        setDirectoryRequestPath(path);
    };

    const finishSpawn = async (sessionId: string, resume?: AgentSessionInfo) => {
        // ждём появления сессии в сторе (нужен cipher для первого сообщения)
        for (let attempt = 0; attempt < 10 && !useProtocolStore.getState().sessions[sessionId]; attempt++) {
            await refreshSessions().catch(() => undefined);
            if (useProtocolStore.getState().sessions[sessionId]) break;
            await new Promise((resolve) => setTimeout(resolve, 400));
        }

        if (zenState?.zenTaskId) linkZenTaskSession(zenState.zenTaskId, sessionId);
        const permissionMode = normalizeAgentPermissionMode(agent, mode);
        const modelState = modelOverrideState(model, hasExplicitModelSelection);
        if (zenState?.zenTaskTitle && !resume) {
            await sendSessionMessage(sessionId, zenState.zenTaskTitle, { permissionMode, ...modelState })
                .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
        }
        navigate(`/session/${sessionId}`, { replace: true, state: { permissionMode, ...modelState } });
    };

    const handleSpawnResult = async (result: SpawnSessionResult, options: SpawnSessionOptions, resume?: AgentSessionInfo) => {
        if (result.type === "requestToApproveDirectoryCreation") {
            setPendingDirectoryCreation({
                directory: result.directory,
                options,
                ...(resume ? { resume } : {}),
            });
            return;
        }
        if (result.type === "error") {
            toast.error(result.errorMessage);
            return;
        }
        await finishSpawn(result.sessionId, resume);
    };

    const spawn = async (resume?: AgentSessionInfo) => {
        if (!machine || isSpawning) return;
        const directory = resume?.projectPath ?? activeDir;
        if (directory === "") return;
        setIsSpawning(true);
        try {
            const options: SpawnSessionOptions = {
                machineId: machine.id,
                directory,
                agent: resume?.agent ?? agent,
                resumeSessionId: resume?.sessionId,
                resumeSessionName: resume?.sessionName ?? undefined,
            };
            const result = await machineSpawnNewSession(options);
            await handleSpawnResult(result, options, resume);
        } finally {
            setIsSpawning(false);
        }
    };

    const approveDirectoryCreation = async () => {
        if (!pendingDirectoryCreation || isApprovingDirectory) return;
        setIsApprovingDirectory(true);
        setIsSpawning(true);
        try {
            const options = { ...pendingDirectoryCreation.options, approvedNewDirectoryCreation: true };
            const result = await machineSpawnNewSession(options);
            const resume = pendingDirectoryCreation.resume;
            setPendingDirectoryCreation(null);
            await handleSpawnResult(result, options, resume);
        } finally {
            setIsApprovingDirectory(false);
            setIsSpawning(false);
        }
    };

    return (
        <div className="flex min-h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
            <header className="flex items-center px-5 pb-3 pt-1.5">
                <h1 className="text-xl font-semibold">{t("new.title")}</h1>
                <button aria-label={t("new.close")} onClick={() => navigate(-1)}
                    className="ml-auto flex size-11 items-center justify-center rounded-[10px] border border-border transition-[background-color,border-color,transform] active:scale-[0.96]">
                    <X className="size-4 text-muted-foreground" />
                </button>
            </header>

            <main className="flex flex-1 flex-col gap-4.5 overflow-y-auto px-5 [&>*]:shrink-0">
                {/* машина */}
                <button onClick={() => setSheet("machine")} disabled={machines.length === 0}
                    className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3">
                    <span className="w-[52px] text-left font-mono text-[10px] text-muted-foreground/70">{t("new.machine")}</span>
                    {machine ? (
                        <>
                            <span className="font-mono text-[13px] font-semibold">{machineName(machine)}</span>
                            <span className={`size-1.5 rounded-full ${machine.active ? "bg-status-running" : "bg-status-offline"}`} />
                        </>
                    ) : (
                        <span className="font-mono text-[12px] text-muted-foreground">{t("new.noMachines")}</span>
                    )}
                    <ChevronDown className="ml-auto size-3 text-muted-foreground" />
                </button>

                {/* агент — 4 карточки */}
                <section className="flex flex-col gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground/70">{t("new.agent")}</span>
                    <div className="grid grid-cols-2 gap-2">
                        {AGENT_OPTIONS.map((a) => (
                            <button key={a.id} onClick={() => selectAgent(a.id)}
                                className={`flex items-center gap-2.5 rounded-xl border bg-card p-3 text-left ${agent === a.id ? "border-accent ring-[3px] ring-accent/10" : "border-border"}`}>
                                <AgentIcon agent={a.id} className="size-[30px] rounded-lg text-[11px]" />
                                <span className="flex flex-col">
                                    <span className="text-[13px] font-semibold">{a.name}</span>
                                    <span className="font-mono text-[9.5px] text-muted-foreground">{a.kind}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </section>

                {/* модель + режим разрешений */}
                <div className="flex gap-2">
                    <section className="flex flex-[1.2] flex-col gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground/70">{t("new.model")}</span>
                        <button onClick={() => setSheet("model")}
                            className="flex h-11 items-center rounded-[10px] border border-input bg-muted px-3 font-mono text-xs">
                            <span className="truncate">{model}</span> <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
                        </button>
                    </section>
                    <section className="flex flex-[1.6] flex-col gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground/70">{t("new.permissions")}</span>
                        <button onClick={() => setSheet("permission")}
                            className="flex h-11 items-center rounded-[10px] border border-input bg-muted px-3 font-mono text-xs transition-[background-color,border-color,transform] active:scale-[0.96]">
                            <span className="min-w-0 truncate">{activeModeLabel}</span>
                            <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
                        </button>
                    </section>
                </div>

                {/* директория — недавние quick picks + browser/picker через RPC list-directory */}
                <section className="flex flex-col gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground/70">{t("new.dirRecent")}</span>
                    <div className="overflow-hidden rounded-xl border border-border">
                        {shouldShowSelectedDir && (
                            <button onClick={() => selectDir(activeDir, activeDirDisplayPath)}
                                className="flex min-h-11 w-full items-center gap-2.5 bg-secondary px-3.5 py-3 font-mono text-[12.5px]">
                                <FolderOpen className="size-3.5 shrink-0 text-accent" />
                                <span className="min-w-0 flex-1 truncate">{activeDirDisplayPath}</span>
                                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">{t("new.dirSelected")}</span>
                            </button>
                        )}
                        {recentDirs.map((d, i) => {
                            const isActive = activeDir === d.path;
                            return (
                                <button key={d.path} onClick={() => selectDir(d.path)}
                                    className={`flex min-h-11 w-full items-center gap-2.5 px-3.5 py-3 font-mono text-[12.5px] ${(i > 0 || shouldShowSelectedDir) ? "border-t border-border " : ""}${isActive ? "bg-secondary" : "bg-card text-muted-foreground"}`}>
                                    <Folder className={`size-3.5 shrink-0 ${isActive ? "text-accent" : "text-muted-foreground/40"}`} />
                                    <span className="min-w-0 flex-1 truncate">{d.path}</span>
                                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">{formatRelativeTime(d.lastUsedAt)}</span>
                                </button>
                            );
                        })}
                        <button onClick={openDirectoryPicker} disabled={!machine}
                            className={`flex min-h-11 w-full items-center gap-2.5 bg-card px-3.5 py-3 font-mono text-[12.5px] text-muted-foreground/70 transition-[background-color,color,transform] active:scale-[0.96] disabled:opacity-50 ${(recentDirs.length > 0 || shouldShowSelectedDir) ? "border-t border-border" : ""}`}>
                            <FolderOpen className="size-3.5 shrink-0" /> {t("new.dirBrowse")}
                        </button>
                    </div>
                </section>

                {/* промпт из задачи Zen — уйдёт первым сообщением после запуска */}
                {zenState?.zenTaskTitle && (
                    <section className="flex flex-col gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground/70">{t("new.promptLabel")}</span>
                        <div className="rounded-xl border border-border bg-card px-3.5 py-3 text-[13px] leading-snug">
                            {zenState.zenTaskTitle}
                        </div>
                    </section>
                )}

                {/* resume: bottom-sheet со списком прошлых сессий агента (RPC list-agent-sessions) */}
                <button onClick={() => setSheet("resume")} disabled={!machine}
                    className="flex h-11 items-center justify-center gap-2 rounded-[10px] border border-dashed border-border font-mono text-[11.5px] text-muted-foreground transition-[background-color,border-color,color,transform] active:scale-[0.96]">
                    <RotateCcw className="size-3" /> {t("new.resume", { agent })}
                </button>
            </main>

            <footer className="px-5 pb-[max(14px,env(safe-area-inset-bottom))] pt-3">
                <button onClick={() => void spawn()} disabled={!machine || activeDir === "" || isSpawning}
                    className="h-[52px] w-full rounded-xl bg-accent text-base font-semibold text-accent-foreground disabled:opacity-50">
                    {isSpawning
                        ? t("new.spawning")
                        : t("new.startButton", { agent, dir: activeDirDisplayPath || "…" })}
                </button>
            </footer>

            <Drawer open={sheet !== null} onOpenChange={(isOpen) => { if (!isOpen) setSheet(null); }}>
                <DrawerContent className={SHEET_CONTENT_CLASS}>
                    {sheet === "machine" && (
                        <>
                            <SheetHeader title={t("new.machineTitle")} tag={t("new.machine")} />
                            {machines.map((m) => (
                                <SheetRow key={m.id} isActive={m.id === machine?.id} label={machineName(m)}
                                    meta={
                                        <>
                                            <StatusDot status={m.active ? "running" : "offline"} className="size-1.5" />
                                            <span className="font-mono text-[10px] text-muted-foreground/70">
                                                {m.active ? t("home.machine.online") : formatRelativeTime(m.activeAt)}
                                            </span>
                                        </>
                                    }
                                    onClick={() => {
                                        setMachineId(m.id);
                                        setDir(null);
                                        setDirDisplayPath(null);
                                        setDirectoryRequestPath(undefined);
                                        setDirectoryListing(null);
                                        setDirectoryError(null);
                                        setDirectoryBackTarget(null);
                                        setSheet(null);
                                    }} />
                            ))}
                        </>
                    )}
                    {sheet === "model" && (
                        <>
                            <SheetHeader title={t("new.modelTitle")} tag={agent} />
                            {agentModels.map((m) => (
                                <SheetRow key={m} isActive={m === model} label={m}
                                    onClick={() => {
                                        setModel(m);
                                        setHasExplicitModelSelection(true);
                                        setSheet(null);
                                    }} />
                            ))}
                        </>
                    )}
                    {sheet === "permission" && (
                        <>
                            <SheetHeader title={t("new.permissions")} tag={agent} />
                            {agentPermissionModes.map((permission) => (
                                <SheetRow key={permission} isActive={permission === mode} label={getAgentPermissionLabel(agent, permission)}
                                    onClick={() => { setMode(permission); setSheet(null); }} />
                            ))}
                        </>
                    )}
                    {sheet === "directory" && (
                        <>
                            <SheetHeader title={t("new.dirBrowserTitle")} tag={machine ? machineName(machine) : t("new.machine")} />
                            <div className="mx-[18px] mb-3 rounded-xl bg-background/70 p-3 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                                <div className="mb-1 font-mono text-[10px] text-muted-foreground/70">{t("new.dirCurrent")}</div>
                                <div className="break-all font-mono text-[12.5px] font-semibold leading-snug">
                                    {directoryHeaderDisplayPath || "…"}
                                </div>
                            </div>

                            <div className="border-t border-border">
                                <button
                                    type="button"
                                    disabled={!directoryParentPath || isDirectoryLoading}
                                    onClick={() => {
                                        if (directoryParentPath) navigateDirectory(directoryParentPath);
                                    }}
                                    className="flex min-h-11 w-full items-center gap-3 px-[18px] py-3 text-left font-mono text-[12.5px] text-muted-foreground transition-[background-color,color,transform] active:scale-[0.96] disabled:opacity-40"
                                >
                                    <ArrowUp className="size-3.5 shrink-0" />
                                    <span className="shrink-0">{t("new.dirParent")}</span>
                                    <span className="ml-auto max-w-[55%] truncate text-[11px]">
                                        {directoryParentDisplayPath ?? "—"}
                                    </span>
                                </button>
                            </div>

                            <div className="max-h-[34dvh] overflow-y-auto border-t border-border">
                                {isDirectoryLoading && (
                                    <div className="flex min-h-11 items-center gap-2 px-[18px] py-3 font-mono text-[12.5px] text-muted-foreground/70">
                                        <Loader2 className="size-3.5 animate-spin" />
                                        {t("new.dirLoading")}
                                    </div>
                                )}
                                {!isDirectoryLoading && directoryError && (
                                    <div className="flex flex-col gap-3 px-[18px] py-3 text-[12.5px] text-muted-foreground">
                                        <div className="rounded-[10px] bg-destructive/10 px-3 py-2 leading-snug text-destructive">
                                            {directoryError}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setDirectoryReloadKey((value) => value + 1)}
                                            className="min-h-11 rounded-[9px] border border-border px-3 font-mono text-[11.5px] transition-[background-color,border-color,color,transform] active:scale-[0.96]"
                                        >
                                            {t("new.dirRetry")}
                                        </button>
                                    </div>
                                )}
                                {!isDirectoryLoading && !directoryError && directoryListing && directoryEntries.length === 0 && (
                                    <div className="min-h-11 px-[18px] py-3 font-mono text-[12.5px] text-muted-foreground/70">
                                        {t("new.dirEmpty")}
                                    </div>
                                )}
                                {!isDirectoryLoading && !directoryError && directoryEntries.map((entry) => (
                                    <button
                                        key={entry.path}
                                        type="button"
                                        onClick={() => navigateDirectory(entry.path)}
                                        className={`flex min-h-11 w-full items-center gap-3 border-t border-border px-[18px] py-3 text-left font-mono text-[12.5px] transition-[background-color,color,transform] active:scale-[0.96] ${entry.hidden ? "text-muted-foreground" : "text-foreground"}`}
                                    >
                                        <Folder className="size-3.5 shrink-0 text-accent" />
                                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                                        {entry.hidden && <span className="ml-auto size-1.5 shrink-0 rounded-full bg-muted-foreground/50" />}
                                    </button>
                                ))}
                            </div>

                            <div className="border-t border-border px-[18px] pt-3">
                                <button
                                    type="button"
                                    disabled={!canSelectDirectoryHeaderPath}
                                    onClick={() => {
                                        if (!canSelectDirectoryHeaderPath) return;
                                        selectDir(directoryHeaderPath, directoryHeaderDisplayPath);
                                        setSheet(null);
                                    }}
                                    className="min-h-[52px] w-full rounded-xl bg-accent px-3 text-[14px] font-semibold text-accent-foreground transition-[background-color,transform] active:scale-[0.96] disabled:opacity-50"
                                >
                                    {t("new.dirSelectCurrent")}
                                </button>
                            </div>
                        </>
                    )}
                    {sheet === "resume" && (
                        <>
                            <SheetHeader title={`${t("new.resumeTitle")} · ${agent}`} tag={t("new.resumeTag")} />
                            {resumeItems === null ? (
                                <div className="border-t border-border px-[18px] py-3 font-mono text-[12.5px] text-muted-foreground/70">
                                    {t("new.resumeLoading")}
                                </div>
                            ) : resumeItems.length === 0 ? (
                                <div className="border-t border-border px-[18px] py-3 font-mono text-[12.5px] text-muted-foreground/70">
                                    {t("new.resumeEmpty")}
                                </div>
                            ) : resumeItems.map((e, i) => (
                                <SheetRow key={e.sessionId} isActive={i === 0}
                                    label={e.sessionName ?? e.firstMessage ?? e.sessionId}
                                    meta={
                                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
                                            {formatRelativeTime(e.lastModified)}
                                        </span>
                                    }
                                    onClick={() => { setSheet(null); void spawn(e); }} />
                            ))}
                        </>
                    )}
                </DrawerContent>
            </Drawer>

            <Dialog open={pendingDirectoryCreation !== null} onOpenChange={(isOpen) => { if (!isOpen && !isApprovingDirectory) setPendingDirectoryCreation(null); }}>
                <DialogContent showCloseButton={false} className="max-w-[calc(100%-2rem)] rounded-2xl border-border bg-card sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="text-base">{t("new.createDirTitle")}</DialogTitle>
                        <DialogDescription className="break-words font-mono text-xs">
                            {pendingDirectoryCreation ? t("new.createDirConfirm", { dir: pendingDirectoryCreation.directory }) : ""}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter className="gap-2">
                        <button
                            type="button"
                            disabled={isApprovingDirectory}
                            onClick={() => setPendingDirectoryCreation(null)}
                            className="h-11 w-full rounded-[9px] border border-border text-[13px] font-medium text-muted-foreground transition-[background-color,border-color,color,transform] active:scale-[0.96] disabled:opacity-50 lg:h-10 lg:flex-1"
                        >
                            {t("common.cancel")}
                        </button>
                        <button
                            type="button"
                            disabled={isApprovingDirectory}
                            onClick={() => void approveDirectoryCreation()}
                            className="h-11 w-full rounded-[9px] bg-accent text-[13px] font-semibold text-accent-foreground transition-[background-color,transform] active:scale-[0.96] disabled:opacity-50 lg:h-10 lg:flex-1"
                        >
                            {isApprovingDirectory ? t("new.spawning") : t("common.create")}
                        </button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
