import { describe, expect, it } from "vitest";
import { canStopSession, type IStopMachineTarget } from "@/lib/sessionCapabilities";
import type { Session } from "@/lib/protocol";

const ACTIVE_MACHINE: IStopMachineTarget = {
    id: "machine-1",
    isActive: true,
};

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: "session-1",
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            path: "/Users/dev/projects/remcli",
            host: "macbook-pro.local",
            startedBy: "daemon",
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: "online",
        ...overrides,
    };
}

describe("canStopSession", () => {
    it("allows an active daemon-owned session with an online RPC machine", () => {
        expect(canStopSession(createSession(), ACTIVE_MACHINE)).toBe(true);
    });

    it("fails closed for terminal, inactive, offline, and unusable machine targets", () => {
        expect(canStopSession(createSession({
            metadata: {
                path: "/Users/dev/projects/remcli",
                host: "macbook-pro.local",
                startedBy: "terminal",
            },
        }), ACTIVE_MACHINE)).toBe(false);
        expect(canStopSession(createSession({ active: false }), ACTIVE_MACHINE)).toBe(false);
        expect(canStopSession(createSession({ presence: 1 }), ACTIVE_MACHINE)).toBe(false);
        expect(canStopSession(createSession(), { id: "machine-1", isActive: false })).toBe(false);
        expect(canStopSession(createSession(), { id: "   ", isActive: true })).toBe(false);
        expect(canStopSession(createSession(), null)).toBe(false);
    });
});
