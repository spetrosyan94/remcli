import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const binPath = join(packageRoot, 'bin', 'remcli.mjs');
const pathSeparator = process.platform === 'win32' ? ';' : ':';

let homeDir: string;
let binDir: string;

function writeFakeBinary(name: string, output: string): string {
    const filePath = join(binDir, name);
    const script = `#!/usr/bin/env node\nif (process.argv.includes('--help') || process.argv.includes('-h')) {\n  console.log(${JSON.stringify(`${name} fake help`)});\n  process.exit(0);\n}\nif (process.argv.includes('--version') || process.argv.includes('-v')) {\n  console.log(${JSON.stringify(output)});\n  process.exit(0);\n}\nconsole.error(${JSON.stringify(`${name} should not be started by passthrough smoke`)});\nprocess.exit(42);\n`;
    writeFileSync(filePath, script, 'utf-8');
    chmodSync(filePath, 0o755);
    return filePath;
}

function runRemcli(args: string[]): ReturnType<typeof spawnSync> {
    const env = {
        ...process.env,
        REMCLI_HOME_DIR: homeDir,
        REMCLI_CLAUDE_PATH: join(binDir, 'claude'),
        PATH: `${binDir}${pathSeparator}${process.env.PATH ?? ''}`
    };
    return spawnSync(process.execPath, [binPath, ...args], {
        cwd: packageRoot,
        env,
        encoding: 'utf-8',
        timeout: 10_000
    });
}

function expectNoDaemonState(): void {
    expect(existsSync(join(homeDir, 'daemon.state.json'))).toBe(false);
    expect(existsSync(join(homeDir, 'daemon.lock'))).toBe(false);
}

beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'remcli-cli-passthrough-home-'));
    binDir = mkdtempSync(join(tmpdir(), 'remcli-cli-passthrough-bin-'));
    writeFakeBinary('claude', 'fake-claude 1.2.3');
    writeFakeBinary('codex', 'codex-cli 9.9.9');
    writeFakeBinary('gemini', '9.9.9');
    writeFakeBinary('agent', 'fake-cursor-agent 9.9.9');
});

afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
});

describe('CLI help/version passthrough', () => {
    it('prints remcli help/version without starting a daemon session', () => {
        const version = runRemcli(['--version']);
        expect(version.status).toBe(0);
        expect(version.stdout).toContain('remcli version:');
        expect(version.stdout).toContain('fake-claude 1.2.3');
        expectNoDaemonState();

        const help = runRemcli(['--help']);
        expect(help.status).toBe(0);
        expect(help.stdout).toContain('remcli');
        expect(help.stdout).toContain('claude fake help');
        expectNoDaemonState();
    });

    it('passes agent help/version directly to vendor CLIs without daemon startup', () => {
        const cases: Array<{ args: string[]; expected: string }> = [
            { args: ['codex', '--version'], expected: 'codex-cli 9.9.9' },
            { args: ['codex', '--help'], expected: 'codex fake help' },
            { args: ['gemini', '--version'], expected: '9.9.9' },
            { args: ['gemini', '--help'], expected: 'gemini fake help' },
            { args: ['cursor', '--version'], expected: 'fake-cursor-agent 9.9.9' },
            { args: ['cursor', '--help'], expected: 'agent fake help' }
        ];

        for (const testCase of cases) {
            const result = runRemcli(testCase.args);
            expect(result.status).toBe(0);
            expect(result.stdout).toContain(testCase.expected);
            expectNoDaemonState();
        }
    });
});
