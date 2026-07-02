// remcli-web — Настройки (design/screens/settings.tsx, разметка 1:1). Сгруппированные списки.
// Layout (safe-area + таб-бар) даёт TabLayout; данные — @/mocks/fixtures.
import * as React from "react";
import { ChevronRight, MoreHorizontal, QrCode } from "lucide-react";
import { useNavigate } from "react-router";
import { Segmented, StatusDot } from "@/components/kit";
import { useTheme, type Theme } from "@/components/theme/ThemeProvider";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { t } from "@/lib/i18n";
import { connectionInfo, machines, settingsLocales, settingsTtsProviders } from "@/mocks/fixtures";

const THEME_OPTIONS: { label: string; value: Theme }[] = [
    { label: t("settings.theme.light"), value: "light" },
    { label: t("settings.theme.dark"), value: "dark" },
    { label: t("settings.theme.system"), value: "system" },
];

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
    const [locale, setLocale] = React.useState(settingsLocales[0].label);
    const [providerId, setProviderId] = React.useState(settingsTtsProviders[0].id);
    const [voice, setVoice] = React.useState(settingsTtsProviders[0].voices[0]);
    const [isAutoSpeak, setIsAutoSpeak] = React.useState(false);

    const provider = settingsTtsProviders.find((p) => p.id === providerId) ?? settingsTtsProviders[0];
    const themeLabel = THEME_OPTIONS.find((o) => o.value === theme)?.label ?? t("settings.theme.dark");

    const selectProvider = (label: string) => {
        const next = settingsTtsProviders.find((p) => p.label === label);
        if (!next) return;
        setProviderId(next.id);
        setVoice(next.voices[0]);
    };

    return (
        <>
            <header className="px-5 pb-3 pt-1.5"><h1 className="text-xl font-semibold">{t("settings.title")}</h1></header>

            <main className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
                <Group label={t("settings.group.appearance")}>
                    <Row label={t("settings.theme")}>
                        <div className="w-44">
                            <Segmented
                                options={THEME_OPTIONS.map((o) => o.label)}
                                value={themeLabel}
                                onChange={(label) => {
                                    const next = THEME_OPTIONS.find((o) => o.label === label);
                                    if (next) setTheme(next.value);
                                }}
                            />
                        </div>
                    </Row>
                    <PickerRow label={t("settings.language")} value={locale} options={settingsLocales.map((l) => l.label)} onSelect={setLocale} /> {/* 10 локалей */}
                </Group>

                <Group label={t("settings.group.voice")}>
                    <PickerRow label={t("settings.ttsProvider")} value={provider.label} options={settingsTtsProviders.map((p) => p.label)} onSelect={selectProvider} />
                    <PickerRow label={t("settings.ttsVoice")} value={voice} options={provider.voices} onSelect={setVoice} />
                    <Row label={t("settings.autoSpeak")}>
                        <ToggleSwitch isOn={isAutoSpeak} onToggle={() => setIsAutoSpeak((v) => !v)} />
                    </Row>
                </Group>

                <Group label={t("settings.group.machines")}>
                    {machines.map((machine) => (
                        <div key={machine.id} className="flex min-h-12 items-center gap-2.5 px-3.5 py-2.5">
                            <StatusDot status={machine.isOnline ? "running" : "offline"} className="size-[7px]" />
                            <span className={`flex-1 font-mono text-[12.5px] ${machine.isOnline ? "" : "text-muted-foreground"}`}>{machine.name}</span>
                            <span className="font-mono text-[10px] text-muted-foreground/70">
                                {machine.isOnline ? `${machine.transport} · ${machine.latencyLabel}` : t("status.offline")}
                            </span>
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <button type="button" aria-label={machine.name} className="flex items-center">
                                        <MoreHorizontal className="size-4 text-muted-foreground/60" />
                                    </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuItem className="font-mono text-xs">{t("settings.machine.rename")}</DropdownMenuItem>
                                    <DropdownMenuItem variant="destructive" className="font-mono text-xs">{t("settings.machine.delete")}</DropdownMenuItem>
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
                    <Row label={t("settings.version")} value={`${connectionInfo.appVersion} · ${t("settings.daemon")} ${connectionInfo.daemonVersion}`} />
                </Group>
            </main>
        </>
    );
}
