import type {
    CodexCapabilitiesSnapshot,
    CodexExecutionConfig,
    CodexModelCapability,
    CodexSessionExecution,
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

export function getCodexResumeSelection(
    capabilities: CodexCapabilitiesSnapshot,
    storedExecution: CodexSessionExecution | undefined,
): CodexResumeSelection | null {
    if (!storedExecution) return null;

    if (capabilities.status !== "ready" || !capabilities.catalogVersion) return null;
    const model = capabilities.models.find((item) => item.id === storedExecution.model);
    if (!model) return null;

    // A missing effort is valid only for providers that expose no reasoning
    // selector for this model. It must never turn into a current default on
    // resume, because that changes the saved execution contract.
    if (model.supportedReasoningEfforts.length === 0) {
        if (storedExecution.reasoningEffort !== undefined) return null;
    } else if (
        !storedExecution.reasoningEffort
        || !model.supportedReasoningEfforts.includes(storedExecution.reasoningEffort)
    ) {
        return null;
    }

    const codexExecution = createCodexExecutionForModel(
        capabilities,
        storedExecution.model,
        storedExecution.reasoningEffort,
    );
    const permissionMode = storedExecution.permissionMode;
    if (!capabilities.permissionModes.includes(permissionMode)) return null;

    return codexExecution && permissionMode ? { codexExecution, permissionMode } : null;
}
