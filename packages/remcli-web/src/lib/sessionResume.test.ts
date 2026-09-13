import { describe, expect, it, vi } from "vitest";
import {
    mergeAntigravityResumeItems,
    resolveStoredAntigravityResumeExecution,
    resumeAntigravitySession,
    resumeCodexSession,
} from "@/lib/sessionResume";
import type {
    AgentSessionInfo,
    AntigravityCapabilitiesSnapshot,
    CodexCapabilitiesSnapshot,
    Session,
    SpawnSessionOptions,
} from "@/lib/protocol";

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

    it("fails closed when the spawned session never reaches the local store", async () => {
        const refreshSessions = vi.fn(async () => undefined);
        const sleep = vi.fn(async () => undefined);

        const result = await resumeCodexSession(createSession(), "machine-online", {
            getCapabilities: vi.fn(async () => createCapabilities()),
            spawn: vi.fn(async () => ({ type: "success" as const, sessionId: "resumed-session" })),
            refreshSessions,
            hasSession: () => false,
            sleep,
        });

        expect(result).toEqual({ type: "spawn-error", errorMessage: "" });
        expect(refreshSessions).toHaveBeenCalledTimes(10);
        expect(sleep).toHaveBeenCalledTimes(10);
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

function createAntigravityCapabilities(): AntigravityCapabilitiesSnapshot {
    return {
        agent: "antigravity",
        status: "ready",
        fetchedAt: 1,
        expiresAt: 2,
        catalogVersion: "fresh-antigravity-catalog",
        executionModes: ["default", "accept-edits", "plan"],
        supportsDangerouslySkipPermissions: true,
        supportsSandbox: true,
        models: [{
            id: "gemini-flash",
            displayName: "Gemini Flash",
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: ["low", "medium", "high"],
            runtimeModels: {
                low: "gemini-flash-low",
                medium: "gemini-flash-medium",
                high: "gemini-flash-high",
            },
        }],
    };
}

function createAntigravitySession(overrides: Partial<Session> = {}): Session {
    return {
        ...createSession(),
        id: "ended-antigravity-session",
        metadata: {
            path: "/Users/dev/projects/remcli",
            host: "macbook.local",
            machineId: "machine-online",
            flavor: "antigravity",
            name: "Antigravity lifecycle",
            antigravitySessionId: "native-antigravity-conversation",
            antigravityExecution: {
                model: "gemini-flash-low",
                reasoningEffort: "low",
            },
        },
        ...overrides,
    };
}

describe("Antigravity resume", () => {
    it("replays the newest trusted Remcli wrapper model tuple for a New Session resume row", () => {
        const older = createAntigravitySession({
            id: "older-wrapper",
            updatedAt: 10,
            metadata: {
                ...createAntigravitySession().metadata!,
                antigravityExecution: { model: "gemini-flash-medium", reasoningEffort: "medium" },
            },
        });
        const newer = createAntigravitySession({ updatedAt: 20 });

        expect(resolveStoredAntigravityResumeExecution(
            createAntigravityCapabilities(),
            [older, newer],
            "machine-online",
            {
                sessionId: "native-antigravity-conversation",
                projectPath: "/Users/dev/projects/remcli",
            },
        )).toEqual({
            type: "ready",
            execution: {
                model: "gemini-flash-low",
                reasoningEffort: "low",
                catalogVersion: "fresh-antigravity-catalog",
            },
        });
    });

    it("distinguishes provider-only history from a saved tuple removed from the fresh catalog", () => {
        expect(resolveStoredAntigravityResumeExecution(
            createAntigravityCapabilities(),
            [],
            "machine-online",
            { sessionId: "provider-only", projectPath: "/Users/dev/projects/remcli" },
        )).toEqual({ type: "not-found" });

        expect(resolveStoredAntigravityResumeExecution(
            createAntigravityCapabilities(),
            [createAntigravitySession({
                metadata: {
                    ...createAntigravitySession().metadata!,
                    antigravityExecution: { model: "removed-model", reasoningEffort: "low" },
                },
            })],
            "machine-online",
            {
                sessionId: "native-antigravity-conversation",
                projectPath: "/Users/dev/projects/remcli",
            },
        )).toEqual({ type: "configuration-unavailable" });
    });

    it("resumes the exact conversation with a freshly validated model tuple and safe controls", async () => {
        let isSessionPresent = false;
        const spawn = vi.fn(async (_options: SpawnSessionOptions) => ({
            type: "success" as const,
            sessionId: "resumed-antigravity-session",
        }));

        const result = await resumeAntigravitySession(createAntigravitySession(), "machine-online", {
            getCapabilities: vi.fn(async () => createAntigravityCapabilities()),
            spawn,
            refreshSessions: vi.fn(async () => { isSessionPresent = true; }),
            hasSession: () => isSessionPresent,
            sleep: async () => undefined,
        });

        expect(result).toEqual({ type: "success", sessionId: "resumed-antigravity-session" });
        expect(spawn).toHaveBeenCalledWith({
            machineId: "machine-online",
            directory: "/Users/dev/projects/remcli",
            agent: "antigravity",
            resumeSessionId: "native-antigravity-conversation",
            resumeSessionName: "Antigravity lifecycle",
            antigravityExecution: {
                model: "gemini-flash-low",
                reasoningEffort: "low",
                catalogVersion: "fresh-antigravity-catalog",
            },
            antigravityLaunchControls: {
                mode: "default",
                dangerouslySkipPermissions: false,
                sandbox: false,
            },
        });
    });

    it("fails closed when the saved runtime model is absent from the fresh catalog", async () => {
        const spawn = vi.fn();
        const result = await resumeAntigravitySession(createAntigravitySession({
            metadata: {
                ...createAntigravitySession().metadata!,
                antigravityExecution: { model: "removed-model", reasoningEffort: "low" },
            },
        }), "machine-online", {
            getCapabilities: vi.fn(async () => createAntigravityCapabilities()),
            spawn,
            refreshSessions: vi.fn(async () => undefined),
            hasSession: () => false,
        });

        expect(result).toEqual({ type: "configuration-unavailable" });
        expect(spawn).not.toHaveBeenCalled();
    });

    it("merges completed Remcli conversations into native history and excludes active wrappers", () => {
        const nativeItems: AgentSessionInfo[] = [{
            sessionId: "native-history-conversation",
            agent: "antigravity",
            projectPath: "/Users/dev/projects/remcli",
            lastModified: 10,
            firstMessage: "Native history",
            messageCount: 1,
            createdAt: null,
            sessionName: null,
        }];
        const active = createAntigravitySession({
            id: "active-wrapper",
            active: true,
            presence: "online",
            metadata: {
                ...createAntigravitySession().metadata!,
                antigravitySessionId: "active-conversation",
            },
        });

        const result = mergeAntigravityResumeItems(
            nativeItems,
            [createAntigravitySession({ updatedAt: 20 }), active],
            "machine-online",
            "/Users/dev/projects/remcli",
        );

        expect(result.map((item) => item.sessionId)).toEqual([
            "native-antigravity-conversation",
            "native-history-conversation",
        ]);
        expect(result.some((item) => item.sessionId === "active-conversation")).toBe(false);
        expect(result[0]).toMatchObject({
            sessionName: "Antigravity lifecycle",
            lastModified: 20,
        });
    });
});
