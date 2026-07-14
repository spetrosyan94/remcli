import * as React from "react";
import { createRoot } from "react-dom/client";
import { AppRuntimeErrorBoundary, RouteChunkRecoveryBoundary } from "@/App";

export type RouteErrorHarnessKind = "chunk" | "runtime" | "success";

const LAZY_IMPORT_ERROR_MESSAGE = "Failed to fetch dynamically imported module";
const RejectedLazyChunkRoute = React.lazy(() => Promise.reject(new Error(LAZY_IMPORT_ERROR_MESSAGE)));

let nextHarnessId = 0;

function ChunkRouteFallback(): React.ReactNode {
    return <p role="status" data-route-recovery="loading">Loading route</p>;
}

function HarnessRoute({ kind }: { kind: RouteErrorHarnessKind }): React.ReactNode {
    if (kind === "success") {
        return <p role="status" data-route-recovery="success">Route recovered after reload</p>;
    }

    if (kind === "chunk") {
        return (
            <React.Suspense fallback={<ChunkRouteFallback />}>
                <RejectedLazyChunkRoute />
            </React.Suspense>
        );
    }

    throw new Error("Cannot read properties of undefined");
}

export function mountRouteErrorBoundaryHarness(kind: RouteErrorHarnessKind): string {
    const id = `route-error-${++nextHarnessId}`;
    const container = document.createElement("div");
    container.dataset.routeErrorHarness = id;
    container.dataset.routeErrorKind = kind;
    container.dataset.runtimeErrorCaptured = "false";
    document.body.appendChild(container);

    createRoot(container).render(
        <AppRuntimeErrorBoundary
            onRuntimeError={() => {
                container.dataset.runtimeErrorCaptured = "true";
            }}
        >
            <RouteChunkRecoveryBoundary>
                <HarnessRoute kind={kind} />
            </RouteChunkRecoveryBoundary>
        </AppRuntimeErrorBoundary>
    );

    return id;
}
