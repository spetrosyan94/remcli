export async function copyText(text: string): Promise<void> {
    try {
        if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
    } catch {
        // Safari на HTTP/LAN может отклонить clipboard write даже после тапа.
    }

    if (typeof document === "undefined" || !document.body) return;

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";

    try {
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
    } catch {
        // Мягкий no-op: копирование не должно блокировать основной сценарий.
    } finally {
        textarea.remove();
    }
}
