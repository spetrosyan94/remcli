// remcli-web — маршруты (DESIGN.md §Навигация): табы (/, /zen, /settings) + push-экраны.
import { Route, Routes } from "react-router";
import { CommandPalette } from "@/components/app/CommandPalette";
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
                <Route element={<TabLayout />}>
                    <Route index element={<HomePage />} />
                    <Route path="zen" element={<ZenPage />} />
                    <Route path="settings" element={<SettingsPage />} />
                </Route>
                <Route path="connect" element={<ConnectPage />} />
                <Route path="new" element={<NewSessionPage />} />
                <Route path="session/:id" element={<ChatPage />} />
                <Route path="session/:id/terminal" element={<TerminalPage />} />
            </Routes>
            <CommandPalette />
            <Toaster />
        </>
    );
}
