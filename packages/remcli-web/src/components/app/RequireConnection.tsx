// remcli-web — гвард роутов: без сохранённого P2P-подключения все экраны ведут на /connect.
// При наличии сохранённого подключения восстанавливает протокол-клиент (page reload):
// экраны рендерятся сразу, данные подтягиваются в стор асинхронно (Skeleton на страницах).
import * as React from "react";
import { Navigate, Outlet } from "react-router";
import { getStoredConnection, isClientStarted, restoreProtocolClient, useIsAuthenticated } from "@/lib/protocol";

// Модульный флаг: StrictMode вызывает эффект дважды — не запускаем восстановление повторно.
let isRestoreInFlight = false;

export function RequireConnection() {
    const isAuthenticated = useIsAuthenticated();
    const hasStoredConnection = getStoredConnection() !== null;

    React.useEffect(() => {
        if (isRestoreInFlight || isClientStarted() || !getStoredConnection()) return;
        isRestoreInFlight = true;
        void restoreProtocolClient()
            .catch(() => undefined)
            .finally(() => {
                isRestoreInFlight = false;
            });
    }, []);

    if (!isAuthenticated && !hasStoredConnection) {
        return <Navigate to="/connect" replace />;
    }
    return <Outlet />;
}
