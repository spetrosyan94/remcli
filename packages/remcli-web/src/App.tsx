// remcli-web — маршруты (DESIGN.md §Навигация): табы (/, /zen, /settings) + push-экраны.
// Все app-роуты за гвардом RequireConnection; /terminal/connect — alias QR-ссылки демона.
import { Route, Routes } from "react-router";
import { CommandPalette } from "@/components/app/CommandPalette";
import { ConciergeChat } from "@/components/app/ConciergeChat";
import { RequireConnection } from "@/components/app/RequireConnection";
import { TabLayout } from "@/components/app/TabLayout";
import { Toaster } from "@/components/ui/sonner";
import { ChatPage } from "@/pages/ChatPage";
import { ConnectPage } from "@/pages/ConnectPage";
import { HomePage } from "@/pages/HomePage";
import { NewSessionPage } from "@/pages/NewSessionPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { TerminalPage } from "@/pages/TerminalPage";
import { ZenPage } from "@/pages/ZenPage";

export function App() {
    return (
        <>
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
            <CommandPalette />
            <Toaster />
        </>
    );
}
