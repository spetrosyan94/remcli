import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CursorTurnError, runCursorTurn } from './cursorQuery';

const runOnUnix = process.platform === 'win32' ? it.skip : it;

const FIXTURE_SOURCE = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const scenario = process.env.REMCLI_CURSOR_FIXTURE_SCENARIO;
const args = process.argv.slice(2);
const sessionId = process.env.REMCLI_CURSOR_FIXTURE_SESSION_ID ?? 'cursor-native-session';
const argsPath = process.env.REMCLI_CURSOR_FIXTURE_ARGS_PATH;
const pidPath = process.env.REMCLI_CURSOR_FIXTURE_PID_PATH;

if (argsPath) {
    writeFileSync(argsPath, JSON.stringify({ args, cursorApiKey: process.env.CURSOR_API_KEY ?? null }));
}

const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');

if (scenario === 'success') {
    emit({ type: 'system', subtype: 'init', session_id: sessionId });
    emit({ type: 'result', subtype: 'success', session_id: sessionId, result: 'REMCLI_CURSOR_SUCCESS' });
    process.exit(0);
}

if (scenario === 'no-init') {
    emit({ type: 'result', subtype: 'success', session_id: sessionId, result: 'missing init' });
    process.exit(0);
}

if (scenario === 'result-before-init') {
    emit({ type: 'result', subtype: 'success', session_id: sessionId, result: 'out-of-order result' });
    emit({ type: 'system', subtype: 'init', session_id: sessionId });
    process.exit(0);
}

if (scenario === 'no-result') {
    emit({ type: 'system', subtype: 'init', session_id: sessionId });
    process.exit(0);
}

if (scenario === 'error-result') {
    emit({ type: 'system', subtype: 'init', session_id: sessionId });
    emit({ type: 'result', subtype: 'error', session_id: sessionId, is_error: true, result: 'fixture-private-result' });
    process.exit(0);
}

if (scenario === 'nonzero-auth') {
    process.stderr.write('unauthorized fixture-private-secret');
    process.exit(7);
}

if (scenario === 'malformed') {
    process.on('SIGTERM', () => {});
    process.stdout.write('not valid json\\n');
    setInterval(() => {}, 1_000);
}

if (scenario === 'resume-mismatch') {
    process.on('SIGTERM', () => {});
    emit({ type: 'system', subtype: 'init', session_id: 'different-native-session' });
    setInterval(() => {}, 1_000);
}

if (scenario === 'abort-tree') {
    const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (pidPath) writeFileSync(pidPath, JSON.stringify({ parent: process.pid, worker: worker.pid }));
    emit({ type: 'system', subtype: 'init', session_id: sessionId });
    setInterval(() => {}, 1_000);
}

