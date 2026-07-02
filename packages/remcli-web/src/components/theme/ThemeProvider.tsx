// remcli-web — тема dark/light/system (localStorage, класс dark на <html>, дефолт — dark).
import * as React from "react";

export type Theme = "dark" | "light" | "system";

interface ThemeContextValue {
    theme: Theme;
    setTheme: (theme: Theme) => void;
}

const STORAGE_KEY = "remcli-theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function readStoredTheme(): Theme {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "system" || stored === "dark" ? stored : "dark";
}

function applyTheme(theme: Theme): void {
    const isDark = theme === "system" ? window.matchMedia(DARK_QUERY).matches : theme === "dark";
    document.documentElement.classList.toggle("dark", isDark);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const [theme, setThemeState] = React.useState<Theme>(readStoredTheme);

    React.useEffect(() => {
        applyTheme(theme);
        if (theme !== "system") return;
        const media = window.matchMedia(DARK_QUERY);
        const onChange = () => applyTheme("system");
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, [theme]);

    const setTheme = React.useCallback((next: Theme) => {
        localStorage.setItem(STORAGE_KEY, next);
        setThemeState(next);
    }, []);

    const value = React.useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
    return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
    const context = React.useContext(ThemeContext);
    if (!context) throw new Error("useTheme must be used within ThemeProvider");
    return context;
}
