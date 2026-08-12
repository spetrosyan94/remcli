// remcli-web — Консьерж: чат с локальным LLM-ассистентом демона (роут /concierge).
// GET /v1/concierge/status при входе; POST /v1/concierge/chat со всей историей
// + lang (код локали приложения — консьерж отвечает на языке пользователя).
// Actions ответа рендерятся mono-строками; spawn_agent_session → ссылка на новую сессию.
import * as React from "react";
import { ArrowLeft, Loader2, Send } from "lucide-react";
import { Link, useNavigate } from "react-router";
import { Caret, UserMessage } from "@/components/kit";
import { stripConciergeSpeakerPrefix } from "@/components/app/conciergeText";
import { EmptyState } from "@/components/kit/EmptyState";
import { copyText } from "@/lib/clipboard";
import { fixtureConciergeFeed, isFixtureRestEndpoint } from "@/lib/fixtures";
import { getCurrentLanguage, t } from "@/lib/i18n";
import {
    conciergeChat,
    fetchConciergeStatus,
    getRestConfig,
    useConnectionStatus,
    useMachines,
    type ConciergeChatMessage,
    type ConciergeStatus,
    type ConnectionStatus,
    type RestConfig,
} from "@/lib/protocol";

interface ConciergeActionEntry {
    tool: string;
    result: unknown;
}

interface ConciergeFeedEntry {
    id: string;
    role: "user" | "assistant";
    content: string;
    actions?: ConciergeActionEntry[];
}

interface StoredConciergeFeed {
    version: 1;
    feed: ConciergeFeedEntry[];
}

export interface IConciergeLifecycleState {
    canFetchStatus: boolean;
    showChecking: boolean;
    showNotConnected: boolean;
    isAvailable: boolean;
}

export type TConciergeStatusPhase = "idle" | "checking" | "settled";

export interface IConciergeStatusState {
    scopeVersion: number;
    phase: TConciergeStatusPhase;
    status: ConciergeStatus | null;
}

interface IConciergeStatusScope {
    connectionStatus: ConnectionStatus;
    config: RestConfig | null;
}

export function settleConciergeStatus(
    current: IConciergeStatusState,
    scopeVersion: number,
    status: ConciergeStatus | null,
): IConciergeStatusState {
    if (current.scopeVersion !== scopeVersion) return current;
    return { ...current, phase: "settled", status };
}

export function getConciergeLifecycleState(input: {
    connectionStatus: ConnectionStatus;
    hasConfig: boolean;
    statusPhase: TConciergeStatusPhase;
    hasAvailableStatus: boolean;
}): IConciergeLifecycleState {
    const canFetchStatus = input.hasConfig && input.connectionStatus === "connected";
    const showChecking = input.connectionStatus === "connecting"
        || (canFetchStatus && input.statusPhase !== "settled");

    return {
        canFetchStatus,
        showChecking,
        showNotConnected: !showChecking && !canFetchStatus,
        isAvailable: canFetchStatus && input.statusPhase === "settled" && input.hasAvailableStatus,
    };
}

export function ConciergeStatusNotice({ lifecycleState }: { lifecycleState: IConciergeLifecycleState }): React.ReactElement | null {
    if (lifecycleState.showNotConnected) {
        return (
            <div role="status" aria-live="polite" aria-atomic="true">
                <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border bg-card/50 px-4 py-6">
                    <span className="font-mono text-[11.5px] text-muted-foreground">{t("concierge.notConnected")}</span>
                    <Link to="/connect" className="h-11 rounded-[9px] border border-border px-3.5 text-[13px] font-medium leading-[44px] text-muted-foreground transition-[background-color,border-color,color,transform] active:scale-[0.96]">
                        {t("concierge.connect")}
                    </Link>
                </div>
            </div>
        );
    }

    if (lifecycleState.showChecking) {
        return (
            <div role="status" aria-live="polite" aria-atomic="true">
                <EmptyState title={t("concierge.title")} hint={t("concierge.checking")} />
            </div>
        );
    }

    if (lifecycleState.canFetchStatus && !lifecycleState.isAvailable) {
        return (
            <div role="status" aria-live="polite" aria-atomic="true">
                <EmptyState title={t("concierge.unavailable")} hint={t("concierge.unavailableHint")} />
            </div>
        );
    }

    return null;
}

const CONCIERGE_FEED_STORAGE_PREFIX = "remcli-web:concierge-feed:v1";

function getLocalStorage(): Storage | null {
    try {
        return typeof localStorage === "undefined" ? null : localStorage;
    } catch {
        return null;
    }
}

function isConciergeActionEntry(value: unknown): value is ConciergeActionEntry {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return typeof record.tool === "string";
}

