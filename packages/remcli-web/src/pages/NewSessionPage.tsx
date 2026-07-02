// remcli-web — Новая сессия (design/screens/new-session.tsx, живой P2P-протокол).
// Машина/сессии — из стора протокола; спавн — RPC spawn-remcli-session
// (payload как в remcli-cli/src/daemon/machineSocket.ts), resume-sheet —
// RPC list-agent-sessions. Модели/режимы — как в remcli-app sources/utils/agents.ts.
import * as React from "react";
import { ChevronDown, RotateCcw, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { AgentIcon, Segmented, StatusDot, type AgentId } from "@/components/kit";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import {
    machineListAgentSessions,
    machineSpawnNewSession,
    refreshSessions,
    sendSessionMessage,
    useMachines,
    useProtocolStore,
    useSessions,
    type AgentSessionInfo,
    type Machine,
    type PermissionMode,
    type SpawnSessionResult,
} from "@/lib/protocol";
import { linkZenTaskSession } from "@/lib/zenTasks";

type SheetKind = "machine" | "model" | "resume";
type PermissionChoice = "safe" | "ask" | "auto";

/* ---------- Конфигурация агентов (зеркало remcli-app sources/utils/agents.ts) ---------- */

interface AgentOption {
    id: AgentId;
    name: string;
    kind: string;
    models: string[];
}

const AGENT_OPTIONS: AgentOption[] = [
    { id: "claude", name: "Claude", kind: "code", models: ["default", "sonnet", "opus", "haiku"] },
    { id: "codex", name: "Codex", kind: "cli", models: ["gpt-5.3-codex", "gpt-5.2", "gpt-5.1-codex-mini"] },
    { id: "gemini", name: "Gemini", kind: "cli", models: ["gemini-2.5-pro", "gemini-3-pro", "gemini-3-flash"] },
    { id: "cursor", name: "Cursor", kind: "agent", models: ["default", "opus-4.6", "composer-1.5", "gemini-3-pro"] },
];

/** safe/ask/auto → PermissionMode протокола (AGENT_PERMISSIONS в remcli-app). */
const PERMISSION_BY_AGENT: Record<AgentId, Record<PermissionChoice, PermissionMode>> = {
    claude: { safe: "plan", ask: "default", auto: "bypassPermissions" },
    codex: { safe: "read-only", ask: "default", auto: "yolo" },
    gemini: { safe: "read-only", ask: "default", auto: "yolo" },
    cursor: { safe: "read-only", ask: "default", auto: "yolo" },
};

// Локальные тексты — заглушка i18n типизирована по ключам, новые ключи добавит владелец i18n.ts
const TEXT = {
    noMachines: "нет машин — запустите remcli daemon",
    spawning: "запускаем…",
    resumeLoading: "загружаем сессии…",
    promptLabel: "промпт · первая команда",
    createDirConfirm: (dir: string) => `Директории «${dir}» нет на машине. Создать?`,
    online: "online",
} as const;

/* ---------- Хелперы ---------- */

function formatRelativeTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    if (diff < 60_000) return "только что";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ч`;
    return new Date(timestamp).toLocaleDateString("ru", { day: "numeric", month: "short" });
}

function machineName(machine: Machine): string {
    return machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id;
}

/** Абсолютный путь → «~/…» для показа (formatPathRelativeToHome из remcli-app). */
function displayPath(path: string, homeDir: string | undefined): string {
    if (!homeDir || !path.startsWith(homeDir)) return path;
    const rest = path.slice(homeDir.length);
    if (rest === "") return "~";
    return rest.startsWith("/") || rest.startsWith("\\") ? `~${rest}` : path;
}

/** «~/…» из ввода → абсолютный путь (resolveAbsolutePath из remcli-app). */
function expandPath(path: string, homeDir: string | undefined): string {
    if (!path.startsWith("~") || !homeDir) return path;
    const home = homeDir.endsWith("/") || homeDir.endsWith("\\") ? homeDir.slice(0, -1) : homeDir;
    if (path === "~") return home;
    if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
    return path;
}

interface RecentDir {
    path: string;
    lastUsedAt: number;
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
    "rounded-t-[20px] border-border bg-card pb-[max(10px,env(safe-area-inset-bottom))] " +
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
    const [mode, setMode] = React.useState<PermissionChoice>("ask");
    const [dir, setDir] = React.useState<string | null>(null);
    const [isOtherDirOpen, setIsOtherDirOpen] = React.useState(false);
    const [customDir, setCustomDir] = React.useState("");
    const [sheet, setSheet] = React.useState<SheetKind | null>(null);
    const [isSpawning, setIsSpawning] = React.useState(false);
    const [resumeItems, setResumeItems] = React.useState<AgentSessionInfo[] | null>(null);

    const machine = machines.find((m) => m.id === machineId) ?? machines[0] ?? null;
    const homeDir = machine?.metadata?.homeDir;
    const agentModels = AGENT_OPTIONS.find((a) => a.id === agent)?.models ?? [];

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

    const customDirExpanded = expandPath(customDir.trim(), homeDir);
    const activeDir = isOtherDirOpen && customDirExpanded !== ""
        ? customDirExpanded
        : (dir && recentDirs.some((d) => d.path === dir) ? dir : recentDirs[0]?.path ?? homeDir ?? "");

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

    const selectAgent = (id: AgentId) => {
        setAgent(id);
        const nextModel = AGENT_OPTIONS.find((a) => a.id === id)?.models[0];
        if (nextModel) setModel(nextModel);
    };

    const selectDir = (path: string) => {
        setDir(path);
        setIsOtherDirOpen(false);
        setCustomDir("");
    };

    const spawn = async (resume?: AgentSessionInfo) => {
        if (!machine || isSpawning) return;
        const directory = resume?.projectPath ?? activeDir;
        if (directory === "") return;
        setIsSpawning(true);
        try {
            const options = {
                machineId: machine.id,
                directory,
                agent: resume?.agent ?? agent,
                resumeSessionId: resume?.sessionId,
                resumeSessionName: resume?.sessionName ?? undefined,
            };
            let result: SpawnSessionResult = await machineSpawnNewSession(options);
            if (result.type === "requestToApproveDirectoryCreation") {
                if (!window.confirm(TEXT.createDirConfirm(result.directory))) return;
                result = await machineSpawnNewSession({ ...options, approvedNewDirectoryCreation: true });
            }
            if (result.type === "error") {
                toast.error(result.errorMessage);
                return;
            }
            if (result.type !== "success") return;
            const sessionId = result.sessionId;

            // ждём появления сессии в сторе (нужен cipher для первого сообщения)
            for (let attempt = 0; attempt < 10 && !useProtocolStore.getState().sessions[sessionId]; attempt++) {
                await refreshSessions().catch(() => undefined);
                if (useProtocolStore.getState().sessions[sessionId]) break;
                await new Promise((resolve) => setTimeout(resolve, 400));
            }

            if (zenState?.zenTaskId) linkZenTaskSession(zenState.zenTaskId, sessionId);
            const permissionMode = PERMISSION_BY_AGENT[agent][mode];
            const modelMeta = model !== "default" ? model : null;
            if (zenState?.zenTaskTitle && !resume) {
                await sendSessionMessage(sessionId, zenState.zenTaskTitle, { permissionMode, model: modelMeta })
                    .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
            }
            navigate(`/session/${sessionId}`, { replace: true, state: { permissionMode, model: modelMeta } });
        } finally {
            setIsSpawning(false);
        }
    };

    return (
        <div className="flex min-h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
            <header className="flex items-center px-5 pb-3 pt-1.5">
                <h1 className="text-xl font-semibold">{t("new.title")}</h1>
                <button aria-label={t("new.close")} onClick={() => navigate(-1)}
                    className="ml-auto flex size-[38px] items-center justify-center rounded-[10px] border border-border">
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
                        <span className="font-mono text-[12px] text-muted-foreground">{TEXT.noMachines}</span>
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
                        <Segmented options={["safe", "ask", "auto"]} value={mode}
                            onChange={(v) => { if (v === "safe" || v === "ask" || v === "auto") setMode(v); }} />
                    </section>
                </div>

                {/* директория — недавние (из прошлых сессий машины) + ввод */}
                <section className="flex flex-col gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground/70">{t("new.dirRecent")}</span>
                    <div className="overflow-hidden rounded-xl border border-border">
                        {recentDirs.map((d, i) => {
                            const isActive = activeDir === d.path && !(isOtherDirOpen && customDirExpanded !== "");
                            return (
                                <button key={d.path} onClick={() => selectDir(d.path)}
                                    className={`flex w-full items-center gap-2.5 px-3.5 py-3 font-mono text-[12.5px] ${i > 0 ? "border-t border-border " : ""}${isActive ? "bg-secondary" : "bg-card text-muted-foreground"}`}>
                                    <span className={isActive ? "text-accent" : "text-muted-foreground/40"}>›</span>
                                    <span className="truncate">{displayPath(d.path, homeDir)}</span>
                                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/70">{formatRelativeTime(d.lastUsedAt)}</span>
                                </button>
                            );
                        })}
                        {isOtherDirOpen ? (
                            <div className={`flex w-full items-center gap-2.5 bg-card px-3.5 py-1.5 font-mono text-[12.5px] ${recentDirs.length > 0 ? "border-t border-border" : ""}`}>
                                <span className={customDir.trim() !== "" ? "text-accent" : "text-muted-foreground/40"}>›</span>
                                <Input autoFocus value={customDir} onChange={(e) => setCustomDir(e.target.value)}
                                    placeholder={t("new.otherDirPlaceholder")}
                                    className="h-8 rounded-none border-none bg-transparent px-0 font-mono text-[12.5px] shadow-none focus-visible:ring-0" />
                            </div>
                        ) : (
                            <button onClick={() => setIsOtherDirOpen(true)}
                                className={`flex w-full items-center gap-2.5 bg-card px-3.5 py-3 font-mono text-[12.5px] text-muted-foreground/70 ${recentDirs.length > 0 ? "border-t border-border" : ""}`}>
                                <span>+</span> {t("new.otherDir")}
                            </button>
                        )}
                    </div>
                </section>

                {/* промпт из задачи Zen — уйдёт первым сообщением после запуска */}
                {zenState?.zenTaskTitle && (
                    <section className="flex flex-col gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground/70">{TEXT.promptLabel}</span>
                        <div className="rounded-xl border border-border bg-card px-3.5 py-3 text-[13px] leading-snug">
                            {zenState.zenTaskTitle}
                        </div>
                    </section>
                )}

                {/* resume: bottom-sheet со списком прошлых сессий агента (RPC list-agent-sessions) */}
                <button onClick={() => setSheet("resume")} disabled={!machine}
                    className="flex h-10 items-center justify-center gap-2 rounded-[10px] border border-dashed border-border font-mono text-[11.5px] text-muted-foreground">
                    <RotateCcw className="size-3" /> {t("new.resumePrefix")} {agent}…
                </button>
            </main>

            <footer className="px-5 pb-[max(14px,env(safe-area-inset-bottom))] pt-3">
                <button onClick={() => void spawn()} disabled={!machine || activeDir === "" || isSpawning}
                    className="h-[52px] w-full rounded-xl bg-accent text-base font-semibold text-accent-foreground disabled:opacity-50">
                    {isSpawning
                        ? TEXT.spawning
                        : `${t("new.start")} ${agent} ${t("new.startIn")} ${displayPath(activeDir, homeDir) || "…"}`}
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
                                                {m.active ? TEXT.online : formatRelativeTime(m.activeAt)}
                                            </span>
                                        </>
                                    }
                                    onClick={() => { setMachineId(m.id); setDir(null); setSheet(null); }} />
                            ))}
                        </>
                    )}
                    {sheet === "model" && (
                        <>
                            <SheetHeader title={t("new.modelTitle")} tag={agent} />
                            {agentModels.map((m) => (
                                <SheetRow key={m} isActive={m === model} label={m}
                                    onClick={() => { setModel(m); setSheet(null); }} />
                            ))}
                        </>
                    )}
                    {sheet === "resume" && (
                        <>
                            <SheetHeader title={`${t("new.resumeTitle")} · ${agent}`} tag={t("new.resumeTag")} />
                            {resumeItems === null ? (
                                <div className="border-t border-border px-[18px] py-3 font-mono text-[12.5px] text-muted-foreground/70">
                                    {TEXT.resumeLoading}
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
        </div>
    );
}
