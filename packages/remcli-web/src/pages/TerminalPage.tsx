// remcli-web — честный handoff к чату сессии. P2P не подтверждает состояние
// нативного Terminal.app, поэтому экран показывает только platform/host сессии.
import { ArrowLeft, Loader2, MonitorSmartphone } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { t } from "@/lib/i18n";
import {
    useSession,
    useMachines,
    useSessionsLoaded,
    type Session,
} from "@/lib/protocol";
import {
    resolveTerminalHandoff,
    terminalMachineForSession,
    TERMINAL_PLATFORM_LABEL_KEYS,
    type TerminalHandoffKind,
} from "@/lib/terminalHandoff";

function displayPath(session: Session): string {
    const path = session.metadata?.path ?? session.id;
    const home = session.metadata?.homeDir;
    return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function handoffCopy(kind: TerminalHandoffKind): { title: string; hint: string } {
    switch (kind) {
        case "active":
            return {
                title: t("terminal.handoff.activeTitle"),
                hint: t("terminal.handoff.activeHint"),
            };
        case "ended":
            return {
                title: t("terminal.handoff.endedTitle"),
                hint: t("terminal.handoff.endedHint"),
            };
        case "unavailable":
            return {
                title: t("terminal.handoff.unavailableTitle"),
                hint: t("terminal.handoff.unavailableHint"),
            };
        case "not-found":
            return {
                title: t("chat.notFound"),
                hint: t("terminal.handoff.notFoundHint"),
            };
        case "loading":
            return {
                title: t("terminal.loading"),
                hint: "",
            };
    }
}

export function TerminalPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const session = useSession(id ?? "");
    const machines = useMachines();
    const machine = terminalMachineForSession(session, machines);
    const hasLoadedSessions = useSessionsLoaded();
    const handoff = resolveTerminalHandoff(session, machine, hasLoadedSessions);
    const copy = handoffCopy(handoff.kind);
    const returnToChat = handoff.kind !== "not-found" && handoff.kind !== "loading" && session !== null;
    const destination = returnToChat && id ? `/session/${id}` : "/";
    const platformLabel = t(TERMINAL_PLATFORM_LABEL_KEYS[handoff.platform]);

    return (
        <div className="dark flex h-dvh min-w-0 flex-col bg-[#050507] pt-[env(safe-area-inset-top)] text-foreground">
            <header className="flex min-w-0 items-center gap-2.5 border-b border-border px-3.5 pb-2.5">
                <button
                    aria-label={t("terminal.back")}
                    className="flex size-11 shrink-0 items-center justify-center rounded-[10px] transition-[background-color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] motion-reduce:active:scale-100"
                    onClick={() => navigate(destination)}
                >
                    <ArrowLeft className="size-[17px]" />
                </button>
                <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[13.5px] font-semibold">
                        {session ? displayPath(session) : "remcli"}
                    </span>
                    {handoff.host && (
                        <span className="truncate font-mono text-[10px] text-muted-foreground">
                            {handoff.host}
                        </span>
                    )}
                </div>
            </header>

            <main
                aria-live="polite"
                className="flex min-w-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center"
            >
                {handoff.kind === "loading" ? (
                    <>
                        <Loader2 className="size-7 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
                        <span role="status" className="font-mono text-[12.5px] text-muted-foreground">
                            {copy.title}
                        </span>
                    </>
                ) : (
                    <>
                        {handoff.kind === "active" && (
                            <span
                                role="status"
                                className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-status-running/30 bg-status-running/10 px-2.5 py-1.5 font-mono text-[10px] text-status-running"
                            >
                                <span className="size-1.5 shrink-0 rounded-full bg-status-running" aria-hidden="true" />
                                <span className="truncate">{platformLabel}</span>
                            </span>
                        )}
                        <MonitorSmartphone className="size-8 text-zinc-600" aria-hidden="true" />
                        <span className="font-mono text-[12.5px] text-foreground">{copy.title}</span>
                        <span className="max-w-[420px] break-words font-mono text-[11px] leading-relaxed text-zinc-400 [overflow-wrap:anywhere]">
                            {copy.hint}
                        </span>
                        <button
                            type="button"
                            onClick={() => navigate(destination)}
                            className="mt-2 min-h-11 rounded-[9px] border border-status-running/35 bg-status-running/10 px-3.5 font-mono text-[12px] font-semibold text-status-running transition-[background-color,border-color,color,transform] duration-[var(--dur-micro)] ease-[var(--ease-out)] active:scale-[0.96] motion-reduce:active:scale-100"
                        >
                            {returnToChat ? t("terminal.handoff.toChat") : t("chat.ended.toList")}
                        </button>
                    </>
                )}
            </main>
        </div>
    );
}
