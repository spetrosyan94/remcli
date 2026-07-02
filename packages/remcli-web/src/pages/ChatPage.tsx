// remcli-web — Чат сессии на живом P2P-протоколе (разметка — design/screens/chat.tsx, 1:1).
// Данные — @/lib/protocol: история через REST (loadSessionMessages) + live через socket (store),
// отправка — sendSessionMessage, permissions — session.agentState.requests + sessionAllow/Deny,
// TTS — synthesizeSpeech, диктовка — MediaRecorder + transcribeAudio (референс remcli-app).
import * as React from "react";
import { ArrowLeft, ChevronDown, Loader2, Mic, MoreHorizontal, Send } from "lucide-react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import {
    AgentMeta, Caret, ConnectionBanner, DiffView, ListenButton, PermissionCard,
    Segmented, STATUS_LABEL, StatusDot, ThinkingRow, ToolCallCard, UserMessage, VoiceRecordBar,
    type AgentId, type DiffLine, type Status,
} from "@/components/kit";
import { t } from "@/lib/i18n";
import {
    fetchTtsStatus, fetchWhisperStatus, getRestConfig, isClientStarted, loadSessionMessages,
    restoreProtocolClient, sendSessionMessage, sessionAllow, sessionDeny, synthesizeSpeech,
    transcribeAudio, useConnectionStatus, useSession, useSessionMessages, useSessionMessagesLoaded,
    type NormalizedMessage, type PermissionMode as ProtocolPermissionMode, type Session,
} from "@/lib/protocol";

