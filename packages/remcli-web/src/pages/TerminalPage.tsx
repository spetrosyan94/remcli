// remcli-web — Терминал сессии (см. design/screens/terminal.tsx, разметка 1:1).
// ВСЕГДА тёмный (класс dark + фон #050507), независимо от темы.
import * as React from "react";
import { ArrowLeft, CornerDownLeft } from "lucide-react";
import { useNavigate, useParams } from "react-router";
import { Caret } from "@/components/kit";
import { t } from "@/lib/i18n";
import {
    terminalHeaderInfo,
    terminalOutputLines,
    terminalPromptSegments,
    terminalQuickKeys,
    type MockTerminalOutputLine,
    type MockTerminalSegment,
    type TerminalTone,
} from "@/mocks/fixtures";

const toneClasses: Record<TerminalTone, string> = {
    ok: "text-emerald-400",
    branch: "text-cyan-400",
    warn: "text-amber-400",
    muted: "text-zinc-500",
};

function TerminalSegments({ segments }: { segments: MockTerminalSegment[] }) {
    return (
        <>
            {segments.map((segment, index) =>
                segment.tone ? (
                    <span key={index} className={toneClasses[segment.tone]}>{segment.text}</span>
                ) : (
                    <React.Fragment key={index}>{segment.text}</React.Fragment>
                ),
            )}
        </>
    );
}

function TerminalLine({ line }: { line: MockTerminalOutputLine }) {
    const className = [line.isMuted ? "text-zinc-500" : "", line.hasTopGap ? "mt-2" : ""]
        .filter(Boolean)
        .join(" ");
    return (
        <div className={className || undefined}>
            <TerminalSegments segments={line.segments} />
            {line.hasCaret ? <Caret /> : null}
        </div>
    );
}

export function TerminalPage() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [lines, setLines] = React.useState<MockTerminalOutputLine[]>(terminalOutputLines);
    const [command, setCommand] = React.useState("");
    const outputRef = React.useRef<HTMLElement>(null);

    React.useEffect(() => {
        const output = outputRef.current;
        if (output) {
            output.scrollTop = output.scrollHeight;
        }
    }, [lines]);

    const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const trimmed = command.trim();
        if (!trimmed) {
            return;
        }
        setLines((prev) => {
            const executed: MockTerminalOutputLine = {
                id: `term-cmd-${Date.now()}`,
                hasTopGap: true,
                segments: [...terminalPromptSegments, { text: ` ${trimmed}` }],
            };
            const caretIndex = prev.findIndex((line) => line.hasCaret);
            if (caretIndex === -1) {
                return [...prev, executed];
            }
            return [...prev.slice(0, caretIndex), executed, ...prev.slice(caretIndex)];
        });
        setCommand("");
    };

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
                    <span className="font-mono text-[13.5px] font-semibold">{terminalHeaderInfo.cwd}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{terminalHeaderInfo.ptyLabel}</span>
                </div>
                <span className="flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/[0.08] px-2.5 py-1 font-mono text-[10px] text-accent">
                    <span className="size-1.5 rounded-full bg-status-running" /> {t("terminal.live")}
                </span>
            </header>

            {/* вывод */}
            <main ref={outputRef} className="flex-1 overflow-y-auto px-4 py-3.5 font-mono text-[11.5px] leading-[1.75] text-zinc-300">
                {lines.map((line) => (
                    <TerminalLine key={line.id} line={line} />
                ))}
            </main>

            {/* ввод команды + быстрые клавиши */}
            <footer className="border-t border-border px-3.5 pb-[max(12px,env(safe-area-inset-bottom))] pt-2">
                <form className="flex items-center gap-2" onSubmit={handleSubmit}>
                    <div className="flex h-11 flex-1 items-center gap-2 rounded-xl border border-input bg-card px-3 font-mono text-[13px]">
                        <span className="text-emerald-400">$</span>
                        <input
                            className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
                            placeholder={t("terminal.placeholder")}
                            value={command}
                            onChange={(event) => setCommand(event.target.value)}
                        />
                    </div>
                    <button type="submit" aria-label={t("terminal.run")} className="flex size-11 items-center justify-center rounded-xl bg-secondary">
                        <CornerDownLeft className="size-4" />
                    </button>
                </form>
                <div className="mt-2 flex gap-1.5 font-mono text-[10.5px] text-muted-foreground">
                    {terminalQuickKeys.map((key) => (
                        <button key={key} className="rounded-[7px] border border-border bg-card px-2.5 py-1.5">{key}</button>
                    ))}
                </div>
            </footer>
        </div>
    );
}
