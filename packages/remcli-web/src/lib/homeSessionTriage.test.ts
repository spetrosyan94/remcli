import { describe, expect, it } from "vitest";
import {
    filterMachineGroups,
    getHomeQuickResumeCandidate,
    homeSessionCategory,
    resolveOnlineMachineForResume,
    type MachineGroup,
} from "@/lib/homeSessionTriage";
import type { Machine, Session } from "@/lib/protocol";

const NOW = 1_700_000_000_000;

function createMachine(overrides: Partial<Machine> = {}): Machine {
    return {
        id: "machine-online",
        seq: 1,
        createdAt: NOW - 1_000,
        updatedAt: NOW,
        active: true,
        activeAt: NOW,
        metadata: {
            host: "macbook.local",
            platform: "darwin",
            remcliCliVersion: "1.0.0",
            remcliHomeDir: "/Users/dev/.remcli",
            homeDir: "/Users/dev",
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
        ...overrides,
    };
}

function createSession(overrides: Partial<Session> = {}): Session {
    const activeAt = overrides.activeAt ?? NOW;
    return {
        id: "session",
        seq: 1,
        createdAt: activeAt - 1_000,
        updatedAt: activeAt,
        active: false,
        activeAt,
        metadata: {
            path: "/Users/dev/projects/remcli",
            host: "macbook.local",
            machineId: "machine-online",
            flavor: "codex",
            codexSessionId: "native-session",
            codexExecution: {
                model: "gpt-5.6-luna",
                reasoningEffort: "xhigh",
                permissionMode: "workspace-write",
            },
        },
        metadataVersion: 1,
        agentState: { controlledByUser: false, requests: {}, completedRequests: {} },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: activeAt,
        ...overrides,
    };
}

describe("Home session triage", () => {
    it("keeps lifecycle categories independent from presentation state", () => {
        const activeIdle = createSession({ active: true, presence: "online" });
        const pendingPermission = createSession({
            active: true,
            presence: "online",
            agentState: {
                controlledByUser: false,
                requests: { request: { tool: "Bash", arguments: {}, createdAt: NOW } },
                completedRequests: {},
            },
        });
        const typedError = createSession({
            active: false,
            presence: NOW - 1_000,
            metadata: {
                ...createSession().metadata!,
                executionOutcome: { kind: "error", occurredAt: NOW - 1_000 },
            },
        });
        const completedRequest = createSession({
            agentState: {
                controlledByUser: false,
                requests: { request: { tool: "Bash", arguments: {}, createdAt: NOW } },
                completedRequests: {
                    request: {
                        tool: "Bash",
                        arguments: {},
                        createdAt: NOW,
                        completedAt: NOW,
                        status: "approved",
                        reason: null,
                        mode: null,
                        allowedTools: null,
                        decision: "approved",
                    },
                },
            },
        });

        expect(homeSessionCategory(activeIdle)).toBe("active");
        expect(homeSessionCategory(pendingPermission)).toBe("attention");
        expect(homeSessionCategory(typedError)).toBe("attention");
        expect(homeSessionCategory(completedRequest)).toBe("completed");
    });

    it("filters grouped sessions with attention taking precedence over active", () => {
        const attention = createSession({
            id: "attention",
            active: true,
            presence: "online",
            agentState: {
                controlledByUser: false,
                requests: { request: { tool: "Bash", arguments: {}, createdAt: NOW } },
                completedRequests: {},
            },
        });
        const active = createSession({ id: "active", active: true, presence: "online" });
        const completed = createSession({ id: "completed" });
        const groups: MachineGroup[] = [{
            key: "machine-online",
            name: "MacBook",
            isOnline: true,
            lastSeenLabel: null,
            rpcMachineId: "machine-online",
            sessions: [attention, active, completed],
        }];

        expect(filterMachineGroups(groups, "attention")[0]?.sessions.map((session) => session.id)).toEqual(["attention"]);
        expect(filterMachineGroups(groups, "active")[0]?.sessions.map((session) => session.id)).toEqual(["active"]);
        expect(filterMachineGroups(groups, "completed")[0]?.sessions.map((session) => session.id)).toEqual(["completed"]);
    });

    it("selects only the newest safe completed provider session deterministically", () => {
        const machine = createMachine();
        const newestEligible = createSession({ id: "b-newest", activeAt: NOW - 1_000, updatedAt: NOW - 1_000 });
        const sameTimestampEligible = createSession({ id: "a-newest", activeAt: NOW - 1_000, updatedAt: NOW - 1_000 });
        const offlineMachine = createSession({
            id: "offline-machine",
            activeAt: NOW,
            updatedAt: NOW,
            metadata: { ...createSession().metadata!, machineId: "offline-machine", host: "offline.local" },
        });
        const deferred = createSession({
            id: "deferred",
            activeAt: NOW,
            updatedAt: NOW,
            metadata: { ...createSession().metadata!, flavor: "claude", claudeSessionId: "claude-native", codexSessionId: undefined, codexExecution: undefined },
        });
        const duplicateActiveWrapper = createSession({
            id: "active-wrapper",
            active: true,
            presence: "online",
            metadata: { ...createSession().metadata!, codexSessionId: "duplicate-native" },
        });
        const duplicatedCompleted = createSession({
            id: "duplicated-completed",
            activeAt: NOW,
            updatedAt: NOW,
            metadata: { ...createSession().metadata!, codexSessionId: "duplicate-native" },
        });

        const candidate = getHomeQuickResumeCandidate({
            sessions: [offlineMachine, deferred, duplicateActiveWrapper, duplicatedCompleted, newestEligible, sameTimestampEligible],
            machines: [machine],
            isConnected: true,
        });

        expect(candidate?.session.id).toBe("a-newest");
        expect(candidate?.machine.id).toBe("machine-online");
    });

    it("requires the exact machine ID when a session has one", () => {
        const session = createSession({
            metadata: { ...createSession().metadata!, machineId: "missing", host: "macbook.local" },
        });

        expect(resolveOnlineMachineForResume(session, [createMachine()])).toBeNull();
        expect(getHomeQuickResumeCandidate({
            sessions: [session],
            machines: [createMachine()],
            isConnected: true,
        })).toBeNull();
    });

    it("uses a hostname only for a legacy session with one unambiguous online match", () => {
        const legacySession = createSession({
            metadata: { ...createSession().metadata!, machineId: undefined },
        });
        const onlineMachine = createMachine();
        const duplicateHostMachine = createMachine({ id: "machine-duplicate" });

        expect(resolveOnlineMachineForResume(legacySession, [onlineMachine])?.id).toBe("machine-online");
        expect(resolveOnlineMachineForResume(legacySession, [onlineMachine, duplicateHostMachine])).toBeNull();
    });

    it("keeps the exact stored Cursor model with a quick Resume candidate", () => {
        const session = createSession({
            metadata: {
                ...createSession().metadata!,
                flavor: "cursor",
                codexSessionId: undefined,
                codexExecution: undefined,
                cursorSessionId: "cursor-native-session",
                cursorExecution: { model: "gpt-5.6-luna-xhigh" },
            },
        });

        const candidate = getHomeQuickResumeCandidate({
            sessions: [session],
            machines: [createMachine()],
            isConnected: true,
        });

        expect(candidate?.agent).toBe("cursor");
        expect(candidate?.cursorModel).toBe("gpt-5.6-luna-xhigh");
    });
});
