import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ConciergeChat,
    ConciergeStatusNotice,
    getConciergeLifecycleState,
    settleConciergeStatus,
    type IConciergeLifecycleState,
    type IConciergeStatusState,
} from "@/components/app/ConciergeChat";
import { stripConciergeSpeakerPrefix } from "@/components/app/conciergeText";
import { t } from "@/lib/i18n";
import type { ConciergeStatus, RestConfig } from "@/lib/protocol";
import type { ConnectionStatus } from "@/lib/protocol/socket";

const mockProtocolState = vi.hoisted(() => ({
    connectionStatus: "disconnected" as ConnectionStatus,
    restConfig: { endpoint: "http://daemon.test", token: "saved-token" },
}));
const mockConcierge = vi.hoisted(() => ({
    fetchConciergeStatus: vi.fn<(config: RestConfig) => Promise<ConciergeStatus>>(),
}));

vi.mock("@/lib/protocol", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/protocol")>();
    return {
        ...actual,
        useConnectionStatus: () => mockProtocolState.connectionStatus,
        getRestConfig: () => mockProtocolState.restConfig,
        fetchConciergeStatus: mockConcierge.fetchConciergeStatus,
    };
});

function renderConcierge(): string {
    return renderToStaticMarkup(
        React.createElement(MemoryRouter, null, React.createElement(ConciergeChat)),
    );
}

function renderStatusNotice(lifecycleState: IConciergeLifecycleState): string {
    return renderToStaticMarkup(
        React.createElement(
            MemoryRouter,
            null,
            React.createElement(ConciergeStatusNotice, { lifecycleState }),
        ),
    );
}

function expectLiveStatusRegion(markup: string): void {
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('aria-atomic="true"');
}

const availableStatus: ConciergeStatus = {
    enabled: true,
    available: true,
    model: "local-model",
};

afterEach(() => {
    mockProtocolState.connectionStatus = "disconnected";
    mockConcierge.fetchConciergeStatus.mockReset();
});

describe("ConciergeChat availability state", () => {
    it("uses the shared EmptyState while the socket is connecting", () => {
        mockProtocolState.connectionStatus = "connecting";

        const markup = renderConcierge();

        expect(markup).toContain('viewBox="0 0 32 32"');
        expect(markup).toContain(t("concierge.checking"));
        expectLiveStatusRegion(markup);
    });

    it("starts a connected status check without an unavailable flash", () => {
        mockProtocolState.connectionStatus = "connected";

        const markup = renderConcierge();

        expect(markup).toContain(t("concierge.checking"));
        expect(markup).not.toContain(t("concierge.unavailable"));
        expectLiveStatusRegion(markup);
    });

    it.each(["error", "disconnected"] as const)(
        "shows the connect link immediately for a socket %s despite saved REST config",
        (connectionStatus) => {
            mockProtocolState.connectionStatus = connectionStatus;

            const markup = renderConcierge();

            expect(markup).toContain(t("concierge.notConnected"));
            expect(markup).toContain(t("concierge.connect"));
            expect(markup).toContain('href="/connect"');
            expect(markup).not.toContain(t("concierge.checking"));
            expect(markup).not.toContain(t("concierge.unavailable"));
            expectLiveStatusRegion(markup);
        },
    );

    it("uses the shared EmptyState when the connected concierge is disabled", () => {
        const lifecycleState = getConciergeLifecycleState({
            connectionStatus: "connected",
            hasConfig: true,
            statusPhase: "settled",
            hasAvailableStatus: false,
        });

        const markup = renderStatusNotice(lifecycleState);

        expect(markup).toContain('viewBox="0 0 32 32"');
        expect(markup).toContain(t("concierge.unavailable"));
        expect(markup).toContain(t("concierge.unavailableHint"));
        expectLiveStatusRegion(markup);
    });

    it.each([
        ["connected", true, "checking", true, false, false],
        ["connected", true, "settled", false, false, true],
        ["connected", true, "settled", false, false, false],
        ["connecting", false, "idle", true, false, false],
        ["error", true, "settled", false, true, false],
        ["disconnected", true, "settled", false, true, false],
    ] as const)(
        "derives the expected display state for %s",
        (connectionStatus, hasConfig, statusPhase, showChecking, showNotConnected, isAvailable) => {
            expect(getConciergeLifecycleState({
                connectionStatus,
                hasConfig,
                statusPhase,
                hasAvailableStatus: isAvailable,
            })).toEqual({
                canFetchStatus: hasConfig && connectionStatus === "connected",
                showChecking,
                showNotConnected,
                isAvailable,
            });
        },
    );

    it("ignores a status response from an older connection scope", () => {
        const current: IConciergeStatusState = {
            scopeVersion: 2,
            phase: "checking",
            status: null,
        };

        expect(settleConciergeStatus(current, 1, availableStatus)).toBe(current);
        expect(settleConciergeStatus(current, 2, availableStatus)).toEqual({
            scopeVersion: 2,
            phase: "settled",
            status: availableStatus,
        });
    });
});

describe("stripConciergeSpeakerPrefix", () => {
    it("removes Russian Jarvis speaker prefixes from assistant replies", () => {
        expect(stripConciergeSpeakerPrefix("Джарвис: Проверил сессии."))
            .toBe("Проверил сессии.");
        expect(stripConciergeSpeakerPrefix("  Джарвис — готов открыть seeded чат."))
            .toBe("готов открыть seeded чат.");
    });

    it("removes English concierge-style speaker prefixes from assistant replies", () => {
        expect(stripConciergeSpeakerPrefix("Jarvis: Ready."))
            .toBe("Ready.");
        expect(stripConciergeSpeakerPrefix("Concierge - I can start a session."))
            .toBe("I can start a session.");
    });

    it("keeps regular assistant text intact", () => {
        expect(stripConciergeSpeakerPrefix("Готов открыть сессию."))
            .toBe("Готов открыть сессию.");
        expect(stripConciergeSpeakerPrefix("AI-инструменты уже запущены."))
            .toBe("AI-инструменты уже запущены.");
    });
});
