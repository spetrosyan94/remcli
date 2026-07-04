import { describe, expect, it } from 'vitest';
import { parseAgentRunArgs } from './agentRunArgs';

describe('parseAgentRunArgs', () => {
    it('extracts remcli daemon flags and keeps vendor args separate', () => {
        expect(parseAgentRunArgs(['codex', '--started-by', 'daemon', '--remcli-starting-mode', 'remote', '--resume', 'abc', '--model', 'gpt-5'])).toEqual({
            startedBy: 'daemon',
            resumeSessionId: 'abc',
            passthroughArgs: ['--model', 'gpt-5'],
            shouldPassthrough: false
        });
    });

    it('marks help and version as vendor passthrough without daemon startup', () => {
        expect(parseAgentRunArgs(['cursor', '--help'])).toMatchObject({
            passthroughArgs: ['--help'],
            shouldPassthrough: true
        });
        expect(parseAgentRunArgs(['gemini', '-v'])).toMatchObject({
            passthroughArgs: ['-v'],
            shouldPassthrough: true
        });
    });

    it('does not forward remcli-only flags to vendor CLI', () => {
        expect(parseAgentRunArgs(['claude', '--started-by', 'daemon', '--remcli-starting-mode', 'remote', '--version'])).toEqual({
            startedBy: 'daemon',
            resumeSessionId: undefined,
            passthroughArgs: ['--version'],
            shouldPassthrough: true
        });
    });

    it('does not consume another flag as a missing resume value', () => {
        expect(parseAgentRunArgs(['cursor', '--resume', '--help'])).toEqual({
            startedBy: undefined,
            resumeSessionId: undefined,
            passthroughArgs: ['--help'],
            shouldPassthrough: true
        });
    });
});
