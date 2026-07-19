// remcli-web — Новая сессия (design/screens/new-session.tsx, живой P2P-протокол).
// Машина/сессии — из стора протокола; спавн — RPC spawn-remcli-session
// (payload как в remcli-cli/src/daemon/machineSocket.ts), resume-sheet —
// RPC list-agent-sessions, directory-picker — RPC list-directory.
// Модели/режимы — daemon-normalized provider capabilities; только non-Codex
// providers пока используют локальные временные options.
import * as React from "react";
import { ArrowUp, ChevronDown, Folder, FolderOpen, Loader2, RotateCcw, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { AgentIcon, StatusDot, type AgentId } from "@/components/kit";
import { formatPathRelativeToHome } from "@/components/app/sessionDisplay";
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
    machineGetCodexCapabilities,
    machineSpawnNewSession,
    refreshSessions,
    sendSessionMessage,
    useMachines,
    useProtocolStore,
    useSessions,
    type AgentSessionInfo,
    type CodexCapabilitiesSnapshot,
    type CodexExecutionConfig,
    type CodexModelCapability,
    type DirectoryListing,
    type Machine,
    type PermissionMode,
    type SpawnSessionOptions,
    type SpawnSessionResult,
} from "@/lib/protocol";
import { linkZenTaskSession } from "@/lib/zenTasks";

type SheetKind = "machine" | "model" | "permission" | "reasoning" | "resume" | "directory";

interface SheetState {
    kind: SheetKind;
    generation: number;
}

export function resolveSheetOpenChange(
    renderedSheet: SheetState | null,
    currentSheet: SheetState | null,
    isOpen: boolean,
): SheetState | null {
    return !isOpen
        && renderedSheet !== null
        && currentSheet !== null
        && renderedSheet.kind === currentSheet.kind
        && renderedSheet.generation === currentSheet.generation
        ? null
        : currentSheet;
}

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
    { id: "codex", name: "Codex", kind: "cli", models: [] },
    { id: "gemini", name: "Gemini", kind: "cli", models: ["gemini-2.5-pro", "gemini-3-pro", "gemini-3-flash"] },
    { id: "cursor", name: "Cursor", kind: "agent", models: ["default", "opus-4.6", "composer-1.5", "gemini-3-pro"] },
];

export function getModelOverride(model: string): string | null {
    return model !== DEFAULT_MODEL_ID ? model : null;
}

export function modelOverrideState(model: string, hasExplicitModelSelection: boolean): { model?: string | null } {
    return hasExplicitModelSelection ? { model: getModelOverride(model) } : {};
}

export function getResumeDirectory(projectPath: string | undefined, activeDirectory: string): string {
    return projectPath || activeDirectory;
}

export function getDefaultCodexExecution(capabilities: CodexCapabilitiesSnapshot): CodexExecutionConfig | null {
    if (capabilities.status !== "ready" || !capabilities.catalogVersion) return null;
    const model = capabilities.models.find((item) => item.isDefault) ?? capabilities.models[0];
    return model ? createCodexExecutionForModel(capabilities, model.id) : null;
}

export function createCodexExecutionForModel(
    capabilities: CodexCapabilitiesSnapshot,
    modelId: string,
    reasoningEffort?: CodexModelCapability["supportedReasoningEfforts"][number],
): CodexExecutionConfig | null {
    if (capabilities.status !== "ready" || !capabilities.catalogVersion) return null;
    const model = capabilities.models.find((item) => item.id === modelId);
    if (!model) return null;
    if (reasoningEffort !== undefined && !model.supportedReasoningEfforts.includes(reasoningEffort)) return null;
    const selectedReasoningEffort = reasoningEffort ?? model.defaultReasoningEffort;
    if (model.supportedReasoningEfforts.length > 0) {
        if (!selectedReasoningEffort || !model.supportedReasoningEfforts.includes(selectedReasoningEffort)) return null;
    }
    return {
        model: model.id,
        catalogVersion: capabilities.catalogVersion,
        ...(selectedReasoningEffort ? { reasoningEffort: selectedReasoningEffort } : {}),
    };
}

function findCodexModel(
    capabilities: CodexCapabilitiesSnapshot | null,
    modelId: string | null,
): CodexModelCapability | null {
    if (capabilities?.status !== "ready" || !modelId) return null;
    return capabilities.models.find((item) => item.id === modelId) ?? null;
}

export type ReasoningControlState = "unsupported" | "loading" | "unavailable" | "no-options" | "choose-required" | "ready";

export function getReasoningControlState(input: {
    agent: AgentId;
    isLoading: boolean;
    capabilities: CodexCapabilitiesSnapshot | null;
    selectedModel: CodexModelCapability | null;
    hasReasoningSelection: boolean;
}): ReasoningControlState {
    if (input.agent !== "codex") return "unsupported";
    if (input.isLoading) return "loading";
    if (input.capabilities?.status !== "ready" || !input.selectedModel) return "unavailable";
    if (input.selectedModel.supportedReasoningEfforts.length === 0) return "no-options";
    if (!input.hasReasoningSelection) return "choose-required";
    return "ready";
}