function isConciergeFeedEntry(value: unknown): value is ConciergeFeedEntry {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    const hasValidActions = record.actions === undefined || (
        Array.isArray(record.actions) && record.actions.every(isConciergeActionEntry)
    );
    return (
        typeof record.id === "string" &&
        (record.role === "user" || record.role === "assistant") &&
        typeof record.content === "string" &&
        hasValidActions
    );
}

function loadStoredFeed(storageKey: string): ConciergeFeedEntry[] {
    const raw = getLocalStorage()?.getItem(storageKey);
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as Partial<StoredConciergeFeed>;
        if (parsed.version !== 1 || !Array.isArray(parsed.feed)) return [];
        return parsed.feed.filter(isConciergeFeedEntry).map(normalizeFeedEntry);
    } catch {
        return [];
    }
}

function normalizeFeedEntry(entry: ConciergeFeedEntry): ConciergeFeedEntry {
    if (entry.role !== "assistant") return entry;
    return {
        ...entry,
        content: stripConciergeSpeakerPrefix(entry.content)
    };
}

function sanitizeActionForStorage(action: ConciergeActionEntry): ConciergeActionEntry {
    const sessionId = action.tool === "spawn_agent_session" ? spawnedSessionId(action.result) : null;
    const errorText = actionErrorText(action.result);
    return {
        tool: action.tool,
        result: {
            ...(sessionId ? { sessionId } : {}),
            ...(errorText ? { error: errorText } : {})
        }
    };
}

function sanitizeFeedForStorage(feed: ConciergeFeedEntry[]): ConciergeFeedEntry[] {
    return feed.map((entry) => ({
        id: entry.id,
        role: entry.role,
        content: entry.role === "assistant" ? stripConciergeSpeakerPrefix(entry.content) : entry.content,
        ...(entry.actions ? { actions: entry.actions.map(sanitizeActionForStorage) } : {})
    }));
}

function storeFeed(storageKey: string, feed: ConciergeFeedEntry[]): void {
    const payload: StoredConciergeFeed = { version: 1, feed: sanitizeFeedForStorage(feed) };
    getLocalStorage()?.setItem(storageKey, JSON.stringify(payload));
}

function conciergeStorageKey(endpoint: string, machineId: string | null): string {
    return `${CONCIERGE_FEED_STORAGE_PREFIX}:${endpoint}:${machineId ?? "daemon"}`;
}

function ConciergeMeta({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-accent font-mono text-[9px] font-bold text-accent-foreground">
                ai
            </span>
            {children}
        </div>
    );
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
                    ? <Link to={`/session/${sessionId}`} className="inline-flex min-h-11 items-center rounded-[7px] px-2 text-accent underline underline-offset-2">{t("concierge.openSession")}</Link>
                    : <span>ok</span>}
        </div>
    );
}

