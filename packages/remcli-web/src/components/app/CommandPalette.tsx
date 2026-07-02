// remcli-web — Command Palette (⌘K / кнопка поиска). Оверлей поверх любого экрана.
// Референс: design/screens/palette.tsx (разметка/классы 1:1); живые сессии из P2P-стора,
// действия: новая сессия · настройки · отключиться (logout + редирект на /connect).
// shadcn <Command> (cmdk) в Radix Dialog; появление: scale 0.98→1 + fade 160ms (MOTION.md §7).
import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Plus, Search, Settings, Unplug } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useNavigate } from "react-router";
import { AgentIcon, StatusDot } from "@/components/kit";
import { sessionAgent, sessionPath, sessionStatus } from "@/components/app/sessionDisplay";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { t } from "@/lib/i18n";
import { logoutProtocolClient, useSessions } from "@/lib/protocol";

/** Подсветка совпадения в пути сессии: <mark class="bg-transparent text-accent"> — как в референсе. */
function HighlightedPath({ path, query }: { path: string; query: string }) {
    const normalizedQuery = query.trim().toLowerCase();
    const matchIndex = normalizedQuery ? path.toLowerCase().indexOf(normalizedQuery) : -1;
    if (matchIndex < 0) {
        return <>{path}</>;
    }
    const matchEnd = matchIndex + normalizedQuery.length;
    return (
        <>
            {path.slice(0, matchIndex)}
            <mark className="bg-transparent text-accent">{path.slice(matchIndex, matchEnd)}</mark>
            {path.slice(matchEnd)}
        </>
    );
}

/** Классы строки палитры (референс: rounded-[9px] px-3 py-2.5; выделение — bg-secondary). */
const paletteItemClass =
    "group flex w-full items-center gap-2.5 rounded-[9px] px-3 py-2.5 text-left " +
    "data-[selected=true]:bg-secondary data-[selected=true]:text-foreground";

/** Заголовок группы (референс: font-mono text-[9.5px] text-muted-foreground/70). */
const groupHeadingClass = "px-3 pb-1 font-mono text-[9.5px] text-muted-foreground/70";

export function CommandPalette() {
    const [isOpen, setIsOpen] = React.useState(false);
    const [query, setQuery] = React.useState("");
    const navigate = useNavigate();
    const sessions = useSessions();

    React.useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "k" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                setIsOpen((open) => !open);
            }
        };
        document.addEventListener("keydown", onKeyDown);
        return () => document.removeEventListener("keydown", onKeyDown);
    }, []);

    const handleOpenChange = (open: boolean) => {
        setIsOpen(open);
        if (!open) setQuery("");
    };

    const closeAnd = (action: () => void) => {
        handleOpenChange(false);
        action();
    };

    // Ручная фильтрация (shouldFilter={false}): фильтруются ТОЛЬКО сессии, действия видны всегда —
    // как в референсе (query="deplo" → 1 сессия + все 3 действия). Матчинг — substring, как в <mark>.
    const normalizedQuery = query.trim().toLowerCase();
    const filteredSessions = React.useMemo(
        () => (normalizedQuery
            ? sessions.filter((session) => sessionPath(session).toLowerCase().includes(normalizedQuery))
            : sessions),
        [sessions, normalizedQuery],
    );

    const disconnect = () => {
        logoutProtocolClient();
        navigate("/connect", { replace: true });
    };

    return (
        <DialogPrimitive.Root open={isOpen} onOpenChange={handleOpenChange}>
            <DialogPrimitive.Portal>
                <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-[160ms] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200" />
                <DialogPrimitive.Content
                    aria-describedby={undefined}
                    className="fixed inset-x-0 top-[calc(env(safe-area-inset-top)+22px)] z-50 mx-3.5 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl shadow-black/60 outline-none duration-[160ms] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
                >
                    <DialogPrimitive.Title className="sr-only">{t("palette.placeholder")}</DialogPrimitive.Title>
                    <Command loop shouldFilter={false} className="bg-transparent">
                        {/* ввод */}
                        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3.5">
                            <Search className="size-[15px] shrink-0 text-muted-foreground" />
                            <CommandPrimitive.Input
                                value={query}
                                onValueChange={setQuery}
                                placeholder={t("palette.placeholder")}
                                className="min-w-0 flex-1 bg-transparent text-[15px] caret-accent outline-none placeholder:text-muted-foreground/70"
                            />
                            <kbd className="ml-auto rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground/70">esc</kbd>
                        </div>

                        <CommandList className="max-h-[60vh] p-1.5 pb-2">
                            {/* сессии (cmdk Empty не срабатывает при shouldFilter={false} — рендерим сами) */}
                            {filteredSessions.length === 0 ? (
                                <div className="py-6 text-center font-mono text-[12px] text-muted-foreground/70">
                                    {t("palette.empty")}
                                </div>
                            ) : (
                                <CommandGroup className="p-0">
                                    <div className={`${groupHeadingClass} pt-1.5`}>{t("palette.sessions")}</div>
                                    {filteredSessions.map((session) => (
                                        <CommandItem
                                            key={session.id}
                                            value={session.id}
                                            onSelect={() => closeAnd(() => navigate(`/session/${session.id}`))}
                                            className={paletteItemClass}
                                        >
                                            <AgentIcon agent={sessionAgent(session)} className="size-6 rounded-[7px] text-[10px]" />
                                            <span className="flex-1 truncate font-mono text-[12.5px]">
                                                <HighlightedPath path={sessionPath(session)} query={query} />
                                            </span>
                                            <StatusDot status={sessionStatus(session)} className="size-[7px]" />
                                            <span className="hidden font-mono text-[10px] text-muted-foreground/70 group-data-[selected=true]:inline">⏎</span>
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            )}

                            {/* действия — видны всегда, фильтрация их не скрывает (референс palette.tsx) */}
                            <CommandGroup className="p-0">
                                <div className={`${groupHeadingClass} pt-2.5`}>{t("palette.actions")}</div>
                                <CommandItem
                                    value={t("palette.newSession")}
                                    onSelect={() => closeAnd(() => navigate("/new"))}
                                    className={paletteItemClass}
                                >
                                    <span className="flex size-6 items-center justify-center rounded-[7px] bg-secondary"><Plus className="size-3.5 text-muted-foreground" /></span>
                                    <span className="flex-1 text-[13px] text-foreground/85">{t("palette.newSession")}</span>
                                    <kbd className="font-mono text-[10px] text-muted-foreground/70">⌘N</kbd>
                                </CommandItem>
                                <CommandItem
                                    value={t("palette.settings")}
                                    onSelect={() => closeAnd(() => navigate("/settings"))}
                                    className={paletteItemClass}
                                >
                                    <span className="flex size-6 items-center justify-center rounded-[7px] bg-secondary"><Settings className="size-3.5 text-muted-foreground" /></span>
                                    <span className="flex-1 text-[13px] text-foreground/85">{t("palette.settings")}</span>
                                </CommandItem>
                                <CommandItem
                                    value={t("palette.disconnect")}
                                    onSelect={() => closeAnd(disconnect)}
                                    className={paletteItemClass}
                                >
                                    <span className="flex size-6 items-center justify-center rounded-[7px] bg-secondary"><Unplug className="size-3.5 text-status-error" /></span>
                                    <span className="flex-1 text-[13px] text-foreground/85">{t("palette.disconnect")}</span>
                                </CommandItem>
                            </CommandGroup>
                        </CommandList>
                    </Command>
                </DialogPrimitive.Content>
            </DialogPrimitive.Portal>
        </DialogPrimitive.Root>
    );
}
