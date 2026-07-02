// remcli-web — Новая сессия (перенос design/screens/new-session.tsx, разметка 1:1).
// Машина → агент (4 карточки) → модель → разрешения → директория + resume-sheet
// (bottom-sheet по эталону design/pages/new-session.html; MOTION.md §7 — vaul drawer).
import * as React from "react";
import { ChevronDown, RotateCcw, X } from "lucide-react";
import { useNavigate } from "react-router";
import { AgentIcon, Segmented, StatusDot, type AgentId } from "@/components/kit";
import { Drawer, DrawerContent, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { agentOptions, machines, newSessionResumeEntries, recentDirs } from "@/mocks/fixtures";

type SheetKind = "machine" | "model" | "resume";

const SHEET_CONTENT_CLASS =
    "rounded-t-[20px] border-border bg-card pb-[max(10px,env(safe-area-inset-bottom))] " +
    "[&>div:first-child]:mt-2 [&>div:first-child]:mb-1 [&>div:first-child]:h-[4.5px] [&>div:first-child]:w-[38px] [&>div:first-child]:bg-muted-foreground/40";

function SheetHeader({ title, tag }: { title: string; tag: string }) {
    return (
        <div className="flex items-center px-[18px] pb-2 pt-1">
            <DrawerTitle className="text-[14.5px] font-semibold">{title}</DrawerTitle>
            <span className="ml-auto font-mono text-[10px] text-muted-foreground/70">{tag}</span>
        </div>
    );
}

function SheetRow({ isActive, label, meta, onClick }: { isActive: boolean; label: string; meta?: React.ReactNode; onClick: () => void }) {
    return (
        <button onClick={onClick} className="flex w-full items-center gap-[11px] border-t border-border px-[18px] py-3 text-left">
            <span className={`flex-1 font-mono text-[12.5px] ${isActive ? "text-foreground" : "text-muted-foreground"}`}>{label}</span>
            {meta}
        </button>
    );
}

export function NewSessionPage() {
    const navigate = useNavigate();
    const [machineId, setMachineId] = React.useState(machines[0].id);
    const [agent, setAgent] = React.useState<AgentId>("claude");
    const [model, setModel] = React.useState(agentOptions[0].models[0]);
    const [mode, setMode] = React.useState("ask");
    const [dir, setDir] = React.useState(recentDirs[0].path);
    const [isOtherDirOpen, setIsOtherDirOpen] = React.useState(false);
    const [customDir, setCustomDir] = React.useState("");
    const [sheet, setSheet] = React.useState<SheetKind | null>(null);

    const machine = machines.find((m) => m.id === machineId) ?? machines[0];
    const agentModels = agentOptions.find((a) => a.id === agent)?.models ?? [];
    const resumeItems = newSessionResumeEntries.filter((e) => e.agent === agent);
    const activeDir = isOtherDirOpen && customDir.trim() !== "" ? customDir.trim() : dir;

    const selectAgent = (id: AgentId) => {
        setAgent(id);
        const nextModel = agentOptions.find((a) => a.id === id)?.models[0];
        if (nextModel) setModel(nextModel);
    };

    const selectDir = (path: string) => {
        setDir(path);
        setIsOtherDirOpen(false);
        setCustomDir("");
    };

    return (
        <div className="flex min-h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
            <header className="flex items-center px-5 pb-3 pt-1.5">
                <h1 className="text-xl font-semibold">{t("new.title")}</h1>
                <button aria-label={t("new.close")} onClick={() => navigate(-1)}
                    className="ml-auto flex size-[38px] items-center justify-center rounded-[10px] border border-border">
                    <X className="size-4 text-muted-foreground" />
                </button>
            </header>

            <main className="flex flex-1 flex-col gap-4.5 overflow-y-auto px-5 [&>*]:shrink-0">
                {/* машина */}
                <button onClick={() => setSheet("machine")}
                    className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3.5 py-3">
                    <span className="w-[52px] text-left font-mono text-[10px] text-muted-foreground/70">{t("new.machine")}</span>
                    <span className="font-mono text-[13px] font-semibold">{machine.name}</span>
                    <span className={`size-1.5 rounded-full ${machine.isOnline ? "bg-status-running" : "bg-status-offline"}`} />
                    <ChevronDown className="ml-auto size-3 text-muted-foreground" />
                </button>

                {/* агент — 4 карточки */}
                <section className="flex flex-col gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground/70">{t("new.agent")}</span>
                    <div className="grid grid-cols-2 gap-2">
                        {agentOptions.map((a) => (
                            <button key={a.id} onClick={() => selectAgent(a.id)}
                                className={`flex items-center gap-2.5 rounded-xl border bg-card p-3 text-left ${agent === a.id ? "border-accent ring-[3px] ring-accent/10" : "border-border"}`}>
                                <AgentIcon agent={a.id} className="size-[30px] rounded-lg text-[11px]" />
                                <span className="flex flex-col">
                                    <span className="text-[13px] font-semibold">{a.name}</span>
                                    <span className="font-mono text-[9.5px] text-muted-foreground">{a.kind}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </section>

                {/* модель + режим разрешений */}
                <div className="flex gap-2">
                    <section className="flex flex-[1.2] flex-col gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground/70">{t("new.model")}</span>
                        <button onClick={() => setSheet("model")}
                            className="flex h-11 items-center rounded-[10px] border border-input bg-muted px-3 font-mono text-xs">
                            {model} <ChevronDown className="ml-auto size-3 text-muted-foreground" />
                        </button>
                    </section>
                    <section className="flex flex-[1.6] flex-col gap-2">
                        <span className="font-mono text-[10px] text-muted-foreground/70">{t("new.permissions")}</span>
                        <Segmented options={["safe", "ask", "auto"]} value={mode} onChange={setMode} />
                    </section>
                </div>

                {/* директория — недавние + ввод */}
                <section className="flex flex-col gap-2">
                    <span className="font-mono text-[10px] text-muted-foreground/70">{t("new.dirRecent")}</span>
                    <div className="overflow-hidden rounded-xl border border-border">
                        {recentDirs.map((d, i) => {
                            const isActive = activeDir === d.path;
                            return (
                                <button key={d.path} onClick={() => selectDir(d.path)}
                                    className={`flex w-full items-center gap-2.5 px-3.5 py-3 font-mono text-[12.5px] ${i > 0 ? "border-t border-border " : ""}${isActive ? "bg-secondary" : "bg-card text-muted-foreground"}`}>
                                    <span className={isActive ? "text-accent" : "text-muted-foreground/40"}>›</span> {d.path}
                                    <span className="ml-auto text-[10px] text-muted-foreground/70">{d.lastUsedLabel}</span>
                                </button>
                            );
                        })}
                        {isOtherDirOpen ? (
                            <div className="flex w-full items-center gap-2.5 border-t border-border bg-card px-3.5 py-1.5 font-mono text-[12.5px]">
                                <span className={customDir.trim() !== "" ? "text-accent" : "text-muted-foreground/40"}>›</span>
                                <Input autoFocus value={customDir} onChange={(e) => setCustomDir(e.target.value)}
                                    placeholder={t("new.otherDirPlaceholder")}
                                    className="h-8 rounded-none border-none bg-transparent px-0 font-mono text-[12.5px] shadow-none focus-visible:ring-0" />
                            </div>
                        ) : (
                            <button onClick={() => setIsOtherDirOpen(true)}
                                className="flex w-full items-center gap-2.5 border-t border-border bg-card px-3.5 py-3 font-mono text-[12.5px] text-muted-foreground/70">
                                <span>+</span> {t("new.otherDir")}
                            </button>
                        )}
                    </div>
                </section>

                {/* resume: открывает bottom-sheet со списком прошлых сессий агента (rc-42 · сегодня 12:41 …) */}
                <button onClick={() => setSheet("resume")}
                    className="flex h-10 items-center justify-center gap-2 rounded-[10px] border border-dashed border-border font-mono text-[11.5px] text-muted-foreground">
                    <RotateCcw className="size-3" /> {t("new.resumePrefix")} {agent}…
                </button>
            </main>

            <footer className="px-5 pb-[max(14px,env(safe-area-inset-bottom))] pt-3">
                <button onClick={() => navigate("/session/s-remcli")}
                    className="h-[52px] w-full rounded-xl bg-accent text-base font-semibold text-accent-foreground">
                    {t("new.start")} {agent} {t("new.startIn")} {activeDir}
                </button>
            </footer>

            <Drawer open={sheet !== null} onOpenChange={(isOpen) => { if (!isOpen) setSheet(null); }}>
                <DrawerContent className={SHEET_CONTENT_CLASS}>
                    {sheet === "machine" && (
                        <>
                            <SheetHeader title={t("new.machineTitle")} tag={t("new.machine")} />
                            {machines.map((m) => (
                                <SheetRow key={m.id} isActive={m.id === machineId} label={m.name}
                                    meta={
                                        <>
                                            <StatusDot status={m.isOnline ? "running" : "offline"} className="size-1.5" />
                                            <span className="font-mono text-[10px] text-muted-foreground/70">
                                                {m.isOnline ? m.latencyLabel : m.lastSeenLabel}
                                            </span>
                                        </>
                                    }
                                    onClick={() => { setMachineId(m.id); setSheet(null); }} />
                            ))}
                        </>
                    )}
                    {sheet === "model" && (
                        <>
                            <SheetHeader title={t("new.modelTitle")} tag={agent} />
                            {agentModels.map((m) => (
                                <SheetRow key={m} isActive={m === model} label={m}
                                    onClick={() => { setModel(m); setSheet(null); }} />
                            ))}
                        </>
                    )}
                    {sheet === "resume" && (
                        <>
                            <SheetHeader title={`${t("new.resumeTitle")} · ${agent}`} tag={t("new.resumeTag")} />
                            {resumeItems.length === 0 ? (
                                <div className="border-t border-border px-[18px] py-3 font-mono text-[12.5px] text-muted-foreground/70">
                                    {t("new.resumeEmpty")}
                                </div>
                            ) : resumeItems.map((e, i) => (
                                <SheetRow key={e.id} isActive={i === 0} label={e.title}
                                    meta={<span className="font-mono text-[10px] text-muted-foreground/70">{e.timeLabel}</span>}
                                    onClick={() => { setSheet(null); navigate("/session/s-remcli"); }} />
                            ))}
                        </>
                    )}
                </DrawerContent>
            </Drawer>
        </div>
    );
}
