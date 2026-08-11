import { describe, expect, it } from "vitest";
import { createPermissionDecision, createPermissionDecisionGate } from "@/lib/permissionDecision";

describe("createPermissionDecision", () => {
    it("maps Codex allow, deny and session-wide allow to native decisions", () => {
        expect(createPermissionDecision({ action: "allow", agent: "codex", tool: "Bash" })).toEqual({
            approved: true,
            decision: "approved",
        });
        expect(createPermissionDecision({ action: "deny", agent: "codex", tool: "Bash" })).toEqual({
            approved: false,
            decision: "abort",
        });
        expect(createPermissionDecision({ action: "always", agent: "codex", tool: "Bash" })).toEqual({
            approved: true,
            decision: "approved_for_session",
        });
    });

    it("keeps non-Codex session-wide allow scoped to the requested tool", () => {
        expect(createPermissionDecision({
            action: "always",
            agent: "claude",
            command: "pnpm test -- --run crypto",
            tool: "Bash",
        })).toEqual({
            allowedTools: ["Bash(pnpm test -- --run crypto)"],
            approved: true,
        });
    });
});

describe("createPermissionDecisionGate", () => {
    it("blocks a duplicate tap until the failed request releases its permission id", () => {
        const gate = createPermissionDecisionGate();

        expect(gate.tryAcquire("permission-1")).toBe(true);
        expect(gate.tryAcquire("permission-1")).toBe(false);
        gate.release("permission-1");
        expect(gate.tryAcquire("permission-1")).toBe(true);
    });
});
