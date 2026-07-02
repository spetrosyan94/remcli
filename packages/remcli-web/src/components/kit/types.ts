// remcli — общие типы UI-кита (перенос design/screens/components.tsx).

export type AgentId = "claude" | "codex" | "gemini" | "cursor";

export type Status = "running" | "thinking" | "permission" | "idle" | "offline" | "error";