if (!['malformed', 'resume-mismatch', 'abort-tree'].includes(scenario ?? '')) {
    throw new Error('Unknown Cursor fixture scenario: ' + scenario);
}
`;

interface FixtureProcessIds {
    parent: number;
    worker: number;
}

function assertProcessStopped(pid: number): void {
    expect(() => process.kill(pid, 0)).toThrow();
}

async function waitForProcessStop(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            process.kill(pid, 0);
        } catch {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assertProcessStopped(pid);
}

describe('runCursorTurn', () => {
    let fixtureDirectory: string;
    let fixtureExecutable: string;
    const spawnedProcessIds: FixtureProcessIds[] = [];

    beforeEach(() => {
        fixtureDirectory = mkdtempSync(join(tmpdir(), 'remcli-cursor-fixture-'));
        fixtureExecutable = join(fixtureDirectory, 'agent');
        writeFileSync(fixtureExecutable, FIXTURE_SOURCE);
        chmodSync(fixtureExecutable, 0o755);
    });

    afterEach(async () => {
        for (const processIds of spawnedProcessIds.splice(0)) {
            for (const pid of [processIds.parent, processIds.worker]) {
                try {
                    process.kill(pid, 'SIGKILL');
                } catch {
                    // The process was already stopped by the test subject.
                }
            }
        }
        if (existsSync(fixtureDirectory)) {
            rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    });

    runOnUnix('accepts a native response only after init, terminal success, and exit code zero', async () => {
        const argsPath = join(fixtureDirectory, 'args.json');
        const events: Array<{ type: string; subtype?: string }> = [];

        const outcome = await runCursorTurn({
            executable: fixtureExecutable,
            prompt: 'fixture prompt must not be logged',
            model: 'composer-1.5',
            resumeSessionId: 'cursor-native-session',
            mode: 'plan',
            env: {
                REMCLI_CURSOR_FIXTURE_SCENARIO: 'success',
                REMCLI_CURSOR_FIXTURE_ARGS_PATH: argsPath,
                CURSOR_API_KEY: 'fixture-api-key',
            },
        }, (event) => {
            events.push({ type: event.type, subtype: event.subtype });
        });

        expect(outcome).toEqual({
            sessionId: 'cursor-native-session',
            response: 'REMCLI_CURSOR_SUCCESS',
            exitCode: 0,
        });
        expect(events).toEqual([
            { type: 'system', subtype: 'init' },
            { type: 'result', subtype: 'success' },
        ]);

        const received = JSON.parse(readFileSync(argsPath, 'utf8')) as {
            args: string[];
            cursorApiKey: string | null;
        };
        expect(received.cursorApiKey).toBe('fixture-api-key');
        expect(received.args).toContain('--resume');
        expect(received.args).toContain('cursor-native-session');
        expect(received.args).toContain('--mode');
        expect(received.args).toContain('plan');
        expect(received.args).not.toContain('--api-key');
        expect(received.args).not.toContain('fixture-api-key');
    });

    runOnUnix.each([
        ['no-init', 'protocol'],
        ['no-result', 'native'],
        ['error-result', 'native'],
    ])('fails closed for a %s stream lifecycle', async (scenario, expectedKind) => {
        await expect(runCursorTurn({
            executable: fixtureExecutable,
            prompt: 'fixture prompt',
            env: { REMCLI_CURSOR_FIXTURE_SCENARIO: scenario },
        }, () => undefined)).rejects.toMatchObject({
            name: 'CursorTurnError',
            kind: expectedKind,
        });
    });

    runOnUnix('rejects a successful result before init before it can reach the session callback', async () => {
        const onEvent = vi.fn();

        await expect(runCursorTurn({
            executable: fixtureExecutable,
            prompt: 'fixture prompt',
            env: { REMCLI_CURSOR_FIXTURE_SCENARIO: 'result-before-init' },
        }, onEvent)).rejects.toMatchObject({ kind: 'protocol' });

        expect(onEvent).not.toHaveBeenCalled();
    });

    runOnUnix('redacts native authentication stderr from the public error', async () => {
        const failure = await runCursorTurn({
            executable: fixtureExecutable,
            prompt: 'fixture prompt',
            env: { REMCLI_CURSOR_FIXTURE_SCENARIO: 'nonzero-auth' },
        }, () => undefined).catch((error: unknown) => error);

        expect(failure).toMatchObject({ kind: 'native' });
        expect(failure).toBeInstanceOf(CursorTurnError);
        expect((failure as Error).message).toContain('authentication failed');
        expect((failure as Error).message).not.toContain('fixture-private-secret');
    });

    runOnUnix('preserves a typed callback failure instead of replacing it with a generic native error', async () => {
        const bindingError = new CursorTurnError('native', 'Cursor native session binding failed: wrapper already owned.');

        await expect(runCursorTurn({
            executable: fixtureExecutable,
            prompt: 'fixture prompt',
            env: { REMCLI_CURSOR_FIXTURE_SCENARIO: 'success' },
        }, () => {
            throw bindingError;
        })).rejects.toBe(bindingError);
    });

    runOnUnix('rejects malformed NDJSON before it can reach the session callback', async () => {
        const onEvent = vi.fn();

        await expect(runCursorTurn({
            executable: fixtureExecutable,
            prompt: 'fixture prompt',
            env: { REMCLI_CURSOR_FIXTURE_SCENARIO: 'malformed' },
        }, onEvent)).rejects.toMatchObject({ kind: 'protocol' });

        expect(onEvent).not.toHaveBeenCalled();
    });

    runOnUnix('rejects a mismatched native resume before publishing the foreign session ID', async () => {
        const onEvent = vi.fn();

        await expect(runCursorTurn({
            executable: fixtureExecutable,
            prompt: 'fixture prompt',
            resumeSessionId: 'expected-native-session',
            env: { REMCLI_CURSOR_FIXTURE_SCENARIO: 'resume-mismatch' },
        }, onEvent)).rejects.toMatchObject({ kind: 'resume-mismatch' });

        expect(onEvent).not.toHaveBeenCalled();
    });

    runOnUnix('aborts the native process group instead of leaving a child worker behind', async () => {
        const abortController = new AbortController();
        const pidPath = join(fixtureDirectory, 'pids.json');
        const onEvent = vi.fn();
        const turn = runCursorTurn({
            executable: fixtureExecutable,
            prompt: 'fixture prompt',
            abort: abortController.signal,
            env: {
                REMCLI_CURSOR_FIXTURE_SCENARIO: 'abort-tree',
                REMCLI_CURSOR_FIXTURE_PID_PATH: pidPath,
            },
        }, onEvent);

        await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true));
        await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'system',
            subtype: 'init',
        })));
        const processIds = JSON.parse(readFileSync(pidPath, 'utf8')) as FixtureProcessIds;
        spawnedProcessIds.push(processIds);
        const rejectedTurn = expect(turn).rejects.toMatchObject({ kind: 'aborted' });
        abortController.abort();

        await rejectedTurn;
        await waitForProcessStop(processIds.parent);
        await waitForProcessStop(processIds.worker);
        expect(onEvent).toHaveBeenCalledTimes(1);
    });

    runOnUnix('reports a missing executable as a typed startup error', async () => {
        await expect(runCursorTurn({
            executable: join(fixtureDirectory, 'missing-agent'),
            prompt: 'fixture prompt',
        }, () => undefined)).rejects.toMatchObject({ kind: 'cli-not-found' });
    });
});
