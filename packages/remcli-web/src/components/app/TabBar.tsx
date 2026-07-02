// remcli-web — нижние табы (DESIGN.md §Навигация): Сессии · Задачи · Настройки, safe-area снизу.
// Разметка — из design/screens/home.tsx (nav + TabItem).
import { ListTodo, SlidersHorizontal, Terminal } from "lucide-react";
import { NavLink } from "react-router";
import { t } from "@/lib/i18n";
import type { LucideIcon } from "lucide-react";

interface TabConfig {
    to: string;
    label: string;
    icon: LucideIcon;
}

const TABS: TabConfig[] = [
    { to: "/", label: t("tabs.sessions"), icon: Terminal },
    { to: "/zen", label: t("tabs.tasks"), icon: ListTodo },
    { to: "/settings", label: t("tabs.settings"), icon: SlidersHorizontal },
];

export function TabBar() {
    return (
        <nav className="border-t border-border bg-background/90 pb-[env(safe-area-inset-bottom)] backdrop-blur">
            <div className="flex px-2 pt-2">
                {TABS.map(({ to, label, icon: Icon }) => (
                    <NavLink
                        key={to}
                        to={to}
                        end={to === "/"}
                        className={({ isActive }) =>
                            `flex min-h-11 flex-1 flex-col items-center gap-0.5 py-1.5 ${isActive ? "text-foreground" : "text-muted-foreground"}`
                        }
                    >
                        {({ isActive }) => (
                            <>
                                <Icon className="size-5" />
                                <span className={`text-[10px] ${isActive ? "font-semibold" : "font-medium"}`}>{label}</span>
                            </>
                        )}
                    </NavLink>
                ))}
            </div>
        </nav>
    );
}
