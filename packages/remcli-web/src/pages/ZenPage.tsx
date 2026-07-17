// remcli-web — Zen / Задачи (design/screens/zen.tsx, разметка 1:1).
// Задачи — в KV демона (src/lib/zenTasks.ts: /v1/kv, ключ zen-tasks, OCC-ретраи,
// live-синк через kv-batch-update), связанные сессии — живые из стора протокола.
// «Работать над задачей» → /new с предзаполненным промптом; после спавна
// NewSessionPage линкует задачу к сессии.
import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, Play, Plus } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { StatusDot } from "@/components/kit";
import { sessionAgent, sessionPath, taskSessionStatus } from "@/components/app/sessionDisplay";
import { t } from "@/lib/i18n";
import { useSessions } from "@/lib/protocol";
import { addZenTask, loadZenTasks, subscribeZenTasks, toggleZenTask, type ZenTask } from "@/lib/zenTasks";

function TaskCheckbox({ isDone, onToggle }: { isDone: boolean; onToggle: () => void }) {
    if (isDone) {
        return (
            <span className="relative mt-0.5 size-[18px] shrink-0">
                <button
                    type="button"
                    aria-label={t("zen.toggleTask")}
                    onClick={onToggle}
                    className="absolute left-1/2 top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg transition-transform active:scale-[0.96]"
                >
                    <span className="flex size-[18px] items-center justify-center rounded-md bg-accent">
                        <Check className="size-2.5 text-accent-foreground" strokeWidth={3} />
                    </span>
                </button>
            </span>
        );
    }
    return (
        <span className="relative mt-0.5 size-[18px] shrink-0">
            <button
                type="button"
                aria-label={t("zen.toggleTask")}
                onClick={onToggle}
                className="absolute left-1/2 top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg transition-transform active:scale-[0.96]"
            >
                <span className="size-[18px] rounded-md border-[1.5px] border-muted-foreground/40" />
            </button>
        </span>
    );
}

export function ZenPage() {
    const navigate = useNavigate();
    const sessions = useSessions();
    const [tasks, setTasks] = useState<ZenTask[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [newTitle, setNewTitle] = useState("");

    // загрузка из KV демона + live-синк между устройствами (kv-batch-update)
    useEffect(() => {
        let isCancelled = false;
        loadZenTasks()
            .then((next) => { if (!isCancelled) setTasks(next); })
            .catch(() => { if (!isCancelled) toast.error(t("zen.syncFailed")); })
            .finally(() => { if (!isCancelled) setIsLoading(false); });
        const unsubscribe = subscribeZenTasks((next) => {
            if (!isCancelled) setTasks(next);
        });
        return () => {
            isCancelled = true;
            unsubscribe();
        };
    }, []);

    // OCC-мутация в KV: применяем результат, при ошибке — тост (состояние не трогаем)
    const applyMutation = (mutation: Promise<ZenTask[]>) => {
        mutation.then(setTasks).catch(() => toast.error(t("zen.syncFailed")));
    };

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
        applyMutation(addZenTask(title));
        setNewTitle("");
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <header className="flex items-baseline gap-2.5 px-5 pb-3 pt-1.5">
                <h1 className="text-xl font-semibold">{t("tabs.tasks")}</h1>
                <span className="font-mono text-[11px] text-muted-foreground">
                    {openCount} {t("zen.openCount")}
                </span>
            </header>

            <main className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4">
                {isLoading && (
                    <div className="flex justify-center py-6">
                        <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    </div>
                )}
                {orderedTasks.map((task, index) => {
                    const isLast = index === orderedTasks.length - 1;
                    const rowBorder = isLast ? "" : " border-b border-border/60";
                    const linkedSession = !task.isDone && task.sessionId
                        ? sessions.find((session) => session.id === task.sessionId)
                        : undefined;

                    // выполненная
                    if (task.isDone) {
                        return (
                            <div key={task.id} className={"flex items-start gap-3 px-2 py-3.5" + rowBorder}>
                                <TaskCheckbox isDone onToggle={() => applyMutation(toggleZenTask(task.id))} />
                                <span className="text-[14.5px] leading-snug text-muted-foreground line-through">{task.title}</span>
                            </div>
                        );
                    }

                    // задача со связанной живой сессией
                    if (linkedSession) {
                        return (
                            <div key={task.id} className={`flex items-start gap-3 px-2 py-3.5${rowBorder}`}>
                                <TaskCheckbox isDone={false} onToggle={() => applyMutation(toggleZenTask(task.id))} />
                                <div className="flex min-w-0 flex-1 flex-col gap-2">
                                    <span className="text-[14.5px] leading-snug">{task.title}</span>
                                    <button
                                        type="button"
                                        onClick={() => navigate(`/session/${linkedSession.id}`)}
                                        className="flex min-h-11 max-w-full items-center gap-1.5 overflow-hidden rounded-[7px] border border-border bg-card px-3 font-mono text-[10.5px] text-muted-foreground transition-[background-color,border-color,color,transform] active:scale-[0.96] lg:min-h-8 lg:px-2.5"
                                    >
                                        <StatusDot status={taskSessionStatus(linkedSession)} className="size-[5px]" />
                                        <span className="min-w-0 truncate">{sessionPath(linkedSession)}</span>
                                        <span className="shrink-0">· {sessionAgent(linkedSession)}</span>
                                    </button>
                                </div>
                            </div>
                        );
                    }

                    // задача без живой сессии → CTA «работать» (new-session с prefill промпта)
                    return (
                        <div key={task.id} className={`flex items-start gap-3 px-2 py-3.5${rowBorder}`}>
                            <TaskCheckbox isDone={false} onToggle={() => applyMutation(toggleZenTask(task.id))} />
                            <div className="flex flex-1 flex-col gap-2">
                                <span className="text-[14.5px] leading-snug">{task.title}</span>
                                <button
                                    type="button"
                                    onClick={() => navigate("/new", { state: { zenTaskTitle: task.title, zenTaskId: task.id } })}
                                    className="flex h-11 w-fit items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-transform active:scale-[0.96] lg:h-8"
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
