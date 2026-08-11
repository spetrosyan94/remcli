import type { I18nKey } from "@/lib/i18n";
import type { Machine, Session } from "@/lib/protocol";

export type TerminalPlatform = "mac" | "windows" | "linux" | "computer";
export type TerminalHandoffKind = "loading" | "active" | "ended" | "unavailable" | "not-found";

export const TERMINAL_PLATFORM_LABEL_KEYS: Record<TerminalPlatform, I18nKey> = {
    mac: "terminal.platform.mac",
    windows: "terminal.platform.windows",
    linux: "terminal.platform.linux",
    computer: "terminal.platform.computer",
};

export interface TerminalHandoffState {
    kind: TerminalHandoffKind;
    platform: TerminalPlatform;
    host: string | null;
}

/**
 * A machine id is the only stable identity. Hostnames can be reused after a
 * reinstall or re-registration, so legacy sessions must not borrow machine
 * platform or availability from a hostname match.
 */
export function terminalMachineForSession(session: Session | null, machines: Machine[]): Machine | null {
    const machineId = session?.metadata?.machineId;
    if (machineId) return machines.find((machine) => machine.id === machineId) ?? null;
    return null;
}

export function terminalPlatform(os: string | null | undefined): TerminalPlatform {
    switch (os?.trim().toLowerCase()) {
        case "darwin":
            return "mac";
        case "win32":
            return "windows";
        case "linux":
            return "linux";
        default:
            return "computer";
    }
}

export function resolveTerminalHandoff(
    session: Session | null,
    machine: Machine | null,
    hasLoadedSessions: boolean,
): TerminalHandoffState {
    if (!hasLoadedSessions) {
        return { kind: "loading", platform: "computer", host: null };
    }

    if (!session) {
        return { kind: "not-found", platform: "computer", host: null };
    }

    const platform = terminalPlatform(session.metadata?.os ?? machine?.metadata?.platform);
    const host = session.metadata?.host ?? machine?.metadata?.host ?? null;

    if (!session.active || session.presence !== "online") {
        return { kind: "ended", platform, host };
    }

    // Missing machine data is not proof of an offline host. Only an explicit
    // inactive machine state makes an otherwise active session unavailable.
    if (machine?.active === false) {
        return { kind: "unavailable", platform, host };
    }

    return { kind: "active", platform, host };
}
