// remcli-web — Консьерж: чат с локальным LLM-ассистентом демона (роут /concierge).
// GET /v1/concierge/status при входе; POST /v1/concierge/chat со всей историей
// + lang (код локали приложения — консьерж отвечает на языке пользователя).
// Actions ответа рендерятся mono-строками; spawn_agent_session → ссылка на новую сессию.
import * as React from "react";
import { ArrowLeft, Loader2, Send } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { Caret, UserMessage } from "@/components/kit";
import { getCurrentLanguage, t } from "@/lib/i18n";
import {
    conciergeChat,
    fetchConciergeStatus,
    getRestConfig,
    type ConciergeChatMessage,
    type ConciergeStatus,
} from "@/lib/protocol";

interface ConciergeFeedEntry {
    id: string;
    role: "user" | "assistant";
    content: string;
    actions?: Array<{ tool: string; result: unknown }>;
}

/** sessionId из результата spawn_agent_session (SpawnSessionResult демона). */
function spawnedSessionId(result: unknown): string | null {
    if (typeof result !== "object" || result === null) return null;
    const record = result as Record<string, unknown>;
    return typeof record.sessionId === "string" ? record.sessionId : null;
}

function actionErrorText(result: unknown): string | null {
    if (typeof result !== "object" || result === null) return null;
    const record = result as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (typeof record.errorMessage === "string") return record.errorMessage;
    return null;
}

function ActionLine({ action }: { action: { tool: string; result: unknown } }) {
    const sessionId = action.tool === "spawn_agent_session" ? spawnedSessionId(action.result) : null;
    const errorText = actionErrorText(action.result);
    return (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 font-mono text-[10.5px] text-muted-foreground">
            <span className="text-accent">{action.tool}</span>
            {errorText
                ? <span className="truncate text-status-error">{t("concierge.error")} · {errorText}</span>
                : sessionId
                    ? <Link to={`/session/${sessionId}`} className="text-accent underline underline-offset-2">{t("concierge.openSession")}</Link>
                    : <span>ok</span>}
        </div>
    );
}

