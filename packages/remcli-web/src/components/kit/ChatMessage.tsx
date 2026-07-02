// remcli — чат: метки и сообщения (перенос design/screens/components.tsx, разметка 1:1).
import * as React from "react";
import { AgentIcon } from "@/components/kit/AgentIcon";
import { t } from "@/lib/i18n";
import type { AgentId } from "@/components/kit/types";

export function AgentMeta({ agent, children }: { agent: AgentId; children: React.ReactNode }) {
    return (
        <div className="flex items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
            <AgentIcon agent={agent} className="size-[18px] rounded-[5px] text-[9px]" />
            {children}
        </div>
    );
}

export function UserMessage({ children }: { children: React.ReactNode }) {
    return (
        <div className="max-w-[85%] self-end rounded-2xl rounded-br-[4px] bg-secondary px-3.5 py-2 text-sm leading-normal">
            {children}
        </div>
    );
}

export function Caret({ thinking = false }: { thinking?: boolean }) {
    return (
        <span className={`ml-0.5 inline-block h-[15px] w-2 align-[-2px] ${thinking ? "animate-blink-think bg-status-thinking" : "animate-blink bg-accent"}`} />
    );
}

export function ThinkingRow({ agent }: { agent: AgentId }) {
    return (
        <div className="flex items-center gap-2 font-mono text-[11.5px] text-muted-foreground">
            <AgentIcon agent={agent} className="size-[18px] rounded-[5px] text-[9px]" />
            {t("chat.thinking")} <Caret thinking />
        </div>
    );
}
