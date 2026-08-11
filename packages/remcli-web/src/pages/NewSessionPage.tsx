// remcli-web — Новая сессия (design/screens/new-session.tsx, живой P2P-протокол).
// Машина/сессии — из стора протокола; спавн — RPC spawn-remcli-session
// (payload как в remcli-cli/src/daemon/machineSocket.ts), resume-sheet —
// RPC list-agent-sessions, directory-picker — RPC list-directory.
// Модели/режимы — daemon-normalized provider capabilities; static options
// остаются только у ещё не capability-driven providers.
import * as React from "react";
import { ArrowUp, Check, ChevronDown, Folder, FolderOpen, Loader2, RotateCcw, SlidersHorizontal, X } from "lucide-react";
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
import { createCodexExecutionForModel } from "@/lib/codexCapabilities";
import { getIntlLocale, t } from "@/lib/i18n";
import {
    machineListDirectory,
    machineListAgentSessions,
    machineGetCodexCapabilities,
    machineGetCursorCapabilities,
    machineListRecentDirectories,
    machineSpawnNewSession,
    refreshSessions,
    sendSessionMessage,
    useMachines,
    useProtocolStore,
    type AgentSessionInfo,
    type CodexCapabilitiesSnapshot,
    type CodexExecutionConfig,
    type CodexModelCapability,
    DEFAULT_CURSOR_LAUNCH_CONTROLS,
    type CursorCapabilitiesSnapshot,
    type CursorExecutionConfig,
    type CursorLaunchControls,
    type CursorModelCapability,
    type DirectoryListing,
    type Machine,
    type PermissionMode,
    type RecentDirectory,
    type SpawnSessionOptions,
    type SpawnSessionResult,
} from "@/lib/protocol";
import { isProviderAvailable } from "@/lib/providerAvailability";
import { linkZenTaskSession } from "@/lib/zenTasks";

type SheetKind = "machine" | "model" | "permission" | "reasoning" | "cursor-launch" | "resume" | "directory";

interface SheetState {
    kind: SheetKind;
    generation: number;
}

interface SheetFocusTarget {
    generation: number;
    trigger: HTMLButtonElement;
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
    isAvailable: boolean;
}

const DEFAULT_MODEL_ID = "default";
const DEFAULT_NEW_SESSION_AGENT = "codex";

export const AGENT_OPTIONS: AgentOption[] = [
    { id: "claude", name: "Claude", kind: "code", models: [], isAvailable: isProviderAvailable("claude") },
    { id: "codex", name: "Codex", kind: "cli", models: [], isAvailable: isProviderAvailable("codex") },
    { id: "gemini", name: "Gemini", kind: "cli", models: [], isAvailable: isProviderAvailable("gemini") },
    { id: "cursor", name: "Cursor", kind: "agent", models: [], isAvailable: isProviderAvailable("cursor") },
];

export const isNewSessionAgentAvailable = isProviderAvailable;

export function getModelOverride(model: string): string | null {
    return model !== DEFAULT_MODEL_ID ? model : null;
}

export function modelOverrideState(model: string, hasExplicitModelSelection: boolean): { model?: string | null } {
    return hasExplicitModelSelection ? { model: getModelOverride(model) } : {};
}

export function getResumeDirectory(projectPath: string | undefined, activeDirectory: string): string {
    return projectPath || activeDirectory;
}

export interface CursorResumeNavigationPreset {
    machineId: string;
    directory: string;
    resumeSessionId: string;
    resumeSessionName: string | null;
    cursorModel: string;
}

