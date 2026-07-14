/** True only for a persisted assistant text block, never for tool/status payloads. */
export function hasNonEmptyAssistantText(content: unknown): boolean {
    if (!Array.isArray(content)) return false;

    return content.some((block) => {
        if (typeof block !== 'object' || block === null) return false;
        const candidate = block as { text?: unknown; type?: unknown };
        return candidate.type === 'text'
            && typeof candidate.text === 'string'
            && candidate.text.trim().length > 0;
    });
}