export function ConciergeChat() {
    const navigate = useNavigate();
    const connectionStatus = useConnectionStatus();
    const machines = useMachines();
    const [feed, setFeed] = React.useState<ConciergeFeedEntry[]>([]);
    const [draft, setDraft] = React.useState("");
    const [isSending, setIsSending] = React.useState(false);
    const [loadedStorageKey, setLoadedStorageKey] = React.useState<string | null>(null);
    const feedRef = React.useRef<HTMLElement>(null);
    const rawConfig = getRestConfig();
    const endpoint = rawConfig?.endpoint ?? null;
    const token = rawConfig?.token ?? null;
    const config = React.useMemo(
        (): RestConfig | null => (endpoint && token ? { endpoint, token } : null),
        [endpoint, token]
    );
    const canFetchStatus = config !== null && connectionStatus === "connected";
    const statusScopeRef = React.useRef<IConciergeStatusScope | null>(null);
    const statusScopeVersionRef = React.useRef(0);
    if (
        statusScopeRef.current === null
        || statusScopeRef.current.connectionStatus !== connectionStatus
        || statusScopeRef.current.config !== config
    ) {
        statusScopeRef.current = { connectionStatus, config };
        statusScopeVersionRef.current += 1;
    }
    const statusScopeVersion = statusScopeVersionRef.current;
    const [conciergeStatusState, setConciergeStatusState] = React.useState<IConciergeStatusState>(() => ({
        scopeVersion: statusScopeVersion,
        phase: canFetchStatus ? "checking" : "idle",
        status: null,
    }));
    const hasCurrentStatusState = conciergeStatusState.scopeVersion === statusScopeVersion;
    const statusPhase = hasCurrentStatusState ? conciergeStatusState.phase : canFetchStatus ? "checking" : "idle";
    const status = hasCurrentStatusState ? conciergeStatusState.status : null;
    const pairedMachineId = machines[0]?.id ?? null;
    const storageKey = endpoint ? conciergeStorageKey(endpoint, pairedMachineId) : null;
    const fallbackStorageKey = endpoint ? conciergeStorageKey(endpoint, null) : null;

    React.useEffect(() => {
        if (!storageKey) {
            setFeed([]);
            setLoadedStorageKey(null);
            return;
        }
        if (endpoint && isFixtureRestEndpoint(endpoint)) {
            setFeed(fixtureConciergeFeed().map(normalizeFeedEntry));
            setLoadedStorageKey(null);
            return;
        }
        const storedFeed = loadStoredFeed(storageKey);
        const fallbackFeed = fallbackStorageKey && fallbackStorageKey !== storageKey && storedFeed.length === 0
            ? loadStoredFeed(fallbackStorageKey)
            : [];
        setFeed(storedFeed.length > 0 ? storedFeed : fallbackFeed);
        setLoadedStorageKey(storageKey);
    }, [fallbackStorageKey, storageKey]);

    React.useEffect(() => {
        if (!storageKey || loadedStorageKey !== storageKey) return;
        storeFeed(storageKey, feed);
    }, [feed, loadedStorageKey, storageKey]);

    React.useEffect(() => {
        const initialPhase: TConciergeStatusPhase = canFetchStatus ? "checking" : "idle";
        setConciergeStatusState((current) => current.scopeVersion === statusScopeVersion
            && current.phase === initialPhase
            && current.status === null
            ? current
            : { scopeVersion: statusScopeVersion, phase: initialPhase, status: null });

        if (!config || !canFetchStatus) {
            return;
        }

        let isCancelled = false;
        fetchConciergeStatus(config)
            .then((next) => {
                if (isCancelled || statusScopeVersionRef.current !== statusScopeVersion) return;
                setConciergeStatusState((current) => settleConciergeStatus(current, statusScopeVersion, next));
            })
            .catch(() => {
                if (isCancelled || statusScopeVersionRef.current !== statusScopeVersion) return;
                setConciergeStatusState((current) => settleConciergeStatus(current, statusScopeVersion, null));
            });
        return () => {
            isCancelled = true;
        };
    }, [canFetchStatus, config, statusScopeVersion]);

    // автоскролл к концу ленты
    React.useEffect(() => {
        const node = feedRef.current;
        if (node) node.scrollTop = node.scrollHeight;
    }, [feed.length, isSending]);

    const lifecycleState = getConciergeLifecycleState({
        connectionStatus,
        hasConfig: config !== null,
        statusPhase,
        hasAvailableStatus: status !== null && status.enabled && status.available,
    });
    const isAvailable = lifecycleState.isAvailable;

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
                content: stripConciergeSpeakerPrefix(response.reply),
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
                    className="flex size-11 items-center justify-center rounded-[10px] transition-[background-color,transform] active:scale-[0.96]">
                    <ArrowLeft className="size-[17px]" />
                </button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[13.5px] font-semibold">{t("concierge.title")}</span>
                    <span className="truncate font-mono text-[10px] text-muted-foreground">
                        {lifecycleState.showNotConnected
                            ? t("concierge.notConnected")
                            : lifecycleState.showChecking
                                ? t("concierge.checking")
                                : isAvailable
                                    ? status?.model ?? "llm"
                                    : t("concierge.unavailable")}
                    </span>
                </div>
            </header>

            {/* лента */}
            <main ref={feedRef} className="flex-1 overflow-y-auto px-3.5 py-3.5 [scroll-behavior:smooth]">
                <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3">
                    <ConciergeStatusNotice lifecycleState={lifecycleState} />
                    {isAvailable && feed.length === 0 && (
                        <span className="self-center py-6 font-mono text-[11px] text-muted-foreground">{t("concierge.empty.hint")}</span>
                    )}

                    {isAvailable && feed.map((entry) =>
                        entry.role === "user" ? (
                            <UserMessage key={entry.id}>{entry.content}</UserMessage>
                        ) : (
                            <div key={entry.id} className="flex flex-col gap-2">
                                <ConciergeMeta>{t("concierge.title")}</ConciergeMeta>
                                <p className="select-text whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">{entry.content}</p>
                                {entry.actions?.map((action, index) => (
                                    <ActionLine key={`${entry.id}-${index}`} action={action} />
                                ))}
                                <div className="flex gap-2">
                                    <button type="button" onClick={() => void copyText(entry.content)}
                                        className="h-11 cursor-pointer rounded-[7px] px-3 font-mono text-[10.5px] text-muted-foreground transition-[background-color,color,transform] duration-[120ms] hover:bg-muted hover:text-foreground active:scale-[0.96] lg:h-7 lg:px-2.5">
                                        {t("chat.copy")}
                                    </button>
                                </div>
                            </div>
                        ),
                    )}

                    {isAvailable && isSending && (
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
