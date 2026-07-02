// remcli-web — Чат сессии, главный экран (реализация design/screens/chat.tsx, разметка 1:1).
// Данные — sessions + chatMessages/chatExtraMessages из @/mocks/fixtures; UI-кит — @/components/kit.
// Десктоп (эталон 3a): лента и ввод max-w-[720px] mx-auto; segmented safe/ask/auto + «терминал» в шапке.
import * as React from "react";
import { ArrowLeft, ChevronDown, Mic, MoreHorizontal, Send } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router";
import {
    AgentMeta, Caret, ConnectionBanner, DiffView, ListenButton, PermissionCard,
    Segmented, STATUS_LABEL, StatusDot, ThinkingRow, ToolCallCard, UserMessage, VoiceRecordBar,
} from "@/components/kit";
import { t } from "@/lib/i18n";
import {
    chatEndedSessions, chatExtraMessages, chatMessages, sessions,
    type AgentChatMessage, type DiffChatMessage, type MockChatMessage, type PermissionChatMessage,
    type PermissionMode, type ThinkingChatMessage, type ToolCallChatMessage, type UserChatMessage,
} from "@/mocks/fixtures";

type InputState = "text" | "recording" | "transcribing";
type TtsPhase = "synth" | "playing";

/** Группа «ответ агента»: метка + текст + tool-calls/diff + ряд TTS (референс chat.tsx). */
interface AgentFeedGroup {
    kind: "agent-group";
    id: string;
    meta?: AgentChatMessage;
    items: (ToolCallChatMessage | DiffChatMessage)[];
}

type FeedItem = UserChatMessage | PermissionChatMessage | ThinkingChatMessage | AgentFeedGroup;

