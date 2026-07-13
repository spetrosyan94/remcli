import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const pathSeparator = process.platform === 'win32' ? ';' : ':';
const cliArtifactSnapshotAttempts = 30;
const cliArtifactSnapshotRetryMs = 250;
const remcliPassthroughCases: Array<[string, string[], string, string]> = [
    ['--version', ['--version'], 'remcli version:', 'fake-claude 1.2.3'],
    ['--help', ['--help'], 'remcli', 'claude fake help']
];
const agentPassthroughCases: Array<[string, string[], string]> = [
    ['codex --version', ['codex', '--version'], 'codex-cli 9.9.9'],
    ['codex --help', ['codex', '--help'], 'codex fake help'],
    ['gemini --version', ['gemini', '--version'], '9.9.9'],
    ['gemini --help', ['gemini', '--help'], 'gemini fake help'],
    ['cursor --version', ['cursor', '--version'], 'fake-cursor-agent 9.9.9'],
    ['cursor --help', ['cursor', '--help'], 'agent fake help']
];

interface CliPassthroughTestEnvironment {
    homeDir: string;
    binDir: string;
}

let cliArtifactRoot: string | undefined;

function writeFakeBinary(binDir: string, name: string, output: string): string {
    const filePath = join(binDir, name);
    const script = `#!/usr/bin/env node\nif (process.argv.includes('--help') || process.argv.includes('-h')) {\n  console.log(${JSON.stringify(`${name} fake help`)});\n  process.exit(0);\n}\nif (process.argv.includes('--version') || process.argv.includes('-v')) {\n  console.log(${JSON.stringify(output)});\n  process.exit(0);\n}\nconsole.error(${JSON.stringify(`${name} should not be started by passthrough smoke`)});\nprocess.exit(42);\n`;
    writeFileSync(filePath, script, 'utf-8');
    chmodSync(filePath, 0o755);
    return filePath;
}

function createCliPassthroughTestEnvironment(): CliPassthroughTestEnvironment {
    const homeDir = mkdtempSync(join(tmpdir(), 'remcli-cli-passthrough-home-'));
    const binDir = mkdtempSync(join(tmpdir(), 'remcli-cli-passthrough-bin-'));
    writeFakeBinary(binDir, 'claude', 'fake-claude 1.2.3');
    writeFakeBinary(binDir, 'codex', 'codex-cli 9.9.9');
    writeFakeBinary(binDir, 'gemini', '9.9.9');
    writeFakeBinary(binDir, 'agent', 'fake-cursor-agent 9.9.9');
    return { homeDir, binDir };
}

async function createCliArtifactSnapshot(): Promise<string> {
    let lastError: unknown;

    for (let attempt = 0; attempt < cliArtifactSnapshotAttempts; attempt += 1) {
        const artifactRoot = mkdtempSync(join(packageRoot, '.remcli-cli-passthrough-artifact-'));

        try {
            cpSync(join(packageRoot, 'bin'), join(artifactRoot, 'bin'), { recursive: true });
            cpSync(join(packageRoot, 'dist'), join(artifactRoot, 'dist'), { recursive: true });
            copyFileSync(join(packageRoot, 'package.json'), join(artifactRoot, 'package.json'));

            if (!existsSync(join(artifactRoot, 'dist', 'index.mjs'))) {
                throw new Error('CLI artifact snapshot is missing dist/index.mjs.');
            }

            return artifactRoot;
        } catch (error) {
            lastError = error;
            rmSync(artifactRoot, { recursive: true, force: true });
        }

        await new Promise<void>((resolve) => setTimeout(resolve, cliArtifactSnapshotRetryMs));
    }

    throw lastError instanceof Error
        ? lastError
        : new Error('Unable to create an isolated CLI artifact snapshot.');
}

function getCliArtifactRoot(): string {
    if (!cliArtifactRoot) {
        throw new Error('CLI artifact snapshot was not created.');
    }

    return cliArtifactRoot;
}

function withCliPassthroughTestEnvironment(callback: (environment: CliPassthroughTestEnvironment) => void): void {
    const environment = createCliPassthroughTestEnvironment();
    try {
        callback(environment);
    } finally {
        rmSync(environment.homeDir, { recursive: true, force: true });
        rmSync(environment.binDir, { recursive: true, force: true });
    }
}

function runRemcli(args: string[], environment: CliPassthroughTestEnvironment): ReturnType<typeof spawnSync> {
    const env = {
        ...process.env,
        REMCLI_HOME_DIR: environment.homeDir,
        REMCLI_CLAUDE_PATH: join(environment.binDir, 'claude'),
        PATH: `${environment.binDir}${pathSeparator}${process.env.PATH ?? ''}`
    };
    return spawnSync(process.execPath, [join(getCliArtifactRoot(), 'bin', 'remcli.mjs'), ...args], {
        cwd: packageRoot,
        env,
        encoding: 'utf-8',
        timeout: 10_000
    });
}

function expectSuccessfulPassthrough(result: ReturnType<typeof spawnSync>): void {
    const diagnostics = [
        result.error?.message,
        result.signal ? `signal=${result.signal}` : undefined,
        result.stderr?.trim()
    ].filter((detail): detail is string => Boolean(detail)).join('\n');
    expect(result.status, diagnostics).toBe(0);
}

function expectNoDaemonState(environment: CliPassthroughTestEnvironment): void {
    expect(existsSync(join(environment.homeDir, 'daemon.state.json'))).toBe(false);
    expect(existsSync(join(environment.homeDir, 'daemon.lock'))).toBe(false);
}

beforeAll(async () => {
    cliArtifactRoot = await createCliArtifactSnapshot();
});

afterAll(() => {
    if (cliArtifactRoot) {
        rmSync(cliArtifactRoot, { recursive: true, force: true });
    }
});

describe('CLI help/version passthrough', () => {
    it.each(remcliPassthroughCases)('prints remcli %s without starting a daemon session', (_name, args, cliOutput, vendorOutput) => {
        withCliPassthroughTestEnvironment((environment) => {
            const result = runRemcli(args, environment);
            expectSuccessfulPassthrough(result);
            expect(result.stdout).toContain(cliOutput);
            expect(result.stdout).toContain(vendorOutput);
            expectNoDaemonState(environment);
        });
    });

    it.each(agentPassthroughCases)('passes %s directly to vendor CLI without daemon startup', (_name, args, expected) => {
        withCliPassthroughTestEnvironment((environment) => {
            const result = runRemcli(args, environment);
            expectSuccessfulPassthrough(result);
            expect(result.stdout).toContain(expected);
            expectNoDaemonState(environment);
        });
    });
});
