// remcli-web — Чат сессии на живом P2P-протоколе (разметка — design/screens/chat.tsx, 1:1).
// Данные — @/lib/protocol: история через REST (loadSessionMessages, пагинация offset/limit)
// + live через socket (store), отправка — sendSessionMessage, permissions —
// session.agentState.requests + sessionAllow/Deny, TTS/диктовка — хуки @/lib/voice,
// resume завершённой сессии — machineSpawnNewSession({resumeSessionId}).
import * as React from "react";
import { ArrowLeft, ChevronDown, Loader2, Mic, MoreHorizontal, Send } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import {
    AgentMeta, Caret, ConnectionBanner, DiffView, ListenButton, PermissionCard,
    Segmented, statusLabel, StatusDot, ThinkingRow, ToolCallCard, UserMessage, VoiceRecordBar,
    type AgentId, type DiffLine, type Status,
} from "@/components/kit";
import { SessionsSidebar } from "@/components/app/SessionsSidebar";
import { copyText } from "@/lib/clipboard";
import { t } from "@/lib/i18n";
import {
    fetchWhisperStatus, getRestConfig, isClientStarted, loadSessionMessages,
    machineSpawnNewSession, refreshSessions, restoreProtocolClient, sendSessionMessage,
    sessionAllow, sessionDeny, useConnectionStatus, useMachines, useProtocolStore,
    useSession, useSessionMessages, useSessionMessagesLoaded,
    type NormalizedMessage, type PermissionMode as ProtocolPermissionMode, type Session,
} from "@/lib/protocol";
import { useVoiceRecorder } from "@/lib/voice/recorder";
import { useTts, useTtsAvailability } from "@/lib/voice/tts";

type UiPermissionMode = "safe" | "ask" | "auto";

const UI_PERMISSION_MODES: UiPermissionMode[] = ["safe", "ask", "auto"];

// Опасные команды (DESIGN.md): rm -rf, force-push, drop … — красный вариант PermissionCard
const DANGEROUS_COMMAND_RE = /\brm\s+-\w*[rf]|--force\b|force[- ]push|\bdrop\s+(table|database|schema)\b|\bmkfs\b|\bdd\s+if=/i;

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
    texts: string[];
    items: (ToolFeedEntry | DiffFeedEntry)[];
}

type FeedItem = UserFeedItem | AgentFeedGroup;

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

/** UI-режим (safe/ask/auto, DESIGN.md) → протокольный permissionMode по семейству агента. */
function toProtocolMode(mode: UiPermissionMode, agent: AgentId): ProtocolPermissionMode {
    if (agent === "codex") {
        return mode === "safe" ? "read-only" : mode === "auto" ? "yolo" : "default";
    }
    return mode === "safe" ? "plan" : mode === "auto" ? "bypassPermissions" : "default";
}

/** Обратный маппинг для navigate state из NewSessionPage: протокольный режим → UI-режим. */
function fromProtocolMode(mode: ProtocolPermissionMode): UiPermissionMode {
    if (mode === "plan" || mode === "read-only") return "safe";
    if (mode === "bypassPermissions" || mode === "yolo") return "auto";
    return "ask";
}

/** Начальные model/permissionMode из navigate state (контракт NewSessionPage → /session/:id). */
function parseNavState(state: unknown): { permissionMode?: ProtocolPermissionMode; model?: string | null } {
    if (!state || typeof state !== "object") return {};
    const record = state as Record<string, unknown>;
    return {
        permissionMode: typeof record.permissionMode === "string"
            ? (record.permissionMode as ProtocolPermissionMode)
            : undefined,
        model: typeof record.model === "string" ? record.model : undefined,
    };
}

