// remcli-web — маршруты (DESIGN.md §Навигация): табы (/, /zen, /settings) + push-экраны.
// Все app-роуты за гвардом RequireConnection; /terminal/connect — alias QR-ссылки демона.
// Страницы — route-level code-splitting (React.lazy + Suspense со Skeleton):
// главный чанк остаётся лёгким, страница догружается при первом переходе.
import * as React from "react";
import { TriangleAlert } from "lucide-react";
import { Route, Routes } from "react-router";
import { CommandPalette } from "@/components/app/CommandPalette";
import { LaunchSplash } from "@/components/app/LaunchSplash";
import { RequireConnection } from "@/components/app/RequireConnection";
import { TabLayout } from "@/components/app/TabLayout";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { t, useLocale } from "@/lib/i18n";
import { claimRouteChunkRetry, isRouteChunkLoadError } from "@/lib/routeChunkRecovery";

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

function RouteErrorFallback() {
    return (
        <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center" role="alert">
            <TriangleAlert className="size-6 text-destructive" aria-hidden="true" />
            <p className="font-mono text-sm text-foreground">{t("status.error")}</p>
            <button
                type="button"
                onClick={() => window.location.reload()}
                className="h-11 rounded-[10px] border border-border px-4 text-[13px] font-semibold transition-[background-color,border-color,transform] active:scale-[0.96]"
            >
                {t("connect.retry")}
            </button>
        </main>
    );
}

interface RouteChunkRecoveryBoundaryProps {
    children: React.ReactNode;
    onChunkLoadRetry?: () => void;
}

interface RouteChunkRecoveryBoundaryState {
    hasChunkLoadError: boolean;
    runtimeError: unknown | null;
}

export class RouteChunkRecoveryBoundary extends React.Component<
    RouteChunkRecoveryBoundaryProps,
    RouteChunkRecoveryBoundaryState
> {
    public state: RouteChunkRecoveryBoundaryState = { hasChunkLoadError: false, runtimeError: null };

    public static getDerivedStateFromError(error: unknown): RouteChunkRecoveryBoundaryState {
        return isRouteChunkLoadError(error)
            ? { hasChunkLoadError: true, runtimeError: null }
            : { hasChunkLoadError: false, runtimeError: error };
    }

    public componentDidCatch(error: unknown): void {
        if (!isRouteChunkLoadError(error)) return;

        try {
            const locationKey = `${window.location.pathname}${window.location.search}`;
            if (claimRouteChunkRetry(window.sessionStorage, locationKey)) {
                if (this.props.onChunkLoadRetry) {
                    this.props.onChunkLoadRetry();
                } else {
                    window.location.reload();
                }
            }
        } catch {
            // Keep the route fallback visible when browser storage or reload is unavailable.
        }
    }

    public render(): React.ReactNode {
        if (this.state.runtimeError) {
            // React forwards ordinary route failures to the app-level error boundary.
            throw this.state.runtimeError;
        }

        return this.state.hasChunkLoadError ? <RouteErrorFallback /> : this.props.children;
    }
}

interface AppRuntimeErrorBoundaryProps {
    children: React.ReactNode;
    onRuntimeError?: () => void;
}

interface AppRuntimeErrorBoundaryState {
    hasError: boolean;
}

export class AppRuntimeErrorBoundary extends React.Component<
    AppRuntimeErrorBoundaryProps,
    AppRuntimeErrorBoundaryState
> {
    public state: AppRuntimeErrorBoundaryState = { hasError: false };

    public static getDerivedStateFromError(): AppRuntimeErrorBoundaryState {
        return { hasError: true };
    }

    public componentDidCatch(): void {
        this.props.onRuntimeError?.();
    }

    public render(): React.ReactNode {
        return this.state.hasError ? <RouteErrorFallback /> : this.props.children;
    }
}

export function App() {
    // Смена языка (useLocale) перемонтирует дерево через key — все t()-строки обновляются сразу.
    const locale = useLocale();
    return (
        <React.Fragment key={locale}>
            <AppRuntimeErrorBoundary>
                <RouteChunkRecoveryBoundary>
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
                </RouteChunkRecoveryBoundary>
            </AppRuntimeErrorBoundary>
            <CommandPalette />
            <Toaster />
            {/* Сплэш холодного старта (QR-коннект / restore) — поверх всего, сам решает, показываться ли */}
            <LaunchSplash />
        </React.Fragment>
    );
}
