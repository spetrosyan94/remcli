import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { buildAntigravityCommand, buildAntigravityCurrentModelCommand, buildAntigravityModelsCommand, buildAntigravityVersionCommand, runAntigravityCommand, type AntigravityKillProcess, type AntigravityProcessSpawner } from './antigravityCli';

describe('Antigravity CLI boundary', () => {
    it('constructs discovery argv without a shell', () => {
        expect(buildAntigravityVersionCommand()).toEqual({ executable: 'agy', args: ['--version'] });
        expect(buildAntigravityModelsCommand()).toEqual({ executable: 'agy', args: ['models'] });
        expect(buildAntigravityCurrentModelCommand()).toEqual({ executable: 'agy', args: ['-p', '/model'] });
    });

    it('keeps sandbox separate from native execution modes and marks the dangerous profile', () => {
        expect(buildAntigravityCommand({ mode: 'accept-edits', sandbox: true })).toEqual({ executable: 'agy', args: ['--mode', 'accept-edits', '--sandbox'] });
        expect(buildAntigravityCommand({ mode: 'plan', dangerouslySkipPermissions: true })).toEqual({ executable: 'agy', args: ['--mode', 'plan', '--dangerously-skip-permissions'] });
        expect(buildAntigravityCommand()).toEqual({ executable: 'agy', args: [] });
    });

    it('keeps the TERM to KILL escalation alive after timeout rejection', async () => {
        vi.useFakeTimers();
        try {
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            const child = { pid: 123, stdout, stderr, once: vi.fn() } as unknown as ReturnType<AntigravityProcessSpawner>;
            const spawnProcess = vi.fn(() => child) as unknown as AntigravityProcessSpawner;
            const killProcess = vi.fn<AntigravityKillProcess>();
            const result = runAntigravityCommand(buildAntigravityModelsCommand(), 'model discovery', 100, 1024, spawnProcess, killProcess);
            const rejection = expect(result).rejects.toThrow('timed out');
            await vi.advanceTimersByTimeAsync(100);
            await rejection;
            expect(killProcess).toHaveBeenNthCalledWith(1, child, 'SIGTERM');
            const closeListener = (child.once as ReturnType<typeof vi.fn>).mock.calls
                .find(([event]) => event === 'close')?.[1] as ((code: number) => void) | undefined;
            closeListener?.(0);
            await vi.advanceTimersByTimeAsync(250);
            expect(killProcess).toHaveBeenNthCalledWith(2, child, 'SIGKILL');
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps the TERM to KILL escalation alive after output-limit rejection', async () => {
        vi.useFakeTimers();
        try {
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            const child = { pid: 123, stdout, stderr, once: vi.fn() } as unknown as ReturnType<AntigravityProcessSpawner>;
            const spawnProcess = vi.fn(() => child) as unknown as AntigravityProcessSpawner;
            const killProcess = vi.fn<AntigravityKillProcess>();
            const result = runAntigravityCommand(buildAntigravityModelsCommand(), 'model discovery', 1_000, 4, spawnProcess, killProcess);
            const rejection = expect(result).rejects.toThrow('output limit');

            stdout.write(Buffer.from('12345'));
            await rejection;
            expect(killProcess).toHaveBeenNthCalledWith(1, child, 'SIGTERM');
            await vi.advanceTimersByTimeAsync(250);
            expect(killProcess).toHaveBeenNthCalledWith(2, child, 'SIGKILL');
        } finally {
            vi.useRealTimers();
        }
    });
});
