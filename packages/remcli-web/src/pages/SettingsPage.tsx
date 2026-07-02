// remcli-web — Настройки (design/screens/settings.tsx, разметка 1:1). Сгруппированные списки.
// Layout (safe-area + таб-бар) даёт TabLayout; данные — живой P2P-стор (@/lib/protocol):
// машины (rename через machine-update-metadata, удаление локально), TTS-статус демона,
// язык (10 локалей, @/lib/i18n), отключение (logout → /connect).
import * as React from "react";
import { ChevronRight, LogOut, MoreHorizontal, QrCode } from "lucide-react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { Segmented, StatusDot } from "@/components/kit";
import { useTheme, type Theme } from "@/components/theme/ThemeProvider";
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
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { LOCALES, setLocale, t, useLocale } from "@/lib/i18n";
import {
    forgetMachine,
    logoutProtocolClient,
    machineSetDisplayName,
    useMachines,
    type Machine,
} from "@/lib/protocol";
import {
    getAutoSpeakEnabled,
    getStoredTtsVoice,
    setAutoSpeakEnabled,
    setStoredTtsVoice,
    useTtsAvailability,
} from "@/lib/voice/tts";

const THEME_OPTIONS: { labelKey: "settings.theme.light" | "settings.theme.dark" | "settings.theme.system"; value: Theme }[] = [
    { labelKey: "settings.theme.light", value: "light" },
    { labelKey: "settings.theme.dark", value: "dark" },
    { labelKey: "settings.theme.system", value: "system" },
];

function machineName(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || machine.id;
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-2">
            <span className="px-1 font-mono text-[10px] text-muted-foreground/70">{label}</span>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">{children}</div>
        </section>
    );
}

function Row({ label, value, chevron, children }: { label: string; value?: string; chevron?: boolean; children?: React.ReactNode }) {
    return (
        <div className="flex min-h-12 items-center gap-2.5 px-3.5 py-2.5">
            <span className="flex-1 text-[13.5px]">{label}</span>
            {value && <span className="font-mono text-xs text-muted-foreground">{value}</span>}
            {children}
            {chevron && <ChevronRight className="size-3 text-muted-foreground/60" />}
        </div>
    );
}

