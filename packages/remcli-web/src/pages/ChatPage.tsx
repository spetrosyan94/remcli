// remcli-web — Чат сессии на живом P2P-протоколе (разметка — design/screens/chat.tsx, 1:1).
// Данные — @/lib/protocol: история через REST (loadSessionMessages, пагинация offset/limit)
// + live через socket (store), отправка — sendSessionMessage, permissions —
// session.agentState.requests + sessionAllow/Deny, TTS/диктовка — хуки @/lib/voice,
// resume завершённой сессии — provider-specific: Cursor через New Session,
// доступный provider через machineSpawnNewSession({resumeSessionId}), deferred provider блокируется до RPC.
import * as React from "react";
import { ArrowLeft, Check, ChevronDown, Loader2, Mic, MoreHorizontal, RefreshCw, Send, Square, Terminal } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import {
    AgentMeta, Caret, ConnectionBanner, DiffView, ListenButton, PermissionCard,
    Segmented, statusLabel, StatusDot, ThinkingRow, ToolCallCard, UserMessage, VoiceRecordBar,
    type AgentId, type DiffLine,
} from "@/components/kit";
import { SessionsSidebar, StopSessionDialog, type StopTarget } from "@/components/app/SessionsSidebar";
import { sessionStatus } from "@/components/app/sessionDisplay";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "@/components/ui/drawer";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { getAgentPermissionLabel, getAgentPermissionModes, normalizeAgentPermissionMode } from "@/lib/agentPermissions";
import { copyText } from "@/lib/clipboard";
import { createCodexExecutionForModel, getCodexResumeSelection } from "@/lib/codexCapabilities";
import { isProviderAvailable } from "@/lib/providerAvailability";
import { canStopSession, type IStopMachineTarget } from "@/lib/sessionCapabilities";
import { t } from "@/lib/i18n";
import {
    fetchWhisperStatus, getRestConfig, isClientStarted, loadSessionMessages,
    machineGetCodexCapabilities, machineGetCursorCapabilities, machineGetSessionExecution,
    machineSetSessionExecution, machineSpawnNewSession, refreshSessions, restoreProtocolClient, sendSessionMessage,
    sessionAllow, sessionDeny, useConnectionStatus, useMachines, useProtocolStore,
    useSession, useSessionMessages, useSessionMessagesLoaded, useSessions,
    type CodexCapabilitiesSnapshot, type CursorCapabilitiesSnapshot, type NormalizedMessage,
    type PermissionMode, type Session, type SessionExecutionSelection, type SessionExecutionSnapshot,
} from "@/lib/protocol";
import { onProtocolReconnected, type SessionMessagesPage } from "@/lib/protocol/client";
import { useVoiceRecorder } from "@/lib/voice/recorder";
import { useTts, useTtsAvailability } from "@/lib/voice/tts";

// Опасные команды (DESIGN.md): rm -rf, force-push, drop … — красный вариант PermissionCard
const DANGEROUS_COMMAND_RE = /\brm\s+-\w*[rf]|--force\b|force[- ]push|\bdrop\s+(table|database|schema)\b|\bmkfs\b|\bdd\s+if=/i;

const PERMISSION_SHEET_CONTENT_CLASS =
    "max-h-[80dvh] overflow-y-auto overscroll-contain data-[vaul-drawer-direction=bottom]:rounded-t-[20px] border-border bg-card pb-[max(10px,env(safe-area-inset-bottom))] " +
    "[&>div:first-child]:mt-2 [&>div:first-child]:mb-1 [&>div:first-child]:h-[4.5px] [&>div:first-child]:w-[38px] [&>div:first-child]:bg-muted-foreground/40";

const CODE_FENCE_PATTERN = /^```([^`]*)$/;
const HEADING_PATTERN = /^(#{1,6})\s+(.+)$/;
const UNORDERED_LIST_ITEM_PATTERN = /^\s*[-*+]\s+(.+)$/;
const ORDERED_LIST_ITEM_PATTERN = /^\s*(\d+)[.)]\s+(.+)$/;
const EXECUTION_MODEL_LIST_CLASS = "max-h-44 overflow-y-auto overscroll-contain";

type SessionExecutionLoadState = "idle" | "loading" | "ready" | "error";

function isSessionExecutionEqual(
    left: SessionExecutionSelection | undefined,
    right: SessionExecutionSelection | undefined,
): boolean {
    if (!left || !right || left.provider !== right.provider) return left === right;
    return left.model === right.model
        && left.catalogVersion === right.catalogVersion
        && (left.provider === "cursor"
            || left.reasoningEffort === (right.provider === "codex" ? right.reasoningEffort : undefined));
}

function compactExecutionModelLabel(displayName: string, modelId: string): string {
    const normalizedDisplayName = displayName.trim();
    if (normalizedDisplayName.length <= 24) return normalizedDisplayName;
    const normalizedModelId = modelId.trim();
    return normalizedModelId.length <= normalizedDisplayName.length
        ? normalizedModelId
        : normalizedDisplayName;
}

function executionSelectionLabel(
    selection: SessionExecutionSelection,
    codexCapabilities: CodexCapabilitiesSnapshot | null,
    cursorCapabilities: CursorCapabilitiesSnapshot | null,
    compact: boolean = false,
): string {
    const model = selection.provider === "codex"
        ? codexCapabilities?.models.find((item) => item.id === selection.model)
        : cursorCapabilities?.models.find((item) => item.id === selection.model);
    const displayName = model?.displayName ?? selection.model;
    const modelLabel = compact
        ? compactExecutionModelLabel(displayName, selection.model)
        : displayName;
    return selection.provider === "codex" && selection.reasoningEffort
        ? `${modelLabel} · ${selection.reasoningEffort}`
        : modelLabel;
}

// ─── Маппинг протокола на модель ленты ───────────────────────────

interface UserFeedItem {
    kind: "user";
    id: string;
    text: string;
}

interface ToolFeedEntry {
    kind: "tool";
    id: string;
    tool: string;
    arg: string;
    state: "running" | "success" | "error";
    outputLines: string[];
    errorText?: string;
}

interface DiffFeedEntry {
    kind: "diff";
    id: string;
    file: string;
    added: number;
    removed: number;
    lines: DiffLine[];
}

/** Группа «ответ агента»: метка + текст + tool-calls/diff + ряд TTS (референс chat.tsx). */
interface AgentFeedGroup {
    kind: "agent-group";
    id: string;
    timeLabel: string;
    tone: "normal" | "error";
    texts: string[];
    items: (ToolFeedEntry | DiffFeedEntry)[];
}

type FeedItem = UserFeedItem | AgentFeedGroup;

interface InlineCodeToken {
    kind: "code";
    start: number;
    end: number;
    content: string;
}

interface InlineLinkToken {
    kind: "link";
    start: number;
    end: number;
    label: string;
    href: string;
    raw: string;
}

type InlineMarkdownToken = InlineCodeToken | InlineLinkToken;

