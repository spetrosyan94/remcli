// remcli-web — мок-данные для экранов (согласованы с design/screens/*.tsx).
// Экранные компоненты импортируют данные отсюда; замена на живой P2P-стор — позже.
import type { AgentId, DiffLine, Status } from "@/components/kit";

/* ---------- Машины ---------- */
export interface MockMachine {
    id: string;
    name: string;
    isOnline: boolean;
    transport: "lan" | "tunnel";
    latencyLabel?: string;
    lastSeenLabel?: string;
}

export const machines: MockMachine[] = [
    { id: "m-mbp", name: "mbp.local", isOnline: true, transport: "lan", latencyLabel: "12ms" },
    { id: "m-studio", name: "studio-pc", isOnline: false, transport: "lan", lastSeenLabel: "yesterday" },
];

/* ---------- Сессии (все 6 статусов) ---------- */
export type PermissionMode = "safe" | "ask" | "auto";

export interface MockSession {
    id: string;
    machineId: string;
    agent: AgentId;
    model: string;
    path: string;
    message: string;
    status: Status;
    timeLabel: string;
    permissionMode: PermissionMode;
}

export const sessions: MockSession[] = [
    // permission всегда поднимается наверх списка
    {
        id: "s-deploy", machineId: "m-mbp", agent: "claude", model: "opus-4.1",
        path: "~/dev/deploy-scripts", message: "Asking for permission: git push --force",
        status: "permission", timeLabel: "2 min", permissionMode: "ask",
    },
    {
        id: "s-remcli", machineId: "m-mbp", agent: "claude", model: "opus-4.1",
        path: "~/dev/remcli", message: "Writing the WebRTC transport…",
        status: "running", timeLabel: "now", permissionMode: "ask",
    },
    {
        id: "s-webapp", machineId: "m-mbp", agent: "cursor", model: "composer-1",
        path: "~/dev/webapp", message: "Thinking about the migration plan…",
        status: "thinking", timeLabel: "1 min", permissionMode: "safe",
    },
    {
        id: "s-gateway", machineId: "m-mbp", agent: "codex", model: "gpt-5.2-codex",
        path: "~/dev/api-gateway", message: "Tests passed, preparing a commit…",
        status: "idle", timeLabel: "12:40", permissionMode: "auto",
    },
    {
        id: "s-parser", machineId: "m-mbp", agent: "codex", model: "gpt-5.2-codex",
        path: "~/oss/parser", message: "error: pnpm build · exit 1",
        status: "error", timeLabel: "11:02", permissionMode: "ask",
    },
    {
        id: "s-rag", machineId: "m-studio", agent: "gemini", model: "gemini-3-pro",
        path: "~/exp/rag-index", message: "machine unreachable",
        status: "offline", timeLabel: "yesterday", permissionMode: "ask",
    },
];

/* ---------- Сообщения чата ---------- */
export interface UserChatMessage {
    id: string;
    kind: "user";
    text: string;
}

export interface AgentChatMessage {
    id: string;
    kind: "agent";
    agent: AgentId;
    timeLabel: string;
    text: string;
    /** имя инлайн-кода внутри text (рендер — <code>), напр. "seal()" */
    code?: string;
}

export interface ToolCallChatMessage {
    id: string;
    kind: "tool-call";
    tool: string;
    arg: string;
    state: "running" | "success" | "error";
    isExpanded?: boolean;
    outputLines?: string[];
    errorText?: string;
}

export interface DiffChatMessage {
    id: string;
    kind: "diff";
    file: string;
    added: number;
    removed: number;
    lines: DiffLine[];
}

export interface PermissionChatMessage {
    id: string;
    kind: "permission";
    tool: string;
    command: string;
    comment?: string;
    isDanger?: boolean;
    alwaysLabel?: string;
    timeLabel: string;
}

export interface ThinkingChatMessage {
    id: string;
    kind: "thinking";
    agent: AgentId;
}

export type MockChatMessage =
    | UserChatMessage
    | AgentChatMessage
    | ToolCallChatMessage
    | DiffChatMessage
    | PermissionChatMessage
    | ThinkingChatMessage;

