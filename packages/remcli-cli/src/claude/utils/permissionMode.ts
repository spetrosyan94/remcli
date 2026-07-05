import type { QueryOptions } from '@/claude/sdk';
import type { ClaudePermissionMode, PermissionMode } from '@/api/types';

/** Derived from SDK's QueryOptions - the modes Claude actually supports */
export type ClaudeSdkPermissionMode = NonNullable<QueryOptions['permissionMode']>;

export function isClaudePermissionMode(mode: PermissionMode): mode is ClaudePermissionMode {
    return mode === 'manual'
        || mode === 'acceptEdits'
        || mode === 'bypassPermissions'
        || mode === 'plan'
        || mode === 'auto'
        || mode === 'dontAsk';
}

export function normalizeClaudeMode(mode: PermissionMode | undefined): ClaudePermissionMode {
    if (!mode) return 'manual';
    if (isClaudePermissionMode(mode)) return mode;
    throw new Error(`Unsupported Claude permission mode "${mode}".`);
}

export function mapToClaudeMode(mode: PermissionMode | undefined): ClaudeSdkPermissionMode {
    return normalizeClaudeMode(mode);
}
