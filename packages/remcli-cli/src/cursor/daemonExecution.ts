import type { CursorPermissionMode } from '@/api/types';
import type { CursorExecutionConfig } from '@/cursor/cursorCapabilities';

export interface CursorDaemonRunOptions {
    execution?: CursorExecutionConfig;
    permissionMode?: CursorPermissionMode;
}

function isCursorPermissionMode(value: string | undefined): value is CursorPermissionMode {
    return value === 'agent'
        || value === 'plan'
        || value === 'ask'
        || value === 'force'
        || value === 'auto-review';
}

/** Only daemon-owned runners may consume the selection injected by SessionManager. */
export function getCursorDaemonRunOptions(
    startedBy: 'daemon' | 'terminal' | undefined,
    environment: NodeJS.ProcessEnv = process.env,
): CursorDaemonRunOptions {
    if (startedBy !== 'daemon') return {};

    const model = environment.REMCLI_CURSOR_MODEL;
    const catalogVersion = environment.REMCLI_CURSOR_CATALOG_VERSION;
    const permissionMode = environment.REMCLI_CURSOR_PERMISSION_MODE;
    const execution = model && catalogVersion
        ? { model, catalogVersion }
        : undefined;

    return {
        ...(execution ? { execution } : {}),
        ...(isCursorPermissionMode(permissionMode) ? { permissionMode } : {}),
    };
}
