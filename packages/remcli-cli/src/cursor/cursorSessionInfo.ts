import type { SessionInfoUpdate } from '@agentclientprotocol/sdk';

import type { Metadata } from '@/api/types';

const MAX_CURSOR_SESSION_TITLE_LENGTH = 60;

function normalizeTitle(value: string): string | null {
    const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    if (normalized.length <= MAX_CURSOR_SESSION_TITLE_LENGTH) return normalized;
    return `${normalized.slice(0, MAX_CURSOR_SESSION_TITLE_LENGTH - 3)}...`;
}

export function parseCursorSessionUpdatedAt(value: string | null | undefined): number | null {
    if (typeof value !== 'string') return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

export function hasCursorNativeTitleDirective(update: SessionInfoUpdate): boolean {
    if (!Object.prototype.hasOwnProperty.call(update, 'title')) return false;
    return update.title === null || (typeof update.title === 'string' && normalizeTitle(update.title) !== null);
}

export function applyCursorSessionInfoUpdate(
    metadata: Metadata,
    update: SessionInfoUpdate,
    now: () => number = Date.now,
): Metadata {
    const hasTitle = Object.prototype.hasOwnProperty.call(update, 'title');
    const updatedAt = parseCursorSessionUpdatedAt(update.updatedAt);
    const currentSummary = metadata.summary;

    if (hasTitle && update.title === null) {
        if (!currentSummary) return metadata;
        const next = { ...metadata };
        delete next.summary;
        return next;
    }

    const normalizedTitle = typeof update.title === 'string' ? normalizeTitle(update.title) : null;
    if (normalizedTitle) {
        const nextSummary = {
            text: normalizedTitle,
            // Remcli summaries require a timestamp. ACP allows updatedAt:null,
            // so retain the current value for an unchanged title or use a
            // monotonic local timestamp for a new title.
            updatedAt: updatedAt
                ?? (currentSummary?.text === normalizedTitle
                    ? currentSummary.updatedAt
                    : Math.max(currentSummary?.updatedAt ?? 0, now())),
        };
        if (currentSummary?.text === nextSummary.text
            && currentSummary.updatedAt === nextSummary.updatedAt) {
            return metadata;
        }
        return { ...metadata, summary: nextSummary };
    }

    if (updatedAt !== null && currentSummary && currentSummary.updatedAt !== updatedAt) {
        return {
            ...metadata,
            summary: { ...currentSummary, updatedAt },
        };
    }

    return metadata;
}
