import { describe, expect, it } from "vitest";
import type { CodexCapabilitiesSnapshot } from "@/lib/protocol";
import {
    createCodexExecutionForModel,
    getCodexResumeSelection,
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
    it("rebuilds the stored selection with a fresh catalog instead of the live default", () => {
        const capabilities = createCapabilities({
            catalogVersion: "fresh-catalog",
            models: [
                {
                    id: "gpt-5.6-sol",
                    displayName: "GPT-5.6 Sol",
                    isDefault: true,
                    defaultReasoningEffort: "max",
                    supportedReasoningEfforts: ["max"],
                },
                {
                    id: "gpt-5.6-luna",
                    displayName: "GPT-5.6 Luna",
                    isDefault: false,
                    defaultReasoningEffort: "xhigh",
                    supportedReasoningEfforts: ["low", "high", "xhigh"],
                },
            ],
        });

        expect(getCodexResumeSelection(capabilities, {
            model: "gpt-5.6-luna",
            reasoningEffort: "xhigh",
            permissionMode: "read-only",
        })).toEqual({
            codexExecution: {
                model: "gpt-5.6-luna",
                reasoningEffort: "xhigh",
                catalogVersion: "fresh-catalog",
            },
            permissionMode: "read-only",
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
        expect(getCodexResumeSelection(capabilities, {
            model: "gpt-5.6-luna",
            reasoningEffort: "xhigh",
            permissionMode: "workspace-write",
        })).toBeNull();
    });

    it("fails closed for a legacy or incompatible stored selection", () => {
        expect(getCodexResumeSelection(createCapabilities(), undefined)).toBeNull();
        expect(getCodexResumeSelection(createCapabilities(), {
            model: "gpt-5.6-luna",
            permissionMode: "workspace-write",
        })).toBeNull();
        expect(getCodexResumeSelection(createCapabilities({
            status: "unavailable",
            catalogVersion: null,
            models: [],
            permissionModes: [],
        }), {
            model: "gpt-5.6-luna",
            reasoningEffort: "xhigh",
            permissionMode: "workspace-write",
        })).toBeNull();
        expect(getCodexResumeSelection(createCapabilities({
            permissionModes: ["workspace-write"],
        }), {
            model: "gpt-5.6-luna",
            reasoningEffort: "xhigh",
            permissionMode: "read-only",
        })).toBeNull();
    });

    it("preserves the absence of reasoning only for a model without a selector", () => {
        const capabilities = createCapabilities({
            models: [{
                id: "gpt-5.6-no-reasoning",
                displayName: "GPT-5.6 No Reasoning",
                isDefault: true,
                supportedReasoningEfforts: [],
            }],
        });

        expect(getCodexResumeSelection(capabilities, {
            model: "gpt-5.6-no-reasoning",
            permissionMode: "read-only",
        })).toEqual({
            codexExecution: {
                model: "gpt-5.6-no-reasoning",
                catalogVersion: "catalog-v1",
            },
            permissionMode: "read-only",
        });
        expect(getCodexResumeSelection(capabilities, {
            model: "gpt-5.6-no-reasoning",
            reasoningEffort: "xhigh",
            permissionMode: "read-only",
        })).toBeNull();
    });
});
