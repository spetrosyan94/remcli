// remcli-web — Zen / Задачи (design/screens/zen.tsx, разметка 1:1).
// Задачи — в localStorage (src/lib/zenTasks.ts: KV-эндпоинты P2P-демона — заглушки),
// связанные сессии — живые из стора протокола. «Работать над задачей» → /new
// с предзаполненным промптом; после спавна NewSessionPage линкует задачу к сессии.
import { useMemo, useState } from "react";
import { Check, Play, Plus } from "lucide-react";
import { useNavigate } from "react-router";
import { StatusDot, type AgentId, type Status } from "@/components/kit";
import { t } from "@/lib/i18n";
import { useSessions, type Session } from "@/lib/protocol";
import { addZenTask, loadZenTasks, toggleZenTask, type ZenTask } from "@/lib/zenTasks";

function sessionStatus(session: Session): Status {
    if (!session.active) return "offline";
    if (Object.keys(session.agentState?.requests ?? {}).length > 0) return "permission";
    if (session.thinking) return "thinking";
    return "running";
}

function sessionAgent(session: Session): AgentId {
    const flavor = session.metadata?.flavor;
    return flavor === "codex" || flavor === "gemini" || flavor === "cursor" ? flavor : "claude";
}

/** Абсолютный путь → «~/…» для показа. */
function sessionPath(session: Session): string {
    const path = session.metadata?.path ?? "";
    const homeDir = session.metadata?.homeDir;
    if (!homeDir || !path.startsWith(homeDir)) return path;
    const rest = path.slice(homeDir.length);
    if (rest === "") return "~";
    return rest.startsWith("/") || rest.startsWith("\\") ? `~${rest}` : path;
}

function TaskCheckbox({ isDone, onToggle }: { isDone: boolean; onToggle: () => void }) {
    if (isDone) {
        return (
            <button
                type="button"
                aria-label={t("zen.toggleTask")}
                onClick={onToggle}
                className="mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-md bg-accent"
            >
                <Check className="size-2.5 text-accent-foreground" strokeWidth={3} />
            </button>
        );
    }
    return (
        <button
            type="button"
            aria-label={t("zen.toggleTask")}
            onClick={onToggle}
            className="mt-0.5 size-[18px] shrink-0 rounded-md border-[1.5px] border-muted-foreground/40"
        />
    );
}

export function ZenPage() {
    const navigate = useNavigate();
    const sessions = useSessions();
    const [tasks, setTasks] = useState<ZenTask[]>(() => loadZenTasks());
    const [newTitle, setNewTitle] = useState("");

    // выполненные — вниз списка, как в эталоне
    const orderedTasks = useMemo(
        () => [...tasks.filter((task) => !task.isDone), ...tasks.filter((task) => task.isDone)],
        [tasks],
    );
    const openCount = tasks.filter((task) => !task.isDone).length;

    const submitNewTask = (event: React.FormEvent) => {
        event.preventDefault();
        const title = newTitle.trim();
        if (title === "") return;
        setTasks(addZenTask(title));
        setNewTitle("");
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex items-baseline gap-2.5 px-5 pb-3 pt-1.5">
                <h1 className="text-xl font-semibold">{t("tabs.tasks")}</h1>
                <span className="font-mono text-[11px] text-muted-foreground/70">
                    {openCount} {t("zen.openCount")}
                </span>
            </header>

            <main className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
                {orderedTasks.map((task, index) => {
                    const isLast = index === orderedTasks.length - 1;
                    const rowBorder = isLast ? "" : " border-b border-border/60";
                    const linkedSession = !task.isDone && task.sessionId
                        ? sessions.find((session) => session.id === task.sessionId)
                        : undefined;

                    // выполненная
                    if (task.isDone) {
                        return (
                            <div key={task.id} className={`flex items-start gap-3 px-2 py-3.5 opacity-45${rowBorder}`}>
                                <TaskCheckbox isDone onToggle={() => setTasks(toggleZenTask(task.id))} />
                                <span className="text-[14.5px] leading-snug text-muted-foreground line-through">{task.title}</span>
                            </div>
                        );
                    }

                    // задача со связанной живой сессией
                    if (linkedSession) {
                        return (
                            <div key={task.id} className={`flex items-start gap-3 px-2 py-3.5${rowBorder}`}>
                                <TaskCheckbox isDone={false} onToggle={() => setTasks(toggleZenTask(task.id))} />
                                <div className="flex flex-1 flex-col gap-2">
                                    <span className="text-[14.5px] leading-snug">{task.title}</span>
                                    <button
                                        type="button"
                                        onClick={() => navigate(`/session/${linkedSession.id}`)}
                                        className="flex w-fit items-center gap-1.5 rounded-[7px] border border-border bg-card px-2.5 py-1 font-mono text-[10.5px] text-muted-foreground"
                                    >
                                        <StatusDot status={sessionStatus(linkedSession)} className="size-[5px]" />
                                        {sessionPath(linkedSession)} · {sessionAgent(linkedSession)}
                                    </button>
                                </div>
                            </div>
                        );
                    }

                    // задача без живой сессии → CTA «работать» (new-session с prefill промпта)
                    return (
                        <div key={task.id} className={`flex items-start gap-3 px-2 py-3.5${rowBorder}`}>
                            <TaskCheckbox isDone={false} onToggle={() => setTasks(toggleZenTask(task.id))} />
                            <div className="flex flex-1 flex-col gap-2">
                                <span className="text-[14.5px] leading-snug">{task.title}</span>
                                <button
                                    type="button"
                                    onClick={() => navigate("/new", { state: { zenTaskTitle: task.title, zenTaskId: task.id } })}
                                    className="flex h-8 w-fit items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground"
                                >
                                    <Play className="size-2.5 fill-current" /> {t("zen.workOnTask")}
                                </button>
                            </div>
                        </div>
                    );
                })}
            </main>

            <footer className="px-4 pb-3 pt-2.5">
                <form onSubmit={submitNewTask}
                    className="flex h-12 items-center gap-2.5 rounded-xl border border-border bg-card px-4 text-sm">
                    <Plus className="size-3.5 shrink-0 text-accent" />
                    <input
                        value={newTitle}
                        onChange={(event) => setNewTitle(event.target.value)}
                        placeholder={t("zen.newTask")}
                        className="h-full w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    />
                </form>
            </footer>
        </div>
    );
}