interface NewSessionNavigationState {
    zenTaskTitle?: string;
    zenTaskId?: string;
    cursorResume?: CursorResumeNavigationPreset;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

// Treat every canonical UUID-shaped value as an opaque identifier. Native
// providers can issue newer UUID versions before the UI knows their version.
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_VISIBLE_OPAQUE_RESUME_ID_LENGTH = 12;

function humanResumeText(value: string | null | undefined, sessionId?: string): string | null {
    if (!nonEmptyString(value)) return null;

    const normalized = value.trim();
    return UUID_PATTERN.test(normalized) || normalized === sessionId?.trim()
        ? null
        : normalized;
}

export function getResumeProjectBasename(projectPath: string): string | null {
    const trimmedPath = projectPath.trim().replace(/[\\/]+$/, "");
    if (trimmedPath === "") return null;

    const separatorIndex = Math.max(trimmedPath.lastIndexOf("/"), trimmedPath.lastIndexOf("\\"));
    return trimmedPath.slice(separatorIndex + 1) || trimmedPath;
}

export function getResumePrimaryLabel(
    item: Pick<AgentSessionInfo, "sessionId" | "sessionName" | "firstMessage">
        & Partial<Pick<AgentSessionInfo, "projectPath" | "lastModified">>,
    agent: AgentId,
): string {
    return humanResumeText(item.sessionName, item.sessionId)
        ?? humanResumeText(item.firstMessage, item.sessionId)
        ?? [
            t("new.resumeProviderTitle", { agent }),
            getResumeProjectBasename(item.projectPath ?? ""),
            item.lastModified === undefined ? null : formatRelativeTime(item.lastModified),
        ].filter((value): value is string => value !== null).join(" · ");
}

export function getResumePreview(item: Pick<AgentSessionInfo, "sessionId" | "sessionName" | "firstMessage">): string | null {
    const sessionName = humanResumeText(item.sessionName, item.sessionId);
    const firstMessage = humanResumeText(item.firstMessage, item.sessionId);
    return sessionName !== null && firstMessage !== null && sessionName !== firstMessage
        ? firstMessage
        : null;
}

export function getShortResumeId(sessionId: string): string {
    const trimmed = sessionId.trim();
    if (UUID_PATTERN.test(trimmed) && trimmed.length > 8) {
        return `${trimmed.slice(0, 8)}…`;
    }
    return trimmed.length > MAX_VISIBLE_OPAQUE_RESUME_ID_LENGTH
        ? `${trimmed.slice(0, MAX_VISIBLE_OPAQUE_RESUME_ID_LENGTH)}…`
        : trimmed;
}

export function parseNewSessionNavigationState(state: unknown): NewSessionNavigationState {
    if (!isRecord(state)) return {};

    const cursorResumeValue = state.cursorResume;
    let cursorResume: CursorResumeNavigationPreset | undefined;
    if (isRecord(cursorResumeValue)
        && nonEmptyString(cursorResumeValue.machineId)
        && nonEmptyString(cursorResumeValue.directory)
        && nonEmptyString(cursorResumeValue.resumeSessionId)
        && nonEmptyString(cursorResumeValue.cursorModel)
        && (cursorResumeValue.resumeSessionName === undefined
            || cursorResumeValue.resumeSessionName === null
            || nonEmptyString(cursorResumeValue.resumeSessionName))) {
        cursorResume = {
            machineId: cursorResumeValue.machineId,
            directory: cursorResumeValue.directory,
            resumeSessionId: cursorResumeValue.resumeSessionId,
            resumeSessionName: typeof cursorResumeValue.resumeSessionName === "string"
                ? cursorResumeValue.resumeSessionName
                : null,
            cursorModel: cursorResumeValue.cursorModel,
        };
    }

    return {
        ...(nonEmptyString(state.zenTaskTitle) ? { zenTaskTitle: state.zenTaskTitle } : {}),
        ...(nonEmptyString(state.zenTaskId) ? { zenTaskId: state.zenTaskId } : {}),
        ...(cursorResume ? { cursorResume } : {}),
    };
}

export function isCursorResumePresetCompatible(
    preset: CursorResumeNavigationPreset | null,
    machineId: string | undefined,
    directory: string,
): boolean {
    return preset === null || (machineId === preset.machineId && directory === preset.directory);
}

export function getPrimarySelectorLabelKey(_agent: AgentId): "new.accessLevel" {
    return "new.accessLevel";
}

export { createCodexExecutionForModel, getDefaultCodexExecution } from "@/lib/codexCapabilities";

function findCodexModel(
    capabilities: CodexCapabilitiesSnapshot | null,
    modelId: string | null,
): CodexModelCapability | null {
    if (capabilities?.status !== "ready" || !modelId) return null;
    return capabilities.models.find((item) => item.id === modelId) ?? null;
}

export function getDefaultCursorExecution(capabilities: CursorCapabilitiesSnapshot): CursorExecutionConfig | null {
    if (capabilities.status !== "ready" || !capabilities.catalogVersion) return null;
    const model = capabilities.models.find((item) => item.isDefault);
    return model ? createCursorExecutionForModel(capabilities, model.id) : null;
}

export function createCursorExecutionForModel(
    capabilities: CursorCapabilitiesSnapshot,
    modelId: string,
): CursorExecutionConfig | null {
    if (capabilities.status !== "ready" || !capabilities.catalogVersion) return null;
    const model = capabilities.models.find((item) => item.id === modelId);
    return model ? { model: model.id, catalogVersion: capabilities.catalogVersion } : null;
}

function findCursorModel(
    capabilities: CursorCapabilitiesSnapshot | null,
    modelId: string | null,
): CursorModelCapability | null {
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

function getCursorLaunchControlsSummary(controls: CursorLaunchControls): string | null {
    const changedControls = [
        controls.force ? t("new.cursorForce") : null,
        controls.autoReview ? t("new.cursorAutoReview") : null,
        controls.sandbox !== "local-configuration"
            ? `${t("new.cursorSandbox")} ${cursorSandboxLabel(controls.sandbox)}`
            : null,
        controls.approveMcps ? "MCP" : null,
    ].filter((value): value is string => value !== null);

    return changedControls.length > 0
        ? t("new.cursorAdvancedSummary", { controls: changedControls.join(" · ") })
        : null;
}

function cursorExecutionModeLabel(mode: CursorLaunchControls["executionMode"]): string {
    switch (mode) {
        case "plan":
            return t("new.cursorModePlan");
        case "ask":
            return t("new.cursorModeAsk");
        default:
            return t("new.cursorModeAgent");
    }
}

function cursorSandboxLabel(sandbox: CursorLaunchControls["sandbox"]): string {
    if (sandbox === "local-configuration") return t("new.cursorHostControlled");
    if (sandbox === "enabled") return t("new.cursorSandboxEnabled");
    return t("new.cursorSandboxDisabled");
}

export function buildNewSessionSpawnOptions(input: {
    machineId: string;
    directory: string;
    agent: AgentId;
    permissionMode?: PermissionMode;
    codexExecution: CodexExecutionConfig | null;
    codexReasoningEfforts: readonly CodexModelCapability["supportedReasoningEfforts"][number][];
    cursorExecution?: CursorExecutionConfig | null;
    cursorLaunchControls?: CursorLaunchControls;
    resume?: ResumeTarget;
}): SpawnSessionOptions {
    const spawnAgent = input.resume?.agent ?? input.agent;
    if (!isNewSessionAgentAvailable(spawnAgent)) {
        throw new Error(`${spawnAgent} is not available in New Session.`);
    }
    if (spawnAgent === "codex" && !input.codexExecution) {
        throw new Error("Codex requires a capability-validated execution selection.");
    }
    if (spawnAgent === "codex" && input.codexReasoningEfforts.length > 0 && !input.codexExecution?.reasoningEffort) {
        throw new Error("Codex requires a selected reasoning effort for this model.");
    }
    if (spawnAgent === "cursor" && !input.cursorExecution) {
        throw new Error("Cursor requires a capability-validated execution selection.");
    }
    if (spawnAgent === "cursor" && !input.cursorLaunchControls) {
        throw new Error("Cursor requires validated launch controls.");
    }
    if (spawnAgent !== "cursor" && !input.permissionMode) {
        throw new Error(`${spawnAgent} requires a permission selection.`);
    }
    return {
        machineId: input.machineId,
        directory: input.directory,
        agent: spawnAgent,
        resumeSessionId: input.resume?.sessionId,
        resumeSessionName: input.resume?.sessionName ?? undefined,
        ...(spawnAgent !== "cursor" && input.permissionMode ? { permissionMode: input.permissionMode } : {}),
        ...(spawnAgent === "codex" && input.codexExecution ? { codexExecution: input.codexExecution } : {}),
        ...(spawnAgent === "cursor" && input.cursorExecution ? { cursorExecution: input.cursorExecution } : {}),
        ...(spawnAgent === "cursor" && input.cursorLaunchControls ? { cursorLaunchControls: input.cursorLaunchControls } : {}),
    };
}

const CODEX_CAPABILITY_REJECTION_PATTERN = /^Codex capability selection rejected: (?:expired|unsupported_selection|policy_denied)\.$/;
const CURSOR_CAPABILITY_REJECTION_PATTERN = /^Cursor capability selection rejected: (?:expired|unsupported_selection|unavailable)\.$/;

/** Match only the daemon's typed Codex capability rejection envelope. */
export function isCodexCapabilityRejection(result: SpawnSessionResult, agent: AgentId): boolean {
    return agent === "codex"
        && result.type === "error"
        && CODEX_CAPABILITY_REJECTION_PATTERN.test(result.errorMessage.trim());
}

/** Match only the daemon's typed Cursor capability rejection envelope. */
export function isCursorCapabilityRejection(result: SpawnSessionResult, agent: AgentId): boolean {
    return agent === "cursor"
        && result.type === "error"
        && CURSOR_CAPABILITY_REJECTION_PATTERN.test(result.errorMessage.trim());
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

function formatRecentDirectoriesError(error: unknown): string {
    if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
        const message = (error as { code?: unknown; message?: unknown }).message;
        if ((error as { code?: unknown }).code === "unavailable" && typeof message === "string" && message.trim().length > 0) {
            return message;
        }
    }
    return t("new.dirError");
}

function formatResumeError(error: unknown): string {
    const details = error instanceof Error ? error.message : String(error);
    return details || t("status.error");
}

interface PendingDirectoryCreation {
    directory: string;
    options: SpawnSessionOptions;
    resume?: ResumeTarget;
}

interface ResumeTarget {
    agent: AgentId;
    projectPath: string;
    sessionId: string;
    sessionName: string | null;
}

interface DirectoryBackTarget {
    path: string;
    displayPath: string;
}

const RESUME_LIST_LIMIT = 20;

/* ---------- Разметка ---------- */

function SheetHeader({ title, tag }: { title: string; tag: string }) {
    return (
        <div className="flex shrink-0 items-center px-[18px] pb-2 pt-1">
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
    showSelectionIndicator = false,
    singleLine = false,
}: {
    isActive: boolean;
    label: string;
    meta?: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    showSelectionIndicator?: boolean;
    singleLine?: boolean;
}) {
    const isSelected = showSelectionIndicator && isActive;
    const labelLayoutClassName = showSelectionIndicator && !singleLine
        ? "min-w-0 flex-1 break-words whitespace-normal"
        : "min-w-0 flex-1 truncate";

    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            aria-pressed={showSelectionIndicator ? isActive : undefined}
            className={`flex ${singleLine ? "h-11" : "min-h-11"} w-full min-w-0 items-center gap-[11px] overflow-hidden border-t px-[18px] py-3 text-left transition-[background-color,border-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-50 ${isSelected ? "border-accent/30 bg-accent/10" : "border-border bg-card"}`}
        >
            <span className={`${labelLayoutClassName} font-mono text-[12.5px] ${isActive ? `${isSelected ? "font-semibold " : ""}text-foreground` : "text-muted-foreground"}`}>{label}</span>
            {meta}
            {showSelectionIndicator && (isActive
                ? <Check className="size-4 shrink-0 text-accent" aria-hidden="true" />
                : <span className="size-1.5 shrink-0 rounded-full bg-muted-foreground/25" aria-hidden="true" />)}
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

export const MODEL_SHEET_CONTENT_CLASS =
    `${SHEET_CONTENT_CLASS} overflow-hidden data-[vaul-drawer-direction=bottom]:max-h-[min(80dvh,28rem)]`;

export function RecentDirectoryList({
    directories,
    selectedDirectory,
    activePath,
    error,
    isLoading,
    isBrowseDisabled,
    browseRef,
    onSelect,
    onRetry,
    onBrowse,
}: {
    directories: RecentDirectory[] | null;
    selectedDirectory?: { canonicalPath: string; displayPath: string } | null;
    activePath: string;
    error: string | null;
    isLoading: boolean;
    isBrowseDisabled: boolean;
    browseRef?: React.RefObject<HTMLButtonElement | null>;
    onSelect: (directory: { canonicalPath: string; displayPath: string }) => void;
    onRetry: () => void;
    onBrowse: () => void;
}) {
    const hasSelectedDirectory = selectedDirectory !== null && selectedDirectory !== undefined;
    const hasRecentDirectories = directories !== null && directories.length > 0;

    return (
        <div className="overflow-hidden rounded-xl border border-border">
            {hasSelectedDirectory && (
                <button
                    type="button"
                    onClick={() => onSelect(selectedDirectory)}
                    className="flex min-h-11 w-full min-w-0 items-center gap-2.5 overflow-hidden bg-secondary px-3.5 py-3 text-left font-mono text-[12.5px]"
                >
                    <FolderOpen className="size-3.5 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1 truncate">{selectedDirectory.displayPath}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{t("new.dirSelected")}</span>
                </button>
            )}
            {isLoading && (
                <div role="status" aria-live="polite" className={`flex min-h-11 items-center gap-2 border-t border-border px-3.5 py-3 font-mono text-[11.5px] text-muted-foreground motion-reduce:transition-opacity motion-reduce:duration-[120ms] ${hasSelectedDirectory ? "" : "border-t-0"}`}>
                    <Loader2 className="size-3.5 animate-spin" />
                    {t("new.dirLoading")}
                </div>
            )}
            {!isLoading && error !== null && (
                <div role="alert" aria-live="assertive" className={`flex min-h-11 items-center gap-2 border-t border-border px-3.5 py-2.5 font-mono text-[11.5px] text-destructive motion-reduce:transition-opacity motion-reduce:duration-[120ms] ${hasSelectedDirectory ? "" : "border-t-0"}`}>
                    <span className="min-w-0 flex-1 break-words">{error}</span>
                    <button
                        type="button"
                        onClick={onRetry}
                        className="min-h-11 shrink-0 rounded-[9px] border border-border px-3 text-[11px] text-foreground transition-[background-color,border-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] motion-reduce:active:scale-100"
                    >
                        {t("new.dirRetry")}
                    </button>
                </div>
            )}
            {!isLoading && error === null && directories !== null && !hasRecentDirectories && (
                <div className={`min-h-11 border-t border-border px-3.5 py-3 font-mono text-[11.5px] text-muted-foreground motion-reduce:transition-opacity motion-reduce:duration-[120ms] ${hasSelectedDirectory ? "" : "border-t-0"}`}>
                    {t("new.dirRecentEmpty")}
                </div>
            )}
            {!isLoading && error === null && directories?.map((directory, index) => {
                const isActive = activePath === directory.canonicalPath;
                return (
                    <button
                        key={directory.canonicalPath}
                        type="button"
                        onClick={() => onSelect(directory)}
                        className={`flex min-h-11 w-full min-w-0 items-center gap-2.5 overflow-hidden px-3.5 py-3 text-left font-mono text-[12.5px] transition-[background-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] motion-reduce:active:scale-100 ${(index > 0 || hasSelectedDirectory || directories.length > 0) ? "border-t border-border " : ""}${isActive ? "bg-secondary" : "bg-card text-muted-foreground"}`}
                    >
                        <Folder className={`size-3.5 shrink-0 ${isActive ? "text-accent" : "text-muted-foreground/40"}`} />
                        <span className="min-w-0 flex-1 truncate">{directory.displayPath}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{formatRelativeTime(directory.lastUsedAt)}</span>
                    </button>
                );
            })}
            <button
                type="button"
                ref={browseRef}
                onClick={onBrowse}
                disabled={isBrowseDisabled}
                className={`flex min-h-11 w-full items-center gap-2.5 bg-card px-3.5 py-3 font-mono text-[12.5px] text-muted-foreground transition-[background-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] motion-reduce:active:scale-100 disabled:opacity-50 ${(hasSelectedDirectory || hasRecentDirectories || isLoading || error !== null) ? "border-t border-border" : ""}`}
            >
                <FolderOpen className="size-3.5 shrink-0" />
                {t("new.dirBrowse")}
            </button>
        </div>
    );
}

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
                                className="min-h-11 rounded-[9px] border border-border px-3 font-mono text-[11.5px] transition-[background-color,border-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96]"
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
                        {[...items]
                            .sort((left, right) => right.lastModified - left.lastModified || left.sessionId.localeCompare(right.sessionId))
                            .map((item, index) => {
                                const primaryLabel = getResumePrimaryLabel(item, agent);
                                const preview = getResumePreview(item);
                                return (
                                    <button
                                        key={item.sessionId}
                                        type="button"
                                        onClick={() => onResume(item)}
                                        disabled={isResuming}
                                        className={`flex min-h-11 w-full min-w-0 items-start gap-2.5 overflow-hidden border-t px-[18px] py-3 text-left transition-[background-color,border-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-50 ${index === 0 ? "border-accent/30 bg-accent/10" : "border-border bg-card"}`}
                                    >
                                        <RotateCcw className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                                        <span className="min-w-0 flex-1">
                                            <span
                                                className="line-clamp-2 min-w-0 overflow-hidden break-words font-mono text-[12.5px] font-semibold leading-snug text-foreground"
                                                title={primaryLabel}
                                                aria-label={primaryLabel}
                                            >
                                                {primaryLabel}
                                            </span>
                                            {preview !== null && (
                                                <span
                                                    className="line-clamp-2 mt-1 min-w-0 overflow-hidden break-words font-mono text-[11px] leading-snug text-muted-foreground"
                                                    title={preview}
                                                    aria-label={preview}
                                                >
                                                    {preview}
                                                </span>
                                            )}
                                            {item.projectPath.trim() !== "" && (
                                                <span
                                                    className="line-clamp-2 mt-1 min-w-0 overflow-hidden break-all font-mono text-[10px] leading-snug text-muted-foreground"
                                                    title={item.projectPath}
                                                    aria-label={item.projectPath}
                                                >
                                                    {item.projectPath}
                                                </span>
                                            )}
                                        </span>
                                        <span className="flex max-w-[30%] shrink-0 flex-col items-end font-mono text-[10px] text-muted-foreground/70">
                                            <span className="max-w-full truncate" title={item.sessionId} aria-label={item.sessionId}>{getShortResumeId(item.sessionId)}</span>
                                            <span className="whitespace-nowrap">{formatRelativeTime(item.lastModified)}</span>
                                        </span>
                                    </button>
                                );
                            })}
                    </>
                )}
            </div>
        </div>
    );
}

