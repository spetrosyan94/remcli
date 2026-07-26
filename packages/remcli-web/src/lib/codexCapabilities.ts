import type {
    CodexCapabilitiesSnapshot,
    CodexExecutionConfig,
    CodexModelCapability,
    PermissionMode,
} from "@/lib/protocol";

type CodexPermissionMode = Extract<PermissionMode, "read-only" | "workspace-write" | "danger-full-access">;

export interface CodexResumeSelection {
    codexExecution: CodexExecutionConfig;
    permissionMode: CodexPermissionMode;
}

export function createCodexExecutionForModel(
    capabilities: CodexCapabilitiesSnapshot,
    modelId: string,
    reasoningEffort?: CodexModelCapability["supportedReasoningEfforts"][number],
): CodexExecutionConfig | null {
    if (capabilities.status !== "ready" || !capabilities.catalogVersion) return null;
    const model = capabilities.models.find((item) => item.id === modelId);
    if (!model) return null;
    if (reasoningEffort !== undefined && !model.supportedReasoningEfforts.includes(reasoningEffort)) return null;

    const selectedReasoningEffort = reasoningEffort ?? model.defaultReasoningEffort;
    if (model.supportedReasoningEfforts.length > 0) {
        if (!selectedReasoningEffort || !model.supportedReasoningEfforts.includes(selectedReasoningEffort)) return null;
    }

    return {
        model: model.id,
        catalogVersion: capabilities.catalogVersion,
        ...(selectedReasoningEffort ? { reasoningEffort: selectedReasoningEffort } : {}),
    };
}

export function getDefaultCodexExecution(capabilities: CodexCapabilitiesSnapshot): CodexExecutionConfig | null {
    if (capabilities.status !== "ready" || !capabilities.catalogVersion) return null;
    const model = capabilities.models.find((item) => item.isDefault) ?? capabilities.models[0];
    return model ? createCodexExecutionForModel(capabilities, model.id) : null;
}

export function getDefaultCodexPermissionMode(capabilities: CodexCapabilitiesSnapshot): CodexPermissionMode | null {
    if (capabilities.status !== "ready") return null;

    return capabilities.permissionModes.includes("workspace-write")
        ? "workspace-write"
        : capabilities.permissionModes[0] ?? null;
}

export function getDefaultCodexResumeSelection(
    capabilities: CodexCapabilitiesSnapshot,
): CodexResumeSelection | null {
    const codexExecution = getDefaultCodexExecution(capabilities);
    const permissionMode = getDefaultCodexPermissionMode(capabilities);

    return codexExecution && permissionMode ? { codexExecution, permissionMode } : null;
}