/** Лента чата по id сессии (заполнена для s-remcli и s-deploy). */
export const chatMessages: Record<string, MockChatMessage[]> = {
    "s-remcli": [
        { id: "c1", kind: "user", text: "Add encryption to the channel and run the tests" },
        {
            id: "c2", kind: "agent", agent: "claude", timeLabel: "claude · 12:41",
            text: "Inspecting the current transport and wrapping send in", code: "seal()",
        },
        { id: "c3", kind: "tool-call", tool: "Read", arg: "src/transport/webrtc.ts", state: "success" },
        {
            id: "c4", kind: "tool-call", tool: "Bash", arg: "pnpm test", state: "running", isExpanded: true,
            outputLines: ["RUN  src/tunnel.test.ts", "PASS src/crypto.test.ts 12 passed"],
        },
        {
            id: "c5", kind: "diff", file: "src/transport/webrtc.ts", added: 12, removed: 4,
            lines: [
                { t: "ctx", text: " const chan = peer.channel;" },
                { t: "del", text: "chan.send(raw);" },
                { t: "add", text: "chan.send(seal(raw, key));" },
                { t: "add", text: 'metrics.bump("tx");' },
            ],
        },
        {
            id: "c6", kind: "permission", tool: "bash", timeLabel: "12:42",
            command: "pnpm test -- --run crypto", comment: "will run the crypto tests",
            alwaysLabel: "always allow pnpm test in this session",
        },
        { id: "c7", kind: "thinking", agent: "claude" },
    ],
    "s-deploy": [
        { id: "d1", kind: "user", text: "Deploy the release branch to production" },
        {
            id: "d2", kind: "agent", agent: "claude", timeLabel: "claude · 13:58",
            text: "The branch diverges from origin — a force-push is needed.",
        },
        {
            id: "d3", kind: "permission", tool: "bash", timeLabel: "14:00",
            command: "git push --force origin release", comment: "will rewrite origin/release history",
            isDanger: true,
        },
    ],
};

/* ---------- Терминал ---------- */
export interface MockTerminalLine {
    text: string;
}

export const terminalLines: MockTerminalLine[] = [
    { text: "➜ remcli git:(main) pnpm test -- --run crypto" },
    { text: " RUN  v2.1.4 ~/dev/remcli" },
    { text: " ✓ src/crypto.test.ts (9) 412ms" },
    { text: " ✓ src/tunnel.test.ts (3) 96ms" },
    { text: " Tests  12 passed (12) · 1.42s" },
    { text: "➜ remcli git:(main) git status -s" },
    { text: " M src/transport/webrtc.ts" },
    { text: "?? src/seal.ts" },
];

/* ---------- Задачи (zen) ---------- */
export interface MockZenTask {
    id: string;
    title: string;
    isDone: boolean;
    /** id живой сессии, если задача уже в работе */
    sessionId?: string;
    /** показать CTA «Работать над задачей» (new-session с prefill) */
    hasWorkCta?: boolean;
}

export const zenTasks: MockZenTask[] = [
    { id: "z1", title: "Finish channel E2E encryption", isDone: false, sessionId: "s-remcli" },
    { id: "z2", title: "Retries on tunnel drop", isDone: false, hasWorkCta: true },
    { id: "z3", title: "Update README on daemon install", isDone: false },
    { id: "z4", title: "Set up QR connection over tunnel", isDone: true },
];

/* ---------- Новая сессия ---------- */
export interface MockAgentOption {
    id: AgentId;
    name: string;
    kind: string;
    models: string[];
}

export const agentOptions: MockAgentOption[] = [
    { id: "claude", name: "Claude", kind: "code", models: ["opus-4.1", "sonnet-4.5", "haiku-4.5"] },
    { id: "codex", name: "Codex", kind: "cli", models: ["gpt-5.2-codex", "gpt-5.2"] },
    { id: "gemini", name: "Gemini", kind: "cli", models: ["gemini-3-pro", "gemini-3-flash"] },
    { id: "cursor", name: "Cursor", kind: "agent", models: ["composer-1"] },
];

export interface MockRecentDir {
    path: string;
    lastUsedLabel: string;
}

export const recentDirs: MockRecentDir[] = [
    { path: "~/dev/remcli", lastUsedLabel: "2 h ago" },
    { path: "~/dev/api-gateway", lastUsedLabel: "yesterday" },
];

export interface MockResumeEntry {
    id: string;
    label: string;
    agent: AgentId;
}

export const resumeEntries: MockResumeEntry[] = [
    { id: "rc-42", label: "rc-42 · today 12:41 · ~/dev/remcli", agent: "claude" },
    { id: "rc-41", label: "rc-41 · yesterday 18:03 · ~/dev/remcli", agent: "claude" },
];

/* ---------- Новая сессия · resume-sheet (эталон design/pages/new-session.html) ---------- */
export interface NewSessionResumeEntry {
    id: string;
    title: string;
    timeLabel: string;
    agent: AgentId;
}

export const newSessionResumeEntries: NewSessionResumeEntry[] = [
    { id: "ns-rc-42", title: "rc-42 · WebRTC transport", timeLabel: "today 12:41", agent: "claude" },
    { id: "ns-rc-41", title: "rc-41 · crypto.ts refactor", timeLabel: "yesterday 18:03", agent: "claude" },
    { id: "ns-rc-39", title: "rc-39 · onboarding flow", timeLabel: "Jun 28", agent: "claude" },
];

/* ---------- Подключение ---------- */
export const connectionInfo = {
    mode: "p2p" as const,
    latencyLabel: "p2p · 12ms",
    daemonVersion: "0.4.2",
    appVersion: "0.4.2",
};

