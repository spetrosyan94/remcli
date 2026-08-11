// remcli-web — Zen / Задачи (design/screens/zen.tsx, разметка 1:1).
// Задачи хранятся в KV демона; удаление задачи не затрагивает AI-сессию.
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, MoreHorizontal, Play, Plus, Trash2 } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { StatusDot } from "@/components/kit";
import { sessionAgent, sessionPath, taskSessionStatus } from "@/components/app/sessionDisplay";
import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/lib/i18n";
import { useSessions } from "@/lib/protocol";
import {
    addZenTask,
    deleteZenTask,
    loadZenTasks,
    subscribeZenTasks,
    toggleZenTask,
    type ZenTask,
} from "@/lib/zenTasks";

function TaskCheckbox({ title, isDone, onToggle }: { title: string; isDone: boolean; onToggle: () => void }) {
    return (
        <span className="relative mt-0.5 size-[18px] shrink-0">
            <button
                type="button"
                aria-label={t("zen.toggleTask", { title })}
                aria-pressed={isDone}
                onClick={onToggle}
                className="absolute left-1/2 top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg transition-transform active:scale-[0.96]"
            >
                {isDone ? (
                    <span className="flex size-[18px] items-center justify-center rounded-md bg-accent">
                        <Check className="size-2.5 text-accent-foreground" strokeWidth={3} />
                    </span>
                ) : (
                    <span className="size-[18px] rounded-md border-[1.5px] border-muted-foreground/40" />
                )}
            </button>
        </span>
    );
}

interface TaskActionsProps {
    task: ZenTask;
    setTriggerRef: (node: HTMLButtonElement | null) => void;
    onDelete: (task: ZenTask) => void;
}

