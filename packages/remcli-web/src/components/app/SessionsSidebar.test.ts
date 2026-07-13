import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { StopTarget } from "@/components/app/SessionsSidebar";
import type { Session } from "@/lib/protocol";

let requestStopSession: typeof import("@/components/app/SessionsSidebar").requestStopSession;

beforeAll(async () => {
    vi.stubGlobal("localStorage", {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
    });
    vi.stubGlobal("navigator", {
        language: "en-US",
        languages: ["en-US"],
    });

    const sidebarModule = await import("@/components/app/SessionsSidebar");
    requestStopSession = sidebarModule.requestStopSession;
});

afterAll(() => {
    vi.unstubAllGlobals();
});

function createSession(startedBy: "daemon" | "terminal"): Session {
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
            startedBy,
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: "online",
    };
}

describe("requestStopSession", () => {
    it("does not call machineStopSession for a terminal session", async () => {
        const stopSession = vi.fn(async () => ({ message: "session stopped" }));
        const target: StopTarget = {
            session: createSession("terminal"),
            machine: { id: "machine-1", isActive: true },
        };

        await expect(requestStopSession(target, stopSession)).resolves.toBe(false);
        expect(stopSession).not.toHaveBeenCalled();
    });

    it("forwards a valid daemon-owned target to machineStopSession", async () => {
        const stopSession = vi.fn(async () => ({ message: "session stopped" }));
        const target: StopTarget = {
            session: createSession("daemon"),
            machine: { id: "machine-1", isActive: true },
        };

        await expect(requestStopSession(target, stopSession)).resolves.toBe(true);
        expect(stopSession).toHaveBeenCalledOnce();
        expect(stopSession).toHaveBeenCalledWith("machine-1", "session-1");
    });
});