function safeMarkdownLinkHref(value: string): string | null {
    const href = value.trim();
    if (/^(https?:|mailto:)/i.test(href)) return href;
    if (/^(?:\/(?!\/)|\.{1,2}\/|#)/.test(href)) return href;
    return null;
}

function findMarkdownLinkDestinationEnd(text: string, start: number): number | null {
    let parenthesisDepth = 0;

    for (let index = start; index < text.length; index += 1) {
        const character = text[index];
        if (character === "\\" && index + 1 < text.length) {
            index += 1;
            continue;
        }
        if (character === "(") {
            parenthesisDepth += 1;
            continue;
        }
        if (character === ")") {
            if (parenthesisDepth === 0) return index;
            parenthesisDepth -= 1;
        }
    }

    return null;
}

function parseMarkdownLink(text: string, start: number): InlineLinkToken | null {
    const labelEnd = text.indexOf("]", start + 1);
    if (labelEnd <= start + 1 || text[labelEnd + 1] !== "(") return null;

    const destinationStart = labelEnd + 2;
    const destinationEnd = findMarkdownLinkDestinationEnd(text, destinationStart);
    if (destinationEnd === null || destinationEnd === destinationStart) return null;

    const href = text.slice(destinationStart, destinationEnd);
    if (/\s/.test(href)) return null;

    return {
        kind: "link",
        start,
        end: destinationEnd + 1,
        label: text.slice(start + 1, labelEnd),
        href,
        raw: text.slice(start, destinationEnd + 1),
    };
}

function findInlineMarkdownToken(text: string, start: number): InlineMarkdownToken | null {
    for (let index = start; index < text.length; index += 1) {
        if (text[index] === "`") {
            const end = text.indexOf("`", index + 1);
            if (end > index + 1) {
                return {
                    kind: "code",
                    start: index,
                    end: end + 1,
                    content: text.slice(index + 1, end),
                };
            }
        }
        if (text[index] === "[") {
            const link = parseMarkdownLink(text, index);
            if (link) return link;
        }
    }

    return null;
}

function renderInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
    const nodes: React.ReactNode[] = [];
    let cursor = 0;

    while (cursor < text.length) {
        const token = findInlineMarkdownToken(text, cursor);
        if (!token) {
            nodes.push(text.slice(cursor));
            break;
        }

        if (token.start > cursor) nodes.push(text.slice(cursor, token.start));

        if (token.kind === "code") {
            nodes.push(
                <code
                    key={`${keyPrefix}-code-${token.start}`}
                    className="rounded-[5px] bg-muted px-1 py-px font-mono text-[0.84em] text-emerald-700 [overflow-wrap:anywhere] dark:text-emerald-300"
                >
                    {token.content}
                </code>
            );
        } else {
            const safeHref = safeMarkdownLinkHref(token.href);
            nodes.push(safeHref ? (
                <a
                    key={`${keyPrefix}-link-${token.start}`}
                    href={safeHref}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-accent underline decoration-accent/40 underline-offset-4 [overflow-wrap:anywhere]"
                >
                    {token.label}
                </a>
            ) : token.raw);
        }

        cursor = token.end;
    }

    return nodes;
}

export function MarkdownMessage({ text, tone = "normal" }: { text: string; tone?: AgentFeedGroup["tone"] }) {
    const blocks: React.ReactNode[] = [];
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const textColor = tone === "error" ? "text-status-error" : "text-foreground/85";
    let lineIndex = 0;
    let blockIndex = 0;

    while (lineIndex < lines.length) {
        const line = lines[lineIndex];
        if (line.trim() === "") {
            lineIndex += 1;
            continue;
        }

        const codeFence = CODE_FENCE_PATTERN.exec(line);
        if (codeFence) {
            const language = codeFence[1]?.trim();
            const codeLines: string[] = [];
            lineIndex += 1;
            while (lineIndex < lines.length && !CODE_FENCE_PATTERN.test(lines[lineIndex])) {
                codeLines.push(lines[lineIndex]);
                lineIndex += 1;
            }
            if (lineIndex < lines.length) lineIndex += 1;

            blocks.push(
                <div key={`code-block-${blockIndex}`} className="max-w-full overflow-hidden rounded-[9px] border border-border bg-muted/65 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset]">
                    {language && (
                        <div className="border-b border-border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                            {language}
                        </div>
                    )}
                    <pre className={`select-text max-w-full whitespace-pre-wrap break-words px-3 py-3 font-mono text-[12px] leading-5 [overflow-wrap:anywhere] ${tone === "error" ? "text-status-error" : "text-zinc-800 dark:text-zinc-200"}`}>
                        <code>{codeLines.join("\n")}</code>
                    </pre>
                </div>
            );
            blockIndex += 1;
            continue;
        }

        const heading = HEADING_PATTERN.exec(line);
        if (heading) {
            const headingLevel = Math.min(heading[1].length, 6);
            const Heading = `h${headingLevel}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            const headingClassName = headingLevel <= 2
                ? "break-words text-base font-semibold tracking-tight text-foreground [overflow-wrap:anywhere]"
                : "break-words text-sm font-semibold text-foreground [overflow-wrap:anywhere]";
            blocks.push(
                <Heading key={`heading-${blockIndex}`} className={headingClassName}>
                    {renderInlineMarkdown(heading[2], `heading-${blockIndex}`)}
                </Heading>
            );
            lineIndex += 1;
            blockIndex += 1;
            continue;
        }

        const unorderedItem = UNORDERED_LIST_ITEM_PATTERN.exec(line);
        if (unorderedItem) {
            const items: string[] = [];
            while (lineIndex < lines.length) {
                const item = UNORDERED_LIST_ITEM_PATTERN.exec(lines[lineIndex]);
                if (!item) break;
                items.push(item[1]);
                lineIndex += 1;
            }
            blocks.push(
                <ul key={`unordered-list-${blockIndex}`} className={`ml-5 list-outside list-disc space-y-1.5 text-sm leading-relaxed marker:text-accent ${textColor}`}>
                    {items.map((item, index) => (
                        <li key={`${blockIndex}-${index}`} className="pl-1 [overflow-wrap:anywhere]">
                            {renderInlineMarkdown(item, `unordered-${blockIndex}-${index}`)}
                        </li>
                    ))}
                </ul>
            );
            blockIndex += 1;
            continue;
        }

        const orderedItem = ORDERED_LIST_ITEM_PATTERN.exec(line);
        if (orderedItem) {
            const start = Number(orderedItem[1]);
            const items: string[] = [];
            while (lineIndex < lines.length) {
                const item = ORDERED_LIST_ITEM_PATTERN.exec(lines[lineIndex]);
                if (!item) break;
                items.push(item[2]);
                lineIndex += 1;
            }
            blocks.push(
                <ol key={`ordered-list-${blockIndex}`} start={start} className={`ml-5 list-outside list-decimal space-y-1.5 text-sm leading-relaxed marker:font-mono marker:text-accent ${textColor}`}>
                    {items.map((item, index) => (
                        <li key={`${blockIndex}-${index}`} className="pl-1 [overflow-wrap:anywhere]">
                            {renderInlineMarkdown(item, `ordered-${blockIndex}-${index}`)}
                        </li>
                    ))}
                </ol>
            );
            blockIndex += 1;
            continue;
        }

        const paragraphLines: string[] = [];
        while (lineIndex < lines.length) {
            const paragraphLine = lines[lineIndex];
            if (
                paragraphLine.trim() === ""
                || CODE_FENCE_PATTERN.test(paragraphLine)
                || HEADING_PATTERN.test(paragraphLine)
                || UNORDERED_LIST_ITEM_PATTERN.test(paragraphLine)
                || ORDERED_LIST_ITEM_PATTERN.test(paragraphLine)
            ) {
                break;
            }
            paragraphLines.push(paragraphLine);
            lineIndex += 1;
        }
        blocks.push(
            <p key={`paragraph-${blockIndex}`} className={`whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere] ${textColor}`}>
                {renderInlineMarkdown(paragraphLines.join("\n"), `paragraph-${blockIndex}`)}
            </p>
        );
        blockIndex += 1;
    }

    return (
        <div className={`select-text min-w-0 max-w-full space-y-3 ${tone === "error" ? "rounded-[9px] border border-status-error/35 bg-status-error/[0.06] px-3 py-2" : ""}`}>
            {blocks}
        </div>
    );
}

function formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatSeconds(total: number): string {
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** Агент сессии из metadata.flavor (протокол); неизвестный flavor — claude. */
function agentOf(session: Session | null): AgentId {
    const flavor = session?.metadata?.flavor;
    return flavor === "codex" || flavor === "gemini" || flavor === "cursor" ? flavor : "claude";
}

interface ChatNavState {
    permissionMode?: PermissionMode;
    model?: string | null;
    hasModelOverride: boolean;
}

export interface CursorResumeNavigationState {
    cursorResume: {
        machineId: string;
        directory: string;
        resumeSessionId: string;
        resumeSessionName: string | null;
    };
}

export function buildCursorResumeNavigationState(input: {
    machineId: string;
    directory: string;
    resumeSessionId: string;
    resumeSessionName?: string;
}): CursorResumeNavigationState {
    return {
        cursorResume: {
            machineId: input.machineId,
            directory: input.directory,
            resumeSessionId: input.resumeSessionId,
            resumeSessionName: input.resumeSessionName?.trim() || null,
        },
    };
}

/** Начальные model/permissionMode из navigate state (контракт NewSessionPage → /session/:id). */
export function parseNavState(state: unknown): ChatNavState {
    if (!state || typeof state !== "object") return { hasModelOverride: false };
    const record = state as Record<string, unknown>;
    const hasModelOverride = Object.prototype.hasOwnProperty.call(record, "model")
        && (record.model === null || typeof record.model === "string");
    return {
        permissionMode: typeof record.permissionMode === "string"
            ? (record.permissionMode as PermissionMode)
            : undefined,
        model: hasModelOverride ? record.model as string | null : undefined,
        hasModelOverride,
    };
}

export function agentSessionIdOf(session: Session | null, agent: AgentId): string | undefined {
    const meta = session?.metadata;
    if (!meta) return undefined;
    if (agent === "codex") return meta.codexSessionId ?? meta.agentSessionId;
    if (agent === "gemini") return meta.geminiSessionId ?? meta.agentSessionId;
    if (agent === "cursor") return meta.cursorSessionId ?? meta.agentSessionId;
    return meta.claudeSessionId ?? meta.agentSessionId;
}

export type ChatResumeAction = "deferred" | "cursor-navigation" | "machine-spawn";

export function getChatResumeAction(agent: AgentId): ChatResumeAction {
    if (!isProviderAvailable(agent)) return "deferred";
    return agent === "cursor" ? "cursor-navigation" : "machine-spawn";
}

export interface EndedSessionResumeProps {
    agent: AgentId;
    isResuming: boolean;
    onResume: () => void;
    onBackToList: () => void;
}

export function EndedSessionResume({
    agent,
    isResuming,
    onResume,
    onBackToList,
}: EndedSessionResumeProps) {
    const isDeferred = !isProviderAvailable(agent);

    return (
        <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border bg-card/50 px-4 py-4">
            <span className="font-mono text-[11px] text-muted-foreground">{t("chat.ended")}</span>
            {isDeferred && (
                <p id="chat-deferred-resume-note" role="status" className="max-w-[32rem] text-center font-mono text-[10px] leading-snug text-muted-foreground">
                    {t("chat.ended.resumeDeferred")}
                </p>
            )}
            <div className="flex gap-2">
                <button
                    type="button"
                    onClick={onResume}
                    disabled={isResuming || isDeferred}
                    aria-describedby={isDeferred ? "chat-deferred-resume-note" : undefined}
                    data-resume-availability={isDeferred ? "deferred" : "available"}
                    className="flex h-11 items-center gap-1.5 rounded-[9px] bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground transition-transform active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100 lg:h-9"
                >
                    {isResuming && <Loader2 className="size-3.5 animate-spin" />}
                    {t("chat.ended.resume")}
                </button>
                <button
                    type="button"
                    onClick={onBackToList}
                    className="h-11 rounded-[9px] border border-border px-3.5 text-[13px] font-medium text-muted-foreground transition-[background-color,border-color,color,transform] active:scale-[0.96] lg:h-9"
                >
                    {t("chat.ended.toList")}
                </button>
            </div>
        </div>
    );
}

function displayPath(session: Session): string {
    const path = session.metadata?.path ?? session.id;
    const home = session.metadata?.homeDir;
    return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** Ключевой строковый аргумент tool-вызова для компактного заголовка карточки. */
function toolArgOf(input: unknown): string {
    if (typeof input === "string") return input;
    if (!input || typeof input !== "object") return "";
    const record = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "filePath", "path", "pattern", "url", "query", "description", "prompt"]) {
        const value = record[key];
        if (typeof value === "string" && value) return value;
    }
    return "";
}

function outputTextOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (content && typeof content === "object") {
        const record = content as Record<string, unknown>;
        for (const key of ["stdout", "output", "text", "message", "error"]) {
            const value = record[key];
            if (typeof value === "string" && value.trim()) return value;
        }
        try {
            return JSON.stringify(content).slice(0, 600);
        } catch {
            return "";
        }
    }
    return "";
}

function outputLinesOf(content: unknown): string[] {
    const text = outputTextOf(content);
    if (!text) return [];
    return text.split("\n").filter((line) => line.trim().length > 0).slice(-8);
}

const MAX_DIFF_LINES = 30;

function parseUnifiedDiff(diff: string): DiffLine[] {
    const lines: DiffLine[] = [];
    for (const raw of diff.split("\n")) {
        if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("@@") || raw.startsWith("diff ")) continue;
        if (raw.startsWith("+")) lines.push({ t: "add", text: raw.slice(1) });
        else if (raw.startsWith("-")) lines.push({ t: "del", text: raw.slice(1) });
        else lines.push({ t: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw });
    }
    return lines;
}

function editToDiffLines(oldText: string, newText: string): DiffLine[] {
    return [
        ...oldText.split("\n").map((text): DiffLine => ({ t: "del", text })),
        ...newText.split("\n").map((text): DiffLine => ({ t: "add", text })),
    ];
}

/** Diff-представление для Edit/MultiEdit/Write (Claude) и file-edit (ACP); null — обычная карточка. */
function diffEntryOf(id: string, name: string, input: unknown): DiffFeedEntry | null {
    if (!input || typeof input !== "object") return null;
    const record = input as Record<string, unknown>;
    const file = typeof record.file_path === "string" ? record.file_path
        : typeof record.filePath === "string" ? record.filePath : "";
    if (!file) return null;

    let lines: DiffLine[] | null = null;
    if (name === "file-edit") {
        if (typeof record.diff === "string" && record.diff) {
            lines = parseUnifiedDiff(record.diff);
        } else if (typeof record.oldContent === "string" || typeof record.newContent === "string") {
            lines = editToDiffLines(
                typeof record.oldContent === "string" ? record.oldContent : "",
                typeof record.newContent === "string" ? record.newContent : "",
            );
        }
    } else if (name === "Edit" && typeof record.old_string === "string" && typeof record.new_string === "string") {
        lines = editToDiffLines(record.old_string, record.new_string);
    } else if (name === "MultiEdit" && Array.isArray(record.edits)) {
        lines = [];
        for (const edit of record.edits) {
            if (edit && typeof edit === "object") {
                const pair = edit as Record<string, unknown>;
                if (typeof pair.old_string === "string" && typeof pair.new_string === "string") {
                    lines.push(...editToDiffLines(pair.old_string, pair.new_string));
                }
            }
        }
    } else if (name === "Write" && typeof record.content === "string") {
        lines = record.content.split("\n").map((text): DiffLine => ({ t: "add", text }));
    }
    if (!lines || lines.length === 0) return null;

    const added = lines.filter((line) => line.t === "add").length;
    const removed = lines.filter((line) => line.t === "del").length;
    return { kind: "diff", id, file, added, removed, lines: lines.slice(0, MAX_DIFF_LINES) };
}

/**
 * Лента из NormalizedMessage[]:
 * user → пузырь; agent text → новая группа; tool-call → карточка/diff в текущей группе;
 * tool-result — завершает карточку по tool_use_id; thinking/события/sidechain — пропуск.
 */
export function buildFeed(messages: NormalizedMessage[], agent: AgentId): FeedItem[] {
    const feed: FeedItem[] = [];
    const toolById = new Map<string, ToolFeedEntry>();
    let group: AgentFeedGroup | null = null;

    const openGroup = (message: NormalizedMessage, suffix: string, tone: AgentFeedGroup["tone"] = "normal"): AgentFeedGroup => {
        const next: AgentFeedGroup = {
            kind: "agent-group",
            id: `${message.id}:${suffix}`,
            timeLabel: `${agent} · ${formatTime(message.createdAt)}`,
            tone,
            texts: [],
            items: [],
        };
        feed.push(next);
        return next;
    };

    for (const message of messages) {
        if (message.role === "user") {
            if (message.isSidechain) continue;
            group = null;
            feed.push({ kind: "user", id: message.id, text: message.meta?.displayText ?? message.content.text });
            continue;
        }
        if (message.role === "event") {
            group = null;
            if (message.content.type === "message" && message.content.message.trim()) {
                const eventGroup = openGroup(message, "event", message.content.isError ? "error" : "normal");
                eventGroup.texts.push(message.content.message);
            }
            continue;
        }
        if (message.isSidechain) continue;

        for (const [index, block] of message.content.entries()) {
            if (block.type === "text") {
                if (!block.text.trim()) continue;
                group = openGroup(message, String(index));
                group.texts.push(block.text);
            } else if (block.type === "tool-call") {
                if (!group) group = openGroup(message, String(index));
                const diff = diffEntryOf(`${message.id}:${block.id}`, block.name, block.input);
                if (diff) {
                    group.items.push(diff);
                    continue;
                }
                const entry: ToolFeedEntry = {
                    kind: "tool",
                    id: `${message.id}:${block.id}`,
                    tool: block.name,
                    arg: toolArgOf(block.input),
                    state: "running",
                    outputLines: [],
                };
                group.items.push(entry);
                toolById.set(block.id, entry);
            } else if (block.type === "tool-result") {
                const entry = toolById.get(block.tool_use_id);
                if (!entry) continue;
                entry.state = block.is_error ? "error" : "success";
                entry.outputLines = outputLinesOf(block.content);
                if (block.is_error) {
                    entry.errorText = entry.outputLines[0]?.slice(0, 32);
                }
            }
            // thinking / summary / sidechain — не рендерим (индикатор — ThinkingRow по ephemeral)
        }
    }
    return feed;
}

interface LineageParentResolution {
    parentId: string | null;
    parentSession: Session | null;
    isKnown: boolean;
}

interface LineageRefreshAttemptGate {
    consumeInitialAttempt(candidateId: string | null, isKnown: boolean): boolean;
}

export interface LineageHistoryScope {
    sessionId: string;
    parentSessionId: string | null;
}

export interface LineageHistoryScopeTransition {
    scope: LineageHistoryScope;
    shouldReset: boolean;
}

/**
 * Keep the initial missing-parent fallback bounded to one attempt per candidate.
 * Reconnect listeners already receive a refreshed session snapshot from the protocol client.
 */
export function createLineageRefreshAttemptGate(): LineageRefreshAttemptGate {
    const observedCandidateIds = new Set<string>();

    return {
        consumeInitialAttempt(candidateId, isKnown) {
            if (!candidateId || observedCandidateIds.has(candidateId)) return false;
            // Remember a known first snapshot too: reconnect can legitimately replace it with missing metadata.
            observedCandidateIds.add(candidateId);
            return !isKnown;
        },
    };
}

/** Keep the last trusted parent while a refreshed session snapshot temporarily omits it. */
export function getLineageHistoryScopeTransition(
    currentScope: LineageHistoryScope | null,
    sessionId: string,
    parentSessionId: string | null,
): LineageHistoryScopeTransition {
    if (!currentScope || currentScope.sessionId !== sessionId) {
        return {
            scope: { sessionId, parentSessionId },
            shouldReset: true,
        };
    }
    if (!parentSessionId || currentScope.parentSessionId === parentSessionId) {
        return { scope: currentScope, shouldReset: false };
    }
    return {
        scope: { sessionId, parentSessionId },
        shouldReset: true,
    };
}

export function getLineageHistoryRequestIdentity(
    sessionId: string,
    parentSessionId: string | null,
): string | null {
    return parentSessionId ? JSON.stringify([sessionId, parentSessionId]) : null;
}

/**
 * A lineage link is display-only and must still prove the provider/workspace
 * boundary from the decrypted session snapshots before it can address a cipher.
 */
export function resolveLineageParent(
    session: Session | null,
    sessions: readonly Session[],
): LineageParentResolution {
    const parentId = session?.metadata?.resumedFromRemcliSessionId ?? null;
    if (!session || !parentId || parentId === session.id) {
        return { parentId: null, parentSession: null, isKnown: Boolean(parentId) };
    }

    const parentSession = sessions.find((candidate) => candidate.id === parentId) ?? null;
    if (!parentSession || !session.metadata || !parentSession.metadata) {
        return { parentId: null, parentSession: null, isKnown: Boolean(parentSession) };
    }

    const currentMetadata = session.metadata;
    const parentMetadata = parentSession.metadata;
    const hasTrustedWorkspace = Boolean(currentMetadata.machineId)
        && currentMetadata.machineId === parentMetadata.machineId
        && Boolean(currentMetadata.path)
        && currentMetadata.path === parentMetadata.path
        && (!currentMetadata.remcliHomeDir || !parentMetadata.remcliHomeDir
            || currentMetadata.remcliHomeDir === parentMetadata.remcliHomeDir);
    const hasTrustedAgent = agentOf(session) === "cursor" && agentOf(parentSession) === "cursor";

    if (!hasTrustedWorkspace || !hasTrustedAgent) {
        return { parentId: null, parentSession: null, isKnown: true };
    }

    return { parentId, parentSession, isKnown: true };
}

/** Keep the parent segment before the child segment while removing boundary duplicates. */
export function mergeLineageMessages(
    parentMessages: NormalizedMessage[],
    childMessages: NormalizedMessage[],
): { parentMessages: NormalizedMessage[]; childMessages: NormalizedMessage[] } {
    const seenIds = new Set<string>();
    const seenLocalIds = new Set<string>();
    const remember = (message: NormalizedMessage): void => {
        seenIds.add(message.id);
        if (message.localId) seenLocalIds.add(message.localId);
    };

    const uniqueParentMessages = parentMessages.filter((message) => {
        if (seenIds.has(message.id) || (message.localId && seenLocalIds.has(message.localId))) return false;
        remember(message);
        return true;
    });

    const uniqueChildMessages = childMessages.filter((message) => {
        if (seenIds.has(message.id) || (message.localId && seenLocalIds.has(message.localId))) return false;
        remember(message);
        return true;
    });

    return { parentMessages: uniqueParentMessages, childMessages: uniqueChildMessages };
}

export async function requestLineageParentHistory(
    parentSessionId: string,
    requestMessages: (sessionId: string) => Promise<SessionMessagesPage> = loadSessionMessages,
): Promise<SessionMessagesPage> {
    return requestMessages(parentSessionId);
}

type ChatMessageSender = (
    sessionId: string,
    text: string,
    options?: Parameters<typeof sendSessionMessage>[2],
) => Promise<void>;

/** Bind outbound chat messages to the visible child route, never to its lineage parent. */
export function createChatMessageSender(
    childSessionId: string,
    sendMessage: ChatMessageSender = sendSessionMessage,
): (text: string, options?: Parameters<typeof sendSessionMessage>[2]) => Promise<void> {
    return (text, options) => sendMessage(childSessionId, text, options);
}

/**
 * The message store only exposes an isLoaded flag, not the page total/offset.
 * Always fetch the first page once per lineage route so older-history metadata
 * remains available when the parent messages were cached by an earlier visit.
 */
export function shouldRequestLineageParentInitialPage(
    parentSessionId: string | null,
    requestedParentSessionId: string | null,
): boolean {
    return Boolean(parentSessionId) && parentSessionId !== requestedParentSessionId;
}

type MessageLoadKind = "initial" | "older" | "refresh";

interface MessagePaginationState {
    offset: number;
    total: number;
    hasMore: boolean;
}

interface MessageLoadQueue {
    enqueue(task: () => Promise<void>): Promise<void>;
    enqueueReconnect(task: () => Promise<void>): Promise<void>;
}

interface MessageLoadScope {
    sessionId: string;
    generation: number;
    queue: MessageLoadQueue;
}

type LineageHistoryState = "idle" | "loading" | "loaded" | "unavailable";
export type LineageDisplayState = LineageHistoryState | "none" | "missing-parent";

export function LineageHistoryNotice({ state }: { state: LineageDisplayState }): React.ReactElement | null {
    if (state !== "missing-parent" && state !== "unavailable") return null;
    return (
        <div
            role="status"
            aria-live="polite"
            data-lineage-notice={state}
            className="flex min-w-0 items-start gap-2 px-1 py-1 font-mono text-[10.5px] leading-relaxed text-muted-foreground"
        >
            <StatusDot status="offline" className="mt-1 size-1.5 shrink-0" />
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{t("chat.lineageUnavailable")}</span>
        </div>
    );
}

interface ScrollRestore {
    generation: number;
    height: number;
    top: number;
    onRestored?: () => void;
}

export function mergeMessagePagination(
    current: MessagePaginationState,
    page: Pick<SessionMessagesPage, "total" | "nextOffset">,
    kind: MessageLoadKind
): MessagePaginationState {
    const receivedSinceLastPage = Math.max(0, page.total - current.total);
    const refreshedOffset = current.offset === 0
        ? page.nextOffset
        : current.offset + receivedSinceLastPage;
    const refreshHasUnloadedGap = kind === "refresh"
        && receivedSinceLastPage > page.nextOffset;
    const requestedOffset = refreshHasUnloadedGap
        ? page.nextOffset
        : kind === "refresh"
            ? Math.max(page.nextOffset, refreshedOffset)
        : page.nextOffset;
    const offset = Math.min(page.total, requestedOffset);

    return {
        offset,
        total: page.total,
        hasMore: offset < page.total
    };
}

export function createMessageLoadQueue(): MessageLoadQueue {
    let pending = Promise.resolve();
    let pendingReconnect: Promise<void> | null = null;

    const enqueue = (task: () => Promise<void>): Promise<void> => {
        const next = pending.then(task, task);
        pending = next.catch(() => undefined);
        return next;
    };

    return {
        enqueue,
        enqueueReconnect(task) {
            if (pendingReconnect) return pendingReconnect;
            const queuedReconnect = enqueue(task).catch(() => undefined);
            pendingReconnect = queuedReconnect.finally(() => {
                pendingReconnect = null;
            });
            return pendingReconnect;
        }
    };
}

export function getMessageLoadScope(
    current: MessageLoadScope | null,
    sessionId: string
): MessageLoadScope {
    if (current?.sessionId === sessionId) return current;

    return {
        sessionId,
        generation: (current?.generation ?? 0) + 1,
        queue: createMessageLoadQueue(),
    };
}

// ─── Pending permissions из agentState (референс useSessionStatus + PermissionFooter) ───

interface PendingPermission {
    id: string;
    tool: string;
    command: string;
    comment?: string;
    isDanger: boolean;
    createdAt: number;
}

function pendingPermissionsOf(session: Session | null): PendingPermission[] {
    const requests = session?.agentState?.requests;
    if (!requests) return [];
    const completed = session?.agentState?.completedRequests ?? {};
    return Object.entries(requests)
        .filter(([id]) => !completed[id])
        .map(([id, request]) => {
            const args: unknown = request.arguments;
            const argText = toolArgOf(args);
            const command = request.tool === "Bash" && argText ? argText : `${request.tool} ${argText}`.trim();
            const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
            const comment = request.tool === "Bash" && typeof record.description === "string" ? record.description : undefined;
            return {
                id,
                tool: request.tool,
                command,
                comment,
                isDanger: DANGEROUS_COMMAND_RE.test(command),
                createdAt: request.createdAt ?? 0,
            };
        })
        .sort((a, b) => a.createdAt - b.createdAt);
}

/** Строка вывода tool-call: подсветка «N passed» + стриминг-курсор в конце (референс chat.tsx). */
function ToolOutputLine({ line, hasCaret }: { line: string; hasCaret: boolean }) {
    const passMatch = /^(.*?)(\d+ passed)$/.exec(line);
    return (
        <div className="min-w-0 max-w-full whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
            {passMatch ? (
                <>
                    {passMatch[1]}
                    <span className="text-status-running">{passMatch[2]}</span>
                </>
            ) : (
                line
            )}
            {hasCaret && <Caret />}
        </div>
    );
}

export function ChatPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const location = useLocation();
    const sessionId = id ?? "";
    // navigate state из NewSessionPage: {permissionMode, model} — фиксируем на входе в чат
    const [navState] = React.useState(() => parseNavState(location.state));

    const session = useSession(sessionId);
    const sessions = useSessions();
    const messages = useSessionMessages(sessionId);
    const messagesLoaded = useSessionMessagesLoaded(sessionId);
    const lineageResolution = React.useMemo(
        () => resolveLineageParent(session, sessions),
        [session, sessions],
    );
    const lineageCandidateId = session?.metadata?.resumedFromRemcliSessionId ?? null;
    const lineageParentId = lineageResolution.parentId;
    const lineageHistoryIdentity = getLineageHistoryRequestIdentity(sessionId, lineageParentId);
    const lineageParentMessages = useSessionMessages(lineageParentId);
    const lineageParentMessagesLoaded = useSessionMessagesLoaded(lineageParentId);
    const connectionStatus = useConnectionStatus();
    const machines = useMachines();
    const agent = agentOf(session);

    const [isBooting, setIsBooting] = React.useState(true);
    const [draft, setDraft] = React.useState("");
    const [uiMode, setUiMode] = React.useState<PermissionMode | null>(() => navState.permissionMode ?? null);
    const [busyPermissionIds, setBusyPermissionIds] = React.useState<readonly string[]>([]);
    const [expandedTools, setExpandedTools] = React.useState<Record<string, boolean>>({});
    const [isWhisperAvailable, setIsWhisperAvailable] = React.useState(false);
    const [banner, setBanner] = React.useState<"ok" | "lost" | "restored">("ok");
    const [isResuming, setIsResuming] = React.useState(false);
    const [hasDetachedAutoscroll, setHasDetachedAutoscroll] = React.useState(false);
    const [isPermissionSheetOpen, setIsPermissionSheetOpen] = React.useState(false);
    const [isExecutionSheetOpen, setIsExecutionSheetOpen] = React.useState(false);
    const [executionLoadState, setExecutionLoadState] = React.useState<SessionExecutionLoadState>("idle");
    const [executionSnapshot, setExecutionSnapshot] = React.useState<SessionExecutionSnapshot | null>(null);
    const [draftExecution, setDraftExecution] = React.useState<SessionExecutionSelection | null>(null);
    const [codexCapabilities, setCodexCapabilities] = React.useState<CodexCapabilitiesSnapshot | null>(null);
    const [cursorCapabilities, setCursorCapabilities] = React.useState<CursorCapabilitiesSnapshot | null>(null);
    const [executionError, setExecutionError] = React.useState<string | null>(null);
    const [isApplyingExecution, setIsApplyingExecution] = React.useState(false);
    const [stopTarget, setStopTarget] = React.useState<StopTarget | null>(null);
    const [lineageHistoryState, setLineageHistoryState] = React.useState<LineageHistoryState>("idle");
    const feedRef = React.useRef<HTMLElement>(null);
    const executionTriggerRef = React.useRef<HTMLButtonElement>(null);
    const appliedExecutionRefreshKeyRef = React.useRef<string | null>(null);
    const executionRequestGenerationRef = React.useRef(0);
    const hadConnectedRef = React.useRef(false);
    const hasDetachedAutoscrollRef = React.useRef(false);

    const lineageMessageGroups = React.useMemo(
        () => mergeLineageMessages(lineageParentMessages, messages),
        [lineageParentMessages, messages],
    );
    const feed = React.useMemo(
        () => buildFeed(lineageMessageGroups.childMessages, agent),
        [agent, lineageMessageGroups.childMessages],
    );
    const parentFeed = React.useMemo(
        () => buildFeed(lineageMessageGroups.parentMessages, agent),
        [agent, lineageMessageGroups.parentMessages],
    );
    const pendingPermissions = React.useMemo(() => pendingPermissionsOf(session), [session]);
    const status = session ? sessionStatus(session) : "offline";
    const hasVisibleErrorMessage = feed.some((item) => item.kind === "agent-group" && item.tone === "error");
    const shouldShowExecutionErrorNotice = status === "error" && !hasVisibleErrorMessage;
    const isCursorSession = agent === "cursor";
    const permissionModes = React.useMemo(() => getAgentPermissionModes(agent), [agent]);
    const activePermissionMode = agent === "cursor"
        ? null
        : normalizeAgentPermissionMode(agent, uiMode ?? undefined);
    const formatPermissionMode = React.useCallback(
        (permission: string) => getAgentPermissionLabel(agent, permission as PermissionMode),
        [agent],
    );

    React.useEffect(() => {
        if (!session) return;
        if (agent === "cursor") {
            setUiMode(null);
            return;
        }
        setUiMode((current) => normalizeAgentPermissionMode(agent, current ?? undefined));
    }, [agent, session]);

    // ── Пагинация истории: offset = число
    // загруженных сообщений (live-сообщения тоже двигают его), страницы — newest-first ──
    const [hasMore, setHasMore] = React.useState(false);
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const loadingOlderRef = React.useRef(false);
    /** Снимок скролла перед prepend старых сообщений — восстанавливаем позицию после рендера. */
    const scrollRestoreRef = React.useRef<ScrollRestore | null>(null);
    /** Автоскролл к низу — только если пользователь у низа ленты (не сбивать чтение истории). */
    const isNearBottomRef = React.useRef(true);
    const paginationRef = React.useRef<MessagePaginationState>({ offset: 0, total: 0, hasMore: false });
    const lineagePaginationRef = React.useRef<MessagePaginationState>({ offset: 0, total: 0, hasMore: false });
    const [lineageParentHasMore, setLineageParentHasMore] = React.useState(false);
    const [messageLoadScope, setMessageLoadScope] = React.useState<MessageLoadScope>(() =>
        getMessageLoadScope(null, sessionId)
    );
    const lineageLoadQueue = React.useMemo(() => createMessageLoadQueue(), [sessionId]);
    const lineageHistoryScopeRef = React.useRef<LineageHistoryScope | null>(null);
    const lineageRequestedHistoryIdentityRef = React.useRef<string | null>(null);
    const lineageInitialLoadIdentityRef = React.useRef<string | null>(null);
    const lineageCurrentHistoryIdentityRef = React.useRef<string | null>(lineageHistoryIdentity);
    const lineageMountedRef = React.useRef(false);
    const lineageHasMessagesRef = React.useRef(false);
    const lineageRefreshAttemptGateRef = React.useRef<LineageRefreshAttemptGate | null>(null);
    const lineageRefreshAttemptGate = lineageRefreshAttemptGateRef.current
        ?? (lineageRefreshAttemptGateRef.current = createLineageRefreshAttemptGate());
    lineageCurrentHistoryIdentityRef.current = lineageHistoryIdentity;
    lineageHasMessagesRef.current = lineageParentMessages.length > 0;
    const activeMessageLoadScopeRef = React.useRef<MessageLoadScope | null>(null);
    const [scrollRestoreVersion, setScrollRestoreVersion] = React.useState(0);

    // Очередь относится к поколению маршрута: незавершённый запрос A не блокирует B.
    if (messageLoadScope.sessionId !== sessionId) {
        setMessageLoadScope(getMessageLoadScope(messageLoadScope, sessionId));
    }

    const updatePagination = React.useCallback((page: SessionMessagesPage, kind: MessageLoadKind) => {
        const pagination = mergeMessagePagination(paginationRef.current, page, kind);
        paginationRef.current = pagination;
        setHasMore(pagination.hasMore);
    }, []);

    const updateLineagePagination = React.useCallback((page: SessionMessagesPage, kind: MessageLoadKind) => {
        const pagination = mergeMessagePagination(lineagePaginationRef.current, page, kind);
        lineagePaginationRef.current = pagination;
        setLineageParentHasMore(pagination.hasMore);
    }, []);

    const clearScrollRestore = React.useCallback((generation?: number) => {
        const restore = scrollRestoreRef.current;
        if (!restore || (generation !== undefined && restore.generation !== generation)) return;
        scrollRestoreRef.current = null;
        restore.onRestored?.();
    }, []);

    const waitForScrollRestore = React.useCallback((generation: number): Promise<void> => {
        const restore = scrollRestoreRef.current;
        if (!restore || restore.generation !== generation) return Promise.resolve();
        return new Promise((resolve) => {
            restore.onRestored = resolve;
            setScrollRestoreVersion((version) => version + 1);
        });
    }, []);

    React.useLayoutEffect(() => {
        activeMessageLoadScopeRef.current = messageLoadScope;
        return () => {
            if (activeMessageLoadScopeRef.current === messageLoadScope) {
                activeMessageLoadScopeRef.current = null;
            }
        };
    }, [messageLoadScope]);

    // ── Boot: восстановить клиент при deep-link и подгрузить первую страницу истории ──
    React.useEffect(() => {
        const { generation, queue } = messageLoadScope;
        loadingOlderRef.current = false;
        clearScrollRestore();
        paginationRef.current = { offset: 0, total: 0, hasMore: false };
        isNearBottomRef.current = true;
        hasDetachedAutoscrollRef.current = false;
        setHasDetachedAutoscroll(false);
        setHasMore(false);
        setIsLoadingOlder(false);
        if (!sessionId) {
            setIsBooting(false);
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                if (!isClientStarted()) {
                    const restored = await restoreProtocolClient();
                    if (!restored) return;
                }
                await queue.enqueue(async () => {
                    if (cancelled || activeMessageLoadScopeRef.current !== messageLoadScope) return;
                    const page = await loadSessionMessages(sessionId);
                    if (!cancelled && activeMessageLoadScopeRef.current === messageLoadScope) {
                        updatePagination(page, "initial");
                    }
                });
            } catch {
                // неизвестная сессия или сеть — ниже покажем notFound/баннер
            } finally {
                if (!cancelled) setIsBooting(false);
            }
        })();
        return () => {
            cancelled = true;
            clearScrollRestore(generation);
        };
    }, [clearScrollRestore, messageLoadScope, sessionId, updatePagination]);

    React.useEffect(() => {
        lineageMountedRef.current = true;
        return () => {
            lineageMountedRef.current = false;
        };
    }, []);

    React.useEffect(() => {
        const transition = getLineageHistoryScopeTransition(
            lineageHistoryScopeRef.current,
            sessionId,
            lineageParentId,
        );
        lineageHistoryScopeRef.current = transition.scope;
        if (!transition.shouldReset) return;

        lineagePaginationRef.current = { offset: 0, total: 0, hasMore: false };
        lineageRequestedHistoryIdentityRef.current = null;
        setLineageParentHasMore(false);
        setLineageHistoryState(lineageParentId ? "loading" : "idle");
    }, [lineageParentId, sessionId]);

    const refreshInitialMissingLineageParent = React.useCallback(() => {
        if (!lineageRefreshAttemptGate.consumeInitialAttempt(lineageCandidateId, lineageResolution.isKnown)) return;
        void refreshSessions().catch(() => undefined);
    }, [lineageCandidateId, lineageRefreshAttemptGate, lineageResolution.isKnown]);

    // Parent history uses the same protocol client/cipher, but never enters the child store.
    React.useEffect(() => {
        if (!lineageParentId || !lineageHistoryIdentity) return;
        if (!shouldRequestLineageParentInitialPage(
            lineageHistoryIdentity,
            lineageRequestedHistoryIdentityRef.current,
        )) return;

        lineageRequestedHistoryIdentityRef.current = lineageHistoryIdentity;
        lineageInitialLoadIdentityRef.current = lineageHistoryIdentity;
        void lineageLoadQueue.enqueue(async () => {
            try {
                const page = await requestLineageParentHistory(lineageParentId);
                if (!lineageMountedRef.current
                    || lineageCurrentHistoryIdentityRef.current !== lineageHistoryIdentity) return;
                updateLineagePagination(page, "initial");
                setLineageHistoryState("loaded");
            } catch {
                if (lineageMountedRef.current
                    && lineageCurrentHistoryIdentityRef.current === lineageHistoryIdentity) {
                    setLineageHistoryState("unavailable");
                }
            } finally {
                if (lineageInitialLoadIdentityRef.current === lineageHistoryIdentity) {
                    lineageInitialLoadIdentityRef.current = null;
                }
            }
        });
    }, [lineageHistoryIdentity, lineageLoadQueue, lineageParentId, updateLineagePagination]);

    React.useEffect(() => {
        // A first route snapshot can contain the child metadata before its parent session.
        refreshInitialMissingLineageParent();
    }, [refreshInitialMissingLineageParent]);

    // Сообщения текущего чата запрашиваются после reconnect через общую очередь с пагинацией.
    // Burst reconnect даёт ровно один REST refresh до завершения уже поставленной задачи.
    React.useEffect(() => {
        let isActive = true;
        const { queue } = messageLoadScope;

        const refreshVisibleMessages = () => {
            void queue.enqueueReconnect(async () => {
                if (!isActive || activeMessageLoadScopeRef.current !== messageLoadScope) return;
                try {
                    const page = await loadSessionMessages(sessionId);
                    if (isActive && activeMessageLoadScopeRef.current === messageLoadScope) {
                        updatePagination(page, "refresh");
                    }
                } catch {
                    // ConnectionBanner already communicates the transport state; keep existing history visible.
                }
            });
        };

        const unsubscribe = onProtocolReconnected(refreshVisibleMessages);
        return () => {
            isActive = false;
            unsubscribe();
        };
    }, [messageLoadScope, sessionId, updatePagination]);

    React.useEffect(() => {
        if (!lineageParentId || !lineageHistoryIdentity) return;
        let isActive = true;
        const refreshLineageHistory = () => {
            if (lineageInitialLoadIdentityRef.current === lineageHistoryIdentity) return;
            void lineageLoadQueue.enqueueReconnect(async () => {
                if (!isActive
                    || lineageInitialLoadIdentityRef.current === lineageHistoryIdentity
                    || lineageCurrentHistoryIdentityRef.current !== lineageHistoryIdentity) return;
                setLineageHistoryState("loading");
                try {
                    const page = await requestLineageParentHistory(lineageParentId);
                    if (!isActive || lineageCurrentHistoryIdentityRef.current !== lineageHistoryIdentity) return;
                    updateLineagePagination(page, "refresh");
                    setLineageHistoryState("loaded");
                } catch {
                    if (isActive
                        && lineageCurrentHistoryIdentityRef.current === lineageHistoryIdentity
                        && !lineageHasMessagesRef.current) {
                        setLineageHistoryState("unavailable");
                    }
                }
            });
        };
        const unsubscribe = onProtocolReconnected(refreshLineageHistory);
        return () => {
            isActive = false;
            unsubscribe();
        };
    }, [lineageHistoryIdentity, lineageLoadQueue, lineageParentId, updateLineagePagination]);

    const loadOlder = React.useCallback(() => {
        const hasOlderLineage = Boolean(lineageParentId && lineageParentHasMore);
        if (loadingOlderRef.current || (!hasMore && !hasOlderLineage)) return;
        if (activeMessageLoadScopeRef.current !== messageLoadScope) return;
        const { generation, queue } = messageLoadScope;
        loadingOlderRef.current = true;
        setIsLoadingOlder(true);
        void queue.enqueue(async () => {
            try {
                const shouldLoadParent = Boolean(lineageParentId && lineagePaginationRef.current.hasMore);
                if (activeMessageLoadScopeRef.current !== messageLoadScope
                    || (!paginationRef.current.hasMore && !shouldLoadParent)) return;
                const node = feedRef.current;
                scrollRestoreRef.current = node
                    ? { generation, height: node.scrollHeight, top: node.scrollTop }
                    : null;
                const targetSessionId = shouldLoadParent ? lineageParentId : sessionId;
                const targetOffset = shouldLoadParent
                    ? lineagePaginationRef.current.offset
                    : paginationRef.current.offset;
                if (!targetSessionId) return;
                const page = await loadSessionMessages(targetSessionId, { offset: targetOffset });
                if (activeMessageLoadScopeRef.current !== messageLoadScope) {
                    clearScrollRestore(generation);
                    return;
                }
                if (shouldLoadParent) updateLineagePagination(page, "older");
                else updatePagination(page, "older");
                await waitForScrollRestore(generation);
            } catch {
                clearScrollRestore(generation); // тихий фейл — не блокируем UI
            } finally {
                if (activeMessageLoadScopeRef.current === messageLoadScope) {
                    loadingOlderRef.current = false;
                    setIsLoadingOlder(false);
                }
            }
        });
    }, [clearScrollRestore, hasMore, lineageParentHasMore, lineageParentId, messageLoadScope, sessionId, updateLineagePagination, updatePagination, waitForScrollRestore]);

    // Восстановление позиции скролла после prepend старых сообщений (до отрисовки кадра,
    // мгновенно — обходим css scroll-behavior:smooth ленты)
    React.useLayoutEffect(() => {
        const restore = scrollRestoreRef.current;
        if (!restore) return;
        scrollRestoreRef.current = null;
        if (restore.generation !== messageLoadScope.generation) {
            restore.onRestored?.();
            return;
        }
        const node = feedRef.current;
        if (node && node.scrollHeight !== restore.height) {
            const previousBehavior = node.style.scrollBehavior;
            node.style.scrollBehavior = "auto";
            node.scrollTop = node.scrollHeight - restore.height + restore.top;
            node.style.scrollBehavior = previousBehavior;
        }
        restore.onRestored?.();
    }, [messageLoadScope.generation, scrollRestoreVersion]);

    const handleFeedScroll = () => {
        const node = feedRef.current;
        if (!node) return;
        const isNearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 120;
        const isDetached = !isNearBottom;
        isNearBottomRef.current = isNearBottom;
        if (hasDetachedAutoscrollRef.current !== isDetached) {
            hasDetachedAutoscrollRef.current = isDetached;
            setHasDetachedAutoscroll(isDetached);
        }
        if (node.scrollTop < 60 && (hasMore || lineageParentHasMore) && !loadingOlderRef.current) void loadOlder();
    };

    const scrollToBottom = () => {
        const node = feedRef.current;
        if (!node) return;
        isNearBottomRef.current = true;
        hasDetachedAutoscrollRef.current = false;
        setHasDetachedAutoscroll(false);
        node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    };

    // ── Доступность TTS/Whisper (P2P REST, хук useTtsAvailability из @/lib/voice) ──
    const ttsAvailability = useTtsAvailability();
    const refreshTtsStatus = ttsAvailability.refresh;
    const isTtsAvailable = ttsAvailability.status?.available ?? false;
    React.useEffect(() => {
        if (isBooting) return;
        // при deep-link клиент восстановился уже после mount-проверки хука — перепроверяем
        refreshTtsStatus();
        const config = getRestConfig();
        if (!config) return;
        let cancelled = false;
        fetchWhisperStatus(config)
            .then((whisperStatus) => { if (!cancelled) setIsWhisperAvailable(whisperStatus.available); })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [isBooting, refreshTtsStatus]);

    // ── Баннер соединения: lost при разрыве после первого подключения, restored → скрытие ──
    React.useEffect(() => {
        if (connectionStatus === "connected") {
            const wasLost = hadConnectedRef.current;
            hadConnectedRef.current = true;
            setBanner((current) => (wasLost && current === "lost" ? "restored" : current === "lost" ? "ok" : current));
        } else if (hadConnectedRef.current || connectionStatus === "error") {
            setBanner("lost");
        }
    }, [connectionStatus]);

    React.useEffect(() => {
        if (banner !== "restored") return;
        const timer = window.setTimeout(() => setBanner("ok"), 2400);
        return () => window.clearTimeout(timer);
    }, [banner]);

    // ── Автоскролл к концу ленты при новых сообщениях/стриминге (MOTION.md §2);
    // при чтении истории (скролл вверх/пагинация) вниз не дёргаем ──
    React.useEffect(() => {
        const node = feedRef.current;
        if (node && isNearBottomRef.current) node.scrollTop = node.scrollHeight;
    }, [feed.length, lineageParentMessages.length, pendingPermissions.length, session?.thinking, messagesLoaded]);

    // ── TTS: хук useTts (@/lib/voice) — generation counter, AbortController, lang, LRU-кэш ──
    const { ttsState, activeId: ttsActiveId, synthesize: ttsSynthesize, stop: stopTts } = useTts();

    const toggleListen = (groupId: string, text: string) => {
        if (ttsActiveId === groupId && ttsState !== "idle") {
            stopTts();
            return;
        }
        if (!text.trim()) return;
        void ttsSynthesize(text, groupId).catch(() => undefined);
    };

    const lineageDisplayState = !lineageCandidateId
        ? "none"
        : !lineageParentId
            ? "missing-parent"
            : lineageHistoryState;
    const isLineageHistoryReady = Boolean(
        lineageParentId && (lineageParentMessagesLoaded || lineageHistoryState === "loaded"),
    );

    const renderFeedItem = (item: FeedItem): React.ReactElement => {
        if (item.kind === "user") {
            return (
                <div key={item.id} className="flex min-w-0 max-w-full justify-end">
                    <UserMessage>
                        <span className="block min-w-0 max-w-full break-words [overflow-wrap:anywhere]">{item.text}</span>
                    </UserMessage>
                </div>
            );
        }

        const groupText = item.texts.join("\n\n");
        const listenState: "idle" | "synth" | "playing" =
            ttsActiveId === item.id && ttsState !== "idle"
                ? (ttsState === "synthesizing" ? "synth" : "playing")
                : "idle";
        return (
            <div key={item.id} className="flex min-w-0 max-w-full flex-col gap-2">
                {item.texts.length > 0 && (
                    <>
                        <AgentMeta agent={agent}>{item.timeLabel}</AgentMeta>
                        {item.texts.map((text, index) => (
                            <MarkdownMessage key={index} text={text} tone={item.tone} />
                        ))}
                    </>
                )}
                {item.items.map((entry) => {
                    if (entry.kind === "diff") {
                        return (
                            <DiffView key={entry.id}
                                file={entry.file} added={entry.added} removed={entry.removed} lines={entry.lines} />
                        );
                    }
                    const expandedByDefault = entry.state === "error" || entry.state === "running";
                    const isExpanded = expandedTools[entry.id] ?? expandedByDefault;
                    return (
                        <ToolCallCard
                            key={entry.id}
                            tool={entry.tool}
                            arg={entry.arg}
                            state={entry.state}
                            expanded={isExpanded && entry.outputLines.length > 0}
                            errorText={entry.errorText}
                            onToggle={entry.outputLines.length > 0
                                ? () => toggleToolExpanded(entry.id, expandedByDefault)
                                : undefined}
                        >
                            {entry.outputLines.map((line, index) => (
                                <ToolOutputLine key={index} line={line}
                                    hasCaret={entry.state === "running" && index === entry.outputLines.length - 1} />
                            ))}
                        </ToolCallCard>
                    );
                })}
                {item.texts.length > 0 && (
                    <div className="flex gap-2">
                        {isTtsAvailable && (
                            <ListenButton state={listenState} onClick={() => toggleListen(item.id, groupText)} />
                        )}
                        <button type="button" onClick={() => void copyText(groupText)}
                            className="h-11 cursor-pointer rounded-[7px] px-3 font-mono text-[10.5px] text-muted-foreground transition-[background-color,color,transform] duration-[120ms] hover:bg-muted hover:text-foreground active:scale-[0.96] lg:h-7 lg:px-2.5">
                            {t("chat.copy")}
                        </button>
                    </div>
                )}
            </div>
        );
    };

    // ── Диктовка: хук useVoiceRecorder (@/lib/voice) — MediaRecorder → Whisper ──
    const recorder = useVoiceRecorder();

    const stopDictation = async () => {
        const text = await recorder.stopAndTranscribe();
        if (text) setDraft((prev) => (prev ? `${prev} ${text}` : text));
    };

    // ── Resume завершённой сессии: spawn с resumeSessionId + переход в новую сессию ──
    // RPC-хендлер живёт под id машины из стора демона (не metadata.machineId) — матчим как HomePage
    const rpcMachineId = React.useMemo(() => {
        const meta = session?.metadata;
        if (!meta) return null;
        if (machines.some((machine) => machine.id === meta.machineId)) return meta.machineId ?? null;
        const byHost = machines.filter((machine) => machine.metadata?.host === meta.host);
        const onlineByHost = byHost.find((machine) => machine.active);
        if (onlineByHost) return onlineByHost.id;
        if (byHost.length > 0) return byHost[0].id;
        const active = machines.filter((machine) => machine.active);
        return active.length === 1 ? active[0].id : null;
    }, [machines, session]);

    const stopMachine = React.useMemo<IStopMachineTarget | null>(() => {
        if (!rpcMachineId) return null;
        const machine = machines.find((item) => item.id === rpcMachineId);
        return machine ? { id: machine.id, isActive: machine.active } : null;
    }, [machines, rpcMachineId]);

    const resumeAgentSessionId = agentSessionIdOf(session, agent);
    const isEnded = session ? session.presence !== "online" : false;
    const hasResumeTarget = isEnded && !!resumeAgentSessionId && !!session?.metadata?.path && !!rpcMachineId;
    const canStop = canStopSession(session, stopMachine);
    const canManageSessionExecution = !isEnded
        && session?.metadata?.startedBy === "daemon"
        && (agent === "codex" || agent === "cursor")
        && Boolean(rpcMachineId);

    const loadSessionExecution = React.useCallback(async (forceRefresh: boolean = false) => {
        const requestGeneration = ++executionRequestGenerationRef.current;
        if (!rpcMachineId || !canManageSessionExecution) {
            setExecutionLoadState("idle");
            setExecutionSnapshot(null);
            setDraftExecution(null);
            setExecutionError(null);
            return;
        }

        setExecutionLoadState("loading");
        setExecutionSnapshot(null);
        setDraftExecution(null);
        setCodexCapabilities(null);
        setCursorCapabilities(null);
        setExecutionError(null);
        try {
            const [snapshot, capabilities] = await Promise.all([
                machineGetSessionExecution(rpcMachineId, sessionId),
                agent === "codex"
                    ? machineGetCodexCapabilities(rpcMachineId, forceRefresh)
                    : machineGetCursorCapabilities(rpcMachineId, forceRefresh),
            ]);
            if (requestGeneration !== executionRequestGenerationRef.current) return;
            if (snapshot.provider !== agent) {
                throw new Error(t("chat.execution.providerMismatch"));
            }
            if (capabilities.status !== "ready") {
                throw new Error(t("chat.execution.unavailable"));
            }
            if (agent === "codex") {
                setCodexCapabilities(capabilities as CodexCapabilitiesSnapshot);
                setCursorCapabilities(null);
            } else {
                setCursorCapabilities(capabilities as CursorCapabilitiesSnapshot);
                setCodexCapabilities(null);
            }
            setExecutionSnapshot(snapshot);
            setDraftExecution(snapshot.pending ?? snapshot.current);
            setExecutionLoadState("ready");
        } catch (error) {
            if (requestGeneration !== executionRequestGenerationRef.current) return;
            setExecutionLoadState("error");
            setExecutionError(error instanceof Error ? error.message : t("chat.execution.unavailable"));
        }
    }, [agent, canManageSessionExecution, rpcMachineId, sessionId]);

    React.useEffect(() => {
        void loadSessionExecution();
    }, [loadSessionExecution]);

    React.useEffect(() => {
        if (!canManageSessionExecution) return;
        return onProtocolReconnected(() => {
            void loadSessionExecution(true);
        });
    }, [canManageSessionExecution, loadSessionExecution]);

    React.useEffect(() => {
        const pending = executionSnapshot?.pending;
        if (!pending) return;
        const didApplyPending = pending.provider === "codex"
            ? session?.metadata?.codexExecution?.model === pending.model
                && session.metadata.codexExecution.reasoningEffort === pending.reasoningEffort
            : session?.metadata?.cursorExecution?.model === pending.model;
        if (!didApplyPending) return;

        const refreshKey = `${sessionId}:${executionSnapshot.revision}:${pending.provider}:${pending.model}:${pending.provider === "codex" ? pending.reasoningEffort ?? "" : ""}`;
        if (appliedExecutionRefreshKeyRef.current === refreshKey) return;
        appliedExecutionRefreshKeyRef.current = refreshKey;
        void loadSessionExecution();
    }, [executionSnapshot, loadSessionExecution, session?.metadata?.codexExecution, session?.metadata?.cursorExecution]);

    const effectiveExecution = executionSnapshot?.pending ?? executionSnapshot?.current ?? null;
    const executionHeaderLabel = effectiveExecution
        ? executionSelectionLabel(effectiveExecution, codexCapabilities, cursorCapabilities, true)
        : agent === "codex"
            ? session?.metadata?.codexExecution?.model ?? agent
            : session?.metadata?.cursorExecution?.model ?? agent;
    const executionFullLabel = effectiveExecution
        ? executionSelectionLabel(effectiveExecution, codexCapabilities, cursorCapabilities)
        : executionHeaderLabel;
    const hasExecutionDraftChanges = Boolean(
        draftExecution
        && effectiveExecution
        && !isSessionExecutionEqual(draftExecution, effectiveExecution),
    );
    const executionModels = agent === "codex"
        ? codexCapabilities?.models ?? []
        : agent === "cursor"
            ? cursorCapabilities?.models ?? []
            : [];
    const selectedCodexExecutionModel = draftExecution?.provider === "codex"
        ? codexCapabilities?.models.find((model) => model.id === draftExecution.model) ?? null
        : null;

    const selectExecutionModel = (modelId: string) => {
        if (agent === "codex" && codexCapabilities) {
            const selected = createCodexExecutionForModel(codexCapabilities, modelId);
            if (!selected) return;
            setDraftExecution({ provider: "codex", ...selected });
            return;
        }
        if (agent === "cursor" && cursorCapabilities?.status === "ready" && cursorCapabilities.catalogVersion) {
            if (!cursorCapabilities.models.some((model) => model.id === modelId)) return;
            setDraftExecution({
                provider: "cursor",
                model: modelId,
                catalogVersion: cursorCapabilities.catalogVersion,
            });
        }
    };

    const selectExecutionReasoning = (reasoningEffort: string) => {
        if (draftExecution?.provider !== "codex" || !codexCapabilities) return;
        const selected = createCodexExecutionForModel(
            codexCapabilities,
            draftExecution.model,
            reasoningEffort,
        );
        if (selected) setDraftExecution({ provider: "codex", ...selected });
    };

    const applySessionExecution = async () => {
        if (!rpcMachineId || !executionSnapshot || !draftExecution || isApplyingExecution) return;
        const requestGeneration = executionRequestGenerationRef.current;
        setIsApplyingExecution(true);
        setExecutionError(null);
        try {
            const updated = await machineSetSessionExecution(
                rpcMachineId,
                sessionId,
                executionSnapshot.revision,
                draftExecution,
            );
            if (requestGeneration !== executionRequestGenerationRef.current) return;
            setExecutionSnapshot(updated);
            setDraftExecution(updated.pending ?? updated.current);
            setExecutionLoadState("ready");
            setIsExecutionSheetOpen(false);
            toast.success(updated.pending
                ? t("chat.execution.queued")
                : t("chat.execution.cancelled"));
        } catch (error) {
            if (requestGeneration !== executionRequestGenerationRef.current) return;
            setExecutionLoadState("error");
            setExecutionError(t("chat.execution.applyFailed"));
        } finally {
            if (requestGeneration === executionRequestGenerationRef.current) {
                setIsApplyingExecution(false);
            }
        }
    };

    const requestStop = () => {
        if (!session || !canStopSession(session, stopMachine)) return;
        setStopTarget({ session, machine: stopMachine });
    };

    const resumeSession = async () => {
        const resumeAction = getChatResumeAction(agent);
        if (resumeAction === "deferred") {
            toast.info(t("chat.ended.resumeDeferred"));
            return;
        }

        const meta = session?.metadata;
        if (!meta?.path || !resumeAgentSessionId || !rpcMachineId || isResuming) return;

        if (resumeAction === "cursor-navigation") {
            setIsResuming(true);
            navigate("/new", {
                state: buildCursorResumeNavigationState({
                    machineId: rpcMachineId,
                    directory: meta.path,
                    resumeSessionId: resumeAgentSessionId,
                    resumeSessionName: meta.name,
                }),
            });
            return;
        }

        setIsResuming(true);
        try {
            let codexResumeSelection = null;
            if (agent === "codex") {
                try {
                    codexResumeSelection = getCodexResumeSelection(
                        await machineGetCodexCapabilities(rpcMachineId, true),
                        meta.codexExecution,
                    );
                } catch {
                    toast.error(t("new.capabilitiesUnavailable"));
                    return;
                }
            }
            if (agent === "codex" && !codexResumeSelection) {
                toast.error(t("chat.resumeConfigurationUnavailable"));
                return;
            }
            const result = await machineSpawnNewSession({
                machineId: rpcMachineId,
                directory: meta.path,
                agent,
                resumeSessionId: resumeAgentSessionId,
                resumeSessionName: meta.name,
                ...(codexResumeSelection ?? {}),
            });
            if (result.type !== "success") {
                toast.error(result.type === "error" ? result.errorMessage : t("chat.resumeFailed"));
                return;
            }
            // ждём появления сессии в сторе (нужен cipher для сообщений) — как NewSessionPage
            for (let attempt = 0; attempt < 10 && !useProtocolStore.getState().sessions[result.sessionId]; attempt++) {
                await refreshSessions().catch(() => undefined);
                if (useProtocolStore.getState().sessions[result.sessionId]) break;
                await new Promise((resolve) => setTimeout(resolve, 400));
            }
            navigate(`/session/${result.sessionId}`, { replace: true });
        } finally {
            setIsResuming(false);
        }
    };

    if (!session) {
        return (
            <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background pt-[env(safe-area-inset-top)] text-foreground">
                {isBooting ? (
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                ) : (
                    <>
                        <span className="font-mono text-[11.5px] text-muted-foreground">{t("chat.notFound")}</span>
                        <button onClick={() => navigate("/")}
                            className="h-11 rounded-[9px] border border-border px-3.5 text-[13px] font-medium text-muted-foreground transition-[background-color,border-color,color,transform] active:scale-[0.96]">
                            {t("chat.ended.toList")}
                        </button>
                    </>
                )}
            </div>
        );
    }

    const handleModeChange = (value: string) => {
        if (isCursorSession) return;
        const nextMode = value as PermissionMode;
        if (permissionModes.includes(nextMode)) setUiMode(nextMode);
    };

    const selectPermissionMode = (nextMode: PermissionMode) => {
        if (isCursorSession) return;
        setUiMode(nextMode);
        setIsPermissionSheetOpen(false);
    };

    // Ответ на permission-запрос (референс PermissionFooter.tsx: codex — через decision)
    const answerPermission = (permission: PendingPermission, action: "allow" | "deny" | "always") => {
        if (busyPermissionIds.includes(permission.id)) return;
        setBusyPermissionIds((ids) => [...ids, permission.id]);
        const isCodex = agent === "codex";
        const run = async () => {
            if (action === "allow") {
                await sessionAllow(sessionId, permission.id, undefined, undefined, isCodex ? "approved" : undefined);
            } else if (action === "deny") {
                await sessionDeny(sessionId, permission.id, undefined, undefined, isCodex ? "abort" : undefined);
            } else if (isCodex) {
                await sessionAllow(sessionId, permission.id, undefined, undefined, "approved_for_session");
            } else {
                const toolIdentifier = permission.tool === "Bash" && permission.command
                    ? `Bash(${permission.command})`
                    : permission.tool;
                await sessionAllow(sessionId, permission.id, undefined, [toolIdentifier]);
            }
        };
        void run()
            .catch((error: unknown) => console.error("[ChatPage] permission response failed:", error))
            .finally(() => setBusyPermissionIds((ids) => ids.filter((busyId) => busyId !== permission.id)));
    };

    const sendDraft = () => {
        const text = draft.trim();
        if (!text) return;
        setDraft("");
        const options = isCursorSession
            ? {}
            : { permissionMode: activePermissionMode! };
        void createChatMessageSender(sessionId)(text, options)
            .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                toast.error(t("chat.sendFailed"), { description: message });
                console.error("[ChatPage] send failed:", error);
            });
    };

    const toggleToolExpanded = (entryId: string, fallback: boolean) => {
        setExpandedTools((current) => ({ ...current, [entryId]: !(current[entryId] ?? fallback) }));
    };

    const host = session.metadata?.host;
    // локальный const — TS сужает union состояния рекордера в JSX-ветках
    const recorderState = recorder.recorderState;
    const isRecorderError = recorderState === "error";
    const isRecorderActive = recorderState === "recording" || recorderState === "transcribing";
    const startDictation = () => {
        if (isRecorderError) recorder.reset();
        void recorder.start();
    };

    return (
        <div className="flex h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground lg:grid lg:grid-cols-[288px_1fr] lg:grid-rows-[minmax(0,1fr)]">
            {/* десктоп (3a): постоянный сайдбар сессий, активная — подсвечена */}
            <SessionsSidebar activeSessionId={session.id} className="hidden lg:flex" />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* шапка: проект · агент/хост/статус · уровень доступа · меню */}
            <header className="flex items-center gap-2.5 border-b border-border px-3.5 pb-2.5 lg:pt-2.5">
                <button aria-label={t("chat.aria.back")} onClick={() => navigate(-1)}
                    className="flex size-11 items-center justify-center rounded-[10px] transition-[background-color,transform] active:scale-[0.96] lg:hidden">
                    <ArrowLeft className="size-[17px]" />
                </button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[13.5px] font-semibold">{displayPath(session)}</span>
                    {canManageSessionExecution ? (
                        <button
                            ref={executionTriggerRef}
                            type="button"
                            onClick={() => setIsExecutionSheetOpen(true)}
                            aria-label={`${t("chat.execution.open")}: ${executionFullLabel}. ${statusLabel(status)}`}
                            aria-haspopup="dialog"
                            aria-expanded={isExecutionSheetOpen}
                            aria-controls="chat-next-message-drawer"
                            title={executionFullLabel}
                            className="flex min-h-11 min-w-0 max-w-full items-center gap-1.5 self-start overflow-hidden whitespace-nowrap rounded-[6px] pr-1 font-mono text-[10px] text-muted-foreground transition-[background-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] hover:text-foreground active:scale-[0.98]"
                        >
                            <StatusDot status={status} className="size-1.5" />
                            <span className="shrink-0">{agent}</span>
                            <span aria-hidden="true">·</span>
                            <span className="min-w-0 truncate">{executionHeaderLabel}</span>
                            {executionSnapshot?.pending && (
                                <span className="shrink-0 text-accent">{t("chat.execution.nextShort")}</span>
                            )}
                            <ChevronDown className="size-2.5 shrink-0" />
                        </button>
                    ) : (
                        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                            <StatusDot status={status} className="size-1.5" />
                            <span className="min-w-0 truncate">{agent}{host ? ` · ${host}` : ""} · {statusLabel(status)}</span>
                        </span>
                    )}
                </div>
                {/* Терминал доступен на desktop; сегменты — только когда для них достаточно места. */}
                <div className="hidden items-center gap-2 lg:flex">
                    {!isCursorSession && (
                        <div className="hidden xl:block">
                            <Segmented
                                options={permissionModes}
                                value={activePermissionMode ?? ""}
                                onChange={handleModeChange}
                                getLabel={formatPermissionMode}
                                shouldFitContent
                            />
                        </div>
                    )}
                    <Link to={`/session/${session.id}/terminal`}
                        className="flex h-10 items-center rounded-lg border border-border px-3 font-mono text-[11px] text-muted-foreground">
                        {t("chat.terminal")}
                    </Link>
                </div>
                {/* Компактный picker нужен на mobile и узком desktop; полные labels — в Drawer. */}
                {!isCursorSession && (
                    <button
                        onClick={() => setIsPermissionSheetOpen(true)}
                        aria-label={`${t("new.accessLevel")}: ${formatPermissionMode(activePermissionMode!)}`}
                        aria-haspopup="dialog"
                        aria-expanded={isPermissionSheetOpen}
                        aria-controls="chat-access-level-sheet"
                        className="flex h-11 max-w-[118px] items-center gap-1 rounded-lg bg-muted px-3 font-mono text-[10.5px] transition-[background-color,color,transform] active:scale-[0.96] xl:hidden">
                        <span className="truncate">{formatPermissionMode(activePermissionMode!)}</span>
                        <ChevronDown className="size-2.5 shrink-0 text-muted-foreground" />
                    </button>
                )}
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button aria-label={t("chat.aria.menu")} className="flex size-11 items-center justify-center rounded-[10px] transition-[background-color,transform] active:scale-[0.96]">
                            <MoreHorizontal className="size-[17px] text-muted-foreground" />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-44">
                        <DropdownMenuItem className="min-h-11 font-mono text-xs" onSelect={() => navigate(`/session/${session.id}/terminal`)}>
                            <Terminal className="size-4" />
                            {t("chat.terminal")}
                        </DropdownMenuItem>
                        {canStop && (
                            <DropdownMenuItem
                                variant="destructive"
                                className="min-h-11 font-mono text-xs"
                                onSelect={requestStop}
                            >
                                <Square className="size-3 fill-current" />
                                {t("home.stop.confirm")}
                            </DropdownMenuItem>
                        )}
                    </DropdownMenuContent>
                </DropdownMenu>
            </header>

            {banner !== "ok" && (
                <div className="px-3.5 pt-2"><ConnectionBanner state={banner} /></div>
            )}

            {/* лента */}
            <div className="relative min-h-0 min-w-0 flex-1">
            <main ref={feedRef} onScroll={handleFeedScroll}
                className="h-full min-w-0 overflow-x-hidden overflow-y-auto px-3.5 py-3.5 [scroll-behavior:smooth]">
                <div className="mx-auto flex w-full min-w-0 max-w-[720px] flex-col gap-3">
                    {!messagesLoaded && (
                        <div className="flex justify-center py-4">
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        </div>
                    )}

                    {/* пагинация истории: автоподгрузка при скролле вверх + явная кнопка */}
                    {messagesLoaded && (hasMore || lineageParentHasMore) && (
                        <div className="flex justify-center pb-1">
                            <button onClick={() => void loadOlder()} disabled={isLoadingOlder}
                                className="flex h-11 items-center gap-2 rounded-[9px] border border-border px-3 font-mono text-[10.5px] text-muted-foreground transition-[background-color,border-color,color,transform] active:scale-[0.96] disabled:opacity-60 lg:h-8">
                                {isLoadingOlder && <Loader2 className="size-3 animate-spin" />}
                                {t("chat.loadEarlier")}
                            </button>
                        </div>
                    )}

                    {shouldShowExecutionErrorNotice && (
                        <div role="status" aria-live="polite" className="flex min-w-0 items-start gap-2 rounded-xl border border-status-error/35 bg-status-error/10 px-3 py-2.5 font-mono text-[11.5px] leading-snug text-status-error">
                            <StatusDot status="error" className="mt-1 size-1.5 shrink-0" />
                            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{t("chat.executionError")}</span>
                        </div>
                    )}

                    <div data-lineage-status={lineageDisplayState}>
                        {lineageDisplayState === "loading" && (
                            <div className="flex justify-center py-2" aria-busy="true">
                                <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
                            </div>
                        )}
                        <LineageHistoryNotice state={lineageDisplayState} />
                        {isLineageHistoryReady && lineageMessageGroups.parentMessages.length > 0 && (
                            <>
                                {parentFeed.map(renderFeedItem)}
                                <div className="my-1 border-t border-dashed border-border/70" aria-hidden="true" />
                            </>
                        )}
                    </div>

                    {feed.map(renderFeedItem)}

                    {/* живые permission-запросы из agentState.requests (вход: MOTION.md §6) */}
                    {pendingPermissions.map((permission) => (
                        <div key={permission.id} className="animate-in fade-in slide-in-from-bottom-2.5 zoom-in-[.98] duration-[var(--dur-enter)] ease-[var(--ease-out)]">
                            <PermissionCard
                                tool={permission.tool}
                                time={permission.createdAt ? formatTime(permission.createdAt) : undefined}
                                command={permission.command}
                                comment={permission.comment}
                                danger={permission.isDanger}
                                alwaysLabel={permission.isDanger ? undefined : t("chat.alwaysAllowCommand", { command: permission.command })}
                                onAllow={() => answerPermission(permission, "allow")}
                                onDeny={() => answerPermission(permission, "deny")}
                                onAlways={() => answerPermission(permission, "always")}
                            />
                        </div>
                    ))}

                    {/* индикатор «думает» — ephemeral activity (session.thinking) */}
                    {session.thinking && <ThinkingRow agent={agent} />}

                    {/* сессия завершена + есть агентская сессия в metadata → resume (design/screens/chat.tsx, ended) */}
                    {hasResumeTarget && (
                        <EndedSessionResume
                            agent={agent}
                            isResuming={isResuming}
                            onResume={() => void resumeSession()}
                            onBackToList={() => navigate("/")}
                        />
                    )}
                </div>
            </main>
            {hasDetachedAutoscroll && (
                <button type="button" onClick={scrollToBottom}
                    className="absolute bottom-3 left-1/2 z-10 flex min-h-11 -translate-x-1/2 items-center rounded-full border border-border bg-card/95 px-4 font-mono text-[11px] text-muted-foreground shadow-lg shadow-black/10 backdrop-blur transition-[opacity,transform,border-color,color] duration-[var(--dur-std)] ease-[var(--ease-out)] hover:border-accent/40 hover:text-foreground">
                    ↓ к концу
                </button>
            )}
            </div>

            {/* ввод: текст + диктовка (Whisper) + отправка */}
            <footer className="border-t border-border px-3.5 pb-[max(10px,env(safe-area-inset-bottom))] pt-2">
                <div className="mx-auto flex w-full max-w-[720px] flex-col gap-2">
                    {isRecorderActive ? (
                        <VoiceRecordBar
                            state={recorderState}
                            seconds={formatSeconds(recorder.elapsedSeconds)}
                            onStop={() => void stopDictation()}
                            onCancel={recorder.cancel}
                            onRetry={startDictation}
                        />
                    ) : (
                        <>
                            {isRecorderError && (
                                <VoiceRecordBar
                                    state="error"
                                    seconds={formatSeconds(recorder.elapsedSeconds)}
                                    onStop={() => void stopDictation()}
                                    onCancel={recorder.cancel}
                                    onRetry={startDictation}
                                />
                            )}
                            <div className="flex items-end gap-2">
                                <div className="relative min-w-0 flex-1">
                                    <textarea rows={1} placeholder={t("chat.placeholder")}
                                        value={draft}
                                        onChange={(event) => setDraft(event.target.value)}
                                        onKeyDown={(event) => {
                                            if (event.key === "Enter" && !event.shiftKey) {
                                                event.preventDefault();
                                                sendDraft();
                                            }
                                        }}
                                        className="block min-h-11 w-full resize-none rounded-xl border border-input bg-muted px-3.5 py-3 text-sm outline-none transition-[border-color,box-shadow,opacity] duration-[120ms] placeholder:text-muted-foreground focus:border-accent focus:ring-[3px] focus:ring-accent/15 lg:pr-40" />
                                    {/* десктоп: хинт горячих клавиш внутри поля (desktop.html) */}
                                    <span className="pointer-events-none absolute inset-y-0 right-3.5 hidden items-center font-mono text-[10px] text-muted-foreground lg:flex">
                                        {t("chat.inputHint")}
                                    </span>
                                </div>
                                {isWhisperAvailable && (
                                    <button aria-label={t("chat.aria.dictate")} onClick={startDictation}
                                        className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border transition-[background-color,border-color,transform] duration-[120ms] active:scale-[0.96]">
                                        <Mic className="size-4 text-muted-foreground" />
                                    </button>
                                )}
                                <button aria-label={t("chat.aria.send")} onClick={sendDraft}
                                    className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary transition-[background-color,opacity,transform] duration-[120ms] active:scale-[0.96]">
                                    <Send className="size-4 text-primary-foreground" />
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </footer>
            <Drawer
                open={canManageSessionExecution && isExecutionSheetOpen}
                onOpenChange={(isOpen) => {
                    setIsExecutionSheetOpen(isOpen);
                    if (isOpen && (executionLoadState === "idle" || executionLoadState === "error")) {
                        void loadSessionExecution(executionLoadState === "error");
                    }
                }}
            >
                <DrawerContent
                    id="chat-next-message-drawer"
                    aria-describedby={executionLoadState === "ready"
                        ? "chat-next-message-description chat-turn-stability-note"
                        : "chat-next-message-description"}
                    className={PERMISSION_SHEET_CONTENT_CLASS}
                    onOpenAutoFocus={(event) => {
                        event.preventDefault();
                        const content = event.currentTarget;
                        if (!(content instanceof HTMLElement)) return;
                        const focusTarget = content.querySelector<HTMLElement>("input[type=radio]:checked")
                            ?? content.querySelector<HTMLButtonElement>("button:not([disabled])")
                            ?? content;
                        focusTarget.focus();
                    }}
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        if (executionTriggerRef.current?.isConnected) executionTriggerRef.current.focus();
                    }}
                >
                    <div className="flex items-start gap-3 px-[18px] pb-2 pt-1">
                        <div className="min-w-0 flex-1">
                            <DrawerTitle className="text-[14.5px] font-semibold">{t("chat.execution.title")}</DrawerTitle>
                            <DrawerDescription id="chat-next-message-description" className="mt-1 font-mono text-[10px] leading-relaxed text-muted-foreground">
                                {agent === "cursor"
                                    ? `Cursor: ${t("new.reasoningUnsupported")}`
                                    : `${t("new.model")} · ${t("new.reasoning")}`}
                            </DrawerDescription>
                        </div>
                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{agent}</span>
                    </div>

                    {executionLoadState === "loading" && (
                        <div className="flex min-h-24 items-center justify-center gap-2 border-t border-border px-[18px] font-mono text-[11px] text-muted-foreground">
                            <Loader2 className="size-4 animate-spin" />
                            {t("chat.execution.loading")}
                        </div>
                    )}

                    {executionLoadState === "error" && (
                        <div className="border-t border-border px-[18px] py-4" role="alert">
                            <p className="break-words font-mono text-[11px] leading-relaxed text-status-error">
                                {executionError ?? t("chat.execution.unavailable")}
                            </p>
                            <button
                                type="button"
                                onClick={() => void loadSessionExecution(true)}
                                className="mt-3 flex min-h-11 items-center gap-2 rounded-[9px] border border-border px-3 font-mono text-[11px] text-foreground transition-[background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96]"
                            >
                                <RefreshCw className="size-3.5" />
                                {t("connect.retry")}
                            </button>
                        </div>
                    )}

                    {executionLoadState === "ready" && executionSnapshot && draftExecution && (
                        <>
                            <div className="border-t border-border px-[18px] py-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
                                <span className="block">
                                    {t("chat.execution.current")}: {executionSelectionLabel(executionSnapshot.current, codexCapabilities, cursorCapabilities)}
                                </span>
                                {executionSnapshot.pending && (
                                    <span className="mt-1 block text-accent">
                                        {t("chat.execution.pending")}: {executionSelectionLabel(executionSnapshot.pending, codexCapabilities, cursorCapabilities)}
                                    </span>
                                )}
                            </div>

                            <div className="border-t border-border px-[18px] pb-2 pt-3">
                                <span className="font-mono text-[10px] font-semibold text-muted-foreground">{t("new.model")}</span>
                            </div>
                            <div role="radiogroup" aria-label={t("new.model")} className={EXECUTION_MODEL_LIST_CLASS}>
                                {executionModels.map((model) => {
                                    const isSelected = model.id === draftExecution.model;
                                    return (
                                        <label
                                            key={model.id}
                                            title={model.displayName}
                                            className="flex min-h-11 w-full cursor-pointer items-center gap-3 border-t border-border px-[18px] py-2.5 text-left transition-[background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.98] has-[:focus-visible]:bg-muted/50"
                                        >
                                            <input
                                                type="radio"
                                                name="chat-session-execution-model"
                                                value={model.id}
                                                checked={isSelected}
                                                onChange={() => selectExecutionModel(model.id)}
                                                className="sr-only"
                                            />
                                            <span className={`min-w-0 flex-1 whitespace-normal break-words font-mono text-[12.5px] ${isSelected ? "text-foreground" : "text-muted-foreground"}`}>
                                                {model.displayName}
                                            </span>
                                            <span aria-hidden="true" className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${isSelected ? "border-accent bg-accent text-accent-foreground" : "border-border"}`}>
                                                {isSelected && <Check className="size-2.5" />}
                                            </span>
                                        </label>
                                    );
                                })}
                            </div>

                            {draftExecution.provider === "codex" && selectedCodexExecutionModel && (
                                <>
                                    <div className="border-t border-border px-[18px] pb-2 pt-3">
                                        <span className="font-mono text-[10px] font-semibold text-muted-foreground">{t("new.reasoning")}</span>
                                    </div>
                                    {selectedCodexExecutionModel.supportedReasoningEfforts.length > 0 ? (
                                        <div role="radiogroup" aria-label={t("new.reasoning")}>
                                            {selectedCodexExecutionModel.supportedReasoningEfforts.map((effort) => {
                                                const isSelected = effort === draftExecution.reasoningEffort;
                                                return (
                                                    <label
                                                        key={effort}
                                                        className="flex min-h-11 w-full cursor-pointer items-center gap-3 border-t border-border px-[18px] py-2.5 text-left transition-[background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.98] has-[:focus-visible]:bg-muted/50"
                                                    >
                                                        <input
                                                            type="radio"
                                                            name="chat-session-execution-reasoning"
                                                            value={effort}
                                                            checked={isSelected}
                                                            onChange={() => selectExecutionReasoning(effort)}
                                                            className="sr-only"
                                                        />
                                                        <span className={`min-w-0 flex-1 whitespace-normal break-words font-mono text-[12.5px] ${isSelected ? "text-foreground" : "text-muted-foreground"}`}>{effort}</span>
                                                        <span aria-hidden="true" className={`flex size-4 shrink-0 items-center justify-center rounded-full border ${isSelected ? "border-accent bg-accent text-accent-foreground" : "border-border"}`}>
                                                            {isSelected && <Check className="size-2.5" />}
                                                        </span>
                                                    </label>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <p className="border-t border-border px-[18px] py-3 font-mono text-[10.5px] text-muted-foreground">
                                            {t("new.reasoningUnsupported")}
                                        </p>
                                    )}
                                </>
                            )}

                            <div className="border-t border-border px-[18px] pb-3 pt-3">
                                <p id="chat-turn-stability-note" className="mb-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
                                    {t("chat.execution.nextMessageNote")}
                                </p>
                                <button
                                    type="button"
                                    disabled={!hasExecutionDraftChanges || isApplyingExecution}
                                    onClick={() => void applySessionExecution()}
                                    className="flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] bg-accent px-4 text-[13px] font-semibold text-accent-foreground transition-[opacity,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.98] disabled:opacity-45"
                                >
                                    {isApplyingExecution && <Loader2 className="size-4 animate-spin" />}
                                    {executionSnapshot.pending && isSessionExecutionEqual(draftExecution, executionSnapshot.current)
                                        ? t("chat.execution.cancelPending")
                                        : t("chat.execution.apply")}
                                </button>
                            </div>
                        </>
                    )}
                </DrawerContent>
            </Drawer>
            <Drawer open={!isCursorSession && isPermissionSheetOpen} onOpenChange={setIsPermissionSheetOpen}>
                <DrawerContent id="chat-access-level-sheet" className={PERMISSION_SHEET_CONTENT_CLASS}>
                    <div className="flex items-center px-[18px] pb-2 pt-1">
                        <DrawerTitle className="text-[14.5px] font-semibold">{t("new.accessLevel")}</DrawerTitle>
                        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{agent}</span>
                    </div>
                    {permissionModes.map((permission) => (
                        <button key={permission} onClick={() => selectPermissionMode(permission)}
                            className="flex min-h-11 w-full items-center gap-[11px] border-t border-border px-[18px] py-3 text-left">
                            <span className={`min-w-0 flex-1 truncate font-mono text-[12.5px] ${permission === activePermissionMode ? "text-foreground" : "text-muted-foreground"}`}>
                                {formatPermissionMode(permission)}
                            </span>
                            <span className={`size-1.5 shrink-0 rounded-full ${permission === activePermissionMode ? "bg-accent" : "bg-muted-foreground/25"}`} />
                        </button>
                    ))}
                </DrawerContent>
            </Drawer>
            <StopSessionDialog target={stopTarget} onClose={() => setStopTarget(null)} />
            </div>
        </div>
    );
}
