import { describe, expect, it } from 'vitest';

import { buildCursorTurnArguments, resolveCursorExecutable } from './cursorCli';

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

    it('builds one explicit non-interactive turn without a credential argument', () => {
        const argumentsList = buildCursorTurnArguments({
            prompt: 'Inspect the current workspace.',
            model: 'composer-1.5',
            resumeSessionId: '4dbf4d0d-bf5c-4487-8a53-972fa2d57199',
            mode: 'plan',
        });

        expect(argumentsList).toEqual([
            '--print',
            '--output-format', 'stream-json',
            '--trust',
            '--model', 'composer-1.5',
            '--resume', '4dbf4d0d-bf5c-4487-8a53-972fa2d57199',
            '--mode', 'plan',
            'Inspect the current workspace.',
        ]);
        expect(argumentsList).not.toContain('--api-key');
    });

    it('maps explicit native write modes without inventing a generic permission flag', () => {
        expect(buildCursorTurnArguments({ prompt: 'Use the normal Agent mode.', mode: 'agent' })).toEqual([
            '--print', '--output-format', 'stream-json', '--trust', 'Use the normal Agent mode.',
        ]);
        expect(buildCursorTurnArguments({ prompt: 'Write the change.', force: true })).toEqual([
            '--print', '--output-format', 'stream-json', '--trust', '--force', 'Write the change.',
        ]);
        expect(buildCursorTurnArguments({ prompt: 'Review the diff.', autoReview: true })).toEqual([
            '--print', '--output-format', 'stream-json', '--trust', '--auto-review', 'Review the diff.',
        ]);
    });

    it('rejects mutually exclusive native modes before spawning a process', () => {
        expect(() => buildCursorTurnArguments({
            prompt: 'Do not run.',
            force: true,
            autoReview: true,
        })).toThrow('cannot be enabled together');
    });
});
