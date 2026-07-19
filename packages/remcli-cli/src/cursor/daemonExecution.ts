import {
    isCursorRunnerIdentity,
    type CursorExecutionConfig,
    type CursorRunnerIdentity,
} from '@/cursor/cursorCapabilities';
import {
    isCursorLaunchControls,
    type CursorLaunchControls,
} from './cursorLaunchControls';
import { isCursorExecutable } from './cursorCli';

export interface CursorDaemonRunOptions {
    execution?: CursorExecutionConfig;
    launchControls?: CursorLaunchControls;
    runner?: CursorRunnerIdentity;
}

/** Only daemon-owned runners may consume the selection injected by SessionManager. */
export function getCursorDaemonRunOptions(
    startedBy: 'daemon' | 'terminal' | undefined,
    environment: NodeJS.ProcessEnv = process.env,
): CursorDaemonRunOptions {
    if (startedBy !== 'daemon') return {};

    const model = environment.REMCLI_CURSOR_MODEL;
    const catalogVersion = environment.REMCLI_CURSOR_CATALOG_VERSION;
    const executionMode = environment.REMCLI_CURSOR_EXECUTION_MODE;
    const force = environment.REMCLI_CURSOR_FORCE;
    const autoReview = environment.REMCLI_CURSOR_AUTO_REVIEW;
    const sandbox = environment.REMCLI_CURSOR_SANDBOX;
    const approveMcps = environment.REMCLI_CURSOR_APPROVE_MCPS;
    const executable = environment.REMCLI_CURSOR_EXECUTABLE;
    const cliFingerprint = environment.REMCLI_CURSOR_CLI_FINGERPRINT;
    const execution = model && catalogVersion ? { model, catalogVersion } : null;
    const hasBooleanControlValues = (force === 'true' || force === 'false')
        && (autoReview === 'true' || autoReview === 'false')
        && (approveMcps === 'true' || approveMcps === 'false');
    const launchControls = {
        executionMode,
        force: force === 'true',
        autoReview: autoReview === 'true',
        sandbox,
        approveMcps: approveMcps === 'true',
    };
    const runner = {
        executable,
        cliFingerprint,
    };

    if (!execution
        || !hasBooleanControlValues
        || !isCursorLaunchControls(launchControls)
        || !isCursorExecutable(runner.executable)
        || !isCursorRunnerIdentity(runner)) {
        return {};
    }

    return {
        execution,
        launchControls,
        runner,
    };
}
