import { describe, expect, it } from 'vitest';

import {
    buildCursorInteractiveTuiCommand,
    buildCursorTurnArguments,
    resolveCursorExecutable,
} from './cursorCli';
import { DEFAULT_CURSOR_LAUNCH_CONTROLS } from './cursorLaunchControls';

describe('Cursor native CLI boundary', () => {
    it('prefers the current agent executable and falls back only when necessary', () => {
        const probes: string[] = [];

        const executable = resolveCursorExecutable((candidate) => {
            probes.push(candidate);
            return candidate === 'cursor-agent';
        });

        expect(executable).toBe('cursor-agent');
        expect(probes).toEqual(['agent', 'cursor-agent']);
    });

    it('builds one explicit non-interactive turn with every independent native launch control', () => {
        const argumentsList = buildCursorTurnArguments({
            prompt: 'Inspect the current workspace.',
            model: 'composer-1.5',
            resumeSessionId: '4dbf4d0d-bf5c-4487-8a53-972fa2d57199',
            trustWorkspace: true,
            launchControls: {
                executionMode: 'plan',
                force: true,
                autoReview: true,
                sandbox: 'disabled',
                approveMcps: true,
            },
        });

        expect(argumentsList).toEqual([
            '--print',
            '--output-format', 'stream-json',
            '--trust',
            '--model', 'composer-1.5',
            '--resume', '4dbf4d0d-bf5c-4487-8a53-972fa2d57199',
            '--mode', 'plan',
            '--force',
            '--auto-review',
            '--sandbox', 'disabled',
            '--approve-mcps',
            'Inspect the current workspace.',
        ]);
        expect(argumentsList).not.toContain('--api-key');
    });

    it('maps Agent to an omitted --mode flag and preserves default launch controls', () => {
        expect(buildCursorTurnArguments({
            prompt: 'Use the normal Agent mode.',
            trustWorkspace: true,
            launchControls: { ...DEFAULT_CURSOR_LAUNCH_CONTROLS },
        })).toEqual([
            '--print', '--output-format', 'stream-json', '--trust', 'Use the normal Agent mode.',
        ]);
        expect(buildCursorTurnArguments({ prompt: 'No trust override.' })).toEqual([
            '--print', '--output-format', 'stream-json', 'No trust override.',
        ]);
    });

    it('rejects malformed launch controls before spawning a process', () => {
        expect(() => buildCursorTurnArguments({
            prompt: 'Do not run.',
            launchControls: {
                ...DEFAULT_CURSOR_LAUNCH_CONTROLS,
                force: 'true',
            } as unknown as typeof DEFAULT_CURSOR_LAUNCH_CONTROLS,
        })).toThrow('launch controls are invalid');
    });

    it('builds a normal interactive Agent TUI resume command without a mode override', () => {
        const command = buildCursorInteractiveTuiCommand({
            executable: 'agent',
            resumeSessionId: 'native-session-1',
            launchControls: { ...DEFAULT_CURSOR_LAUNCH_CONTROLS },
        });

        expect(command).toBe("'agent' --resume 'native-session-1'");
        expect(command).not.toMatch(/--print|--output-format|--trust/);
    });

    it('builds an interactive TUI command with every supported explicit control', () => {
        expect(buildCursorInteractiveTuiCommand({
            executable: 'cursor-agent',
            resumeSessionId: 'native-session-2',
            model: 'composer-1.5',
            launchControls: {
                executionMode: 'plan',
                force: true,
                autoReview: true,
                sandbox: 'disabled',
                approveMcps: true,
            },
        })).toBe(
            "'cursor-agent' --resume 'native-session-2' --model 'composer-1.5' --mode plan --force --auto-review --sandbox disabled --approve-mcps",
        );
    });

    it('shell-quotes hostile resume IDs and models', () => {
        expect(buildCursorInteractiveTuiCommand({
            executable: 'agent',
            resumeSessionId: "native'; echo resume-pwned; 'session",
            model: 'model $(echo model-pwned) && "quoted"',
            launchControls: { ...DEFAULT_CURSOR_LAUNCH_CONTROLS },
        })).toBe(
            "'agent' --resume 'native'\\''; echo resume-pwned; '\\''session' --model 'model $(echo model-pwned) && \"quoted\"'",
        );
    });

    it('rejects empty resume IDs, invalid executables, empty models, and malformed controls', () => {
        const validOptions = {
            executable: 'agent' as const,
            resumeSessionId: 'native-session-3',
            launchControls: { ...DEFAULT_CURSOR_LAUNCH_CONTROLS },
        };

        for (const resumeSessionId of ['', '   ']) {
            expect(() => buildCursorInteractiveTuiCommand({ ...validOptions, resumeSessionId }))
                .toThrow('resume session ID must be a non-empty string');
        }
        expect(() => buildCursorInteractiveTuiCommand({
            ...validOptions,
            executable: 'cursor' as 'agent',
        })).toThrow('executable is invalid');
        expect(() => buildCursorInteractiveTuiCommand({ ...validOptions, model: '\n\t' }))
            .toThrow('model must be a non-empty string');
        expect(() => buildCursorInteractiveTuiCommand({
            ...validOptions,
            launchControls: {
                ...DEFAULT_CURSOR_LAUNCH_CONTROLS,
                force: 'true',
            } as unknown as typeof DEFAULT_CURSOR_LAUNCH_CONTROLS,
        })).toThrow('launch controls are invalid');
    });
});