function groupMessages(messages: MockChatMessage[]): FeedItem[] {
    const feed: FeedItem[] = [];
    let group: AgentFeedGroup | null = null;
    for (const message of messages) {
        if (message.kind === "agent") {
            group = { kind: "agent-group", id: message.id, meta: message, items: [] };
            feed.push(group);
        } else if (message.kind === "tool-call" || message.kind === "diff") {
            if (!group) {
                group = { kind: "agent-group", id: message.id, items: [] };
                feed.push(group);
            }
            group.items.push(message);
        } else {
            group = null;
            feed.push(message);
        }
    }
    return feed;
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
    const sessionId = id ?? "";
    const session = sessions.find((s) => s.id === sessionId);
    const ended = chatEndedSessions[sessionId];

    const [inputState, setInputState] = React.useState<InputState>("text");
    const [draft, setDraft] = React.useState("");
    const [sentMessages, setSentMessages] = React.useState<UserChatMessage[]>([]);
    const [resolvedPermissionIds, setResolvedPermissionIds] = React.useState<readonly string[]>([]);
    const [tts, setTts] = React.useState<{ groupId: string; phase: TtsPhase } | null>(null);
    const [permissionMode, setPermissionMode] = React.useState<PermissionMode>(session?.permissionMode ?? "ask");
    const [connection, setConnection] = React.useState<"ok" | "lost" | "restored">(
        session?.status === "offline" ? "lost" : "ok",
    );
    const feedRef = React.useRef<HTMLElement>(null);

    const messages: MockChatMessage[] = [
        ...(chatMessages[sessionId] ?? []),
        ...(chatExtraMessages[sessionId] ?? []),
        ...sentMessages,
    ];
    const feed = groupMessages(messages);

    // синтез → играет (MOTION.md §4): спиннер сменяется эквалайзером
    React.useEffect(() => {
        if (tts?.phase !== "synth") return;
        const timer = window.setTimeout(() => {
            setTts((current) => (current?.phase === "synth" ? { groupId: current.groupId, phase: "playing" } : current));
        }, 900);
        return () => window.clearTimeout(timer);
    }, [tts]);

    // распознавание → текст (MOTION.md §3)
    React.useEffect(() => {
        if (inputState !== "transcribing") return;
        const timer = window.setTimeout(() => setInputState("text"), 1400);
        return () => window.clearTimeout(timer);
    }, [inputState]);

    // демо-проводка баннера соединения (chat-states.html): lost (~3s) → restored → скрытие
    React.useEffect(() => {
        if (connection === "ok") return;
        const timer = window.setTimeout(
            () => setConnection((current) => (current === "lost" ? "restored" : "ok")),
            connection === "lost" ? 3000 : 2400,
        );
        return () => window.clearTimeout(timer);
    }, [connection]);

    // автоскролл к концу ленты (MOTION.md §2)
    React.useEffect(() => {
        const node = feedRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [feed.length]);

    if (!session) {
        return (
            <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background pt-[env(safe-area-inset-top)] text-foreground">
                <span className="font-mono text-[11.5px] text-muted-foreground">{t("chat.notFound")}</span>
                <button onClick={() => navigate("/")}
                    className="h-9 rounded-[9px] border border-border px-3.5 text-[13px] font-medium text-muted-foreground">
                    {t("chat.ended.toList")}
                </button>
            </div>
        );
    }

    const handleModeChange = (value: string) => {
        if (value === "safe" || value === "ask" || value === "auto") setPermissionMode(value);
    };

    const resolvePermission = (permissionId: string) => {
        setResolvedPermissionIds((ids) => [...ids, permissionId]);
    };

    const toggleListen = (groupId: string) => {
        setTts((current) => (current?.groupId === groupId ? null : { groupId, phase: "synth" }));
    };

    const sendDraft = () => {
        const text = draft.trim();
        if (!text) return;
        setSentMessages((prev) => [...prev, { id: `chat-local-${prev.length}`, kind: "user", text }]);
        setDraft("");
    };

    return (
        <div className="flex h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
            {/* шапка: проект · агент/модель/статус · режим разрешений · меню */}
            <header className="flex items-center gap-2.5 border-b border-border px-3.5 pb-2.5">
                <button aria-label={t("chat.aria.back")} onClick={() => navigate(-1)}
                    className="flex size-[38px] items-center justify-center rounded-[10px]">
                    <ArrowLeft className="size-[17px]" />
                </button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[13.5px] font-semibold">{session.path}</span>
                    <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
                        <StatusDot status={session.status} className="size-1.5" />
                        {session.agent} · {session.model} · {STATUS_LABEL[session.status]}
                    </span>
                </div>
                {/* десктоп (3a): segmented safe/ask/auto полностью + кнопка «терминал» */}
                <div className="hidden items-center gap-2 md:flex">
                    <Segmented options={["safe", "ask", "auto"]} value={permissionMode} onChange={handleModeChange} />
                    <Link to={`/session/${session.id}/terminal`}
                        className="flex h-10 items-center rounded-lg border border-border px-3 font-mono text-[11px] text-muted-foreground">
                        {t("chat.terminal")}
                    </Link>
                </div>
                <button className="flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 font-mono text-[10.5px] md:hidden">
                    {permissionMode} <ChevronDown className="size-2.5 text-muted-foreground" />
                </button>
                <button aria-label={t("chat.aria.menu")} className="flex size-[38px] items-center justify-center rounded-[10px]">
                    <MoreHorizontal className="size-[17px] text-muted-foreground" />
                </button>
            </header>

            {connection !== "ok" && (
                <div className="px-3.5 pt-2"><ConnectionBanner state={connection} /></div>
            )}

            {/* лента */}
            <main ref={feedRef} className="flex-1 overflow-y-auto px-3.5 py-3.5 [scroll-behavior:smooth]">
                <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3">
                    {feed.map((item) => {
                        if (item.kind === "user") return <UserMessage key={item.id}>{item.text}</UserMessage>;

                        if (item.kind === "thinking") return <ThinkingRow key={item.id} agent={item.agent} />;

                        if (item.kind === "permission") {
                            if (resolvedPermissionIds.includes(item.id)) return null;
                            return (
                                /* самый важный элемент — заметен мгновенно (вход: MOTION.md §6) */
                                <div key={item.id} className="animate-in fade-in slide-in-from-bottom-2.5 zoom-in-[.98] duration-[240ms]">
                                    <PermissionCard
                                        tool={item.tool} time={item.timeLabel}
                                        command={item.command} comment={item.comment}
                                        danger={item.isDanger} alwaysLabel={item.alwaysLabel}
                                        onAllow={() => resolvePermission(item.id)}
                                        onDeny={() => resolvePermission(item.id)}
                                        onAlways={() => resolvePermission(item.id)}
                                    />
                                </div>
                            );
                        }

                        const listenState: "idle" | TtsPhase = tts?.groupId === item.id ? tts.phase : "idle";
                        return (
                            <div key={item.id} className="flex flex-col gap-2">
                                {item.meta && (
                                    <>
                                        <AgentMeta agent={item.meta.agent}>{item.meta.timeLabel}</AgentMeta>
                                        <p className="text-sm leading-relaxed text-foreground/85">
                                            {item.meta.text}
                                            {item.meta.code && (
                                                <>
                                                    {" "}
                                                    <code className="rounded-[5px] bg-muted px-1 py-px font-mono text-[12.5px] text-emerald-700 dark:text-emerald-300">
                                                        {item.meta.code}
                                                    </code>.
                                                </>
                                            )}
                                        </p>
                                    </>
                                )}
                                {item.items.map((entry) =>
                                    entry.kind === "tool-call" ? (
                                        <ToolCallCard key={entry.id}
                                            tool={entry.tool} arg={entry.arg} state={entry.state}
                                            expanded={entry.isExpanded} errorText={entry.errorText}>
                                            {entry.outputLines?.map((line, index) => (
                                                <ToolOutputLine key={index} line={line}
                                                    hasCaret={entry.state === "running" && index === (entry.outputLines?.length ?? 0) - 1} />
                                            ))}
                                        </ToolCallCard>
                                    ) : (
                                        <DiffView key={entry.id}
                                            file={entry.file} added={entry.added} removed={entry.removed} lines={entry.lines} />
                                    ),
                                )}
                                {item.meta && (
                                    <div className="flex gap-2">
                                        <span onClick={() => toggleListen(item.id)}>
                                            <ListenButton state={listenState} />
                                        </span>
                                        <button onClick={() => { if (item.meta) void navigator.clipboard.writeText(item.meta.text); }}
                                            className="h-7 rounded-[7px] px-2.5 font-mono text-[10.5px] text-muted-foreground/60">
                                            {t("chat.copy")}
                                        </button>
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {ended && (
                        <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border bg-card/50 px-4 py-4">
                            <span className="font-mono text-[11px] text-muted-foreground">{ended.label}</span>
                            <div className="flex gap-2">
                                <button className="h-9 rounded-[9px] bg-primary px-3.5 text-[13px] font-semibold text-primary-foreground">
                                    {t("chat.ended.resume")}
                                </button>
                                <button onClick={() => navigate("/")}
                                    className="h-9 rounded-[9px] border border-border px-3.5 text-[13px] font-medium text-muted-foreground">
                                    {t("chat.ended.toList")}
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </main>

            {/* ввод: текст + диктовка + отправка */}
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
                            <button aria-label={t("chat.aria.dictate")} onClick={() => setInputState("recording")}
                                className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border">
                                <Mic className="size-4 text-muted-foreground" />
                            </button>
                            <button aria-label={t("chat.aria.send")} onClick={sendDraft}
                                className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary">
                                <Send className="size-4 text-primary-foreground" />
                            </button>
                        </div>
                    ) : (
                        <div onClick={() => { if (inputState === "recording") setInputState("transcribing"); }}>
                            <VoiceRecordBar state={inputState === "recording" ? "recording" : "transcribing"} />
                        </div>
                    )}
                </div>
            </footer>
        </div>
    );
}
