import { describe, expect, it, vi } from 'vitest';

import {
    getBuildFailureMessage,
    setup,
    type BuildResult,
} from './test-setup';

function createBuildResult(overrides: Partial<BuildResult> = {}): BuildResult {
    return {
        status: 0,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        ...overrides,
    };
}

describe('vitest global setup build check', () => {
    it('allows a successful build that writes diagnostics to stderr', () => {
        const runBuild = vi.fn(() => createBuildResult({
            stderr: Buffer.from('debugger listening on stderr'),
        }));

        expect(() => setup(runBuild)).not.toThrow();
        expect(runBuild).toHaveBeenCalledOnce();
        expect(getBuildFailureMessage(createBuildResult({
            stderr: Buffer.from('warning emitted by the build tool'),
        }))).toBeUndefined();
    });

    it('fails on a non-zero exit status and redacts build output', () => {
        const secret = 'build-access-token';
        const buildResult = createBuildResult({
            status: 1,
            stderr: Buffer.from(`Build failed at https://example.test?access_token=${secret}`),
            stdout: Buffer.from('pkgroll output'),
        });

        expect(() => setup(() => buildResult)).toThrowError(
            `Build failed (status=1)\nstderr: Build failed at https://example.test?access_token=[REDACTED]\nstdout: pkgroll output`,
        );
    });

    it('fails when the build process reports a spawn error', () => {
        const buildResult = createBuildResult({
            error: new Error('spawn failed: https://example.test?token=spawn-secret'),
        });

        expect(() => setup(() => buildResult)).toThrowError(
            'Build failed (error=Error: spawn failed: https://example.test?token=[REDACTED])',
        );
    });

    it('fails when the build process is terminated by a signal', () => {
        const buildResult = createBuildResult({
            status: null,
            signal: 'SIGTERM',
        });

        expect(() => setup(() => buildResult)).toThrowError(
            'Build failed (status=null, signal=SIGTERM)',
        );
    });
});
