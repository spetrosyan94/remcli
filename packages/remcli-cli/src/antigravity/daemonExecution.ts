import type { AntigravityExecutionConfig } from './antigravityCapabilities';
import type { AntigravityLaunchControls } from './antigravityCli';

export interface AntigravityDaemonRunOptions {
    execution?: AntigravityExecutionConfig;
    launchControls?: AntigravityLaunchControls;
}

function parseBoolean(value: string | undefined): boolean | null {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return null;
}

/** Only a daemon-owned runner may consume capability-validated launch state. */
export function getAntigravityDaemonRunOptions(
    startedBy: 'daemon' | 'terminal' | undefined,
    environment: NodeJS.ProcessEnv = process.env,
): AntigravityDaemonRunOptions {
    if (startedBy !== 'daemon') return {};

    const model = environment.REMCLI_ANTIGRAVITY_MODEL;
    const catalogVersion = environment.REMCLI_ANTIGRAVITY_CATALOG_VERSION;
    const effort = environment.REMCLI_ANTIGRAVITY_REASONING_EFFORT;
    const mode = environment.REMCLI_ANTIGRAVITY_MODE;
    const dangerouslySkipPermissions = parseBoolean(
        environment.REMCLI_ANTIGRAVITY_DANGEROUSLY_SKIP_PERMISSIONS,
    );
    const sandbox = parseBoolean(environment.REMCLI_ANTIGRAVITY_SANDBOX);

    if (!model
        || !catalogVersion
        || (effort !== undefined && effort !== 'low' && effort !== 'medium' && effort !== 'high')
        || (mode !== 'default' && mode !== 'accept-edits' && mode !== 'plan')
        || dangerouslySkipPermissions === null
        || sandbox === null) {
        return {};
    }

    return {
        execution: {
            model,
            catalogVersion,
            ...(effort ? { reasoningEffort: effort } : {}),
        },
        launchControls: {
            mode,
            dangerouslySkipPermissions,
            sandbox,
        },
    };
}