function displayPath(session: Session): string {
    const path = session.metadata?.path ?? session.id;
    const home = session.metadata?.homeDir;
    return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function statusOf(session: Session, hasPendingPermission: boolean): Status {
    if (session.presence !== "online") return "offline";
    if (hasPendingPermission) return "permission";
    if (session.thinking) return "thinking";
    return "idle";
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
 * Лента из NormalizedMessage[] (маппинг как в remcli-app reducer, упрощённо):
 * user → пузырь; agent text → новая группа; tool-call → карточка/diff в текущей группе;
 * tool-result — завершает карточку по tool_use_id; thinking/события/sidechain — пропуск.
 */
function buildFeed(messages: NormalizedMessage[], agent: AgentId): FeedItem[] {
    const feed: FeedItem[] = [];
    const toolById = new Map<string, ToolFeedEntry>();
    let group: AgentFeedGroup | null = null;

    const openGroup = (message: NormalizedMessage, suffix: string): AgentFeedGroup => {
        const next: AgentFeedGroup = {
            kind: "agent-group",
            id: `${message.id}:${suffix}`,
            timeLabel: `${agent} · ${formatTime(message.createdAt)}`,
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
        if (message.role === "event") continue;
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
        <div className="whitespace-pre-wrap">
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
    const messages = useSessionMessages(sessionId);
    const messagesLoaded = useSessionMessagesLoaded(sessionId);
    const connectionStatus = useConnectionStatus();
    const machines = useMachines();
    const agent = agentOf(session);

    const [isBooting, setIsBooting] = React.useState(true);
    const [draft, setDraft] = React.useState("");
    const [uiMode, setUiMode] = React.useState<UiPermissionMode>(() =>
        navState.permissionMode ? fromProtocolMode(navState.permissionMode) : "ask"
    );
    const [busyPermissionIds, setBusyPermissionIds] = React.useState<readonly string[]>([]);
    const [expandedTools, setExpandedTools] = React.useState<Record<string, boolean>>({});
    const [isWhisperAvailable, setIsWhisperAvailable] = React.useState(false);
    const [banner, setBanner] = React.useState<"ok" | "lost" | "restored">("ok");
    const [isResuming, setIsResuming] = React.useState(false);
    const [hasDetachedAutoscroll, setHasDetachedAutoscroll] = React.useState(false);
    const feedRef = React.useRef<HTMLElement>(null);
    const hadConnectedRef = React.useRef(false);
    const hasDetachedAutoscrollRef = React.useRef(false);

    const feed = React.useMemo(() => buildFeed(messages, agent), [messages, agent]);
    const pendingPermissions = React.useMemo(() => pendingPermissionsOf(session), [session]);
    const status = session ? statusOf(session, pendingPermissions.length > 0) : "offline";

    // ── Пагинация истории (паттерн remcli-app useLoadMoreMessages): offset = число
    // загруженных сообщений (live-сообщения тоже двигают его), страницы — newest-first ──
    const [hasMore, setHasMore] = React.useState(false);
    const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
    const loadingOlderRef = React.useRef(false);
    const offsetRef = React.useRef(0);
    /** Снимок скролла перед prepend старых сообщений — восстанавливаем позицию после рендера. */
    const scrollRestoreRef = React.useRef<{ height: number; top: number } | null>(null);
    /** Автоскролл к низу — только если пользователь у низа ленты (не сбивать чтение истории). */
    const isNearBottomRef = React.useRef(true);

    // ── Boot: восстановить клиент при deep-link и подгрузить первую страницу истории ──
    React.useEffect(() => {
        offsetRef.current = 0;
        loadingOlderRef.current = false;
        scrollRestoreRef.current = null;
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
                const page = await loadSessionMessages(sessionId);
                if (!cancelled) setHasMore(page.hasMore);
            } catch {
                // неизвестная сессия или сеть — ниже покажем notFound/баннер
            } finally {
                if (!cancelled) setIsBooting(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [sessionId]);

    // offset следует за числом загруженных сообщений (live-поток тоже добавляет их в стор)
    React.useEffect(() => {
        if (messages.length > offsetRef.current) offsetRef.current = messages.length;
    }, [messages.length]);

    const loadOlder = React.useCallback(async () => {
        if (loadingOlderRef.current || !hasMore) return;
        loadingOlderRef.current = true;
        setIsLoadingOlder(true);
        const node = feedRef.current;
        scrollRestoreRef.current = node ? { height: node.scrollHeight, top: node.scrollTop } : null;
        try {
            const page = await loadSessionMessages(sessionId, { offset: offsetRef.current });
            setHasMore(page.hasMore);
        } catch {
            scrollRestoreRef.current = null; // тихий фейл — не блокируем UI
        } finally {
            loadingOlderRef.current = false;
            setIsLoadingOlder(false);
        }
    }, [sessionId, hasMore]);

    // Восстановление позиции скролла после prepend старых сообщений (до отрисовки кадра,
    // мгновенно — обходим css scroll-behavior:smooth ленты)
    React.useLayoutEffect(() => {
        const restore = scrollRestoreRef.current;
        if (!restore) return;
        scrollRestoreRef.current = null;
        const node = feedRef.current;
        if (node && node.scrollHeight !== restore.height) {
            const previousBehavior = node.style.scrollBehavior;
            node.style.scrollBehavior = "auto";
            node.scrollTop = node.scrollHeight - restore.height + restore.top;
            node.style.scrollBehavior = previousBehavior;
        }
    }, [feed]);

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
        if (node.scrollTop < 60 && hasMore && !loadingOlderRef.current) void loadOlder();
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
    }, [feed.length, pendingPermissions.length, session?.thinking, messagesLoaded]);

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

    const resumeAgentSessionId = session?.metadata?.claudeSessionId;
    const isEnded = session ? session.presence !== "online" : false;
    const canResume = isEnded && !!resumeAgentSessionId && !!session?.metadata?.path && !!rpcMachineId;

    const resumeSession = async () => {
        const meta = session?.metadata;
        if (!meta?.path || !resumeAgentSessionId || !rpcMachineId || isResuming) return;
        setIsResuming(true);
        try {
            const result = await machineSpawnNewSession({
                machineId: rpcMachineId,
                directory: meta.path,
                agent,
                resumeSessionId: resumeAgentSessionId,
                resumeSessionName: meta.name,
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
        if (value === "safe" || value === "ask" || value === "auto") setUiMode(value);
    };

    const cycleMode = () => {
        const nextIndex = (UI_PERMISSION_MODES.indexOf(uiMode) + 1) % UI_PERMISSION_MODES.length;
        setUiMode(UI_PERMISSION_MODES[nextIndex]);
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
        void sendSessionMessage(sessionId, text, { permissionMode: toProtocolMode(uiMode, agent), model: navState.model ?? null })
            .catch((error: unknown) => console.error("[ChatPage] send failed:", error));
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
            {/* шапка: проект · агент/хост/статус · режим разрешений · меню */}
            <header className="flex items-center gap-2.5 border-b border-border px-3.5 pb-2.5 lg:pt-2.5">
                <button aria-label={t("chat.aria.back")} onClick={() => navigate(-1)}
                    className="flex size-11 items-center justify-center rounded-[10px] transition-[background-color,transform] active:scale-[0.96] lg:hidden">
                    <ArrowLeft className="size-[17px]" />
                </button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[13.5px] font-semibold">{displayPath(session)}</span>
                    <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                        <StatusDot status={status} className="size-1.5" />
                        {agent}{host ? ` · ${host}` : ""} · {statusLabel(status)}
                    </span>
                </div>
                {/* десктоп (3a): segmented safe/ask/auto полностью + кнопка «терминал» */}
                <div className="hidden items-center gap-2 md:flex">
                    <Segmented options={["safe", "ask", "auto"]} value={uiMode} onChange={handleModeChange} />
                    <Link to={`/session/${session.id}/terminal`}
                        className="flex h-10 items-center rounded-lg border border-border px-3 font-mono text-[11px] text-muted-foreground">
                        {t("chat.terminal")}
                    </Link>
                </div>
                <button onClick={cycleMode}
                    className="flex h-11 items-center gap-1 rounded-lg bg-muted px-3 font-mono text-[10.5px] transition-[background-color,color,transform] active:scale-[0.96] md:hidden">
                    {uiMode} <ChevronDown className="size-2.5 text-muted-foreground" />
                </button>
                <button aria-label={t("chat.aria.menu")} className="flex size-11 items-center justify-center rounded-[10px] transition-[background-color,transform] active:scale-[0.96]">
                    <MoreHorizontal className="size-[17px] text-muted-foreground" />
                </button>
            </header>

            {banner !== "ok" && (
                <div className="px-3.5 pt-2"><ConnectionBanner state={banner} /></div>
            )}

            {/* лента */}
            <div className="relative min-h-0 flex-1">
            <main ref={feedRef} onScroll={handleFeedScroll}
                className="h-full overflow-y-auto px-3.5 py-3.5 [scroll-behavior:smooth]">
                <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3">
                    {!messagesLoaded && (
                        <div className="flex justify-center py-4">
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        </div>
                    )}

                    {/* пагинация истории: автоподгрузка при скролле вверх + явная кнопка */}
                    {messagesLoaded && hasMore && (
                        <div className="flex justify-center pb-1">
                            <button onClick={() => void loadOlder()} disabled={isLoadingOlder}
                                className="flex h-11 items-center gap-2 rounded-[9px] border border-border px-3 font-mono text-[10.5px] text-muted-foreground transition-[background-color,border-color,color,transform] active:scale-[0.96] disabled:opacity-60 lg:h-8">
                                {isLoadingOlder && <Loader2 className="size-3 animate-spin" />}
                                {t("chat.loadEarlier")}
                            </button>
                        </div>
                    )}

                    {feed.map((item) => {
                        if (item.kind === "user") return <UserMessage key={item.id}>{item.text}</UserMessage>;

                        const groupText = item.texts.join("\n\n");
                        const listenState: "idle" | "synth" | "playing" =
                            ttsActiveId === item.id && ttsState !== "idle"
                                ? (ttsState === "synthesizing" ? "synth" : "playing")
                                : "idle";
                        return (
                            <div key={item.id} className="flex flex-col gap-2">
                                {item.texts.length > 0 && (
                                    <>
                                        <AgentMeta agent={agent}>{item.timeLabel}</AgentMeta>
                                        {item.texts.map((text, index) => (
                                            <p key={index} className="select-text whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">
                                                {text}
                                            </p>
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
                                        <div key={entry.id} onClick={() => toggleToolExpanded(entry.id, expandedByDefault)}
                                            className="cursor-pointer">
                                            <ToolCallCard
                                                tool={entry.tool} arg={entry.arg} state={entry.state}
                                                expanded={isExpanded && entry.outputLines.length > 0}
                                                errorText={entry.errorText}>
                                                {entry.outputLines.map((line, index) => (
                                                    <ToolOutputLine key={index} line={line}
                                                        hasCaret={entry.state === "running" && index === entry.outputLines.length - 1} />
                                                ))}
                                            </ToolCallCard>
                                        </div>
                                    );
                                })}
                                {item.texts.length > 0 && (
                                    <div className="flex gap-2">
                                        {isTtsAvailable && (
                                            <ListenButton state={listenState} onClick={() => toggleListen(item.id, groupText)} />
                                        )}
                                        <button type="button" onClick={() => void copyText(groupText)}
                                            className="h-11 cursor-pointer rounded-[7px] px-3 font-mono text-[10.5px] text-muted-foreground/60 transition-[background-color,color,transform] duration-[120ms] hover:bg-muted hover:text-foreground active:scale-[0.96] lg:h-7 lg:px-2.5">
                                            {t("chat.copy")}
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}

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
                    {canResume && (
                        <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border bg-card/50 px-4 py-4">
                            <span className="font-mono text-[11px] text-muted-foreground">{t("chat.ended")}</span>
                            <div className="flex gap-2">
                                <button onClick={() => void resumeSession()} disabled={isResuming}
                                    className="flex h-11 items-center gap-1.5 rounded-[9px] bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground transition-transform active:scale-[0.96] disabled:opacity-60 lg:h-9">
                                    {isResuming && <Loader2 className="size-3.5 animate-spin" />}
                                    {t("chat.ended.resume")}
                                </button>
                                <button onClick={() => navigate("/")}
                                    className="h-11 rounded-[9px] border border-border px-3.5 text-[13px] font-medium text-muted-foreground transition-[background-color,border-color,color,transform] active:scale-[0.96] lg:h-9">
                                    {t("chat.ended.toList")}
                                </button>
                            </div>
                        </div>
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
                                    <span className="pointer-events-none absolute inset-y-0 right-3.5 hidden items-center font-mono text-[10px] text-muted-foreground/50 lg:flex">
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
            </div>
        </div>
    );
}
