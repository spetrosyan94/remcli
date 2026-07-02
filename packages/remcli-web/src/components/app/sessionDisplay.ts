// remcli-web — маппинг сущностей P2P-протокола (Session/Machine) в пропсы UI-кита:
// агент, путь (~/…), статус (DESIGN.md §Карта статусов), строка состояния, метки времени.
// Референс: remcli-app sources/utils/sessionUtils.ts.
import type { AgentId, Status } from "@/components/kit";
import { t } from "@/lib/i18n";
import type { Machine, Session } from "@/lib/protocol";

/** flavor из метаданных сессии → id агента UI-кита (неизвестный флейвор → claude). */
export function sessionAgent(session: Session): AgentId {
    const flavor = session.metadata?.flavor;
    if (flavor === "codex" || flavor === "gemini" || flavor === "cursor") return flavor;
    return "claude";
}

/** Путь относительно домашней директории: /Users/x/dev/remcli → ~/dev/remcli. */
export function formatPathRelativeToHome(path: string, homeDir?: string): string {
    if (!homeDir) return path;
    const normalizedHome = homeDir.endsWith("/") ? homeDir.slice(0, -1) : homeDir;
    if (!path.startsWith(normalizedHome)) return path;
    const relative = path.slice(normalizedHome.length);
    if (relative === "") return "~";
    return relative.startsWith("/") ? `~${relative}` : `~/${relative}`;
}

/** Отображаемый путь сессии (fallback — короткий id, если метаданные не расшифрованы). */
export function sessionPath(session: Session): string {
    const path = session.metadata?.path;
    if (!path) return session.id.slice(0, 8);
    return formatPathRelativeToHome(path, session.metadata?.homeDir);
}

/** Есть ли неотвеченный запрос разрешения (agentState.requests). */
export function hasPendingPermission(session: Session): boolean {
    const requests = session.agentState?.requests;
    return !!requests && Object.keys(requests).length > 0;
}

/**
 * Статус сессии для UI-кита: permission > thinking > idle у живых,
 * offline у неактивных ('running'/'error' протокол на списке не различает).
 */
export function sessionStatus(session: Session): Status {
    if (session.presence !== "online") return "offline";
    if (hasPendingPermission(session)) return "permission";
    if (session.thinking) return "thinking";
    return "idle";
}

/** Строка состояния под путём: запрос разрешения / думает / summary / путь. */
export function sessionMessage(session: Session): string {
    const status = sessionStatus(session);
    if (status === "permission") {
        const requests = session.agentState?.requests ?? {};
        const first = Object.values(requests)[0];
        return first ? `${t("status.permission")}: ${first.tool}` : t("status.permission");
    }
    if (status === "thinking") return `${t("status.thinking")}…`;
    if (status === "offline") return t("status.offline");
    return session.metadata?.summary?.text ?? t("status.idle");
}

/** Компактная метка времени: сейчас · N мин · HH:MM · вчера · D мес. */
export function formatTimeLabel(timestamp: number): string {
    if (!timestamp) return "";
    const diffMs = Date.now() - timestamp;
    if (diffMs < 60_000) return t("time.now");
    if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)} ${t("time.min")}`;
    const date = new Date(timestamp);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
        return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    }
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) return t("time.yesterday");
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

/** Имя машины: displayName → host → короткий id. */
export function machineName(machine: Machine): string {
    return machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id.slice(0, 8);
}
