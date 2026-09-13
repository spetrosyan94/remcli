import { describe, expect, it } from 'vitest';
import { AGENTS, createAgentInstallInvocation } from './setup';

describe('Antigravity CLI setup', () => {
    it('keeps the official installer commands exact', () => {
        const antigravity = AGENTS.find((agent) => agent.binary === 'agy');

        expect(antigravity?.install).toEqual({
            unix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
            windows: 'irm https://antigravity.google/cli/install.ps1 | iex',
            windowsShell: 'powershell',
        });
    });

    it('executes only the Antigravity Windows command through a separately selected PowerShell', () => {
        const antigravity = AGENTS.find((agent) => agent.binary === 'agy')!;

        expect(createAgentInstallInvocation(
            antigravity,
            'win32',
            () => 'pwsh',
        )).toEqual({
            command: 'pwsh',
            args: [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                'irm https://antigravity.google/cli/install.ps1 | iex',
            ],
        });
    });

    it('preserves every other provider command and all Unix commands', () => {
        for (const agent of AGENTS) {
            expect(createAgentInstallInvocation(agent, 'darwin')).toEqual({
                command: agent.install.unix,
            });

            if (agent.binary !== 'agy') {
                expect(createAgentInstallInvocation(agent, 'win32', () => {
                    throw new Error('PowerShell resolution must not run');
                })).toEqual({
                    command: agent.install.windows,
                });
            }
        }
    });
});
