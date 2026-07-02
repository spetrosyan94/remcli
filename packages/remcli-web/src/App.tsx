// remcli-web — маршруты (DESIGN.md §Навигация): табы (/, /zen, /settings) + push-экраны.
// Все app-роуты за гвардом RequireConnection; /terminal/connect — alias QR-ссылки демона.
// Страницы — route-level code-splitting (React.lazy + Suspense со Skeleton):
// главный чанк остаётся лёгким, страница догружается при первом переходе.
import * as React from "react";
import { Route, Routes } from "react-router";
import { CommandPalette } from "@/components/app/CommandPalette";
import { RequireConnection } from "@/components/app/RequireConnection";
import { TabLayout } from "@/components/app/TabLayout";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { useLocale } from "@/lib/i18n";

const ChatPage = React.lazy(() => import("@/pages/ChatPage").then((m) => ({ default: m.ChatPage })));
const ConciergeChat = React.lazy(() => import("@/components/app/ConciergeChat").then((m) => ({ default: m.ConciergeChat })));
const ConnectPage = React.lazy(() => import("@/pages/ConnectPage").then((m) => ({ default: m.ConnectPage })));
const HomePage = React.lazy(() => import("@/pages/HomePage").then((m) => ({ default: m.HomePage })));
const NewSessionPage = React.lazy(() => import("@/pages/NewSessionPage").then((m) => ({ default: m.NewSessionPage })));
const SettingsPage = React.lazy(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const TerminalPage = React.lazy(() => import("@/pages/TerminalPage").then((m) => ({ default: m.TerminalPage })));
const ZenPage = React.lazy(() => import("@/pages/ZenPage").then((m) => ({ default: m.ZenPage })));

/** Заглушка на время догрузки чанка страницы (Skeleton в ритме карточек списка). */
function RouteFallback() {
    return (
        <div className="flex h-dvh flex-col gap-3 bg-background px-5 pb-5 pt-[calc(env(safe-area-inset-top)+18px)]">
            <Skeleton className="h-6 w-40 bg-muted" />
            {[0, 1, 2].map((index) => (
                <Skeleton key={index} className="h-[66px] rounded-xl bg-muted" />
            ))}
        </div>
    );
}

export function App() {
    // Смена языка (useLocale) перемонтирует дерево через key — все t()-строки обновляются сразу.
    const locale = useLocale();
    return (
        <React.Fragment key={locale}>
            <React.Suspense fallback={<RouteFallback />}>
                <Routes>
                    <Route element={<RequireConnection />}>
                        <Route element={<TabLayout />}>
                            <Route index element={<HomePage />} />
                            <Route path="zen" element={<ZenPage />} />
                            <Route path="settings" element={<SettingsPage />} />
                        </Route>
                        <Route path="new" element={<NewSessionPage />} />
                        <Route path="concierge" element={<ConciergeChat />} />
                        <Route path="session/:id" element={<ChatPage />} />
                        <Route path="session/:id/terminal" element={<TerminalPage />} />
                    </Route>
                    <Route path="connect" element={<ConnectPage />} />
                    <Route path="terminal/connect" element={<ConnectPage />} />
                </Routes>
            </React.Suspense>
            <CommandPalette />
            <Toaster />
        </React.Fragment>
    );
}
