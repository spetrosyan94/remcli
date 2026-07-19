/**
 * Test setup file for vitest
 *
 * Global setup that runs ONCE before all tests
 */

import { spawnSync } from 'node:child_process'
import { redactSensitiveText } from './utils/redaction'

export interface BuildResult {
    status: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
    stdout: Buffer;
    stderr: Buffer;
}

export type BuildRunner = () => BuildResult;

function runBuild(): BuildResult {
    return spawnSync('npm', ['run', 'build'], { stdio: 'pipe' });
}

function formatOutput(label: string, output: Buffer): string | undefined {
    const text = output.toString().trim();
    return text.length > 0 ? `${label}: ${redactSensitiveText(text)}` : undefined;
}

export function getBuildFailureMessage(buildResult: BuildResult): string | undefined {
    const reasons = [
        buildResult.status !== 0 ? `status=${String(buildResult.status)}` : undefined,
        buildResult.signal !== null ? `signal=${buildResult.signal}` : undefined,
        buildResult.error
            ? `error=${buildResult.error.name}: ${redactSensitiveText(buildResult.error.message)}`
            : undefined,
    ].filter((reason): reason is string => reason !== undefined);

    if (reasons.length === 0) {
        return undefined;
    }

    const diagnostics = [
        formatOutput('stderr', buildResult.stderr),
        formatOutput('stdout', buildResult.stdout),
    ].filter((output): output is string => output !== undefined);

    return [
        `Build failed (${reasons.join(', ')})`,
        ...diagnostics,
    ].join('\n');
}

export function setup(buildRunner?: BuildRunner): void {
    // Extend test timeout for integration tests
    process.env.VITEST_POOL_TIMEOUT = '60000';

    // Make sure to build the project before running tests
    // We rely on the dist files to spawn our CLI in integration tests
    const buildResult = (typeof buildRunner === 'function' ? buildRunner : runBuild)();
    const failureMessage = getBuildFailureMessage(buildResult);

    if (failureMessage !== undefined) {
        throw new Error(failureMessage);
    }
}
