// remcli — ConnectionBanner (перенос design/screens/components.tsx, разметка 1:1).
import { Check, Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";

export function ConnectionBanner({ state }: { state: "lost" | "restored" }) {
    if (state === "restored")
        return (
            <div className="flex items-center gap-2.5 rounded-[9px] border border-status-running/30 bg-status-running/[0.08] px-3 py-2">
                <Check className="size-3 text-status-running" />
                <span className="font-mono text-[11.5px] text-status-running">{t("connection.restored")}</span>
            </div>
        );
    return (
        <div className="flex items-center gap-2.5 rounded-[9px] border border-status-permission/30 bg-status-permission/[0.09] px-3 py-2">
            <Loader2 className="size-3 animate-spin text-status-permission" />
            <span className="font-mono text-[11.5px] text-status-permission">{t("connection.lost")}</span>
        </div>
    );
}
