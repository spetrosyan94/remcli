import { beforeEach, describe, expect, it, vi } from 'vitest';

const tmuxMocks = vi.hoisted(() => ({
    spawnInTmux: vi.fn(),
}));

const openTerminalMocks = vi.hoisted(() => ({
    openTerminalWithCommand: vi.fn(async () => true),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: () => {},
        debugLargeJson: () => {},
        info: () => {},
        warn: () => {},
    },
}));

vi.mock('@/persistence', () => ({
    readSettings: vi.fn(async () => ({ profiles: [], activeProfileId: undefined })),
    validateProfileForAgent: vi.fn(() => true),
    getProfileEnvironmentVariables: vi.fn(() => ({})),
}));

vi.mock('@/utils/tmux', () => ({
    isTmuxAvailable: vi.fn(async () => true),
    getTmuxUtilities: vi.fn(() => ({
        spawnInTmux: tmuxMocks.spawnInTmux,
    })),
}));

vi.mock('@/utils/openTerminal', () => ({
    openTerminalWithCommand: openTerminalMocks.openTerminalWithCommand,
}));

import {
    createSessionManager,
    resolveSpawnAuthEnvironment,
} from './sessionSpawner';
import { buildSafeSpawnSessionLogPayload } from './spawnSessionLog';

beforeEach(() => {
    vi.clearAllMocks();
    openTerminalMocks.openTerminalWithCommand.mockResolvedValue(true);
});

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

describe('createSessionManager resume deduplication', () => {
    it('joins concurrent spawns for the same native agent session', async () => {
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session',
            pid: process.pid,
        });

        const manager = createSessionManager();
        const options = {
            directory: process.cwd(),
            agent: 'codex' as const,
            resumeSessionId: 'codex-thread-1',
        };

        const first = manager.spawnSession(options);
        const second = manager.spawnSession(options);

        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        });
        expect(openTerminalMocks.openTerminalWithCommand).not.toHaveBeenCalled();

        manager.onRemcliSessionWebhook('remcli-session-1', {
            path: process.cwd(),
            host: 'test-host',
            homeDir: '/Users/test',
            remcliHomeDir: '/Users/test/.remcli',
            remcliLibDir: process.cwd(),
            remcliToolsDir: `${process.cwd()}/tools/unpacked`,
            hostPid: process.pid,
            startedBy: 'daemon',
            flavor: 'codex',
            agentSessionId: 'codex-thread-1',
            codexSessionId: 'codex-thread-1',
        });

        await expect(first).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-1' });
        await expect(second).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-1' });
    });

    it('reuses an already tracked native agent session', async () => {
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session',
            pid: process.pid,
        });

        const manager = createSessionManager();
        const options = {
            directory: process.cwd(),
            agent: 'codex' as const,
            resumeSessionId: 'codex-thread-2',
        };

        const first = manager.spawnSession(options);
        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        });
        expect(openTerminalMocks.openTerminalWithCommand).not.toHaveBeenCalled();
        manager.onRemcliSessionWebhook('remcli-session-2', {
            path: process.cwd(),
            host: 'test-host',
            homeDir: '/Users/test',
            remcliHomeDir: '/Users/test/.remcli',
            remcliLibDir: process.cwd(),
            remcliToolsDir: `${process.cwd()}/tools/unpacked`,
            hostPid: process.pid,
            startedBy: 'daemon',
            flavor: 'codex',
            agentSessionId: 'codex-thread-2',
            codexSessionId: 'codex-thread-2',
        });
        await expect(first).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-2' });

        const second = await manager.spawnSession(options);

        expect(second).toEqual({ type: 'success', sessionId: 'remcli-session-2' });
        expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
    });

    it('refuses duplicate resume spawn while the first process is still waiting for webhook', async () => {
        vi.useFakeTimers();
        try {
            tmuxMocks.spawnInTmux.mockResolvedValueOnce({
                success: true,
                sessionId: 'tmux-session',
                pid: process.pid,
            });

            const manager = createSessionManager();
            const options = {
                directory: process.cwd(),
                agent: 'codex' as const,
                resumeSessionId: 'codex-thread-slow',
            };

            const first = manager.spawnSession(options);
            await vi.waitFor(() => {
                expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
            });

            await vi.advanceTimersByTimeAsync(15_000);
            await expect(first).resolves.toEqual({
                type: 'error',
                errorMessage: expect.stringContaining('Session webhook timeout'),
            });

            const second = await manager.spawnSession(options);

            expect(second).toEqual({
                type: 'error',
                errorMessage: expect.stringContaining('already starting'),
            });
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps opening a tmux terminal attach for non-Codex agents', async () => {
        tmuxMocks.spawnInTmux.mockResolvedValueOnce({
            success: true,
            sessionId: 'tmux-session',
            pid: process.pid,
        });

        const manager = createSessionManager();
        const spawning = manager.spawnSession({
            directory: process.cwd(),
            agent: 'claude',
        });

        await vi.waitFor(() => {
            expect(tmuxMocks.spawnInTmux).toHaveBeenCalledTimes(1);
        });

        expect(openTerminalMocks.openTerminalWithCommand).toHaveBeenCalledWith(
            expect.stringMatching(/^env -u TMUX tmux attach -t remcli-\d+-claude$/)
        );

        manager.onRemcliSessionWebhook('remcli-session-claude', {
            path: process.cwd(),
            host: 'test-host',
            homeDir: '/Users/test',
            remcliHomeDir: '/Users/test/.remcli',
            remcliLibDir: process.cwd(),
            remcliToolsDir: `${process.cwd()}/tools/unpacked`,
            hostPid: process.pid,
            startedBy: 'daemon',
            flavor: 'claude',
            agentSessionId: 'claude-session-1',
            claudeSessionId: 'claude-session-1',
        });

        await expect(spawning).resolves.toEqual({ type: 'success', sessionId: 'remcli-session-claude' });
    });
});
