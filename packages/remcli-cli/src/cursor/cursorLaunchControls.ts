/**
 * Cursor launch controls are fixed when a remote session is created.
 *
 * ACP exposes the provider-native Agent, Plan and Ask session modes. Other
 * root CLI flags are not accepted by `agent acp` and therefore are not part of
 * Remcli's Cursor session contract.
 */

export type CursorExecutionMode = 'agent' | 'plan' | 'ask';

export interface CursorLaunchControls {
    executionMode: CursorExecutionMode;
}

export const DEFAULT_CURSOR_LAUNCH_CONTROLS: CursorLaunchControls = {
    executionMode: 'agent',
};

const CURSOR_LAUNCH_CONTROL_KEYS = new Set(['executionMode']);

export function isCursorExecutionMode(value: unknown): value is CursorExecutionMode {
    return value === 'agent' || value === 'plan' || value === 'ask';
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

        if (!Object.prototype.hasOwnProperty.call(record, 'executionMode')) {
            return false;
        }

        return isCursorExecutionMode(record.executionMode);
    } catch {
        return false;
    }
}