export function buildNewSessionSpawnOptions(input: {
    machineId: string;
    directory: string;
    agent: AgentId;
    permissionMode: PermissionMode;
    codexExecution: CodexExecutionConfig | null;
    codexReasoningEfforts: readonly CodexModelCapability["supportedReasoningEfforts"][number][];
    resume?: AgentSessionInfo;
}): SpawnSessionOptions {
    const spawnAgent = input.resume?.agent ?? input.agent;
    if (spawnAgent === "codex" && !input.codexExecution) {
        throw new Error("Codex requires a capability-validated execution selection.");
    }
    if (spawnAgent === "codex" && input.codexReasoningEfforts.length > 0 && !input.codexExecution?.reasoningEffort) {
        throw new Error("Codex requires a selected reasoning effort for this model.");
    }
    return {
        machineId: input.machineId,
        directory: input.directory,
        agent: spawnAgent,
        resumeSessionId: input.resume?.sessionId,
        resumeSessionName: input.resume?.sessionName ?? undefined,
        permissionMode: input.permissionMode,
        ...(spawnAgent === "codex" && input.codexExecution ? { codexExecution: input.codexExecution } : {}),
    };
}

const CODEX_CAPABILITY_REJECTION_PATTERN = /^Codex capability selection rejected: (?:expired|unsupported_selection|policy_denied)\.$/;

/** Match only the daemon's typed Codex capability rejection envelope. */
export function isCodexCapabilityRejection(result: SpawnSessionResult, agent: AgentId): boolean {
    return agent === "codex"
        && result.type === "error"
        && CODEX_CAPABILITY_REJECTION_PATTERN.test(result.errorMessage.trim());
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

function formatResumeError(error: unknown): string {
    const details = error instanceof Error ? error.message : String(error);
    return details || t("status.error");
}

interface RecentDir {
    path: string;
    displayPath: string;
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
            <span className="ml-auto font-mono text-[10px] text-muted-foreground">{tag}</span>
        </div>
    );
}

function SheetRow({
    isActive,
    label,
    meta,
    onClick,
    disabled = false,
}: {
    isActive: boolean;
    label: string;
    meta?: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="flex min-h-11 w-full min-w-0 items-center gap-[11px] border-t border-border px-[18px] py-3 text-left disabled:cursor-not-allowed disabled:opacity-50"
        >
            <span className={`min-w-0 flex-1 truncate font-mono text-[12.5px] ${isActive ? "text-foreground" : "text-muted-foreground"}`}>{label}</span>
            {meta}
        </button>
    );
}

const SHEET_CONTENT_CLASS =
    // rounded через тот же data-вариант, что в ui/drawer.tsx — иначе twMerge не схлопнет rounded-t-lg базы.
    "data-[vaul-drawer-direction=bottom]:rounded-t-[20px] border-border bg-card pb-[max(10px,env(safe-area-inset-bottom))] " +
    "[&>div:first-child]:mt-2 [&>div:first-child]:mb-1 [&>div:first-child]:h-[4.5px] [&>div:first-child]:w-[38px] [&>div:first-child]:bg-muted-foreground/40";

export const DIRECTORY_SHEET_CONTENT_CLASS =
    `${SHEET_CONTENT_CLASS} data-[vaul-drawer-direction=bottom]:h-[min(78dvh,35rem)]`;

export const RESUME_SHEET_CONTENT_CLASS =
    `${SHEET_CONTENT_CLASS} data-[vaul-drawer-direction=bottom]:h-[min(72dvh,32rem)]`;

