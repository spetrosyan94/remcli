import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PermissionCard } from "@/components/kit/PermissionCard";

describe("PermissionCard response feedback", () => {
    it("keeps every action disabled while the response is being sent", () => {
        const markup = renderToStaticMarkup(React.createElement(PermissionCard, {
            tool: "Bash",
            command: "pnpm test",
            alwaysLabel: "always allow pnpm test",
            responseState: "sending",
            onAllow: () => undefined,
            onDeny: () => undefined,
            onAlways: () => undefined,
        }));

        expect(markup).toContain('aria-busy="true"');
        expect(markup).toContain('role="status"');
        expect(markup).toContain("sending response");
        expect(markup.match(/disabled=""/g)).toHaveLength(6);
    });

    it("keeps the request actionable after a failed response and exposes retry feedback", () => {
        const markup = renderToStaticMarkup(React.createElement(PermissionCard, {
            tool: "Bash",
            command: "pnpm test",
            alwaysLabel: "always allow pnpm test",
            responseState: "error",
            onAllow: () => undefined,
            onDeny: () => undefined,
            onAlways: () => undefined,
            onRetry: () => undefined,
        }));

        expect(markup).toContain('role="alert"');
        expect(markup).toContain("could not send response");
        expect(markup).toContain(">Retry<");
        expect(markup).not.toContain('disabled=""');
    });

    it("does not expose a session-wide allow action for dangerous commands", () => {
        const markup = renderToStaticMarkup(React.createElement(PermissionCard, {
            tool: "Bash",
            command: "git push --force origin main",
            danger: true,
            alwaysLabel: "always allow git push --force origin main",
            onAllow: () => undefined,
            onDeny: () => undefined,
            onAlways: () => undefined,
        }));

        expect(markup).not.toContain("always allow git push --force origin main");
        expect(markup).not.toContain("A — always");
    });
});
