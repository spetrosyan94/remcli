import { describe, expect, it, vi } from "vitest";
import { resumeCodexSession } from "@/lib/sessionResume";
import type { CodexCapabilitiesSnapshot, Session, SpawnSessionOptions } from "@/lib/protocol";

function createCapabilities(overrides: Partial<CodexCapabilitiesSnapshot> = {}): CodexCapabilitiesSnapshot {
    return {
        agent: "codex",
        status: "ready",
        fetchedAt: 1,
        expiresAt: 2,
        catalogVersion: "fresh-catalog",
        permissionModes: ["read-only", "workspace-write"],
        models: [
            {
                id: "gpt-5.6-sol",
                displayName: "GPT-5.6 Sol",
                isDefault: true,
                defaultReasoningEffort: "high",
                supportedReasoningEfforts: ["high"],
            },
            {
                id: "gpt-5.6-luna",
                displayName: "GPT-5.6 Luna",
                isDefault: false,
                defaultReasoningEffort: "xhigh",
                supportedReasoningEfforts: ["high", "xhigh"],
            },
        ],
        ...overrides,
    };
}

function createSession(overrides: Partial<Session> = {}): Session {
    return {
        id: "ended-session",
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 2,
        metadata: {
            path: "/Users/dev/projects/remcli",
            host: "macbook.local",
            machineId: "machine-online",
            flavor: "codex",
            name: "remcli",
            codexSessionId: "native-codex-thread",
            codexExecution: {
                model: "gpt-5.6-luna",
                reasoningEffort: "xhigh",
                permissionMode: "workspace-write",
            },
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 2,
        ...overrides,
    };
}

describe("resumeCodexSession", () => {
    it("reuses the stored execution tuple instead of the current catalog default", async () => {
        let isSessionPresent = false;
        const spawn = vi.fn(async (_options: SpawnSessionOptions) => ({ type: "success" as const, sessionId: "resumed-session" }));
        const refreshSessions = vi.fn(async () => { isSessionPresent = true; });

        const result = await resumeCodexSession(createSession(), "machine-online", {
            getCapabilities: vi.fn(async () => createCapabilities()),
            spawn,
            refreshSessions,
            hasSession: () => isSessionPresent,
            sleep: async () => undefined,
        });

        expect(result).toEqual({ type: "success", sessionId: "resumed-session" });
        expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
            agent: "codex",
            machineId: "machine-online",
            resumeSessionId: "native-codex-thread",
            permissionMode: "workspace-write",
            codexExecution: {
                model: "gpt-5.6-luna",
                reasoningEffort: "xhigh",
                catalogVersion: "fresh-catalog",
            },
        }));
        expect(refreshSessions).toHaveBeenCalledTimes(1);
    });

    it("fails closed when the original execution configuration cannot be replayed", async () => {
        const spawn = vi.fn();
        const result = await resumeCodexSession(createSession({
            metadata: { ...createSession().metadata!, codexExecution: undefined },
        }), "machine-online", {
            getCapabilities: vi.fn(async () => createCapabilities()),
            spawn,
            refreshSessions: vi.fn(async () => undefined),
            hasSession: () => false,
        });

        expect(result).toEqual({ type: "configuration-unavailable" });
        expect(spawn).not.toHaveBeenCalled();
    });

    it("does not spawn when fresh capabilities reject the original selection", async () => {
        const spawn = vi.fn();
        const result = await resumeCodexSession(createSession(), "machine-online", {
            getCapabilities: vi.fn(async () => createCapabilities({
                models: [{
                    id: "gpt-5.6-sol",
                    displayName: "GPT-5.6 Sol",
                    isDefault: true,
                    supportedReasoningEfforts: ["high"],
                }],
            })),
            spawn,
            refreshSessions: vi.fn(async () => undefined),
            hasSession: () => false,
        });

        expect(result).toEqual({ type: "configuration-unavailable" });
        expect(spawn).not.toHaveBeenCalled();
    });

    it("contains capability and spawn failures without changing the stored selection", async () => {
        const unavailable = await resumeCodexSession(createSession(), "machine-online", {
            getCapabilities: vi.fn(async () => { throw new Error("offline"); }),
            spawn: vi.fn(),
            refreshSessions: vi.fn(async () => undefined),
            hasSession: () => false,
        });
        const failedSpawn = await resumeCodexSession(createSession(), "machine-online", {
            getCapabilities: vi.fn(async () => createCapabilities()),
            spawn: vi.fn(async () => { throw new Error("transport closed"); }),
            refreshSessions: vi.fn(async () => undefined),
            hasSession: () => false,
        });

        expect(unavailable).toEqual({ type: "capabilities-unavailable" });
        expect(failedSpawn).toEqual({ type: "spawn-error", errorMessage: "" });
    });

    it("refuses a directory-approval response because resume must keep the original directory", async () => {
        const result = await resumeCodexSession(createSession(), "machine-online", {
            getCapabilities: vi.fn(async () => createCapabilities()),
            spawn: vi.fn(async () => ({ type: "requestToApproveDirectoryCreation" as const, directory: "/Users/dev/projects/remcli" })),
            refreshSessions: vi.fn(async () => undefined),
            hasSession: () => false,
        });

        expect(result).toEqual({ type: "configuration-unavailable" });
    });
});