export function NewSessionPage() {
    const navigate = useNavigate();
    const location = useLocation();
    const navigationState = parseNewSessionNavigationState(location.state);

    const machines = useMachines();

    const [cursorResumePreset, setCursorResumePreset] = React.useState<CursorResumeNavigationPreset | null>(
        () => navigationState.cursorResume ?? null,
    );
    const [machineId, setMachineId] = React.useState<string | null>(
        () => navigationState.cursorResume?.machineId ?? null,
    );
    const [agent, setAgent] = React.useState<AgentId>(
        () => navigationState.cursorResume ? "cursor" : DEFAULT_NEW_SESSION_AGENT,
    );
    const [model, setModel] = React.useState(DEFAULT_MODEL_ID);
    const [hasExplicitModelSelection, setHasExplicitModelSelection] = React.useState(false);
    const [mode, setMode] = React.useState<PermissionMode>(() => getDefaultPermissionMode(DEFAULT_NEW_SESSION_AGENT));
    const [codexCapabilities, setCodexCapabilities] = React.useState<CodexCapabilitiesSnapshot | null>(null);
    const [codexModelId, setCodexModelId] = React.useState<string | null>(null);
    const [codexExecution, setCodexExecution] = React.useState<CodexExecutionConfig | null>(null);
    const [isCodexCapabilitiesLoading, setIsCodexCapabilitiesLoading] = React.useState(false);
    const [codexCapabilitiesReloadKey, setCodexCapabilitiesReloadKey] = React.useState(0);
    const [cursorCapabilities, setCursorCapabilities] = React.useState<CursorCapabilitiesSnapshot | null>(null);
    const [cursorModelId, setCursorModelId] = React.useState<string | null>(null);
    const [cursorExecution, setCursorExecution] = React.useState<CursorExecutionConfig | null>(null);
    const [cursorLaunchControls, setCursorLaunchControls] = React.useState<CursorLaunchControls>(() => ({
        ...DEFAULT_CURSOR_LAUNCH_CONTROLS,
    }));
    const [isCursorCapabilitiesLoading, setIsCursorCapabilitiesLoading] = React.useState(false);
    const [cursorCapabilitiesReloadKey, setCursorCapabilitiesReloadKey] = React.useState(0);
    const [dir, setDir] = React.useState<string | null>(() => navigationState.cursorResume?.directory ?? null);
    const [dirDisplayPath, setDirDisplayPath] = React.useState<string | null>(null);
    const [recentDirectories, setRecentDirectories] = React.useState<RecentDirectory[] | null>(null);
    const [recentDirectoriesError, setRecentDirectoriesError] = React.useState<string | null>(null);
    const [recentDirectoriesReloadKey, setRecentDirectoriesReloadKey] = React.useState(0);
    const [directoryRequestPath, setDirectoryRequestPath] = React.useState<string | undefined>(undefined);
    const [directoryListing, setDirectoryListing] = React.useState<DirectoryListing | null>(null);
    const [directoryError, setDirectoryError] = React.useState<string | null>(null);
    const [directoryBackTarget, setDirectoryBackTarget] = React.useState<DirectoryBackTarget | null>(null);
    const [directoryReloadKey, setDirectoryReloadKey] = React.useState(0);
    const [isDirectoryLoading, setIsDirectoryLoading] = React.useState(false);
    const [sheet, setSheet] = React.useState<SheetState | null>(null);
    const sheetGenerationRef = React.useRef(0);
    const directoryTriggerRef = React.useRef<HTMLButtonElement>(null);
    const sheetFocusTargetRef = React.useRef<SheetFocusTarget | null>(null);
    const [isSpawning, setIsSpawning] = React.useState(false);
    const [isApprovingDirectory, setIsApprovingDirectory] = React.useState(false);
    const [pendingDirectoryCreation, setPendingDirectoryCreation] = React.useState<PendingDirectoryCreation | null>(null);
    const [resumeItems, setResumeItems] = React.useState<AgentSessionInfo[] | null>(null);
    const [resumeError, setResumeError] = React.useState<string | null>(null);
    const [resumeRetryItem, setResumeRetryItem] = React.useState<ResumeTarget | null>(null);
    const [resumeReloadKey, setResumeReloadKey] = React.useState(0);

    const selectedMachine = machines.find((m) => m.id === machineId) ?? null;
    // A Cursor resume preset must never silently fall back to another machine.
    const machine = selectedMachine ?? (cursorResumePreset ? null : machines[0] ?? null);
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
    const activeModeLabel = agent === "cursor"
        ? cursorExecutionModeLabel(cursorLaunchControls.executionMode)
        : getAgentPermissionLabel(agent, mode);
    const cursorLaunchControlsSummary = agent === "cursor"
        ? getCursorLaunchControlsSummary(cursorLaunchControls)
        : null;
    const selectedCodexModel = findCodexModel(codexCapabilities, codexModelId);
    const selectedCursorModel = findCursorModel(cursorCapabilities, cursorModelId);
    const activeModelLabel = agent === "codex"
        ? selectedCodexModel?.displayName ?? t("new.capabilitiesLoading")
        : agent === "cursor"
            ? selectedCursorModel?.displayName ?? t("new.capabilitiesLoading")
            : model;
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
    const isCursorCatalogReady = agent === "cursor"
        && cursorCapabilities?.status === "ready"
        && selectedCursorModel !== null;
    const isCursorCapabilityReady = isCursorCatalogReady
        && cursorExecution !== null
        && cursorExecution.catalogVersion === cursorCapabilities.catalogVersion
        && cursorExecution.model === selectedCursorModel?.id
        && (!cursorResumePreset || cursorExecution.model === cursorResumePreset.cursorModel);
    const isCursorCapabilityUnavailable = agent === "cursor"
        && !isCursorCapabilitiesLoading
        && (!cursorCapabilities || cursorCapabilities.status === "unavailable" || selectedCursorModel === null);
    const isCapabilityDrivenAgent = agent === "codex" || agent === "cursor";
    const isActiveCapabilitiesLoading = agent === "codex"
        ? isCodexCapabilitiesLoading
        : agent === "cursor"
            ? isCursorCapabilitiesLoading
            : false;
    const isActiveCapabilityUnavailable = agent === "codex"
        ? isCodexCapabilityUnavailable
        : agent === "cursor"
            ? isCursorCapabilityUnavailable
            : false;
    const isActiveCapabilityCatalogReady = agent === "codex"
        ? isCodexCatalogReady
        : agent === "cursor"
            ? isCursorCatalogReady
            : true;
    const reasoningControlState = getReasoningControlState({
        agent,
        isLoading: isCodexCapabilitiesLoading,
        capabilities: codexCapabilities,
        selectedModel: selectedCodexModel,
        hasReasoningSelection: hasCodexReasoningSelection,
    });

    const activeDir = dir ?? recentDirectories?.[0]?.canonicalPath ?? homeDir ?? "";
    const activeDirDisplayPath = dir
        ? (dirDisplayPath ?? dir)
        : (recentDirectories?.[0]?.displayPath ?? homeDir ?? "");
    const isResumePresetCompatible = isCursorResumePresetCompatible(cursorResumePreset, machine?.id, activeDir);
    const cursorResumeTarget: ResumeTarget | undefined = cursorResumePreset
        ? {
            agent: "cursor",
            projectPath: cursorResumePreset.directory,
            sessionId: cursorResumePreset.resumeSessionId,
            sessionName: cursorResumePreset.resumeSessionName,
        }
        : undefined;
    const cursorResumePrimaryLabel = cursorResumePreset
        ? getResumePrimaryLabel({
            sessionId: cursorResumePreset.resumeSessionId,
            sessionName: cursorResumePreset.resumeSessionName,
            firstMessage: null,
        }, "cursor")
        : null;
    const hasActiveDirInRecent = recentDirectories?.some((directory) => directory.canonicalPath === activeDir) ?? false;
    const isRecentDirectoriesLoaded = recentDirectories !== null || recentDirectoriesError !== null;
    const shouldShowSelectedDir = isRecentDirectoriesLoaded && activeDir !== "" && !hasActiveDirInRecent;
    const directoryHeaderPath = directoryListing?.path ?? directoryRequestPath ?? activeDir;
    const directoryHeaderDisplayPath = directoryListing?.displayPath
        ?? (directoryHeaderPath === activeDir
            ? activeDirDisplayPath
            : directoryHeaderPath);
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

    // Cursor exposes the account-visible model list through its native CLI.
    // The page keeps only the daemon-normalized snapshot and sends that exact
    // model/catalog pair atomically with spawn.
    React.useEffect(() => {
        if (agent !== "cursor" || !activeMachineId) {
            setIsCursorCapabilitiesLoading(false);
            return;
        }
        let isStale = false;
        setIsCursorCapabilitiesLoading(true);
        setCursorCapabilities(null);
        setCursorModelId(null);
        setCursorExecution(null);
        void machineGetCursorCapabilities(
            activeMachineId,
            cursorCapabilitiesReloadKey > 0 || cursorResumePreset !== null,
        )
            .then((capabilities) => {
                if (isStale) return;
                setCursorCapabilities(capabilities);
                if (capabilities.status !== "ready") return;
                const selectedModel = cursorResumePreset
                    ? capabilities.models.find((item) => item.id === cursorResumePreset.cursorModel) ?? null
                    : capabilities.models.find((item) => item.isDefault) ?? null;
                setCursorModelId(selectedModel?.id ?? null);
                setCursorExecution(selectedModel ? createCursorExecutionForModel(capabilities, selectedModel.id) : null);
            })
            .catch(() => {
                if (!isStale) setCursorCapabilities(null);
            })
            .finally(() => {
                if (!isStale) setIsCursorCapabilitiesLoading(false);
            });
        return () => { isStale = true; };
    }, [activeMachineId, agent, cursorCapabilitiesReloadKey, cursorResumePreset]);

    // Recent directories are daemon-owned machine state, never session metadata.
    React.useEffect(() => {
        if (!activeMachineId) {
            setRecentDirectories(null);
            setRecentDirectoriesError(null);
            return;
        }
        let isStale = false;
        setRecentDirectories(null);
        setRecentDirectoriesError(null);
        void machineListRecentDirectories(activeMachineId)
            .then((directories) => {
                if (!isStale) setRecentDirectories(directories);
            })
            .catch((error: unknown) => {
                if (isStale) return;
                setRecentDirectoriesError(formatRecentDirectoriesError(error));
            });
        return () => { isStale = true; };
    }, [activeMachineId, recentDirectoriesReloadKey]);

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
        if (!isNewSessionAgentAvailable(id)) return;
        if (id !== "cursor") setCursorResumePreset(null);
        setAgent(id);
        const nextModel = AGENT_OPTIONS.find((a) => a.id === id)?.models[0];
        if (nextModel) setModel(nextModel);
        setHasExplicitModelSelection(false);
        if (id !== "codex") setCodexModelId(null);
        if (id !== "codex") {
            setCodexExecution(null);
        }
        if (id !== "cursor") setCursorModelId(null);
        if (id !== "cursor") {
            setCursorExecution(null);
        }
        setCursorLaunchControls({ ...DEFAULT_CURSOR_LAUNCH_CONTROLS });
        if (id !== "cursor") {
            setMode(getDefaultPermissionMode(id));
        }
    };

    const selectDir = (path: string, displayPath?: string) => {
        if (cursorResumePreset && path !== cursorResumePreset.directory) setCursorResumePreset(null);
        setDir(path);
        setDirDisplayPath(displayPath ?? null);
    };

    const openSheet = (kind: SheetKind, trigger: HTMLButtonElement | null = null) => {
        const generation = sheetGenerationRef.current + 1;
        sheetGenerationRef.current = generation;
        sheetFocusTargetRef.current = trigger ? { generation, trigger } : null;
        setSheet({ kind, generation });
    };

    const retryActiveCapabilities = () => {
        if (agent === "codex") {
            setCodexCapabilitiesReloadKey((value) => value + 1);
            return;
        }
        if (agent === "cursor") {
            setCursorCapabilitiesReloadKey((value) => value + 1);
        }
    };

    const openDirectoryPicker = () => {
        setDirectoryRequestPath(activeDir || homeDir || undefined);
        setDirectoryListing(null);
        setDirectoryError(null);
        setDirectoryBackTarget(null);
        openSheet("directory", directoryTriggerRef.current);
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

    const finishSpawn = async (sessionId: string, resume?: ResumeTarget) => {
        // ждём появления сессии в сторе (нужен cipher для первого сообщения)
        for (let attempt = 0; attempt < 10 && !useProtocolStore.getState().sessions[sessionId]; attempt++) {
            await refreshSessions().catch(() => undefined);
            if (useProtocolStore.getState().sessions[sessionId]) break;
            await new Promise((resolve) => setTimeout(resolve, 400));
        }

        if (navigationState.zenTaskId) linkZenTaskSession(navigationState.zenTaskId, sessionId);
        const permissionMode = agent === "cursor"
            ? undefined
            : normalizeAgentPermissionMode(agent, mode);
        const modelState = agent === "codex" || agent === "cursor"
            ? {}
            : modelOverrideState(model, hasExplicitModelSelection);
        if (navigationState.zenTaskTitle && !resume) {
            await sendSessionMessage(sessionId, navigationState.zenTaskTitle, {
                ...(permissionMode ? { permissionMode } : {}),
                ...modelState,
            })
                .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)));
        }
        navigate(`/session/${sessionId}`, {
            replace: true,
            state: {
                ...(permissionMode ? { permissionMode } : {}),
                ...modelState,
            },
        });
    };

    const handleSpawnResult = async (
        result: SpawnSessionResult,
        options: SpawnSessionOptions,
        resume?: ResumeTarget,
        isNavigationResume = false,
    ) => {
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
            if (isCursorCapabilityRejection(result, options.agent ?? "claude")) {
                setCursorCapabilities(null);
                setCursorModelId(null);
                setCursorExecution(null);
                setIsCursorCapabilitiesLoading(true);
                setCursorCapabilitiesReloadKey((value) => value + 1);
            }
            if (resume && !isNavigationResume) {
                setResumeError(result.errorMessage);
                setResumeRetryItem(resume);
                return;
            }
            toast.error(result.errorMessage);
            return;
        }
        try {
            const refreshedDirectories = await machineListRecentDirectories(options.machineId);
            setRecentDirectories(refreshedDirectories);
            setRecentDirectoriesError(null);
        } catch (error: unknown) {
            setRecentDirectoriesError(formatRecentDirectoriesError(error));
        }
        if (result.terminal?.type === "unavailable") {
            toast.warning(t("new.terminalUnavailable"));
        }
        await finishSpawn(result.sessionId, resume);
    };

    const spawn = async (resume?: ResumeTarget) => {
        if (!machine || isSpawning) return;
        const selectedResume = resume ?? cursorResumeTarget;
        const isNavigationResume = resume === undefined && cursorResumeTarget !== undefined;
        if (!resume && cursorResumePreset && !isResumePresetCompatible) return;
        const directory = getResumeDirectory(selectedResume?.projectPath, activeDir);
        if (directory === "") {
            openDirectoryPicker();
            return;
        }
        const spawnAgent = selectedResume?.agent ?? agent;
        if (!isNewSessionAgentAvailable(spawnAgent)) {
            toast.error(t("new.capabilitiesUnavailable"));
            return;
        }
        const permissionMode = spawnAgent === "cursor"
            ? undefined
            : normalizeAgentPermissionMode(spawnAgent, mode);
        if (spawnAgent === "codex" && !isCodexCapabilityReady) {
            toast.error(t("new.capabilitiesUnavailable"));
            return;
        }
        if (spawnAgent === "cursor" && !isCursorCapabilityReady) {
            toast.error(t("new.capabilitiesUnavailable"));
            return;
        }
        if (selectedResume) {
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
                cursorExecution,
                cursorLaunchControls,
                resume: selectedResume,
            });
            const result = await machineSpawnNewSession(options);
            await handleSpawnResult(result, options, selectedResume, isNavigationResume);
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
        : sheetKind === "model"
            ? MODEL_SHEET_CONTENT_CLASS
        : sheetKind === "resume"
            ? RESUME_SHEET_CONTENT_CLASS
            : SHEET_CONTENT_CLASS;

    return (
        <div className="flex h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
            <header className="flex items-center px-5 pb-3 pt-1.5">
                <h1 className="text-xl font-semibold">{t("new.title")}</h1>
                <button aria-label={t("new.close")} onClick={() => navigate(-1)}
                    className="ml-auto flex size-11 items-center justify-center rounded-[10px] border border-border transition-[background-color,border-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96]">
                    <X className="size-4 text-muted-foreground" />
                </button>
            </header>

            <main className="flex min-h-0 flex-1 flex-col gap-4.5 overflow-y-auto px-5 [&>*]:shrink-0">
                {/* машина */}
                <button onClick={(event) => openSheet("machine", event?.currentTarget ?? null)} disabled={machines.length === 0}
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
                            <button key={a.id} onClick={() => selectAgent(a.id)} disabled={!a.isAvailable}
                                aria-pressed={agent === a.id}
                                aria-describedby={!a.isAvailable ? "deferred-provider-note" : undefined}
                                data-provider-availability={a.isAvailable ? "available" : "deferred"}
                                className={`flex items-center gap-2.5 rounded-xl border bg-card p-3 text-left transition-[border-color,box-shadow,opacity,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100 ${agent === a.id ? "border-accent ring-[3px] ring-accent/10" : "border-border"}`}>
                                <AgentIcon agent={a.id} className="size-[30px] rounded-lg text-[11px]" />
                                <span className="flex flex-col">
                                    <span className="text-[13px] font-semibold">{a.name}</span>
                                    <span className="font-mono text-[9.5px] text-muted-foreground">{a.kind}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                    <p id="deferred-provider-note" className="font-mono text-[10px] leading-snug text-muted-foreground">
                        {t("new.deferredProviders")}
                    </p>
                </section>

                {/* capability controls: model, permissions, reasoning */}
                <section className="flex min-w-0 flex-col gap-2" aria-label={t("new.model")}>
                    <div
                        data-capability-layout="two-row"
                        className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] gap-2"
                    >
                        <section data-capability-control="model" className="flex min-w-0 flex-col gap-2">
                            <span className="flex min-h-[22px] items-end font-mono text-[10px] text-muted-foreground">{t("new.model")}</span>
                            {isActiveCapabilitiesLoading ? (
                                <div aria-busy="true" className="flex min-h-11 min-w-0 items-center gap-1.5 rounded-[10px] border border-input bg-muted px-2.5 font-mono text-[11px] text-muted-foreground">
                                    <Loader2 className="size-3 shrink-0 animate-spin" />
                                    <span className="min-w-0 truncate">{t("new.capabilitiesLoading")}</span>
                                </div>
                            ) : isActiveCapabilityUnavailable ? (
                                <button type="button" onClick={retryActiveCapabilities}
                                    className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-destructive/40 bg-destructive/[0.06] px-2.5 font-mono text-[11px] text-destructive transition-[border-color,background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96]">
                                    <span className="min-w-0 truncate">{t("new.capabilitiesRetry")}</span>
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={(event) => openSheet("model", event?.currentTarget ?? null)}
                                    disabled={(isCapabilityDrivenAgent && !isActiveCapabilityCatalogReady) || cursorResumePreset !== null}
                                    aria-label={`${t("new.model")}: ${activeModelLabel}`}
                                    aria-haspopup="dialog"
                                    aria-expanded={sheetKind === "model"}
                                    aria-controls="new-session-sheet"
                                    className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-input bg-muted px-2.5 font-mono text-[11px] transition-[background-color,border-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] disabled:opacity-50">
                                    <span className="min-w-0 truncate">{activeModelLabel}</span>
                                    <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
                                </button>
                            )}
                        </section>
                        <section data-capability-control="permission" className="flex min-w-0 flex-col gap-2">
                            <span className="flex min-h-[22px] items-end font-mono text-[10px] text-muted-foreground">{t(getPrimarySelectorLabelKey(agent))}</span>
                            <button
                                type="button"
                                onClick={(event) => openSheet("permission", event?.currentTarget ?? null)}
                                disabled={(agent === "codex" && codexCapabilities?.status !== "ready") || (agent === "cursor" && cursorCapabilities?.status !== "ready")}
                                aria-label={`${t(getPrimarySelectorLabelKey(agent))}: ${activeModeLabel}`}
                                aria-haspopup="dialog"
                                aria-expanded={sheetKind === "permission"}
                                aria-controls="new-session-sheet"
                                className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-input bg-muted px-2.5 font-mono text-[11px] transition-[background-color,border-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] disabled:opacity-50">
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
                                <button type="button" onClick={retryActiveCapabilities}
                                    className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-destructive/40 bg-destructive/[0.06] px-2.5 font-mono text-[11px] text-destructive transition-[border-color,background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96]">
                                    <span className="min-w-0 truncate">{t("new.capabilitiesRetry")}</span>
                                </button>
                            ) : reasoningControlState === "no-options" ? (
                                <div role="status" className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-dashed border-border bg-card px-2.5 font-mono text-[11px] text-muted-foreground">
                                    <span className="min-w-0 truncate">{t("new.reasoningNoOptions")}</span>
                                </div>
                            ) : reasoningControlState === "choose-required" ? (
                                <button
                                    type="button"
                                    onClick={(event) => openSheet("reasoning", event?.currentTarget ?? null)}
                                    aria-label={`${t("new.reasoning")}: ${t("new.reasoningChoose")}`}
                                    aria-haspopup="dialog"
                                    aria-expanded={sheetKind === "reasoning"}
                                    aria-controls="new-session-sheet"
                                    className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-input bg-muted px-2.5 font-mono text-[11px] transition-[background-color,border-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96]">
                                    <span className="min-w-0 truncate">{t("new.reasoningChoose")}</span>
                                    <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    onClick={(event) => openSheet("reasoning", event?.currentTarget ?? null)}
                                    disabled={reasoningControlState !== "ready"}
                                    aria-label={`${t("new.reasoning")}: ${codexExecution?.reasoningEffort ?? ""}`}
                                    aria-haspopup="dialog"
                                    aria-expanded={sheetKind === "reasoning"}
                                    aria-controls="new-session-sheet"
                                    className="flex min-h-11 min-w-0 items-center rounded-[10px] border border-input bg-muted px-2.5 font-mono text-[11px] transition-[background-color,border-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] disabled:opacity-50">
                                    <span className="min-w-0 truncate">{codexExecution?.reasoningEffort}</span>
                                    <ChevronDown className="ml-auto size-3 shrink-0 text-muted-foreground" />
                                </button>
                            )}
                        </section>
                    </div>
                    {agent === "cursor" && (
                        <button
                            type="button"
                            onClick={(event) => openSheet("cursor-launch", event?.currentTarget ?? null)}
                            aria-haspopup="dialog"
                            aria-expanded={sheetKind === "cursor-launch"}
                            aria-controls="new-session-sheet"
                            aria-label={`${t("new.cursorAdvanced")}${cursorLaunchControlsSummary ? ` · ${cursorLaunchControlsSummary}` : ""}`}
                            className={`inline-flex min-h-11 max-w-full self-start items-center gap-1.5 rounded-[10px] border px-2.5 font-mono text-[11px] transition-[border-color,background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] ${cursorLaunchControlsSummary ? "border-accent/40 bg-accent/[0.06] text-foreground" : "border-border bg-card text-muted-foreground"}`}
                        >
                            <SlidersHorizontal className="size-3 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 truncate">
                                {t("new.cursorAdvanced")}{cursorLaunchControlsSummary ? ` · ${cursorLaunchControlsSummary}` : ""}
                            </span>
                        </button>
                    )}
                </section>

                {/* директория — недавние quick picks + browser/picker через RPC list-directory */}
                <section className="flex flex-col gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground">{t("new.dirRecent")}</span>
                    <RecentDirectoryList
                        directories={recentDirectories}
                        selectedDirectory={shouldShowSelectedDir ? { canonicalPath: activeDir, displayPath: activeDirDisplayPath } : null}
                        activePath={activeDir}
                        error={recentDirectoriesError}
                        isLoading={recentDirectories === null && recentDirectoriesError === null}
                        isBrowseDisabled={!machine}
                        browseRef={directoryTriggerRef}
                        onSelect={(directory) => selectDir(directory.canonicalPath, directory.displayPath)}
                        onRetry={() => setRecentDirectoriesReloadKey((value) => value + 1)}
                        onBrowse={openDirectoryPicker}
                    />
                </section>

                {cursorResumePreset && (
                    <section role="status" className="flex min-w-0 flex-col gap-1 rounded-xl border border-accent/30 bg-accent/[0.06] px-3.5 py-3 font-mono text-[11.5px]">
                        <span className="font-semibold text-foreground">{t("new.resumeTitle")} · Cursor</span>
                        <span className="min-w-0 truncate text-foreground">
                            {cursorResumePrimaryLabel}
                        </span>
                        <code className="break-all text-[10px] text-muted-foreground">{getShortResumeId(cursorResumePreset.resumeSessionId)}</code>
                        {cursorCapabilities?.status === "ready" && selectedCursorModel === null && !isCursorCapabilitiesLoading && (
                            <span role="alert" className="mt-1 text-destructive">{t("chat.resumeConfigurationUnavailable")}</span>
                        )}
                        {!isResumePresetCompatible && (
                            <span role="alert" className="mt-1 text-destructive">{t("new.resumePresetMismatch")}</span>
                        )}
                    </section>
                )}

                {/* промпт из задачи Zen — уйдёт первым сообщением после запуска */}
                {navigationState.zenTaskTitle && (
                    <section className="flex flex-col gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground">{t("new.promptLabel")}</span>
                        <div className="rounded-xl border border-border bg-card px-3.5 py-3 text-[13px] leading-snug">
                            {navigationState.zenTaskTitle}
                        </div>
                    </section>
                )}

                {/* resume: bottom-sheet со списком прошлых сессий агента (RPC list-agent-sessions) */}
                <button onClick={(event) => openSheet("resume", event?.currentTarget ?? null)} disabled={!machine || (agent === "codex" && !isCodexCapabilityReady) || (agent === "cursor" && !isCursorCapabilityReady)}
                    className="flex h-11 items-center justify-center gap-2 rounded-[10px] border border-dashed border-border font-mono text-[11.5px] text-muted-foreground transition-[background-color,border-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96]">
                    <RotateCcw className="size-3" /> {t("new.resume", { agent })}
                </button>
            </main>

            <footer className="px-5 pb-[max(14px,env(safe-area-inset-bottom))] pt-3">
                <button onClick={() => void spawn()} disabled={!machine || activeDir === "" || isSpawning || !isResumePresetCompatible || (agent === "codex" && !isCodexCapabilityReady) || (agent === "cursor" && !isCursorCapabilityReady)}
                    className="h-[52px] w-full overflow-hidden rounded-xl bg-accent px-3 text-base font-semibold text-accent-foreground disabled:opacity-50">
                    {isSpawning
                        ? t("new.spawning")
                        : <span className="block truncate whitespace-nowrap">{cursorResumePreset
                            ? `${t("new.resumeTitle")} · ${cursorResumePrimaryLabel}`
                            : t("new.startButton", { agent, dir: activeDirDisplayPath || "…" })}</span>}
                </button>
            </footer>

            <Drawer
                key={drawerInstanceKey}
                open={sheet !== null}
                onOpenChange={(isOpen) => {
                    setSheet((currentSheet) => resolveSheetOpenChange(sheet, currentSheet, isOpen));
                }}
            >
                <DrawerContent
                    id="new-session-sheet"
                    className={drawerContentClassName}
                    onOpenAutoFocus={(event) => {
                        event.preventDefault();
                        const content = event.currentTarget;
                        if (content instanceof HTMLElement) {
                            const focusTarget = content.querySelector<HTMLButtonElement>("button:not([disabled])")
                                ?? content.querySelector<HTMLElement>("[tabindex=\"0\"]")
                                ?? content;
                            focusTarget.focus();
                        }
                    }}
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        const target = sheetFocusTargetRef.current;
                        if (!target || target.generation !== drawerInstanceKey || !target.trigger.isConnected) return;
                        sheetFocusTargetRef.current = null;
                        target.trigger.focus();
                    }}
                >
                    {sheetKind === "machine" && (
                        <>
                            <SheetHeader title={t("new.machineTitle")} tag={t("new.machine")} />
                            {machines.map((m) => (
                                <SheetRow key={m.id} isActive={m.id === machine?.id} label={machineName(m)} showSelectionIndicator
                                    meta={
                                        <>
                                            <StatusDot status={m.active ? "running" : "offline"} className="size-1.5" />
                                            <span className="font-mono text-[10px] text-muted-foreground">
                                                {m.active ? t("home.machine.online") : formatRelativeTime(m.activeAt)}
                                            </span>
                                        </>
                                    }
                                    onClick={() => {
                                        if (cursorResumePreset && m.id !== cursorResumePreset.machineId) {
                                            setCursorResumePreset(null);
                                        }
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
                            <div
                                role="region"
                                aria-label={`${t("new.modelTitle")} · ${agent}`}
                                aria-describedby="model-sheet-note"
                                data-scroll-contract="176px viewport · 44px rows"
                                className="h-[176px] max-h-[176px] min-h-0 shrink-0 overflow-x-hidden overflow-y-auto overscroll-contain"
                            >
                                {agent === "codex" && codexCapabilities?.status === "ready" && codexCapabilities.catalogVersion
                                    ? codexCapabilities.models.map((item) => (
                                        <SheetRow key={item.id} isActive={item.id === codexModelId} label={item.displayName} showSelectionIndicator singleLine
                                            onClick={() => {
                                                setCodexModelId(item.id);
                                                setCodexExecution(createCodexExecutionForModel(codexCapabilities, item.id));
                                                setSheet(null);
                                            }} />
                                    ))
                                    : agent === "cursor" && cursorCapabilities?.status === "ready" && cursorCapabilities.catalogVersion
                                        ? cursorCapabilities.models.map((item) => (
                                            <SheetRow key={item.id} isActive={item.id === cursorModelId} label={item.displayName} showSelectionIndicator singleLine
                                                onClick={() => {
                                                    setCursorModelId(item.id);
                                                    setCursorExecution(createCursorExecutionForModel(cursorCapabilities, item.id));
                                                    setSheet(null);
                                                }} />
                                        ))
                                    : agentModels.map((item) => (
                                        <SheetRow key={item} isActive={item === model} label={item} showSelectionIndicator singleLine
                                            onClick={() => {
                                                setModel(item);
                                                setHasExplicitModelSelection(true);
                                                setSheet(null);
                                            }} />
                                    ))}
                            </div>
                            <div id="model-sheet-note" className="shrink-0 border-t border-border bg-card px-[18px] py-3 font-mono text-[9.5px] leading-[1.4] text-muted-foreground">
                                {t("new.modelDrawerNote", { count: agent === "codex" ? codexCapabilities?.models.length ?? 0 : agent === "cursor" ? cursorCapabilities?.models.length ?? 0 : agentModels.length })}
                            </div>
                        </>
                    )}
                    {sheetKind === "permission" && (
                        <>
                            <SheetHeader title={t("new.accessLevel")} tag={agent} />
                            {agent === "cursor" ? (
                                (["agent", "plan", "ask"] as const).map((executionMode) => (
                                    <SheetRow
                                        key={executionMode}
                                        isActive={executionMode === cursorLaunchControls.executionMode}
                                        label={cursorExecutionModeLabel(executionMode)}
                                        showSelectionIndicator
                                        meta={executionMode === "agent"
                                            ? <span className="font-mono text-[10px] text-muted-foreground">{t("new.cursorModeAgentHint")}</span>
                                            : undefined}
                                        onClick={() => {
                                            setCursorLaunchControls((current) => ({ ...current, executionMode }));
                                            setSheet(null);
                                        }}
                                    />
                                ))
                            ) : agentPermissionModes.map((permission) => (
                                <SheetRow key={permission} isActive={permission === mode} label={getAgentPermissionLabel(agent, permission)} showSelectionIndicator
                                    onClick={() => { setMode(permission); setSheet(null); }} />
                            ))}
                        </>
                    )}
                    {sheetKind === "cursor-launch" && (
                        <>
                            <div id="cursor-launch-sheet">
                                <SheetHeader title={t("new.cursorAdvanced")} tag="cursor" />
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={cursorLaunchControls.force}
                                    onClick={() => setCursorLaunchControls((current) => ({ ...current, force: !current.force }))}
                                    className="flex min-h-11 w-full items-center gap-3 border-t border-border px-[18px] py-3 text-left transition-[background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96]"
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block font-mono text-[12.5px] text-foreground">{t("new.cursorForce")}</span>
                                        <span className="mt-0.5 block font-mono text-[9.5px] leading-[1.35] text-muted-foreground">--force</span>
                                    </span>
                                    <span aria-hidden="true" className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-[var(--dur-micro)] ease-[var(--ease-out)] ${cursorLaunchControls.force ? "bg-accent" : "bg-muted-foreground/30"}`}>
                                        <span className={`absolute top-1 size-4 rounded-full bg-card shadow-sm transition-transform duration-[var(--dur-micro)] ease-[var(--ease-out)] ${cursorLaunchControls.force ? "translate-x-6" : "translate-x-1"}`} />
                                    </span>
                                </button>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={cursorLaunchControls.autoReview}
                                    onClick={() => setCursorLaunchControls((current) => ({ ...current, autoReview: !current.autoReview }))}
                                    className="flex min-h-11 w-full items-center gap-3 border-t border-border px-[18px] py-3 text-left transition-[background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96]"
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block font-mono text-[12.5px] text-foreground">{t("new.cursorAutoReview")}</span>
                                        <span className="mt-0.5 block font-mono text-[9.5px] leading-[1.35] text-muted-foreground">--auto-review</span>
                                    </span>
                                    <span aria-hidden="true" className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-[var(--dur-micro)] ease-[var(--ease-out)] ${cursorLaunchControls.autoReview ? "bg-accent" : "bg-muted-foreground/30"}`}>
                                        <span className={`absolute top-1 size-4 rounded-full bg-card shadow-sm transition-transform duration-[var(--dur-micro)] ease-[var(--ease-out)] ${cursorLaunchControls.autoReview ? "translate-x-6" : "translate-x-1"}`} />
                                    </span>
                                </button>
                                <div className="border-t border-border px-[18px] pb-2 pt-3">
                                    <span className="font-mono text-[10px] font-semibold text-muted-foreground">{t("new.cursorSandbox")}</span>
                                </div>
                                {(["local-configuration", "enabled", "disabled"] as const).map((sandbox) => (
                                    <SheetRow
                                        key={sandbox}
                                        isActive={sandbox === cursorLaunchControls.sandbox}
                                        label={cursorSandboxLabel(sandbox)}
                                        showSelectionIndicator
                                        onClick={() => setCursorLaunchControls((current) => ({ ...current, sandbox }))}
                                    />
                                ))}
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={cursorLaunchControls.approveMcps}
                                    onClick={() => setCursorLaunchControls((current) => ({ ...current, approveMcps: !current.approveMcps }))}
                                    className="flex min-h-11 w-full items-center gap-3 border-t border-border px-[18px] py-3 text-left transition-[background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96]"
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block font-mono text-[12.5px] text-foreground">{t("new.cursorApproveMcps")}</span>
                                        <span className="mt-0.5 block font-mono text-[9.5px] leading-[1.35] text-muted-foreground">--approve-mcps</span>
                                    </span>
                                    <span aria-hidden="true" className={`relative h-6 w-11 shrink-0 rounded-full transition-colors duration-[var(--dur-micro)] ease-[var(--ease-out)] ${cursorLaunchControls.approveMcps ? "bg-accent" : "bg-muted-foreground/30"}`}>
                                        <span className={`absolute top-1 size-4 rounded-full bg-card shadow-sm transition-transform duration-[var(--dur-micro)] ease-[var(--ease-out)] ${cursorLaunchControls.approveMcps ? "translate-x-6" : "translate-x-1"}`} />
                                    </span>
                                </button>
                                <div className="border-t border-border px-[18px] py-3 font-mono text-[9.5px] leading-[1.45] text-muted-foreground">
                                    <span className="block">{t("new.cursorTrustFact")}</span>
                                    <span className="mt-1 block">{t("new.cursorHostControlledFact")}</span>
                                    <span className="mt-1 block">{t("new.cursorLocalRulesFact")}</span>
                                </div>
                            </div>
                        </>
                    )}
                    {sheetKind === "reasoning" && selectedCodexModel && selectedCodexModel.supportedReasoningEfforts.length > 0 && codexCapabilities?.catalogVersion && (
                        <>
                            <SheetHeader title={t("new.reasoningTitle")} tag={selectedCodexModel.displayName} />
                            {selectedCodexModel.supportedReasoningEfforts.map((reasoningEffort) => (
                                <SheetRow key={reasoningEffort} isActive={reasoningEffort === codexExecution?.reasoningEffort} label={reasoningEffort} showSelectionIndicator
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
                                    className="flex min-h-11 w-full items-center gap-3 px-[18px] py-3 text-left font-mono text-[12.5px] text-muted-foreground transition-[background-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] disabled:opacity-40"
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
                                            className="min-h-11 rounded-[9px] border border-border px-3 font-mono text-[11.5px] transition-[background-color,border-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96]"
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
                                        className={`flex min-h-11 w-full items-center gap-3 border-t border-border px-[18px] py-3 text-left font-mono text-[12.5px] transition-[background-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] ${entry.hidden ? "text-muted-foreground" : "text-foreground"}`}
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
                                    className="min-h-[52px] w-full rounded-xl bg-accent px-3 text-[14px] font-semibold text-accent-foreground transition-[background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] disabled:opacity-50"
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
                            className="h-11 w-full rounded-[9px] border border-border text-[13px] font-medium text-muted-foreground transition-[background-color,border-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] disabled:opacity-50 lg:h-10 lg:flex-1"
                        >
                            {t("common.cancel")}
                        </button>
                        <button
                            type="button"
                            disabled={isApprovingDirectory}
                            onClick={() => void approveDirectoryCreation()}
                            className="h-11 w-full rounded-[9px] bg-accent text-[13px] font-semibold text-accent-foreground transition-[background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] disabled:opacity-50 lg:h-10 lg:flex-1"
                        >
                            {isApprovingDirectory ? t("new.spawning") : t("common.create")}
                        </button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
