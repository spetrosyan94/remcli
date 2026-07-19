/**
 * Cursor launch controls are fixed when a remote session is created.
 *
 * They intentionally do not share the generic provider `PermissionMode`:
 * Cursor exposes execution mode, independent launch flags, sandbox override
 * and MCP approval as distinct native controls.
 */

export type CursorExecutionMode = 'agent' | 'plan' | 'ask';
export type CursorSandboxMode = 'local-configuration' | 'enabled' | 'disabled';

export interface CursorLaunchControls {
    executionMode: CursorExecutionMode;
    force: boolean;
    autoReview: boolean;
    sandbox: CursorSandboxMode;
    approveMcps: boolean;
}

export const DEFAULT_CURSOR_LAUNCH_CONTROLS: CursorLaunchControls = {
    executionMode: 'agent',
    force: false,
    autoReview: false,
    sandbox: 'local-configuration',
    approveMcps: false,
};

const CURSOR_LAUNCH_CONTROL_KEYS = new Set([
    'executionMode',
    'force',
    'autoReview',
    'sandbox',
    'approveMcps',
]);

export function isCursorExecutionMode(value: unknown): value is CursorExecutionMode {
    return value === 'agent' || value === 'plan' || value === 'ask';
}

export function isCursorSandboxMode(value: unknown): value is CursorSandboxMode {
    return value === 'local-configuration' || value === 'enabled' || value === 'disabled';
}

/** Strictly validate untrusted machine-RPC data before it reaches a runner. */
export function isCursorLaunchControls(value: unknown): value is CursorLaunchControls {
    try {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        if (Object.getPrototypeOf(value) !== Object.prototype) return false;

        const record = value as Record<string, unknown>;
        if (!Reflect.ownKeys(record).every((key) => (
            typeof key === 'string' && CURSOR_LAUNCH_CONTROL_KEYS.has(key)
        ))) {
            return false;
        }

        if (!Object.prototype.hasOwnProperty.call(record, 'executionMode')
            || !Object.prototype.hasOwnProperty.call(record, 'force')
            || !Object.prototype.hasOwnProperty.call(record, 'autoReview')
            || !Object.prototype.hasOwnProperty.call(record, 'sandbox')
            || !Object.prototype.hasOwnProperty.call(record, 'approveMcps')) {
            return false;
        }

        return isCursorExecutionMode(record.executionMode)
            && typeof record.force === 'boolean'
            && typeof record.autoReview === 'boolean'
            && isCursorSandboxMode(record.sandbox)
            && typeof record.approveMcps === 'boolean';
    } catch {
        return false;
    }
}