export function ResumeSheetContent({
    agent,
    items,
    error = null,
    isResuming = false,
    onResume,
    onRetry,
}: {
    agent: AgentId;
    items: AgentSessionInfo[] | null;
    error?: string | null;
    isResuming?: boolean;
    onResume: (session: AgentSessionInfo) => void;
    onRetry?: () => void;
}) {
    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <SheetHeader title={`${t("new.resumeTitle")} · ${agent}`} tag={t("new.resumeTag")} />
            <div
                role="region"
                aria-label={t("new.resumeTitle")}
                aria-busy={(items === null && error === null) || isResuming}
                tabIndex={0}
                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain outline-none"
            >
                {error !== null ? (
                    <div role="alert" aria-live="assertive" className="flex min-h-[12rem] flex-col justify-center gap-3 border-t border-border px-[18px] py-3 font-mono text-[12.5px] text-muted-foreground">
                        <div className="rounded-[10px] bg-destructive/10 px-3 py-2 leading-snug text-destructive">
                            <div className="font-semibold">{t("status.error")}</div>
                            <div className="mt-1 break-words text-[11.5px]">{error}</div>
                        </div>
                        {onRetry && (
                            <button
                                type="button"
                                onClick={onRetry}
                                className="min-h-11 rounded-[9px] border border-border px-3 font-mono text-[11.5px] transition-[background-color,border-color,color,transform] active:scale-[0.96]"
                            >
                                {t("connect.retry")}
                            </button>
                        )}
                    </div>
                ) : items === null ? (
                    <div role="status" aria-live="polite" className="flex min-h-[12rem] items-center justify-center gap-2 border-t border-border px-[18px] py-3 font-mono text-[12.5px] text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin text-accent" />
                        {t("new.resumeLoading")}
                    </div>
                ) : items.length === 0 ? (
                    <div className="min-h-[12rem] border-t border-border px-[18px] py-3 font-mono text-[12.5px] text-muted-foreground">
                        {t("new.resumeEmpty")}
                    </div>
                ) : (
                    <>
                        {isResuming && (
                            <div role="status" aria-live="polite" className="flex min-h-11 items-center gap-2 border-t border-border px-[18px] py-3 font-mono text-[11.5px] text-muted-foreground">
                                <Loader2 className="size-3.5 animate-spin text-accent" />
                                {t("new.spawning")}
                            </div>
                        )}
                        {items.map((item, index) => (
                            <SheetRow
                                key={item.sessionId}
                                isActive={index === 0}
                                label={item.sessionName ?? item.firstMessage ?? item.sessionId}
                                meta={
                                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                                        {formatRelativeTime(item.lastModified)}
                                    </span>
                                }
                                onClick={() => onResume(item)}
                                disabled={isResuming}
                            />
                        ))}
                    </>
                )}
            </div>
        </div>
    );
}

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
    const [codexCapabilities, setCodexCapabilities] = React.useState<CodexCapabilitiesSnapshot | null>(null);
    const [codexModelId, setCodexModelId] = React.useState<string | null>(null);
    const [codexExecution, setCodexExecution] = React.useState<CodexExecutionConfig | null>(null);
    const [isCodexCapabilitiesLoading, setIsCodexCapabilitiesLoading] = React.useState(false);
    const [codexCapabilitiesReloadKey, setCodexCapabilitiesReloadKey] = React.useState(0);
    const [dir, setDir] = React.useState<string | null>(null);
    const [dirDisplayPath, setDirDisplayPath] = React.useState<string | null>(null);
    const [directoryRequestPath, setDirectoryRequestPath] = React.useState<string | undefined>(undefined);
    const [directoryListing, setDirectoryListing] = React.useState<DirectoryListing | null>(null);
    const [directoryError, setDirectoryError] = React.useState<string | null>(null);
    const [directoryBackTarget, setDirectoryBackTarget] = React.useState<DirectoryBackTarget | null>(null);
    const [directoryReloadKey, setDirectoryReloadKey] = React.useState(0);
    const [isDirectoryLoading, setIsDirectoryLoading] = React.useState(false);
    const [sheet, setSheet] = React.useState<SheetState | null>(null);
    const sheetGenerationRef = React.useRef(0);
    const [isSpawning, setIsSpawning] = React.useState(false);
    const [isApprovingDirectory, setIsApprovingDirectory] = React.useState(false);
    const [pendingDirectoryCreation, setPendingDirectoryCreation] = React.useState<PendingDirectoryCreation | null>(null);
    const [resumeItems, setResumeItems] = React.useState<AgentSessionInfo[] | null>(null);
    const [resumeError, setResumeError] = React.useState<string | null>(null);
    const [resumeRetryItem, setResumeRetryItem] = React.useState<AgentSessionInfo | null>(null);
    const [resumeReloadKey, setResumeReloadKey] = React.useState(0);

    const machine = machines.find((m) => m.id === machineId) ?? machines[0] ?? null;
    const activeMachineId = machine?.id;
    const homeDir = machine?.metadata?.homeDir;
    const sheetKind = sheet?.kind ?? null;
    // Vaul keeps a ref to its latest onOpenChange callback. A newly opened sheet
    // therefore needs a fresh root so a late close from the prior instance
    // cannot be delivered to the new sheet's callback.
    const drawerInstanceKey = sheet?.generation ?? sheetGenerationRef.current;
    const agentModels = AGENT_OPTIONS.find((a) => a.id === agent)?.models ?? [];
    const agentPermissionModes = agent === "codex" && codexCapabilities?.status === "ready"
        ? codexCapabilities.permissionModes
        : agent === "codex"
            ? []
            : getAgentPermissionModes(agent);
    const activeModeLabel = getAgentPermissionLabel(agent, mode);
    const selectedCodexModel = findCodexModel(codexCapabilities, codexModelId);
    const hasCodexReasoningSelection = selectedCodexModel
        ? selectedCodexModel.supportedReasoningEfforts.length === 0
            || (codexExecution?.model === selectedCodexModel.id
                && codexExecution.reasoningEffort !== undefined
                && selectedCodexModel.supportedReasoningEfforts.includes(codexExecution.reasoningEffort))
        : false;
    const hasCodexPermissionSelection = agent === "codex"
        && agentPermissionModes.includes(mode as typeof agentPermissionModes[number]);
    const isCodexCatalogReady = agent === "codex"
        && codexCapabilities?.status === "ready"
        && selectedCodexModel !== null;
    const isCodexCapabilityReady = agent === "codex"
        && isCodexCatalogReady
        && codexExecution !== null
        && selectedCodexModel !== null
        && hasCodexReasoningSelection
        && hasCodexPermissionSelection;
    const isCodexCapabilityUnavailable = agent === "codex"
        && !isCodexCapabilitiesLoading
        && (!codexCapabilities || codexCapabilities.status === "unavailable" || selectedCodexModel === null);
    const reasoningControlState = getReasoningControlState({
        agent,
        isLoading: isCodexCapabilitiesLoading,
        capabilities: codexCapabilities,
        selectedModel: selectedCodexModel,
        hasReasoningSelection: hasCodexReasoningSelection,
    });

    // недавние директории — из прошлых сессий выбранной машины (metadata.path)
    const recentDirs = React.useMemo<RecentDir[]>(() => {
        if (!machine) return [];
        const byPath = new Map<string, RecentDir>();
        for (const session of sessions) {
            const meta = session.metadata;
            if (!meta?.path) continue;
            if (meta.machineId && meta.machineId !== machine.id) continue;
            const known = byPath.get(meta.path);
            if (!known || session.updatedAt > known.lastUsedAt) {
                byPath.set(meta.path, {
                    path: meta.path,
                    displayPath: formatPathRelativeToHome(meta.path, meta.homeDir ?? homeDir),
                    lastUsedAt: session.updatedAt,
                });
            }
        }
        return [...byPath.values()]
            .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
            .slice(0, 4);
    }, [homeDir, machine, sessions]);

    const activeDir = dir ?? recentDirs[0]?.path ?? homeDir ?? "";
    const activeDirDisplayPath = dir
        ? (dirDisplayPath ?? formatPathRelativeToHome(dir, homeDir))
        : (recentDirs[0]?.displayPath ?? formatPathRelativeToHome(activeDir, homeDir));
    const hasActiveDirInRecent = recentDirs.some((d) => d.path === activeDir);
    const shouldShowSelectedDir = activeDir !== "" && !hasActiveDirInRecent;
    const directoryHeaderPath = directoryListing?.path ?? directoryRequestPath ?? activeDir;
    const directoryHeaderDisplayPath = directoryListing?.displayPath
        ?? (directoryHeaderPath === activeDir
            ? activeDirDisplayPath
            : formatPathRelativeToHome(directoryHeaderPath, homeDir));
    const canSelectDirectoryHeaderPath = directoryHeaderPath !== "" && !isDirectoryLoading && !directoryError && directoryListing !== null;
    const directoryParentPath = directoryListing?.parent ?? (directoryError ? directoryBackTarget?.path ?? null : null);
    const directoryParentDisplayPath = directoryListing?.parentDisplayPath ?? (directoryError ? directoryBackTarget?.displayPath ?? null : null);
    const directoryEntries = directoryListing?.entries ?? [];

    // Codex is capability-driven: the account-visible catalog and supported
    // efforts come from the daemon's shared app-server, never from web static
    // options. A catalog refresh also revalidates the selected atomic pair.
    React.useEffect(() => {
        if (agent !== "codex" || !activeMachineId) {
            setIsCodexCapabilitiesLoading(false);
            return;
        }
        let isStale = false;
        setIsCodexCapabilitiesLoading(true);
        setCodexCapabilities(null);
        setCodexModelId(null);
        setCodexExecution(null);
        void machineGetCodexCapabilities(activeMachineId, codexCapabilitiesReloadKey > 0)
            .then((capabilities) => {
                if (isStale) return;
                setCodexCapabilities(capabilities);
                if (capabilities.status !== "ready") return;
                const defaultModel = capabilities.models.find((item) => item.isDefault) ?? capabilities.models[0] ?? null;
                setCodexModelId(defaultModel?.id ?? null);
                setCodexExecution((current) => {
                    if (!current || current.catalogVersion !== capabilities.catalogVersion) return defaultModel
                        ? createCodexExecutionForModel(capabilities, defaultModel.id)
                        : null;
                    const currentModel = capabilities.models.find((item) => item.id === current.model);
                    if (!currentModel) return defaultModel ? createCodexExecutionForModel(capabilities, defaultModel.id) : null;
                    const hasValidReasoningSelection = currentModel.supportedReasoningEfforts.length === 0
                        ? current.reasoningEffort === undefined
                        : current.reasoningEffort !== undefined
                            && currentModel.supportedReasoningEfforts.includes(current.reasoningEffort);
                    return hasValidReasoningSelection ? current : createCodexExecutionForModel(capabilities, currentModel.id);
                });
                setMode((current) => {
                    if (capabilities.permissionModes.includes(current as typeof capabilities.permissionModes[number])) {
                        return current;
                    }
                    return capabilities.permissionModes.includes("workspace-write")
                        ? "workspace-write"
                        : capabilities.permissionModes[0] ?? getDefaultPermissionMode("codex");
                });
            })
            .catch(() => {
                if (!isStale) setCodexCapabilities(null);
            })
            .finally(() => {
                if (!isStale) setIsCodexCapabilitiesLoading(false);
            });
        return () => { isStale = true; };
    }, [activeMachineId, agent, codexCapabilitiesReloadKey]);

    // resume-sheet: RPC list-agent-sessions с фильтром по агенту
    React.useEffect(() => {
        if (sheetKind !== "resume" || !activeMachineId) return;
        let isStale = false;
        setResumeItems(null);
        setResumeError(null);
        setResumeRetryItem(null);
        void machineListAgentSessions(activeMachineId, agent, activeDir || undefined, RESUME_LIST_LIMIT)
            .then((items) => {
                if (!isStale) setResumeItems(items);
            })
            .catch((error: unknown) => {
                if (isStale) return;
                setResumeError(formatResumeError(error));
            });
        return () => { isStale = true; };
    }, [activeDir, activeMachineId, agent, resumeReloadKey, sheetKind]);

    // directory-picker: RPC list-directory, stale responses ignored when user navigates fast.
    React.useEffect(() => {
        if (sheetKind !== "directory" || !activeMachineId) return;
        let isStale = false;
        setIsDirectoryLoading(true);
        setDirectoryError(null);
        setDirectoryListing(null);
        void machineListDirectory(activeMachineId, directoryRequestPath).then((listing) => {
            if (!isStale) setDirectoryListing(listing);
        }).catch((error: unknown) => {
            if (!isStale) setDirectoryError(formatDirectoryError(error));
        }).finally(() => {
            if (!isStale) setIsDirectoryLoading(false);
        });
        return () => { isStale = true; };
    }, [activeMachineId, directoryReloadKey, directoryRequestPath, sheetKind]);

    const selectAgent = (id: AgentId) => {
        setAgent(id);
        const nextModel = AGENT_OPTIONS.find((a) => a.id === id)?.models[0];
        if (nextModel) setModel(nextModel);
        setHasExplicitModelSelection(false);
        if (id !== "codex") setCodexModelId(null);
        if (id !== "codex") {
            setCodexExecution(null);
        }
        setMode(getDefaultPermissionMode(id));
    };

    const selectDir = (path: string, displayPath?: string) => {
        setDir(path);
        setDirDisplayPath(displayPath ?? null);
    };

    const openSheet = (kind: SheetKind) => {
        const generation = sheetGenerationRef.current + 1;
        sheetGenerationRef.current = generation;
        setSheet({ kind, generation });
    };

    const openDirectoryPicker = () => {
        setDirectoryRequestPath(activeDir || homeDir || undefined);
        setDirectoryListing(null);
        setDirectoryError(null);
        setDirectoryBackTarget(null);
        openSheet("directory");
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
        const modelState = agent === "codex" ? {} : modelOverrideState(model, hasExplicitModelSelection);
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
            if (isCodexCapabilityRejection(result, options.agent ?? "claude")) {
                setCodexCapabilities(null);
                setCodexModelId(null);
                setCodexExecution(null);
                setIsCodexCapabilitiesLoading(true);
                setCodexCapabilitiesReloadKey((value) => value + 1);
            }
            if (resume) {
                setResumeError(result.errorMessage);
                setResumeRetryItem(resume);
                return;
            }
            toast.error(result.errorMessage);
            return;
        }
        await finishSpawn(result.sessionId, resume);
    };

    const spawn = async (resume?: AgentSessionInfo) => {
        if (!machine || isSpawning) return;
        const directory = getResumeDirectory(resume?.projectPath, activeDir);
        if (directory === "") {
            openDirectoryPicker();
            return;
        }
        const spawnAgent = resume?.agent ?? agent;
        const permissionMode = normalizeAgentPermissionMode(spawnAgent, mode);
        if (spawnAgent === "codex" && !isCodexCapabilityReady) {
            toast.error(t("new.capabilitiesUnavailable"));
            return;
        }
        if (resume) {
            setResumeError(null);
            setResumeRetryItem(null);
        }
        setIsSpawning(true);
        try {
            const options = buildNewSessionSpawnOptions({
                machineId: machine.id,
                directory,
                agent: spawnAgent,
                permissionMode,
                codexExecution,
                codexReasoningEfforts: spawnAgent === "codex"
                    ? selectedCodexModel?.supportedReasoningEfforts ?? []
                    : [],
                resume,
            });
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

    const drawerContentClassName = sheetKind === "directory"
        ? DIRECTORY_SHEET_CONTENT_CLASS
        : sheetKind === "resume"
            ? RESUME_SHEET_CONTENT_CLASS
            : SHEET_CONTENT_CLASS;

    return (
        <div className="flex h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
            <header className="flex items-center px-5 pb-3 pt-1.5">
                <h1 className="text-xl font-semibold">{t("new.title")}</h1>
                <button aria-label={t("new.close")} onClick={() => navigate(-1)}
                    className="ml-auto flex size-11 items-center justify-center rounded-[10px] border border-border transition-[background-color,border-color,transform] active:scale-[0.96]">
                    <X className="size-4 text-muted-foreground" />
                </button>
            </header>

            <main className="flex min-h-0 flex-1 flex-col gap-4.5 overflow-y-auto px-5 [&>*]:shrink-0">
                {/* машина */}
                <button onClick={() => openSheet("machine")} disabled={machines.length === 0}
                    className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3">
                    <span className="w-[52px] text-left font-mono text-[10px] text-muted-foreground">{t("new.machine")}</span>
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
                    <span className="font-mono text-[10px] text-muted-foreground">{t("new.agent")}</span>
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

                {/* capability controls: model, permissions, reasoning */}
                <section className="flex min-w-0 flex-col gap-2" aria-label={t("new.model")}>
                    <div
                        data-capability-layout="two-row"
                        className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-2"
                    >
                        <section data-capability-control="model" className="flex min-w-0 flex-col gap-2">
                            <span className="flex min-h-[22px] items-end font-mono text-[10px] text-muted-foreground">{t("new.model")}</span>
                            {agent === "codex" && isCodexCapabilitiesLoading ? (
                                <div aria-busy="true" className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-[10px] border border-input bg-muted px-2.5 font-mono text-[11px] text-muted-foreground">
                                    <Loader2 className="size-3 shrink-0 animate-spin" />
                                    <span className="min-w-0 truncate">{t("new.capabilitiesLoading")}</span>
                                </div>
                            ) : agent === "codex" && isCodexCapabilityUnavailable ? (
                                <button type="button" onClick={() => setCodexCapabilitiesReloadKey((value) => value + 1)}
                                    className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-destructive/40 bg-destructive/[0.06] px-2.5 font-mono text-[11px] text-destructive transition-[border-color,background-color,transform] active:scale-[0.96]">
                                    <span className="min-w-0 truncate">{t("new.capabilitiesRetry")}</span>
                                </button>
                            ) : (
                                <button type="button" onClick={() => openSheet("model")} disabled={agent === "codex" && !isCodexCatalogReady}
                                    className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-input bg-muted px-2.5 font-mono text-[11px] transition-[background-color,border-color,transform] active:scale-[0.96] disabled:opacity-50">
                                    <span className="min-w-0 truncate">{agent === "codex" ? selectedCodexModel?.displayName : model}</span>
                                    <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
                                </button>
                            )}
                        </section>
                        <section data-capability-control="permission" className="flex min-w-0 flex-col gap-2">
                            <span className="flex min-h-[22px] items-end font-mono text-[10px] text-muted-foreground">{t("new.permissions")}</span>
                            <button type="button" onClick={() => openSheet("permission")} disabled={agent === "codex" && codexCapabilities?.status !== "ready"}
                                className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-input bg-muted px-2.5 font-mono text-[11px] transition-[background-color,border-color,transform] active:scale-[0.96] disabled:opacity-50">
                                <span className="min-w-0 truncate">{activeModeLabel}</span>
                                <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
                            </button>
                        </section>
                        <section data-capability-control="reasoning" className="col-start-1 flex min-w-0 flex-col gap-2" aria-label={t("new.reasoning")}>
                            <span className="flex min-h-[22px] flex-col justify-end font-mono text-[10px] leading-[11px] text-muted-foreground">
                                <span>{t("new.reasoningShort")}</span>
                                <span>{t("new.reasoningLong")}</span>
                            </span>
                            {reasoningControlState === "unsupported" ? (
                                <div role="status" className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-dashed border-border bg-card px-2.5 font-mono text-[11px] text-muted-foreground">
                                    <span className="min-w-0 truncate">{t("new.reasoningUnsupported")}</span>
                                </div>
                            ) : reasoningControlState === "loading" ? (
                                <div aria-busy="true" className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-[10px] border border-input bg-muted px-2.5 font-mono text-[11px] text-muted-foreground">
                                    <Loader2 className="size-3 shrink-0 animate-spin" />
                                    <span className="min-w-0 truncate">{t("new.capabilitiesLoading")}</span>
                                </div>
                            ) : reasoningControlState === "unavailable" ? (
                                <button type="button" onClick={() => setCodexCapabilitiesReloadKey((value) => value + 1)}
                                    className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-destructive/40 bg-destructive/[0.06] px-2.5 font-mono text-[11px] text-destructive transition-[border-color,background-color,transform] active:scale-[0.96]">
                                    <span className="min-w-0 truncate">{t("new.capabilitiesRetry")}</span>
                                </button>
                            ) : reasoningControlState === "no-options" ? (
                                <div role="status" className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-dashed border-border bg-card px-2.5 font-mono text-[11px] text-muted-foreground">
                                    <span className="min-w-0 truncate">{t("new.reasoningNoOptions")}</span>
                                </div>
                            ) : reasoningControlState === "choose-required" ? (
                                <button type="button" onClick={() => openSheet("reasoning")}
                                    className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-input bg-muted px-2.5 font-mono text-[11px] transition-[background-color,border-color,transform] active:scale-[0.96]">
                                    <span className="min-w-0 truncate">{t("new.reasoningChoose")}</span>
                                    <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
                                </button>
                            ) : (
                                <button type="button" onClick={() => openSheet("reasoning")} disabled={reasoningControlState !== "ready"}
                                    className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-input bg-muted px-2.5 font-mono text-[11px] transition-[background-color,border-color,transform] active:scale-[0.96] disabled:opacity-50">
                                    <span className="min-w-0 truncate">{codexExecution?.reasoningEffort}</span>
                                    <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
                                </button>
                            )}
                        </section>
                    </div>
                </section>

                {/* директория — недавние quick picks + browser/picker через RPC list-directory */}
                <section className="flex flex-col gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground">{t("new.dirRecent")}</span>
                    <div className="overflow-hidden rounded-xl border border-border">
                        {shouldShowSelectedDir && (
                            <button onClick={() => selectDir(activeDir, activeDirDisplayPath)}
                                className="flex min-h-11 w-full items-center gap-2.5 bg-secondary px-3.5 py-3 text-left font-mono text-[12.5px]">
                                <FolderOpen className="size-3.5 shrink-0 text-accent" />
                                <span className="min-w-0 flex-1 truncate text-left">{activeDirDisplayPath}</span>
                                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{t("new.dirSelected")}</span>
                            </button>
                        )}
                        {recentDirs.map((d, i) => {
                            const isActive = activeDir === d.path;
                            return (
                                <button key={d.path} onClick={() => selectDir(d.path, d.displayPath)}
                                    className={`flex min-h-11 w-full items-center gap-2.5 px-3.5 py-3 text-left font-mono text-[12.5px] ${(i > 0 || shouldShowSelectedDir) ? "border-t border-border " : ""}${isActive ? "bg-secondary" : "bg-card text-muted-foreground"}`}>
                                    <Folder className={`size-3.5 shrink-0 ${isActive ? "text-accent" : "text-muted-foreground/40"}`} />
                                    <span className="min-w-0 flex-1 truncate text-left">{d.displayPath}</span>
                                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(d.lastUsedAt)}</span>
                                </button>
                            );
                        })}
                        <button onClick={openDirectoryPicker} disabled={!machine}
                            className={`flex min-h-11 w-full items-center gap-2.5 bg-card px-3.5 py-3 font-mono text-[12.5px] text-muted-foreground transition-[background-color,color,transform] active:scale-[0.96] disabled:opacity-50 ${(recentDirs.length > 0 || shouldShowSelectedDir) ? "border-t border-border" : ""}`}>
                            <FolderOpen className="size-3.5 shrink-0" /> {t("new.dirBrowse")}
                        </button>
                    </div>
                </section>

                {/* промпт из задачи Zen — уйдёт первым сообщением после запуска */}
                {zenState?.zenTaskTitle && (
                    <section className="flex flex-col gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground">{t("new.promptLabel")}</span>
                        <div className="rounded-xl border border-border bg-card px-3.5 py-3 text-[13px] leading-snug">
                            {zenState.zenTaskTitle}
                        </div>
                    </section>
                )}

                {/* resume: bottom-sheet со списком прошлых сессий агента (RPC list-agent-sessions) */}
                <button onClick={() => openSheet("resume")} disabled={!machine || (agent === "codex" && !isCodexCapabilityReady)}
                    className="flex h-11 items-center justify-center gap-2 rounded-[10px] border border-dashed border-border font-mono text-[11.5px] text-muted-foreground transition-[background-color,border-color,color,transform] active:scale-[0.96]">
                    <RotateCcw className="size-3" /> {t("new.resume", { agent })}
                </button>
            </main>

            <footer className="px-5 pb-[max(14px,env(safe-area-inset-bottom))] pt-3">
                <button onClick={() => void spawn()} disabled={!machine || activeDir === "" || isSpawning || (agent === "codex" && !isCodexCapabilityReady)}
                    className="h-[52px] w-full overflow-hidden rounded-xl bg-accent px-3 text-base font-semibold text-accent-foreground disabled:opacity-50">
                    {isSpawning
                        ? t("new.spawning")
                        : <span className="block truncate whitespace-nowrap">{t("new.startButton", { agent, dir: activeDirDisplayPath || "…" })}</span>}
                </button>
            </footer>

            <Drawer
                key={drawerInstanceKey}
                open={sheet !== null}
                onOpenChange={(isOpen) => {
                    setSheet((currentSheet) => resolveSheetOpenChange(sheet, currentSheet, isOpen));
                }}
            >
                <DrawerContent className={drawerContentClassName}>
                    {sheetKind === "machine" && (
                        <>
                            <SheetHeader title={t("new.machineTitle")} tag={t("new.machine")} />
                            {machines.map((m) => (
                                <SheetRow key={m.id} isActive={m.id === machine?.id} label={machineName(m)}
                                    meta={
                                        <>
                                            <StatusDot status={m.active ? "running" : "offline"} className="size-1.5" />
                                            <span className="font-mono text-[10px] text-muted-foreground">
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
                    {sheetKind === "model" && (
                        <>
                            <SheetHeader title={t("new.modelTitle")} tag={agent} />
                            {agent === "codex" && codexCapabilities?.status === "ready" && codexCapabilities.catalogVersion
                                ? codexCapabilities.models.map((item) => (
                                    <SheetRow key={item.id} isActive={item.id === codexModelId} label={item.displayName}
                                        onClick={() => {
                                            setCodexModelId(item.id);
                                            setCodexExecution(createCodexExecutionForModel(codexCapabilities, item.id));
                                            setSheet(null);
                                        }} />
                                ))
                                : agentModels.map((item) => (
                                    <SheetRow key={item} isActive={item === model} label={item}
                                        onClick={() => {
                                            setModel(item);
                                            setHasExplicitModelSelection(true);
                                            setSheet(null);
                                        }} />
                                ))}
                        </>
                    )}
                    {sheetKind === "permission" && (
                        <>
                            <SheetHeader title={t("new.permissions")} tag={agent} />
                            {agentPermissionModes.map((permission) => (
                                <SheetRow key={permission} isActive={permission === mode} label={getAgentPermissionLabel(agent, permission)}
                                    onClick={() => { setMode(permission); setSheet(null); }} />
                            ))}
                        </>
                    )}
                    {sheetKind === "reasoning" && selectedCodexModel && selectedCodexModel.supportedReasoningEfforts.length > 0 && codexCapabilities?.catalogVersion && (
                        <>
                            <SheetHeader title={t("new.reasoningTitle")} tag={selectedCodexModel.displayName} />
                            {selectedCodexModel.supportedReasoningEfforts.map((reasoningEffort) => (
                                <SheetRow key={reasoningEffort} isActive={reasoningEffort === codexExecution?.reasoningEffort} label={reasoningEffort}
                                    onClick={() => {
                                        const nextExecution = createCodexExecutionForModel(codexCapabilities, selectedCodexModel.id, reasoningEffort);
                                        if (!nextExecution) return;
                                        setCodexExecution(nextExecution);
                                        setSheet(null);
                                    }} />
                            ))}
                        </>
                    )}
                    {sheetKind === "directory" && (
                        <div className="flex min-h-0 flex-1 flex-col">
                            <SheetHeader title={t("new.dirBrowserTitle")} tag={machine ? machineName(machine) : t("new.machine")} />
                            <div className="mx-[18px] mb-3 shrink-0 rounded-xl bg-background/70 p-3 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                                <div className="mb-1 font-mono text-[10px] text-muted-foreground">{t("new.dirCurrent")}</div>
                                <div className="break-all font-mono text-[12.5px] font-semibold leading-snug">
                                    {directoryHeaderDisplayPath || "…"}
                                </div>
                            </div>

                            <div className="shrink-0 border-t border-border">
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

                            <div role="region" aria-label={t("new.dirBrowserTitle")} className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain border-t border-border transition-[opacity,transform] duration-[var(--dur-std)] ease-[var(--ease-out)]">
                                <div key={isDirectoryLoading ? "loading" : directoryError ? "error" : directoryListing?.path ?? "empty"} className="animate-in fade-in duration-[var(--dur-enter)] ease-[var(--ease-out)]">
                                    {isDirectoryLoading && (
                                    <div className="flex min-h-11 items-center gap-2 px-[18px] py-3 font-mono text-[12.5px] text-muted-foreground">
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
                                    <div className="min-h-11 px-[18px] py-3 font-mono text-[12.5px] text-muted-foreground">
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
                            </div>

                            <div className="shrink-0 border-t border-border px-[18px] pt-3">
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
                        </div>
                    )}
                    {sheetKind === "resume" && (
                        <ResumeSheetContent
                            agent={agent}
                            items={resumeItems}
                            error={resumeError}
                            isResuming={isSpawning}
                            onResume={(session) => {
                                void spawn(session);
                            }}
                            onRetry={() => {
                                if (resumeRetryItem) {
                                    void spawn(resumeRetryItem);
                                    return;
                                }
                                setResumeReloadKey((value) => value + 1);
                            }}
                        />
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