function TaskActions({ task, setTriggerRef, onDelete }: TaskActionsProps) {
    const [isOpen, setIsOpen] = useState(false);
    const [isDeletePending, setIsDeletePending] = useState(false);

    const requestDelete = () => {
        if (isDeletePending) return;
        setIsDeletePending(true);
        setIsOpen(false);
    };

    const openDeleteAfterMenuExit = (event: React.AnimationEvent<HTMLDivElement>) => {
        if (!isDeletePending || event.target !== event.currentTarget || event.currentTarget.dataset.state !== "closed") return;
        setIsDeletePending(false);
        requestAnimationFrame(() => {
            onDelete(task);
        });
    };

    return (
        <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    ref={setTriggerRef}
                    type="button"
                    aria-label={t("zen.taskActions", { title: task.title })}
                    className="-my-3.5 -mr-2 flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-[background-color,color,transform] hover:bg-muted hover:text-foreground active:scale-[0.96]"
                >
                    <MoreHorizontal className="size-[17px]" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-36" onAnimationEnd={openDeleteAfterMenuExit}>
                <DropdownMenuItem
                    variant="destructive"
                    className="min-h-11 font-mono text-xs"
                    onSelect={requestDelete}
                >
                    <Trash2 className="size-3.5" />
                    {t("common.delete")}
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function ZenPage() {
    const navigate = useNavigate();
    const sessions = useSessions();
    const [tasks, setTasks] = useState<ZenTask[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [hasLoadError, setHasLoadError] = useState(false);
    const [newTitle, setNewTitle] = useState("");
    const [isCreating, setIsCreating] = useState(false);
    const [deleteTarget, setDeleteTarget] = useState<ZenTask | null>(null);
    const [isDeleting, setIsDeleting] = useState(false);
    const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
    const returnFocusRef = useRef<HTMLElement | null>(null);
    const cancelButtonRef = useRef<HTMLButtonElement>(null);
    const newTaskInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        let isCancelled = false;
        loadZenTasks()
            .then((next) => {
                if (!isCancelled) {
                    setTasks(next);
                    setHasLoadError(false);
                }
            })
            .catch(() => {
                if (!isCancelled) {
                    setHasLoadError(true);
                    toast.error(t("zen.syncFailed"));
                }
            })
            .finally(() => { if (!isCancelled) setIsLoading(false); });
        const unsubscribe = subscribeZenTasks((next) => {
            if (!isCancelled) {
                setTasks(next);
                setHasLoadError(false);
            }
        });
        return () => {
            isCancelled = true;
            unsubscribe();
        };
    }, []);

    const applyMutation = (mutation: Promise<ZenTask[]>) => {
        mutation
            .then((next) => {
                setTasks(next);
                setHasLoadError(false);
            })
            .catch(() => toast.error(t("zen.syncFailed")));
    };

    const orderedTasks = useMemo(
        () => [...tasks.filter((task) => !task.isDone), ...tasks.filter((task) => task.isDone)],
        [tasks],
    );
    const openCount = tasks.filter((task) => !task.isDone).length;

    const submitNewTask = async (event: React.FormEvent) => {
        event.preventDefault();
        const title = newTitle.trim();
        if (title === "" || isCreating) return;

        setIsCreating(true);
        try {
            const next = await addZenTask(title);
            setTasks(next);
            setHasLoadError(false);
            setNewTitle("");
        } catch {
            toast.error(t("zen.syncFailed"));
        } finally {
            setIsCreating(false);
        }
    };

    const openDeleteDialog = (task: ZenTask) => {
        returnFocusRef.current = triggerRefs.current.get(task.id) ?? null;
        setDeleteTarget(task);
    };

    const closeDeleteDialog = () => {
        if (!isDeleting) setDeleteTarget(null);
    };

    const confirmDelete = async () => {
        if (!deleteTarget || isDeleting) return;
        const targetIndex = orderedTasks.findIndex((task) => task.id === deleteTarget.id);
        const nextTask = orderedTasks[targetIndex + 1] ?? orderedTasks[targetIndex - 1];
        const successFocusTarget = nextTask
            ? triggerRefs.current.get(nextTask.id) ?? newTaskInputRef.current
            : newTaskInputRef.current;
        setIsDeleting(true);
        try {
            const next = await deleteZenTask(deleteTarget.id);
            returnFocusRef.current = successFocusTarget;
            setTasks(next);
            setHasLoadError(false);
            setDeleteTarget(null);
        } catch {
            toast.error(t("zen.syncFailed"));
        } finally {
            setIsDeleting(false);
        }
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
                {!isLoading && hasLoadError && (
                    <div className="flex flex-1 items-center justify-center px-8 text-center font-mono text-xs leading-5 text-destructive">
                        {t("zen.syncFailed")}
                    </div>
                )}
                {!isLoading && !hasLoadError && orderedTasks.length === 0 && (
                    <div className="flex flex-1 items-center justify-center px-8 text-center font-mono text-xs leading-5 text-muted-foreground">
                        {t("zen.empty")}
                    </div>
                )}
                {orderedTasks.map((task, index) => {
                    const isLast = index === orderedTasks.length - 1;
                    const rowBorder = isLast ? "" : " border-b border-border/60";
                    const linkedSession = !task.isDone && task.sessionId
                        ? sessions.find((session) => session.id === task.sessionId)
                        : undefined;

                    return (
                        <div key={task.id} className={`flex min-w-0 items-start gap-3 px-2 py-3.5${rowBorder}`}>
                            <TaskCheckbox title={task.title} isDone={task.isDone} onToggle={() => applyMutation(toggleZenTask(task.id))} />
                            <div className="flex min-w-0 flex-1 flex-col gap-2">
                                <span className={`min-w-0 break-words text-[14.5px] leading-snug [overflow-wrap:anywhere] ${task.isDone ? "text-muted-foreground line-through" : ""}`}>
                                    {task.title}
                                </span>
                                {linkedSession && (
                                    <button
                                        type="button"
                                        onClick={() => navigate(`/session/${linkedSession.id}`)}
                                        className="flex min-h-11 max-w-full items-center gap-1.5 overflow-hidden rounded-[7px] border border-border bg-card px-3 font-mono text-[10.5px] text-muted-foreground transition-[background-color,border-color,color,transform] active:scale-[0.96] lg:min-h-8 lg:px-2.5"
                                    >
                                        <StatusDot status={taskSessionStatus(linkedSession)} className="size-[5px]" />
                                        <span className="min-w-0 truncate">{sessionPath(linkedSession)}</span>
                                        <span className="shrink-0">· {sessionAgent(linkedSession)}</span>
                                    </button>
                                )}
                                {!task.isDone && !linkedSession && (
                                    <button
                                        type="button"
                                        onClick={() => navigate("/new", { state: { zenTaskTitle: task.title, zenTaskId: task.id } })}
                                        className="flex h-11 w-fit items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-transform active:scale-[0.96] lg:h-8"
                                    >
                                        <Play className="size-2.5 fill-current" /> {t("zen.workOnTask")}
                                    </button>
                                )}
                            </div>
                            <TaskActions
                                task={task}
                                setTriggerRef={(node) => {
                                    if (node) triggerRefs.current.set(task.id, node);
                                    else triggerRefs.current.delete(task.id);
                                }}
                                onDelete={openDeleteDialog}
                            />
                        </div>
                    );
                })}
            </main>

            <footer className="px-4 pb-3 pt-2.5">
                <form
                    aria-busy={isCreating}
                    onSubmit={(event) => { void submitNewTask(event); }}
                    className="flex h-12 items-center gap-2 rounded-xl border border-border bg-card pl-4 pr-0.5 text-sm transition-[border-color] duration-[var(--dur-micro)] ease-[var(--ease-out)] focus-within:border-ring motion-reduce:transition-none"
                >
                    <input
                        ref={newTaskInputRef}
                        value={newTitle}
                        onChange={(event) => setNewTitle(event.target.value)}
                        placeholder={t("zen.newTask")}
                        aria-label={t("zen.newTask")}
                        className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                    />
                    <button
                        type="submit"
                        aria-label={t("zen.addTask")}
                        aria-busy={isCreating}
                        title={t("zen.addTask")}
                        disabled={newTitle.trim() === "" || isCreating}
                        className="flex size-11 shrink-0 items-center justify-center rounded-[9px] bg-accent text-accent-foreground transition-[background-color,color,transform,opacity] duration-[var(--dur-micro)] ease-[var(--ease-out)] hover:brightness-105 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none motion-reduce:active:scale-100"
                    >
                        {isCreating ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : <Plus className="size-4" />}
                    </button>
                </form>
            </footer>

            <Dialog open={deleteTarget !== null} onOpenChange={(isOpen) => { if (!isOpen) closeDeleteDialog(); }}>
                <DialogContent
                    showCloseButton={false}
                    className="max-w-[calc(100%-2rem)] rounded-2xl border-border bg-card sm:max-w-sm"
                    onOpenAutoFocus={(event) => {
                        event.preventDefault();
                        cancelButtonRef.current?.focus();
                    }}
                    onCloseAutoFocus={(event) => {
                        event.preventDefault();
                        requestAnimationFrame(() => returnFocusRef.current?.focus());
                    }}
                >
                    <DialogHeader>
                        <DialogTitle className="text-base">{t("zen.deleteTitle")}</DialogTitle>
                        <DialogDescription className="break-words font-mono text-xs leading-5 [overflow-wrap:anywhere]">
                            {deleteTarget ? `“${deleteTarget.title}” · ` : ""}{t("zen.deleteHint")}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button
                            ref={cancelButtonRef}
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-11 w-full lg:h-8 lg:w-auto"
                            disabled={isDeleting}
                            onClick={closeDeleteDialog}
                        >
                            {t("common.cancel")}
                        </Button>
                        <Button
                            type="button"
                            variant="destructive"
                            size="sm"
                            className="h-11 w-full lg:h-8 lg:w-auto"
                            disabled={isDeleting}
                            onClick={() => void confirmDelete()}
                        >
                            {isDeleting && <Loader2 className="size-3.5 animate-spin" />}
                            {t("common.delete")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
