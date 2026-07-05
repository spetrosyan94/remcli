import { describe, expect, it, vi } from 'vitest';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: () => {},
        debugLargeJson: () => {},
        info: () => {},
        warn: () => {},
    },
}));

import {
    resolveSpawnAuthEnvironment,
} from './sessionSpawner';
import { buildSafeSpawnSessionLogPayload } from './spawnSessionLog';

describe('resolveSpawnAuthEnvironment', () => {
    it('does not replace Codex CODEX_HOME with an auth-only temporary home', () => {
        expect(resolveSpawnAuthEnvironment({
            agent: 'codex',
            token: '{"OPENAI":"token"}',
        })).toEqual({});
    });

    it('keeps Claude token injection behavior unchanged', () => {
        expect(resolveSpawnAuthEnvironment({
            agent: 'claude',
            token: 'claude-token',
        })).toEqual({
            CLAUDE_CODE_OAUTH_TOKEN: 'claude-token',
        });
    });

    it('does not add auth env when token is absent', () => {
        expect(resolveSpawnAuthEnvironment({
            agent: 'codex',
        })).toEqual({});
    });
});

describe('buildSafeSpawnSessionLogPayload', () => {
    it('does not include token or environment variable values', () => {
        const payload = buildSafeSpawnSessionLogPayload({
            directory: '/Users/dev/project',
            agent: 'codex',
            token: 'secret-token',
            environmentVariables: {
                ANTHROPIC_AUTH_TOKEN: 'secret-anthropic-token',
                ANTHROPIC_MODEL: 'claude-sonnet',
            },
        });

        expect(payload).toEqual({
            directory: '/Users/dev/project',
            sessionId: undefined,
            resumeSessionId: undefined,
            resumeSessionName: undefined,
            approvedNewDirectoryCreation: undefined,
            agent: 'codex',
            hasToken: true,
            environmentVariableKeys: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL'],
        });
        expect(JSON.stringify(payload)).not.toContain('secret-token');
        expect(JSON.stringify(payload)).not.toContain('secret-anthropic-token');
    });
});
