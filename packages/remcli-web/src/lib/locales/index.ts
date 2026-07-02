// remcli-web — реестр локалей: id, словари, подписи для пикера языка.
import { ca } from "./ca";
import { en } from "./en";
import { es } from "./es";
import { it } from "./it";
import { ja } from "./ja";
import { pl } from "./pl";
import { pt } from "./pt";
import { ru, type Dictionary, type I18nKey } from "./ru";
import { zhHans } from "./zh-Hans";
import { zhHant } from "./zh-Hant";

export type { Dictionary, I18nKey };

export type LocaleId = "ru" | "en" | "es" | "pt" | "it" | "ca" | "pl" | "ja" | "zh-Hans" | "zh-Hant";

export const dictionaries: Record<LocaleId, Dictionary> = {
    "ru": ru,
    "en": en,
    "es": es,
    "pt": pt,
    "it": it,
    "ca": ca,
    "pl": pl,
    "ja": ja,
    "zh-Hans": zhHans,
    "zh-Hant": zhHant,
};

/** Порядок и самоназвания языков для пикера в настройках (DESIGN.md §Язык интерфейса). */
export const LOCALES: { id: LocaleId; label: string }[] = [
    { id: "ru", label: "Русский" },
    { id: "en", label: "English" },
    { id: "es", label: "Español" },
    { id: "pt", label: "Português" },
    { id: "it", label: "Italiano" },
    { id: "ca", label: "Català" },
    { id: "pl", label: "Polski" },
    { id: "ja", label: "日本語" },
    { id: "zh-Hans", label: "简体中文" },
    { id: "zh-Hant", label: "繁體中文" },
];
