import type { CursorLaunchControls } from './cursorLaunchControls';

/** Mode config for MessageQueue2 hashing */
export interface CursorMode {
    launchControls: CursorLaunchControls;
    model?: string;
    /** Runtime-only durable P2P delivery identity. Never sent to Cursor CLI. */
    deliveryId?: string;
}
