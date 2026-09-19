// remcli — UI-кит: перенос design/screens/components.tsx (разметка и классы 1:1).
export type { AgentId, Status } from "@/components/kit/types";
export { AgentIcon } from "@/components/kit/AgentIcon";
export { statusLabel, StatusBadge, StatusDot } from "@/components/kit/StatusBadge";
export { SessionCard } from "@/components/kit/SessionCard";
export { PermissionCard } from "@/components/kit/PermissionCard";
export {
    StructuredInputCard,
    STRUCTURED_SUCCESS_VISIBLE_MS,
    STRUCTURED_ALREADY_RESOLVED_VISIBLE_MS,
    StructuredResponseFeedback,
    createInitialStructuredValues,
    createStructuredResponseGate,
    isSafeDisplayUrl,
    isSafeHttpsUrl,
    isStructuredResponseLocked,
    navigateValidatedStructuredUrl,
    openStructuredUrlPlaceholder,
    structuredFieldIsValid,
    structuredFormContent,
    structuredToolAnswers,
    type FieldValue,
    type FieldValues,
    type StructuredFieldValueState,
    type StructuredInputCardProps,
    type StructuredResponseState,
} from "@/components/kit/StructuredInputCard";
export { ToolCallCard } from "@/components/kit/ToolCallCard";
export { DiffView, type DiffLine } from "@/components/kit/DiffView";
export { AgentMeta, Caret, ThinkingRow, UserMessage } from "@/components/kit/ChatMessage";
export { ListenButton } from "@/components/kit/ListenButton";
export { VoiceRecordBar } from "@/components/kit/VoiceRecordBar";
export { ConnectionBanner } from "@/components/kit/ConnectionBanner";
export { EmptyState } from "@/components/kit/EmptyState";
export { Logo } from "@/components/kit/Logo";
export { Segmented } from "@/components/kit/Segmented";
