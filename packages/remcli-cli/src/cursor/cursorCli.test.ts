import { describe, expect, it } from 'vitest';

import {
    buildCursorInteractiveTuiCommand,
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

    it('builds a normal interactive Agent TUI resume command without a mode override', () => {
        const command = buildCursorInteractiveTuiCommand({
            executable: 'agent',
            resumeSessionId: 'native-session-1',
            launchControls: { ...DEFAULT_CURSOR_LAUNCH_CONTROLS },
        });

        expect(command).toBe("'agent' --resume 'native-session-1'");
        expect(command).not.toMatch(/--print|--output-format|--trust/);
    });

    it('builds an interactive TUI command with an ACP-compatible mode', () => {
        expect(buildCursorInteractiveTuiCommand({
            executable: 'cursor-agent',
            resumeSessionId: 'native-session-2',
            model: 'composer-1.5',
            launchControls: { executionMode: 'plan' },
        })).toBe(
            "'cursor-agent' --resume 'native-session-2' --model 'composer-1.5' --mode plan",
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
                force: true,
            } as unknown as typeof DEFAULT_CURSOR_LAUNCH_CONTROLS,
        })).toThrow('launch controls are invalid');
    });
});
