// remcli-web — Zen / Задачи (design/screens/zen.tsx, разметка 1:1). Самый тихий экран.
// Layout (min-h-dvh, safe-area, таб-бар) даёт TabLayout — здесь только header/main/footer.
import { useMemo, useState } from "react";
import { Check, Play, Plus } from "lucide-react";
import { useNavigate } from "react-router";
import { StatusDot } from "@/components/kit";
import { t } from "@/lib/i18n";
import { sessions, zenTasks, type MockZenTask } from "@/mocks/fixtures";

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
    const [tasks, setTasks] = useState<MockZenTask[]>(zenTasks);

    // выполненные — вниз списка, как в эталоне
    const orderedTasks = useMemo(
        () => [...tasks.filter((task) => !task.isDone), ...tasks.filter((task) => task.isDone)],
        [tasks],
    );
    const openCount = tasks.filter((task) => !task.isDone).length;

    const toggleTask = (id: string) => {
        setTasks((prev) => prev.map((task) => (task.id === id ? { ...task, isDone: !task.isDone } : task)));
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
                                <TaskCheckbox isDone onToggle={() => toggleTask(task.id)} />
                                <span className="text-[14.5px] leading-snug text-muted-foreground line-through">{task.title}</span>
                            </div>
                        );
                    }

                    // задача со связанной живой сессией
                    if (linkedSession) {
                        return (
                            <div key={task.id} className={`flex items-start gap-3 px-2 py-3.5${rowBorder}`}>
                                <TaskCheckbox isDone={false} onToggle={() => toggleTask(task.id)} />
                                <div className="flex flex-1 flex-col gap-2">
                                    <span className="text-[14.5px] leading-snug">{task.title}</span>
                                    <button
                                        type="button"
                                        onClick={() => navigate(`/session/${linkedSession.id}`)}
                                        className="flex w-fit items-center gap-1.5 rounded-[7px] border border-border bg-card px-2.5 py-1 font-mono text-[10.5px] text-muted-foreground"
                                    >
                                        <StatusDot status={linkedSession.status} className="size-[5px]" /> {linkedSession.path} · {linkedSession.agent}
                                    </button>
                                </div>
                            </div>
                        );
                    }

                    // задача без сессии → CTA «работать» (запускает new-session с prefill)
                    if (task.hasWorkCta) {
                        return (
                            <div key={task.id} className={`flex items-start gap-3 px-2 py-3.5${rowBorder}`}>
                                <TaskCheckbox isDone={false} onToggle={() => toggleTask(task.id)} />
                                <div className="flex flex-1 flex-col gap-2">
                                    <span className="text-[14.5px] leading-snug">{task.title}</span>
                                    <button
                                        type="button"
                                        onClick={() => navigate("/new", { state: { zenTaskTitle: task.title } })}
                                        className="flex h-8 w-fit items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground"
                                    >
                                        <Play className="size-2.5 fill-current" /> {t("zen.workOnTask")}
                                    </button>
                                </div>
                            </div>
                        );
                    }

                    return (
                        <div key={task.id} className={`flex items-start gap-3 px-2 py-3.5${rowBorder}`}>
                            <TaskCheckbox isDone={false} onToggle={() => toggleTask(task.id)} />
                            <span className="text-[14.5px] leading-snug">{task.title}</span>
                        </div>
                    );
                })}
            </main>

            <footer className="px-4 pb-3 pt-2.5">
                <div className="flex h-12 items-center gap-2.5 rounded-xl border border-border bg-card px-4 text-sm text-muted-foreground">
                    <Plus className="size-3.5 text-accent" /> {t("zen.newTask")}
                </div>
            </footer>
        </div>
    );
}
