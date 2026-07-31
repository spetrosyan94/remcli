// remcli-web — движок i18n (10 локалей, словари — src/lib/locales/).
// Определение языка: localStorage → navigator.language → en.
// Все UI-тексты берём через t(key, params); ключи типизированы базовым словарём (locales/ru.ts).
// Смена языка: setLocale(id) (персист в localStorage) + useLocale() для реактивности.
// Плюрализация — Intl.PluralRules (tPlural), локальные даты — getIntlLocale().
import * as React from "react";
import { dictionaries, LOCALES, type I18nKey, type LocaleId } from "@/lib/locales";

export { LOCALES, type I18nKey, type LocaleId };

const LOCALE_STORAGE_KEY = "remcli-locale";

/* ---------- Определение локали: localStorage → navigator.language → en ---------- */

function isLocaleId(value: string | null | undefined): value is LocaleId {
    return LOCALES.some((locale) => locale.id === value);
}

function matchNavigatorLanguage(raw: string): LocaleId | null {
    const lower = raw.toLowerCase();
    if (lower.startsWith("zh")) {
        const isTraditional = lower.includes("hant") || lower.includes("tw") || lower.includes("hk") || lower.includes("mo");
        return isTraditional ? "zh-Hant" : "zh-Hans";
    }
    const base = lower.split("-")[0];
    return isLocaleId(base) ? base : null;
}

function detectLocale(): LocaleId {
    const stored = typeof localStorage === "undefined" ? null : localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocaleId(stored)) return stored;
    if (typeof navigator === "undefined") return "en";
    const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
    for (const candidate of candidates) {
        if (!candidate) continue;
        const matched = matchNavigatorLanguage(candidate);
        if (matched) return matched;
    }
    return "en";
}

/* ---------- Текущая локаль (модульное состояние + подписка) ---------- */

let currentLocale: LocaleId = detectLocale();

const localeListeners = new Set<() => void>();

export function getLocale(): LocaleId {
    return currentLocale;
}

export function setLocale(id: LocaleId): void {
    if (currentLocale === id) return;
    currentLocale = id;
    localStorage.setItem(LOCALE_STORAGE_KEY, id);
    localeListeners.forEach((listener) => listener());
}

/** Код текущего языка — для TTS (`lang`) и Accept-Language-подобных нужд. */
export function getCurrentLanguage(): string {
    return currentLocale;
}

/** BCP-47-тег текущей локали для Intl / toLocaleDateString / toLocaleTimeString. */
export function getIntlLocale(): string {
    return currentLocale;
}

/** Реактивная подписка на локаль (компоненты с t() перерисуются при смене). */
export function useLocale(): LocaleId {
    return React.useSyncExternalStore(
        (onChange) => {
            localeListeners.add(onChange);
            return () => localeListeners.delete(onChange);
        },
        () => currentLocale,
    );
}

/* ---------- Перевод ---------- */

type TranslationParams = Record<string, string | number>;

export function t(key: I18nKey, params?: TranslationParams): string {
    let text: string = dictionaries[currentLocale][key];
    if (params) {
        for (const [name, value] of Object.entries(params)) {
            text = text.replaceAll(`{${name}}`, String(value));
        }
    }
    return text;
}

/* ---------- Плюрализация (Intl.PluralRules по текущей локали) ---------- */

/** Ключи-группы с формами .one/.few/.many/.other в словарях. */
type PluralKeyPrefix = "home.sessions";

export function tPlural(prefix: PluralKeyPrefix, count: number): string {
    const category = new Intl.PluralRules(currentLocale).select(count);
    const dictionary = dictionaries[currentLocale];
    const exact = `${prefix}.${category}`;
    if (exact in dictionary) return dictionary[exact as I18nKey];
    return dictionary[`${prefix}.other`];
}
