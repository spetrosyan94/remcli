import { describe, expect, it } from "vitest";
import { FIXTURE_MACHINES, FIXTURE_SESSIONS } from "@/lib/fixtures/data";
import type { Machine, Session } from "@/lib/protocol/types";
import { resolveTerminalHandoff, terminalMachineForSession, terminalPlatform } from "@/lib/terminalHandoff";

const runningSession = FIXTURE_SESSIONS.find((session) => session.id === "fx-running");
const onlineMachine = FIXTURE_MACHINES.find((machine) => machine.id === "fx-machine-online");
const offlineMachine = FIXTURE_MACHINES.find((machine) => machine.id === "fx-machine-offline");

if (!runningSession || !onlineMachine || !offlineMachine) {
    throw new Error("Terminal fixture data is incomplete");
}

describe("terminal handoff mapping", () => {
    it.each([
        ["darwin", "mac"],
        ["win32", "windows"],
        ["linux", "linux"],
        ["freebsd", "computer"],
        [undefined, "computer"],
    ] as const)("maps %s to %s", (os, expected) => {
        expect(terminalPlatform(os)).toBe(expected);
    });

    it("keeps an active session active when its machine is not in the store", () => {
        expect(resolveTerminalHandoff(runningSession, null, true).kind).toBe("active");
    });

    it("shows active success only when the known machine is not explicitly inactive", () => {
        expect(resolveTerminalHandoff(runningSession, onlineMachine, true).kind).toBe("active");
        expect(resolveTerminalHandoff(runningSession, offlineMachine, true).kind).toBe("unavailable");
    });

    it("does not borrow a machine from hostname-only legacy metadata", () => {
        const { machineId: _machineId, os: _os, ...legacyMetadata } = runningSession.metadata ?? {};
        const legacyOfflineSession: Session = {
            ...runningSession,
            metadata: {
                ...legacyMetadata,
                path: runningSession.metadata?.path ?? "~",
                host: "build-server",
            },
        };
        const replacementBuildServer: Machine = {
            ...onlineMachine,
            id: "replacement-build-server",
            metadata: {
                ...onlineMachine.metadata,
                host: "build-server",
                platform: onlineMachine.metadata?.platform ?? "darwin",
                remcliCliVersion: onlineMachine.metadata?.remcliCliVersion ?? "test",
                remcliHomeDir: onlineMachine.metadata?.remcliHomeDir ?? "~/.remcli",
                homeDir: onlineMachine.metadata?.homeDir ?? "~",
            },
        };

        expect(terminalMachineForSession(legacyOfflineSession, FIXTURE_MACHINES)).toBeNull();
        expect(terminalMachineForSession(legacyOfflineSession, [replacementBuildServer])).toBeNull();
        expect(resolveTerminalHandoff(legacyOfflineSession, null, true).kind).toBe("active");
    });

    it("separates ended, not-found, and pre-snapshot loading states", () => {
        const ended = { ...runningSession, active: false };
        const stalePresence = { ...runningSession, presence: runningSession.activeAt };

        expect(resolveTerminalHandoff(ended, onlineMachine, true).kind).toBe("ended");
        expect(resolveTerminalHandoff(stalePresence, onlineMachine, true).kind).toBe("ended");
        expect(resolveTerminalHandoff(null, null, true).kind).toBe("not-found");
        expect(resolveTerminalHandoff(null, null, false).kind).toBe("loading");
    });
});
