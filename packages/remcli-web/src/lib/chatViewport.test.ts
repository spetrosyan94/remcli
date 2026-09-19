import { describe, expect, it } from "vitest";
import {
    contentRevisionOf,
    chatViewportModeAfterAnchorMeasurement,
    chatViewportModeAfterScroll,
    isScrollNearTarget,
    isUserScrollIntent,
    structuredAnchorTarget,
    shouldBlockStructuredAnchor,
    viewportAnchorIdentity,
} from "@/lib/chatViewport";

describe("chat viewport stream anchoring", () => {
    it("uses measured three-field card geometry and reserves trailing room for the inset", () => {
        expect(structuredAnchorTarget({
            feedTop: 100,
            scrollTop: 260,
            scrollHeight: 900,
            clientHeight: 600,
            cardTop: 760,
            cardHeight: 720,
        })).toEqual({ top: 906, extraBottom: 606 });
        expect(structuredAnchorTarget({
            feedTop: 100,
            scrollTop: 260,
            scrollHeight: 900,
            clientHeight: 600,
            cardTop: 760,
            cardHeight: 300,
        })).toBeNull();
    });

    it("keeps intermediate smooth-scroll events attached and completes near the target", () => {
        expect(isScrollNearTarget(900, 906)).toBe(false);
        expect(isScrollNearTarget(905, 906)).toBe(true);
        expect(isScrollNearTarget(900, 906, 8)).toBe(true);
    });

    it("keeps a late scroll event at the anchor target, but exits on target deviation", () => {
        const metrics = { scrollTop: 900, scrollHeight: 1_200, clientHeight: 300 };

        expect(chatViewportModeAfterScroll("structured-anchor", metrics, false, 900)).toBe("structured-anchor");
        expect(chatViewportModeAfterScroll("structured-anchor", { ...metrics, scrollTop: 700 }, false, 900)).toBe("detached");
        expect(chatViewportModeAfterScroll("structured-anchor", { ...metrics, scrollTop: 700 }, true, 900)).toBe("detached");
    });

    it("exits structured-anchor when the replacement card is compact", () => {
        expect(chatViewportModeAfterAnchorMeasurement(
            "structured-anchor",
            { scrollTop: 400, scrollHeight: 1_200, clientHeight: 500 },
            null,
        )).toBe("detached");
    });

    it("blocks retained structured state until the new session content changes", () => {
        const retained = { sessionId: "session-b", structuredAnchorKey: "request-a", contentVersion: "revision-a" };

        expect(shouldBlockStructuredAnchor(retained, retained)).toBe(true);
        expect(shouldBlockStructuredAnchor(retained, { ...retained, contentVersion: "revision-b" })).toBe(false);
        expect(shouldBlockStructuredAnchor(retained, { ...retained, structuredAnchorKey: "request-b" })).toBe(false);
    });

    it.each(["wheel", "touchstart", "pointerdown"])("recognizes %s as user scroll intent", (type) => {
        expect(isUserScrollIntent({ type, target: null } as Event)).toBe(true);
    });

    it("recognizes keyboard scrolling but ignores editable targets", () => {
        expect(isUserScrollIntent({ type: "keydown", key: "PageDown", target: null } as unknown as Event)).toBe(true);
        expect(isUserScrollIntent({ type: "keydown", key: "a", target: null } as unknown as Event)).toBe(false);
    });

    it("makes session identity part of the processed anchor identity contract", () => {
        expect(viewportAnchorIdentity("session-a", "request-1")).not.toBe(
            viewportAnchorIdentity("session-b", "request-1"),
        );
        expect(viewportAnchorIdentity("session-a", "request-1")).toBe(
            viewportAnchorIdentity("session-a", "request-1"),
        );
    });

    it("revises when tool output or error presentation changes", () => {
        const running = contentRevisionOf({ id: "tool-1", state: "running", outputLines: [], errorText: undefined });
        const completed = contentRevisionOf({ id: "tool-1", state: "success", outputLines: ["12 passed"], errorText: undefined });
        const failed = contentRevisionOf({ id: "tool-1", state: "error", outputLines: ["failed"], errorText: "failed" });
        expect(completed).not.toBe(running);
        expect(failed).not.toBe(completed);
    });
});
