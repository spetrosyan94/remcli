import { describe, expect, it } from "vitest";
import type { CodexCapabilitiesSnapshot } from "@/lib/protocol";
import {
    createCodexExecutionForModel,
    getDefaultCodexResumeSelection,
} from "@/lib/codexCapabilities";

function createCapabilities(overrides: Partial<CodexCapabilitiesSnapshot> = {}): CodexCapabilitiesSnapshot {
    return {
        agent: "codex",
        status: "ready",
        fetchedAt: 1,
        expiresAt: 2,
        catalogVersion: "catalog-v1",
        permissionModes: ["read-only", "workspace-write"],
        models: [{
            id: "gpt-5.6-luna",
            displayName: "GPT-5.6 Luna",
            isDefault: true,
            defaultReasoningEffort: "xhigh",
            supportedReasoningEfforts: ["low", "high", "xhigh"],
        }],
        ...overrides,
    };
}

describe("Codex capability selections", () => {
    it("builds an atomic default resume selection from the live catalog", () => {
        expect(getDefaultCodexResumeSelection(createCapabilities())).toEqual({
            codexExecution: {
                model: "gpt-5.6-luna",
                reasoningEffort: "xhigh",
                catalogVersion: "catalog-v1",
            },
            permissionMode: "workspace-write",
        });
    });

    it("rejects a model whose required reasoning selection is unavailable", () => {
        const capabilities = createCapabilities({
            models: [{
                id: "gpt-5.6-luna",
                displayName: "GPT-5.6 Luna",
                isDefault: true,
                supportedReasoningEfforts: ["high"],
            }],
        });

        expect(createCodexExecutionForModel(capabilities, "gpt-5.6-luna")).toBeNull();
        expect(getDefaultCodexResumeSelection(capabilities)).toBeNull();
    });

    it("does not synthesize a resume selection from an unavailable catalog", () => {
        expect(getDefaultCodexResumeSelection(createCapabilities({
            status: "unavailable",
            catalogVersion: null,
            models: [],
            permissionModes: [],
        }))).toBeNull();
    });
});
