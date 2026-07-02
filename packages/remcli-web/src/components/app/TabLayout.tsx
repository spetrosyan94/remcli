// remcli-web — layout таб-экранов (/, /zen, /settings): контент + нижние табы.
// Страницы внутри НЕ ставят min-h-dvh/таб-бар — это делает layout.
import { Outlet } from "react-router";
import { TabBar } from "@/components/app/TabBar";

export function TabLayout() {
    return (
        <div className="relative flex h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] text-foreground">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
                <Outlet />
            </div>
            <TabBar />
        </div>
    );
}
