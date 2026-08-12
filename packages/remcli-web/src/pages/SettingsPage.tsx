// remcli-web — Настройки (design/screens/settings.tsx, разметка 1:1). Сгруппированные списки.
// Layout (safe-area + таб-бар) даёт TabLayout; данные — живой P2P-стор (@/lib/protocol):
// машины (rename через machine-update-metadata, удаление — DELETE /v1/machines/:id,
// 403 для машины самого демона), TTS-статус демона, язык (10 локалей, @/lib/i18n),
// отключение (logout → /connect).
import * as React from "react";
import { ChevronRight, KeyRound, LoaderCircle, LogOut, MoreHorizontal, QrCode } from "lucide-react";
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
    logoutProtocolClient,
    machineCancelPairingRekey,
    machineDelete,
    machineRequestPairingRekey,
    machineSetDisplayName,
    machineShowPairingQr,
    pollPairingRekey,
    replaceProtocolClient,
    useMachines,
    type PairingQrPresentation,
    type PendingPairingRekey,
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

// DialogContent exits in 200ms. Keep the host-confirmation layer fully gone
// before presenting the replacement QR instead of briefly stacking dialogs.
const REKEY_DIALOG_EXIT_DELAY_MS = 240;

function machineName(machine: Machine): string {
    return machine.metadata?.displayName || machine.metadata?.host || machine.id;
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <section className="flex flex-col gap-2">
            <span className="px-1 font-mono text-[10px] text-muted-foreground">{label}</span>
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
            {chevron && <ChevronRight className="size-3 text-muted-foreground" />}
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
                    <ChevronRight className="size-3 text-muted-foreground" />
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

/** Тумблер: визуальный трек 36×22, реальная mobile touch-зона 44×44. */
function ToggleSwitch({ isOn, label, onToggle }: { isOn: boolean; label: string; onToggle: () => void }) {
    return (
        <button type="button" role="switch" aria-checked={isOn} aria-label={label} onClick={onToggle}
            className="flex size-11 items-center justify-center rounded-full transition-transform active:scale-[0.96]">
            <span className={`relative h-[22px] w-9 rounded-full transition-colors ${isOn ? "bg-accent" : "bg-border"}`}>
                <span className={`absolute left-0.5 top-0.5 size-[18px] rounded-full transition-transform ${isOn ? "translate-x-[14px] bg-accent-foreground" : "bg-muted-foreground"}`} />
            </span>
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
    const [isDeleting, setIsDeleting] = React.useState(false);
    const [pairingQr, setPairingQr] = React.useState<PairingQrPresentation | null>(null);
    const [isLoadingPairingQr, setIsLoadingPairingQr] = React.useState(false);
    const [pendingRekey, setPendingRekey] = React.useState<PendingPairingRekey | null>(null);
    const [rekeyPairingQr, setRekeyPairingQr] = React.useState<PairingQrPresentation | null>(null);
    const [isCancellingRekey, setIsCancellingRekey] = React.useState(false);

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
    const pairingMachine = machines.find((machine) => machine.active) ?? machines[0] ?? null;

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

    // DELETE /v1/machines/:id; 403 — машина самого демона, удалить нельзя (объясняем)
    const submitDelete = async () => {
        if (!deleteTarget || isDeleting) return;
        setIsDeleting(true);
        try {
            const result = await machineDelete(deleteTarget.id);
            if (result.ok || result.status === 404) {
                setDeleteTarget(null);
                return;
            }
            toast.error(result.status === 403 ? t("settings.machine.deleteOwn") : result.error);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("settings.machine.deleteFailed"));
        } finally {
            setIsDeleting(false);
        }
    };

    const disconnect = () => {
        logoutProtocolClient();
        navigate("/connect", { replace: true });
    };

    const showPairingQr = async () => {
        if (!pairingMachine || isLoadingPairingQr) return;
        setIsLoadingPairingQr(true);
        try {
            setPairingQr(await machineShowPairingQr(pairingMachine.id));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("status.error"));
        } finally {
            setIsLoadingPairingQr(false);
        }
    };

    const requestPairingRekey = async () => {
        if (!pairingMachine || pendingRekey) return;
        try {
            setPendingRekey(await machineRequestPairingRekey(pairingMachine.id));
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("status.error"));
        }
    };

    const cancelPairingRekey = async () => {
        const request = pendingRekey;
        if (!request || isCancellingRekey) return;
        if (!pairingMachine) {
            setPendingRekey(null);
            return;
        }

        setIsCancellingRekey(true);
        try {
            const result = await machineCancelPairingRekey(pairingMachine.id, request);
            if (result.type === 'cancelled' || result.type === 'expired' || result.type === 'not-found') {
                setPendingRekey((current) => current?.requestId === request.requestId ? null : current);
                return;
            }
            if (result.type === 'invalid-code') {
                toast.error(t("status.error"));
            }
            // `already-approved` stays open: the polling effect must receive
            // the sealed replacement instead of hiding a completed rotation.
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("status.error"));
        } finally {
            setIsCancellingRekey(false);
        }
    };

    React.useEffect(() => {
        if (!pendingRekey) return undefined;
        let isActive = true;
        const poll = async () => {
            try {
                const result = await pollPairingRekey(pendingRekey);
                if (!isActive || result.type !== "ready") return;
                let reconnectError: Error | null = null;
                try {
                    await replaceProtocolClient(result.pairing.payload);
                } catch (error) {
                    reconnectError = error instanceof Error ? error : new Error(t("status.error"));
                }
                if (!isActive) return;
                setPendingRekey(null);
                setRekeyPairingQr(result.pairing);
                if (reconnectError) {
                    toast.error(reconnectError.message);
                }
            } catch (error) {
                if (!isActive) return;
                setPendingRekey(null);
                toast.error(error instanceof Error ? error.message : t("status.error"));
            }
        };
        void poll();
        const intervalId = window.setInterval(() => { void poll(); }, 1_500);
        return () => {
            isActive = false;
            window.clearInterval(intervalId);
        };
    }, [pendingRekey]);

    React.useEffect(() => {
        if (!rekeyPairingQr || pendingRekey !== null) return undefined;
        const timeoutId = window.setTimeout(() => {
            setPairingQr(rekeyPairingQr);
            setRekeyPairingQr(null);
        }, REKEY_DIALOG_EXIT_DELAY_MS);
        return () => window.clearTimeout(timeoutId);
    }, [pendingRekey, rekeyPairingQr]);

    const pairingApprovalCommand = pendingRekey
        ? `remcli daemon rekey approve ${pendingRekey.requestId} ${pendingRekey.approvalCode}`
        : "";

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
                        <ToggleSwitch isOn={isAutoSpeak} label={t("settings.autoSpeak")} onToggle={toggleAutoSpeak} />
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
                            <span className={`min-w-0 truncate flex-1 font-mono text-[12.5px] ${machine.active ? "" : "text-muted-foreground"}`}>{machineName(machine)}</span>
                            <span className="font-mono text-[10px] text-muted-foreground">
                                {machine.active ? t("home.machine.online") : t("status.offline")}
                            </span>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button type="button" aria-label={machineName(machine)} className="-mr-3 flex size-11 items-center justify-center rounded-lg transition-[background-color,transform] hover:bg-muted active:scale-[0.96]">
                                        <MoreHorizontal className="size-4 text-muted-foreground" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem className="min-h-11 font-mono text-xs" onSelect={() => openRename(machine)}>
                                        {t("settings.machine.rename")}
                                    </DropdownMenuItem>
                                    <DropdownMenuItem variant="destructive" className="min-h-11 font-mono text-xs" onSelect={() => setDeleteTarget(machine)}>
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
                    <button
                        type="button"
                        onClick={() => void showPairingQr()}
                        disabled={!pairingMachine || isLoadingPairingQr}
                        className="flex min-h-12 w-full items-center gap-2.5 px-3.5 py-2.5 text-accent disabled:cursor-not-allowed disabled:opacity-45"
                    >
                        {isLoadingPairingQr ? <LoaderCircle className="size-[13px] animate-spin" /> : <QrCode className="size-[13px]" />}
                        <span className="text-[13px] font-medium">{t("settings.pairing.showQr")}</span>
                    </button>
                    <button
                        type="button"
                        onClick={() => void requestPairingRekey()}
                        disabled={!pairingMachine || pendingRekey !== null}
                        className="flex min-h-12 w-full items-center gap-2.5 px-3.5 py-2.5 text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45"
                    >
                        {pendingRekey ? <LoaderCircle className="size-[13px] animate-spin" /> : <KeyRound className="size-[13px]" />}
                        <span className="text-[13px] font-medium">{t("settings.pairing.rotate")}</span>
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
                <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="text-base">{t("settings.machine.renameTitle")}</DialogTitle>
                    </DialogHeader>
                    <Input
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        placeholder={t("settings.machine.renamePlaceholder")}
                        className="h-11 font-mono text-sm lg:h-8"
                        onKeyDown={(event) => { if (event.key === "Enter") void submitRename(); }}
                        autoFocus
                    />
                    <DialogFooter>
                        <Button variant="outline" size="sm" className="h-11 w-full lg:h-8 lg:w-auto" onClick={() => setRenameTarget(null)}>{t("common.cancel")}</Button>
                        <Button size="sm" className="h-11 w-full lg:h-8 lg:w-auto" disabled={isRenaming} onClick={() => void submitRename()}>{t("common.save")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Удаление машины (DELETE /v1/machines/:id, 'delete-machine' разлетается всем клиентам) */}
            <Dialog open={deleteTarget !== null} onOpenChange={(isOpen) => { if (!isOpen) setDeleteTarget(null); }}>
                <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="text-base">{t("settings.machine.deleteTitle")}</DialogTitle>
                        <DialogDescription className="break-words font-mono text-xs">
                            {deleteTarget ? machineName(deleteTarget) : ""} · {t("settings.machine.deleteHint")}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" size="sm" className="h-11 w-full lg:h-8 lg:w-auto" onClick={() => setDeleteTarget(null)}>{t("common.cancel")}</Button>
                        <Button variant="destructive" size="sm" className="h-11 w-full lg:h-8 lg:w-auto" disabled={isDeleting} onClick={() => void submitDelete()}>{t("common.delete")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={pairingQr !== null} onOpenChange={(isOpen) => { if (!isOpen) setPairingQr(null); }}>
                <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="text-base">{t("settings.pairing.showQr")}</DialogTitle>
                    </DialogHeader>
                    {pairingQr && (
                        <img
                            src={pairingQr.qrDataUrl}
                            alt={t("settings.pairing.showQr")}
                            className="mx-auto aspect-square w-full max-w-64 rounded-lg bg-white p-2"
                        />
                    )}
                    <DialogFooter>
                        <Button size="sm" className="h-11 w-full lg:h-8 lg:w-auto" onClick={() => setPairingQr(null)}>{t("common.cancel")}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={pendingRekey !== null} onOpenChange={(isOpen) => { if (!isOpen) void cancelPairingRekey(); }}>
                <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-sm">
                    <DialogHeader>
                        <DialogTitle className="text-base">{t("settings.pairing.rotate")}</DialogTitle>
                        <DialogDescription className="break-all font-mono text-xs leading-5">
                            {pairingApprovalCommand}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                        <LoaderCircle className="size-3.5 animate-spin" />
                        <span>{pendingRekey ? new Date(pendingRekey.expiresAt).toLocaleTimeString() : ""}</span>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" size="sm" className="h-11 w-full lg:h-8 lg:w-auto" disabled={isCancellingRekey} onClick={() => void cancelPairingRekey()}>
                            {isCancellingRekey ? <LoaderCircle className="size-3.5 animate-spin" /> : t("common.cancel")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
}
