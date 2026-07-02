// remcli-web — Терминал сессии: честная заглушка.
// В P2P-протоколе демона (p2pSocketHandlers.ts / p2pRestRoutes.ts) нет терминальных
// событий или PTY-RPC — интерактивный терминал доступен только с хоста. Экран
// показывает контекст сессии (путь/хост из стора) и объясняет ограничение.
// ВСЕГДА тёмный (класс dark + фон #050507), независимо от темы.
import { ArrowLeft, TerminalSquare } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { t } from "@/lib/i18n";
import { useSession, type Session } from "@/lib/protocol";

function displayPath(session: Session): string {
    const path = session.metadata?.path ?? session.id;
    const home = session.metadata?.homeDir;
    return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

export function TerminalPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const session = useSession(id ?? "");

    const host = session?.metadata?.host;

    return (
        // принудительный dark: класс dark + свой фон #050507
        <div className="dark flex h-dvh flex-col bg-[#050507] pt-[env(safe-area-inset-top)] text-foreground">
            <header className="flex items-center gap-2.5 border-b border-border px-3.5 pb-2.5">
                <button
                    aria-label={t("terminal.back")}
                    className="flex size-[38px] items-center justify-center rounded-[10px]"
                    onClick={() => navigate(id ? `/session/${id}` : "/")}
                >
                    <ArrowLeft className="size-[17px]" />
                </button>
                <div className="flex flex-1 flex-col">
                    <span className="truncate font-mono text-[13.5px] font-semibold">
                        {session ? displayPath(session) : t("chat.notFound")}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                        {host ? `${host} · tty` : "tty"}
                    </span>
                </div>
            </header>

            {/* заглушка: терминальных событий в P2P-протоколе нет */}
            <main className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
                <TerminalSquare className="size-8 text-zinc-600" />
                <span className="font-mono text-[12.5px] text-zinc-400">
                    {t("terminal.stub.title")}
                </span>
                <span className="max-w-[420px] font-mono text-[11px] leading-relaxed text-zinc-600">
                    {t("terminal.stub.hint")}
                </span>
                <button
                    onClick={() => navigate(id ? `/session/${id}` : "/")}
                    className="mt-2 h-9 rounded-[9px] border border-border px-3.5 font-mono text-[12px] text-muted-foreground"
                >
                    {t("terminal.back")}
                </button>
            </main>
        </div>
    );
}