/** Строка-пикер: та же разметка Row, но кнопка-триггер выпадающего списка. */
function PickerRow({ label, value, options, onSelect }: { label: string; value: string; options: string[]; onSelect: (v: string) => void }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button type="button" className="flex min-h-12 w-full items-center gap-2.5 px-3.5 py-2.5 text-left">
                    <span className="flex-1 text-[13.5px]">{label}</span>
                    <span className="font-mono text-xs text-muted-foreground">{value}</span>
                    <ChevronRight className="size-3 text-muted-foreground/60" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
                <DropdownMenuRadioGroup value={value} onValueChange={onSelect}>
                    {options.map((option) => (
                        <DropdownMenuRadioItem key={option} value={option} className="font-mono text-xs">
                            {option}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** Тумблер (разметка эталона settings.html: трек 36×22, бегунок 18px). */
function ToggleSwitch({ isOn, onToggle }: { isOn: boolean; onToggle: () => void }) {
    return (
        <button type="button" role="switch" aria-checked={isOn} onClick={onToggle}
            className={`relative h-[22px] w-9 rounded-full transition-colors ${isOn ? "bg-accent" : "bg-border"}`}>
            <span className={`absolute left-0.5 top-0.5 size-[18px] rounded-full transition-transform ${isOn ? "translate-x-[14px] bg-accent-foreground" : "bg-muted-foreground"}`} />
        </button>
    );
}

export function SettingsPage() {
    const navigate = useNavigate();
    const { theme, setTheme } = useTheme();
    const locale = useLocale();
    const machines = useMachines();
    const tts = useTtsAvailability();

    const [voice, setVoice] = React.useState<string | null>(getStoredTtsVoice);
    const [isAutoSpeak, setIsAutoSpeak] = React.useState(getAutoSpeakEnabled);
    const [renameTarget, setRenameTarget] = React.useState<Machine | null>(null);
    const [renameValue, setRenameValue] = React.useState("");
    const [isRenaming, setIsRenaming] = React.useState(false);
    const [deleteTarget, setDeleteTarget] = React.useState<Machine | null>(null);

    const themeLabel = t(THEME_OPTIONS.find((o) => o.value === theme)?.labelKey ?? "settings.theme.dark");
    const localeLabel = LOCALES.find((l) => l.id === locale)?.label ?? locale;

    // Провайдер задаётся конфигом демона (~/.remcli/setup.json) — показываем статус
    const providerValue = tts.isChecking && !tts.status
        ? t("settings.ttsChecking")
        : tts.status
            ? (tts.status.available ? tts.status.provider : t("settings.ttsOff"))
            : t("tts.unavailable");
    const voices = tts.status?.voices ?? [];
    const voiceValue = voice && voices.includes(voice) ? voice : voices[0] ?? "—";

    // Версия демона — из метаданных самой свежей машины
    const daemonVersion = machines.find((m) => m.metadata?.remcliCliVersion)?.metadata?.remcliCliVersion;

    const selectVoice = (next: string) => {
        setVoice(next);
        setStoredTtsVoice(next);
    };

    const toggleAutoSpeak = () => {
        setIsAutoSpeak((current) => {
            setAutoSpeakEnabled(!current);
            return !current;
        });
    };

    const openRename = (machine: Machine) => {
        setRenameTarget(machine);
        setRenameValue(machineName(machine));
    };

    const submitRename = async () => {
        if (!renameTarget || isRenaming) return;
        setIsRenaming(true);
        try {
            await machineSetDisplayName(renameTarget.id, renameValue);
            setRenameTarget(null);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("status.error"));
        } finally {
            setIsRenaming(false);
        }
    };

    const submitDelete = () => {
        if (!deleteTarget) return;
        forgetMachine(deleteTarget.id);
        setDeleteTarget(null);
    };

    const disconnect = () => {
        logoutProtocolClient();
        navigate("/connect", { replace: true });
    };

    return (
        <>
            <header className="px-5 pb-3 pt-1.5"><h1 className="text-xl font-semibold">{t("settings.title")}</h1></header>

            <main className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
                <Group label={t("settings.group.appearance")}>
                    <Row label={t("settings.theme")}>
                        <div className="w-44">
                            <Segmented
                                options={THEME_OPTIONS.map((o) => t(o.labelKey))}
                                value={themeLabel}
                                onChange={(label) => {
                                    const next = THEME_OPTIONS.find((o) => t(o.labelKey) === label);
                                    if (next) setTheme(next.value);
                                }}
                            />
                        </div>
                    </Row>
                    <PickerRow
                        label={t("settings.language")}
                        value={localeLabel}
                        options={LOCALES.map((l) => l.label)}
                        onSelect={(label) => {
                            const next = LOCALES.find((l) => l.label === label);
                            if (next) setLocale(next.id);
                        }}
                    /> {/* 10 локалей */}
                </Group>

                <Group label={t("settings.group.voice")}>
                    <Row label={t("settings.ttsProvider")} value={providerValue} />
                    {voices.length > 0 && (
                        <PickerRow label={t("settings.ttsVoice")} value={voiceValue} options={voices} onSelect={selectVoice} />
                    )}
                    <Row label={t("settings.autoSpeak")}>
                        <ToggleSwitch isOn={isAutoSpeak} onToggle={toggleAutoSpeak} />
                    </Row>
                </Group>

                <Group label={t("settings.group.machines")}>
                    {machines.length === 0 && (
                        <div className="flex min-h-12 items-center px-3.5 py-2.5">
                            <span className="font-mono text-xs text-muted-foreground">{t("settings.machine.empty")}</span>
                        </div>
                    )}
                    {machines.map((machine) => (
                        <div key={machine.id} className="flex min-h-12 items-center gap-2.5 px-3.5 py-2.5">
                            <StatusDot status={machine.active ? "running" : "offline"} className="size-[7px]" />
                            <span className={`flex-1 font-mono text-[12.5px] ${machine.active ? "" : "text-muted-foreground"}`}>{machineName(machine)}</span>
                            <span className="font-mono text-[10px] text-muted-foreground/70">
                                {machine.active ? t("home.machine.online") : t("status.offline")}
                            </span>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button type="button" aria-label={machineName(machine)} className="flex items-center">
                                        <MoreHorizontal className="size-4 text-muted-foreground/60" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem className="font-mono text-xs" onSelect={() => openRename(machine)}>
                                        {t("settings.machine.rename")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem variant="destructive" className="font-mono text-xs" onSelect={() => setDeleteTarget(machine)}>
                                        {t("settings.machine.delete")}
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        </div>
                    ))}
                    <button type="button" onClick={() => navigate("/connect")} className="flex min-h-12 w-full items-center gap-2.5 px-3.5 py-2.5 text-accent">
                        <QrCode className="size-[13px]" />
                        <span className="text-[13px] font-medium">{t("settings.addMachineQr")}</span>
                    </button>
                </Group>

                <Group label={t("settings.group.about")}>
                    <Row label={t("settings.version")} value={daemonVersion ? `${t("settings.daemon")} v${daemonVersion}` : "—"} />
                    <button type="button" onClick={disconnect} className="flex min-h-12 w-full items-center gap-2.5 px-3.5 py-2.5 text-status-error">
                        <LogOut className="size-[13px]" />
                        <span className="text-[13px] font-medium">{t("settings.disconnect")}</span>
                    </button>
                </Group>
            </main>

            {/* Переименование машины (machine-update-metadata, OCC retry) */}
            <Dialog open={renameTarget !== null} onOpenChange={(isOpen) => { if (!isOpen) setRenameTarget(null); }}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="text-base">{t("settings.machine.renameTitle")}</DialogTitle>
                    </DialogHeader>
                    <Input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        placeholder={t("settings.machine.renamePlaceholder")}
                        className="font-mono text-sm"
                        onKeyDown={(event) => { if (event.key === "Enter") void submitRename(); }}
                        autoFocus
                    />
                    <DialogFooter>
                        <Button variant="outline" size="sm" onClick={() => setRenameTarget(null)}>{t("common.cancel")}</Button>
                        <Button size="sm" disabled={isRenaming} onClick={() => void submitRename()}>{t("common.save")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Удаление машины (локально: у демона нет DELETE /v1/machines) */}
            <Dialog open={deleteTarget !== null} onOpenChange={(isOpen) => { if (!isOpen) setDeleteTarget(null); }}>
                <DialogContent className="max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="text-base">{t("settings.machine.deleteTitle")}</DialogTitle>
                        <DialogDescription className="font-mono text-xs">
                            {deleteTarget ? machineName(deleteTarget) : ""} · {t("settings.machine.deleteHint")}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>{t("common.cancel")}</Button>
                        <Button variant="destructive" size="sm" onClick={submitDelete}>{t("common.delete")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
