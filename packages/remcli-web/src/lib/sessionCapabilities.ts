import type { Session } from "@/lib/protocol";

export interface IStopMachineTarget {
    id: string | null;
    isActive: boolean;
}

/** A stop RPC is valid only for an active session created and owned by the daemon. */
export function canStopSession(session: Session | null, machine: IStopMachineTarget | null): boolean {
    return session?.metadata?.startedBy === "daemon"
        && session.active
        && session.presence === "online"
        && machine?.isActive === true
        && typeof machine.id === "string"
        && machine.id.trim().length > 0;
}