export function ConciergeChat() {
    const navigate = useNavigate();
    const [status, setStatus] = React.useState<ConciergeStatus | null>(null);
    const [isCheckingStatus, setIsCheckingStatus] = React.useState(true);
    const [feed, setFeed] = React.useState<ConciergeFeedEntry[]>([]);
    const [draft, setDraft] = React.useState("");
    const [isSending, setIsSending] = React.useState(false);
    const feedRef = React.useRef<HTMLElement>(null);
    const config = getRestConfig();

    React.useEffect(() => {
        if (!config) {
            setIsCheckingStatus(false);
            return;
        }
        let isCancelled = false;
        fetchConciergeStatus(config)
            .then((next) => { if (!isCancelled) setStatus(next); })
            .catch(() => { if (!isCancelled) setStatus(null); })
            .finally(() => { if (!isCancelled) setIsCheckingStatus(false); });
        return () => { isCancelled = true; };
        // config стабилен в рамках подключения — статус проверяем один раз при входе
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // автоскролл к концу ленты
    React.useEffect(() => {
        const node = feedRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [feed.length, isSending]);

    const isAvailable = status !== null && status.enabled && status.available;

    const send = async () => {
        const text = draft.trim();
        if (!text || isSending || !isAvailable) return;
        const restConfig = getRestConfig();
        if (!restConfig) return;

        const nextFeed: ConciergeFeedEntry[] = [...feed, { id: `c-${Date.now()}`, role: "user", content: text }];
        setFeed(nextFeed);
        setDraft("");
        setIsSending(true);
        try {
            const history: ConciergeChatMessage[] = nextFeed.map(({ role, content }) => ({ role, content }));
            const response = await conciergeChat(restConfig, history, { lang: getCurrentLanguage() });
            setFeed((current) => [...current, {
                id: `c-${Date.now()}-a`,
                role: "assistant",
                content: response.reply,
                actions: response.actions,
            }]);
        } catch (error) {
            setFeed((current) => [...current, {
                id: `c-${Date.now()}-e`,
                role: "assistant",
                content: `${t("concierge.error")}: ${error instanceof Error ? error.message : "unknown"}`,
            }]);
        } finally {
            setIsSending(false);
        }
    };

    return (
        <div className="flex h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
            {/* шапка: назад · консьерж · модель */}
            <header className="flex items-center gap-2.5 border-b border-border px-3.5 pb-2.5">
                <button aria-label={t("chat.aria.back")} onClick={() => navigate(-1)}
                    className="flex size-[38px] items-center justify-center rounded-[10px]">
                    <ArrowLeft className="size-[17px]" />
                </button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[13.5px] font-semibold">{t("concierge.title")}</span>
                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {isCheckingStatus ? t("concierge.checking") : isAvailable ? status.model ?? "llm" : t("concierge.unavailable")}
                    </span>
                </div>
            </header>

            {/* лента */}
            <main ref={feedRef} className="flex-1 overflow-y-auto px-3.5 py-3.5 [scroll-behavior:smooth]">
                <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3">
                    {!config && !isCheckingStatus && (
                        <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border bg-card/50 px-4 py-6">
                            <span className="font-mono text-[11.5px] text-muted-foreground">{t("concierge.notConnected")}</span>
                            <Link to="/connect" className="h-9 rounded-[9px] border border-border px-3.5 text-[13px] font-medium leading-9 text-muted-foreground">
                                {t("concierge.connect")}
                            </Link>
                        </div>
                    )}
                    {config && !isCheckingStatus && !isAvailable && (
                        <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed border-border bg-card/50 px-4 py-6 text-center">
                            <span className="font-mono text-[11.5px] text-muted-foreground">{t("concierge.unavailable")}</span>
                            <span className="font-mono text-[10px] text-muted-foreground/60">{t("concierge.unavailableHint")}</span>
                        </div>
                    )}
                    {isAvailable && feed.length === 0 && (
                        <span className="self-center py-6 font-mono text-[11px] text-muted-foreground/70">{t("concierge.empty.hint")}</span>
                    )}

                    {feed.map((entry) =>
                        entry.role === "user" ? (
                            <UserMessage key={entry.id}>{entry.content}</UserMessage>
                        ) : (
                            <div key={entry.id} className="flex flex-col gap-2">
                                <span className="font-mono text-[10.5px] text-muted-foreground">{t("concierge.title")}</span>
                                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{entry.content}</p>
                                {entry.actions?.map((action, index) => (
                                    <ActionLine key={`${entry.id}-${index}`} action={action} />
                                ))}
                            </div>
                        ),
                    )}

                    {isSending && (
                        <div className="flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
                            <Loader2 className="size-3 animate-spin" /> {t("concierge.thinking")} <Caret thinking />
                        </div>
                    )}
                </div>
            </main>

            {/* ввод */}
            <footer className="border-t border-border px-3.5 pb-[max(10px,env(safe-area-inset-bottom))] pt-2">
                <div className="mx-auto flex w-full max-w-[720px] items-end gap-2">
                    <textarea rows={1} placeholder={t("concierge.placeholder")}
                        value={draft}
                        disabled={!isAvailable || isSending}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                void send();
                            }
                        }}
                        className="min-h-11 flex-1 resize-none rounded-xl border border-input bg-muted px-3.5 py-3 text-sm outline-none placeholder:text-muted-foreground focus:border-accent focus:ring-[3px] focus:ring-accent/15 disabled:opacity-50" />
                    <button aria-label={t("chat.aria.send")} onClick={() => void send()} disabled={!isAvailable || isSending}
                        className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary disabled:opacity-50">
                        <Send className="size-4 text-primary-foreground" />
                    </button>
                </div>
            </footer>
        </div>
    );
}