// Экран /connect: мок камеры и подключения (design/pages/connect-states.html)
export const connectMock = {
    host: "mbp.local",
    manualAddress: "10.0.1.14:7350",
    scanDurationMs: 2000,
    connectDurationMs: 1800,
};

/* ---------- Терминал: экран /session/:id/terminal (сегменты с подсветкой) ---------- */
export type TerminalTone = "ok" | "branch" | "warn" | "muted";

export interface MockTerminalSegment {
    text: string;
    tone?: TerminalTone;
}

export interface MockTerminalOutputLine {
    id: string;
    segments: MockTerminalSegment[];
    /** вся строка приглушена (text-zinc-500) */
    isMuted?: boolean;
    /** отступ сверху (mt-2) — начало нового блока вывода */
    hasTopGap?: boolean;
    /** мигающий курсор в конце строки */
    hasCaret?: boolean;
}

export const terminalHeaderInfo = {
    cwd: "~/dev/remcli",
    ptyLabel: "pty · zsh · 80×24",
};

/** приглашение zsh: «➜ remcli git:(main)» */
export const terminalPromptSegments: MockTerminalSegment[] = [
    { text: "➜ remcli", tone: "ok" },
    { text: " " },
    { text: "git:(main)", tone: "branch" },
];

export const terminalOutputLines: MockTerminalOutputLine[] = [
    { id: "t1", segments: [...terminalPromptSegments, { text: " pnpm test -- --run crypto" }] },
    { id: "t2", isMuted: true, segments: [{ text: " RUN  v2.1.4 ~/dev/remcli" }] },
    { id: "t3", segments: [{ text: " " }, { text: "✓", tone: "ok" }, { text: " src/crypto.test.ts " }, { text: "(9)", tone: "muted" }, { text: " 412ms" }] },
    { id: "t4", segments: [{ text: " " }, { text: "✓", tone: "ok" }, { text: " src/tunnel.test.ts " }, { text: "(3)", tone: "muted" }, { text: " 96ms" }] },
    { id: "t5", isMuted: true, segments: [{ text: " Tests  " }, { text: "12 passed", tone: "ok" }, { text: " (12) · 1.42s" }] },
    { id: "t6", hasTopGap: true, segments: [...terminalPromptSegments, { text: " git status -s" }] },
    { id: "t7", segments: [{ text: " M", tone: "warn" }, { text: " src/transport/webrtc.ts" }] },
    { id: "t8", segments: [{ text: "??", tone: "ok" }, { text: " src/seal.ts" }] },
    { id: "t9", hasTopGap: true, hasCaret: true, segments: [...terminalPromptSegments] },
];

export const terminalQuickKeys = ["tab", "ctrl+c", "↑", "esc"];

/* ---------- Настройки ---------- */
export interface SettingsLocaleOption {
    id: string;
    label: string;
}

/** 10 локалей (DESIGN.md §Язык интерфейса), дефолт — ru. */
export const settingsLocales: SettingsLocaleOption[] = [
    { id: "ru", label: "Русский" },
    { id: "en", label: "English" },
    { id: "es", label: "Español" },
    { id: "pt", label: "Português" },
    { id: "it", label: "Italiano" },
    { id: "ca", label: "Català" },
    { id: "pl", label: "Polski" },
    { id: "ja", label: "日本語" },
    { id: "zh-Hans", label: "简体中文" },
    { id: "zh-Hant", label: "繁體中文" },
];

export interface SettingsTtsProviderOption {
    id: string;
    label: string;
    voices: string[];
}

/** Провайдеры TTS с голосами; дефолт — system / «Milena · ru». */
export const settingsTtsProviders: SettingsTtsProviderOption[] = [
    { id: "system", label: "system", voices: ["Milena · ru", "Yuri · ru", "Samantha · en"] },
    { id: "edge", label: "edge-tts", voices: ["Dmitry · ru", "Svetlana · ru", "Guy · en"] },
    { id: "qwen3", label: "qwen3-tts", voices: ["default", "my-voice · clone"] },
];

/* ---------- Чат: доп. фикстуры экрана /session/:id ---------- */
export interface ChatEndedSessionInfo {
    /** mono-строка «— сессия завершена · exit 0 · 14:02 —» */
    label: string;
}

/** Завершённые сессии — блок «сессия завершена» (chat-states 1f). */
export const chatEndedSessions: Record<string, ChatEndedSessionInfo> = {
    "s-gateway": { label: "— session ended · exit 0 · 14:02 —" },
};

/** Дополнительные ленты чата (существующий chatMessages не трогаем). */
export const chatExtraMessages: Record<string, MockChatMessage[]> = {
    "s-gateway": [
        { id: "chat-g1", kind: "user", text: "Run the tests and prepare a commit" },
        {
            id: "chat-g2", kind: "agent", agent: "codex", timeLabel: "codex · 13:57",
            text: "Tests are green, the commit is ready.",
        },
        { id: "chat-g3", kind: "tool-call", tool: "Bash", arg: "pnpm test", state: "success" },
    ],
};