type InputState = "text" | "recording" | "transcribing";
type TtsPhase = "synth" | "playing";
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
    const agent = agentOf(session);

    const [isBooting, setIsBooting] = React.useState(true);
    const [inputState, setInputState] = React.useState<InputState>("text");
    const [draft, setDraft] = React.useState("");
    const [uiMode, setUiMode] = React.useState<UiPermissionMode>(() =>
        navState.permissionMode ? fromProtocolMode(navState.permissionMode) : "ask"
    );
    const [busyPermissionIds, setBusyPermissionIds] = React.useState<readonly string[]>([]);
    const [expandedTools, setExpandedTools] = React.useState<Record<string, boolean>>({});
    const [tts, setTts] = React.useState<{ groupId: string; phase: TtsPhase } | null>(null);
    const [isTtsAvailable, setIsTtsAvailable] = React.useState(false);
    const [isWhisperAvailable, setIsWhisperAvailable] = React.useState(false);
    const [banner, setBanner] = React.useState<"ok" | "lost" | "restored">("ok");
    const [recordSeconds, setRecordSeconds] = React.useState(0);
    const feedRef = React.useRef<HTMLElement>(null);
    const hadConnectedRef = React.useRef(false);

    const feed = React.useMemo(() => buildFeed(messages, agent), [messages, agent]);
    const pendingPermissions = React.useMemo(() => pendingPermissionsOf(session), [session]);
    const status = session ? statusOf(session, pendingPermissions.length > 0) : "offline";

    // ── Boot: восстановить клиент при deep-link и подгрузить историю сессии ──
    React.useEffect(() => {
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
                await loadSessionMessages(sessionId);
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

    // ── Доступность TTS/Whisper (P2P REST, референс useTtsAvailability) ──
    React.useEffect(() => {
        if (isBooting) return;
        const config = getRestConfig();
        if (!config) return;
        let cancelled = false;
        fetchTtsStatus(config)
            .then((ttsStatus) => { if (!cancelled) setIsTtsAvailable(ttsStatus.available); })
            .catch(() => undefined);
        fetchWhisperStatus(config)
            .then((whisperStatus) => { if (!cancelled) setIsWhisperAvailable(whisperStatus.available); })
            .catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [isBooting]);

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

    // ── Автоскролл к концу ленты при новых сообщениях/стриминге (MOTION.md §2) ──
    React.useEffect(() => {
        const node = feedRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [feed.length, pendingPermissions.length, session?.thinking, messagesLoaded]);

    // ── Таймер записи диктовки ──
    React.useEffect(() => {
        if (inputState !== "recording") return;
        const timer = window.setInterval(() => setRecordSeconds((seconds) => seconds + 1), 1000);
        return () => window.clearInterval(timer);
    }, [inputState]);

    // ── TTS: синтез через демон + воспроизведение, abort при stop/переключении ──
    const ttsGenerationRef = React.useRef(0);
    const ttsAbortRef = React.useRef<AbortController | null>(null);
    const ttsAudioRef = React.useRef<HTMLAudioElement | null>(null);
    const ttsUrlRef = React.useRef<string | null>(null);

    const stopTts = React.useCallback(() => {
        ttsGenerationRef.current += 1;
        ttsAbortRef.current?.abort();
        ttsAbortRef.current = null;
        if (ttsAudioRef.current) {
            ttsAudioRef.current.pause();
            ttsAudioRef.current = null;
        }
        if (ttsUrlRef.current) {
            URL.revokeObjectURL(ttsUrlRef.current);
            ttsUrlRef.current = null;
        }
        setTts(null);
    }, []);

    const toggleListen = (groupId: string, text: string) => {
        if (tts?.groupId === groupId) {
            stopTts();
            return;
        }
        stopTts();
        const config = getRestConfig();
        if (!config || !text.trim()) return;
        const generation = ttsGenerationRef.current;
        const controller = new AbortController();
        ttsAbortRef.current = controller;
        setTts({ groupId, phase: "synth" });
        synthesizeSpeech(config, text, { signal: controller.signal })
            .then((buffer) => {
                if (generation !== ttsGenerationRef.current) return;
                const url = URL.createObjectURL(new Blob([buffer], { type: "audio/ogg" }));
                ttsUrlRef.current = url;
                const audio = new Audio(url);
                ttsAudioRef.current = audio;
                audio.onended = () => {
                    if (generation === ttsGenerationRef.current) stopTts();
                };
                setTts({ groupId, phase: "playing" });
                void audio.play().catch(() => {
                    if (generation === ttsGenerationRef.current) stopTts();
                });
            })
            .catch(() => {
                if (generation === ttsGenerationRef.current) setTts(null);
            });
    };

    // ── Диктовка: MediaRecorder → Whisper (референс whisperRecorder.web.ts) ──
    const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
    const recordChunksRef = React.useRef<Blob[]>([]);

    const startDictation = async () => {
        if (inputState !== "text") return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            recordChunksRef.current = [];
            const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
                ? "audio/webm;codecs=opus"
                : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";
            const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) recordChunksRef.current.push(event.data);
            };
            recorder.start(250);
            mediaRecorderRef.current = recorder;
            setRecordSeconds(0);
            setInputState("recording");
        } catch {
            // микрофон недоступен/запрещён — остаёмся в текстовом режиме
        }
    };

    const stopDictation = () => {
        const recorder = mediaRecorderRef.current;
        if (!recorder) {
            setInputState("text");
            return;
        }
        setInputState("transcribing");
        recorder.onstop = () => {
            recorder.stream.getTracks().forEach((track) => track.stop());
            const blob = new Blob(recordChunksRef.current, { type: recorder.mimeType || "audio/webm" });
            mediaRecorderRef.current = null;
            recordChunksRef.current = [];
            const config = getRestConfig();
            if (!config) {
                setInputState("text");
                return;
            }
            transcribeAudio(config, blob)
                .then((result) => setDraft((prev) => (prev ? `${prev} ${result.text}` : result.text)))
                .catch(() => undefined)
                .finally(() => setInputState("text"));
        };
        recorder.stop();
    };

    // ── Очистка ресурсов при выходе со страницы ──
    React.useEffect(() => () => {
        stopTts();
        const recorder = mediaRecorderRef.current;
        if (recorder) {
            recorder.onstop = null;
            try {
                recorder.stop();
            } catch {
                // уже остановлен
            }
            recorder.stream.getTracks().forEach((track) => track.stop());
            mediaRecorderRef.current = null;
        }
    }, [stopTts]);

    if (!session) {
        return (
            <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background pt-[env(safe-area-inset-top)] text-foreground">
                {isBooting ? (
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                ) : (
                    <>
                        <span className="font-mono text-[11.5px] text-muted-foreground">{t("chat.notFound")}</span>
                        <button onClick={() => navigate("/")}
                            className="h-9 rounded-[9px] border border-border px-3.5 text-[13px] font-medium text-muted-foreground">
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

    return (
        <div className="flex h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
            {/* шапка: проект · агент/хост/статус · режим разрешений · меню */}
            <header className="flex items-center gap-2.5 border-b border-border px-3.5 pb-2.5">
                <button aria-label={t("chat.aria.back")} onClick={() => navigate(-1)}
                    className="flex size-[38px] items-center justify-center rounded-[10px]">
                    <ArrowLeft className="size-[17px]" />
                </button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[13.5px] font-semibold">{displayPath(session)}</span>
                    <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                        <StatusDot status={status} className="size-1.5" />
                        {agent}{host ? ` · ${host}` : ""} · {STATUS_LABEL[status]}
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
                    className="flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 font-mono text-[10.5px] md:hidden">
                    {uiMode} <ChevronDown className="size-2.5 text-muted-foreground" />
                </button>
                <button aria-label={t("chat.aria.menu")} className="flex size-[38px] items-center justify-center rounded-[10px]">
                    <MoreHorizontal className="size-[17px] text-muted-foreground" />
                </button>
            </header>

            {banner !== "ok" && (
                <div className="px-3.5 pt-2"><ConnectionBanner state={banner} /></div>
            )}

            {/* лента */}
            <main ref={feedRef} className="flex-1 overflow-y-auto px-3.5 py-3.5 [scroll-behavior:smooth]">
                <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3">
                    {!messagesLoaded && (
                        <div className="flex justify-center py-4">
                            <Loader2 className="size-4 animate-spin text-muted-foreground" />
                        </div>
                    )}

                    {feed.map((item) => {
                        if (item.kind === "user") return <UserMessage key={item.id}>{item.text}</UserMessage>;

                        const groupText = item.texts.join("\n\n");
                        const listenState: "idle" | TtsPhase = tts?.groupId === item.id ? tts.phase : "idle";
                        return (
                            <div key={item.id} className="flex flex-col gap-2">
                                {item.texts.length > 0 && (
                                    <>
                                        <AgentMeta agent={agent}>{item.timeLabel}</AgentMeta>
                                        {item.texts.map((text, index) => (
                                            <p key={index} className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">
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
                                            <span onClick={() => toggleListen(item.id, groupText)}>
                                                <ListenButton state={listenState} />
                                            </span>
                                        )}
                                        <button onClick={() => void navigator.clipboard.writeText(groupText)}
                                            className="h-7 rounded-[7px] px-2.5 font-mono text-[10.5px] text-muted-foreground/60">
                                            {t("chat.copy")}
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {/* живые permission-запросы из agentState.requests (вход: MOTION.md §6) */}
                    {pendingPermissions.map((permission) => (
                        <div key={permission.id} className="animate-in fade-in slide-in-from-bottom-2.5 zoom-in-[.98] duration-[240ms]">
                            <PermissionCard
                                tool={permission.tool}
                                time={permission.createdAt ? formatTime(permission.createdAt) : undefined}
                                command={permission.command}
                                comment={permission.comment}
                                danger={permission.isDanger}
                                alwaysLabel={permission.isDanger ? undefined : `всегда разрешать · ${permission.tool}`}
                                onAllow={() => answerPermission(permission, "allow")}
                                onDeny={() => answerPermission(permission, "deny")}
                                onAlways={() => answerPermission(permission, "always")}
                            />
                        </div>
                    ))}

                    {/* индикатор «думает» — ephemeral activity (session.thinking) */}
                    {session.thinking && <ThinkingRow agent={agent} />}
                </div>
            </main>

            {/* ввод: текст + диктовка (Whisper) + отправка */}
            <footer className="border-t border-border px-3.5 pb-[max(10px,env(safe-area-inset-bottom))] pt-2">
                <div className="mx-auto w-full max-w-[720px]">
                    {inputState === "text" ? (
                        <div className="flex items-end gap-2">
                            <textarea rows={1} placeholder={t("chat.placeholder")}
                                value={draft}
                                onChange={(event) => setDraft(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === "Enter" && !event.shiftKey) {
                                        event.preventDefault();
                                        sendDraft();
                                    }
                                }}
                                className="min-h-11 flex-1 resize-none rounded-xl border border-input bg-muted px-3.5 py-3 text-sm outline-none placeholder:text-muted-foreground focus:border-accent focus:ring-[3px] focus:ring-accent/15" />
                            {isWhisperAvailable && (
                                <button aria-label={t("chat.aria.dictate")} onClick={() => void startDictation()}
                                    className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border">
                                    <Mic className="size-4 text-muted-foreground" />
                                </button>
                            )}
                            <button aria-label={t("chat.aria.send")} onClick={sendDraft}
                                className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary">
                                <Send className="size-4 text-primary-foreground" />
                            </button>
                        </div>
                    ) : (
                        <div onClick={() => { if (inputState === "recording") stopDictation(); }}>
                            <VoiceRecordBar
                                state={inputState === "recording" ? "recording" : "transcribing"}
                                seconds={formatSeconds(recordSeconds)}
                            />
                        </div>
                    )}
                </div>
            </footer>
        </div>
    );
}
