/**
 * Linux user-level systemd autostart adapter for the Remcli daemon.
 *
 * The adapter owns only units marked with `remcli-managed-autostart-v1` and
 * keeps the systemd boundary injectable so platform tests never invoke systemctl.
 */

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { projectPath } from '@/projectPath';

const execFileAsync = promisify(execFile);
const SYSTEMCTL_BINARY = 'systemctl';
const UNIT_NAME = 'remcli.service';
const UNIT_DIRECTORY_SEGMENTS = ['.config', 'systemd', 'user'];
const UNIT_OWNER_MARKER = '# remcli-managed-autostart-v1';
const UNIT_FILE_MODE = 0o644;
const USER_MANAGER_TIMEOUT_MS = 5_000;

export interface LinuxSystemdAutostartStatus {
    unitPath: string;
    state: 'missing' | 'foreign' | 'installed' | 'stale';
    hasStalePaths: boolean;
    hasUnsafePolicy: boolean;
    isEnabled: boolean;
    isTunnelEnabled: boolean;
}

export interface LinuxSystemdAutostartOptions {
    isTunnelEnabled: boolean;
}

export interface LinuxSystemdAutostartDependencies {
    platform: NodeJS.Platform;
    homeDirectory: string;
    nodePath: string;
    entrypointPath: string;
    pathExists(path: string): boolean;
    filesystem: {
        chmod(path: string, mode: number): Promise<void>;
        lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
        mkdir(path: string, options: { recursive: true }): Promise<void>;
        readFile(path: string, encoding: 'utf8'): Promise<string>;
        rename(oldPath: string, newPath: string): Promise<void>;
        unlink(path: string): Promise<void>;
        writeFile(path: string, content: string, options: { encoding: 'utf8'; flag: 'wx'; mode: number }): Promise<void>;
    };
    runSystemctl(args: string[]): Promise<string>;
}

const defaultDependencies: LinuxSystemdAutostartDependencies = {
    platform: process.platform,
    homeDirectory: homedir(),
    nodePath: process.execPath,
    entrypointPath: join(projectPath(), 'dist', 'index.mjs'),
    pathExists: existsSync,
    filesystem: {
        chmod,
        lstat,
        async mkdir(path: string, options: { recursive: true }): Promise<void> {
            await mkdir(path, options);
        },
        readFile,
        rename,
        unlink,
        writeFile,
    },
    async runSystemctl(args: string[]): Promise<string> {
        const result = await execFileAsync(SYSTEMCTL_BINARY, args, { timeout: USER_MANAGER_TIMEOUT_MS });
        return result.stdout;
    },
};

export async function installLinuxSystemdAutostart(
    options: LinuxSystemdAutostartOptions,
    dependencies: LinuxSystemdAutostartDependencies = defaultDependencies,
): Promise<LinuxSystemdAutostartStatus> {
    assertLinuxSystemdAutostart(dependencies);
    assertRuntimePathsExist(dependencies);
    await assertUserManagerAvailable(dependencies);

    const unitPath = getUnitPath(dependencies);
    const existingUnit = await inspectUnitFile(unitPath, dependencies);
    if (existingUnit.kind === 'foreign'
        || (existingUnit.kind === 'file' && !isOwnedUnit(existingUnit.content))) {
        throw new Error(`Refusing to replace foreign systemd user unit: ${unitPath}`);
    }
    const previousState = existingUnit.kind === 'file'
        ? {
            isActive: await isUnitActive(dependencies),
            isEnabled: await isUnitEnabled(dependencies),
        }
        : { isActive: false, isEnabled: false };

    const unitContent = createUnitContent(options, dependencies);
    let hasReplacedUnit = false;
    try {
        await writeUnitAtomically(unitPath, unitContent, dependencies);
        hasReplacedUnit = true;
        await dependencies.runSystemctl(['--user', 'daemon-reload']);
        await dependencies.runSystemctl(['--user', 'enable', '--now', UNIT_NAME]);
    } catch (installError) {
        if (!hasReplacedUnit) {
            throw installError;
        }

        try {
            await rollbackFailedInstall(
                unitPath,
                existingUnit.kind === 'file' ? existingUnit.content : null,
                previousState,
                dependencies,
            );
        } catch (rollbackError) {
            throw new AggregateError(
                [installError, rollbackError],
                `Failed to install and roll back Linux systemd autostart: ${unitPath}`,
            );
        }
        throw installError;
    }

    return getLinuxSystemdAutostartStatus(dependencies);
}

export async function uninstallLinuxSystemdAutostart(
    dependencies: LinuxSystemdAutostartDependencies = defaultDependencies,
): Promise<LinuxSystemdAutostartStatus> {
    assertLinuxSystemdAutostart(dependencies);

    const unitPath = getUnitPath(dependencies);
    const existingUnit = await inspectUnitFile(unitPath, dependencies);
    if (existingUnit.kind === 'missing') {
        return getMissingStatus(unitPath);
    }
    if (existingUnit.kind === 'foreign' || !isOwnedUnit(existingUnit.content)) {
        throw new Error(`Refusing to remove foreign systemd user unit: ${unitPath}`);
    }

    await assertUserManagerAvailable(dependencies);
    await dependencies.runSystemctl(['--user', 'disable', UNIT_NAME]);
    await dependencies.filesystem.unlink(unitPath);
    await dependencies.runSystemctl(['--user', 'daemon-reload']);

    return getMissingStatus(unitPath);
}

export async function getLinuxSystemdAutostartStatus(
    dependencies: LinuxSystemdAutostartDependencies = defaultDependencies,
): Promise<LinuxSystemdAutostartStatus> {
    assertLinuxSystemdAutostart(dependencies);

    const unitPath = getUnitPath(dependencies);
    const unitFile = await inspectUnitFile(unitPath, dependencies);
    if (unitFile.kind === 'missing') {
        return getMissingStatus(unitPath);
    }
    if (unitFile.kind === 'foreign' || !isOwnedUnit(unitFile.content)) {
        return {
            unitPath,
            state: 'foreign',
            hasStalePaths: false,
            hasUnsafePolicy: false,
            isEnabled: false,
            isTunnelEnabled: false,
        };
    }
    const unitContent = unitFile.content;

    const actualCommand = getExecStartCommand(unitContent);
    const commandWithoutTunnel = createExecStartCommand({ isTunnelEnabled: false }, dependencies);
    const commandWithTunnel = createExecStartCommand({ isTunnelEnabled: true }, dependencies);
    const isTunnelEnabled = actualCommand?.endsWith(' "--tunnel"') ?? false;
    const hasMatchingCommand = actualCommand === commandWithoutTunnel || actualCommand === commandWithTunnel;
    const hasSafeServicePolicy = hasExactDirective(unitContent, 'Restart', 'no')
        && !unitContent.split('\n').some((line) => line.trimStart().startsWith('Environment='));
    const hasStalePaths = !dependencies.pathExists(dependencies.nodePath)
        || !dependencies.pathExists(dependencies.entrypointPath)
        || !hasMatchingCommand;
    const isEnabled = await isUnitEnabled(dependencies);
    return {
        unitPath,
        state: hasStalePaths || !hasSafeServicePolicy || !isEnabled ? 'stale' : 'installed',
        hasStalePaths,
        hasUnsafePolicy: !hasSafeServicePolicy,
        isEnabled,
        isTunnelEnabled,
    };
}

function assertLinuxSystemdAutostart(dependencies: LinuxSystemdAutostartDependencies): void {
    if (dependencies.platform !== 'linux') {
        throw new Error('Linux systemd autostart is only supported on Linux');
    }
    if (!isAbsolute(dependencies.nodePath) || !isAbsolute(dependencies.entrypointPath)) {
        throw new Error('Linux systemd autostart requires absolute Node and entrypoint paths');
    }
}

function assertRuntimePathsExist(dependencies: LinuxSystemdAutostartDependencies): void {
    if (!dependencies.pathExists(dependencies.nodePath)) {
        throw new Error(`Node executable does not exist: ${dependencies.nodePath}`);
    }
    if (!dependencies.pathExists(dependencies.entrypointPath)) {
        throw new Error(`Remcli daemon entrypoint does not exist: ${dependencies.entrypointPath}`);
    }
}

async function assertUserManagerAvailable(dependencies: LinuxSystemdAutostartDependencies): Promise<void> {
    try {
        await dependencies.runSystemctl(['--user', 'show-environment']);
    } catch {
        throw new Error('systemd user manager is unavailable; sign in to a graphical or user session before enabling autostart');
    }
}

function getUnitPath(dependencies: LinuxSystemdAutostartDependencies): string {
    return join(dependencies.homeDirectory, ...UNIT_DIRECTORY_SEGMENTS, UNIT_NAME);
}

function createUnitContent(
    options: LinuxSystemdAutostartOptions,
    dependencies: LinuxSystemdAutostartDependencies,
): string {
    return `${UNIT_OWNER_MARKER}
[Unit]
Description=Remcli daemon

[Service]
Type=simple
ExecStart=${createExecStartCommand(options, dependencies)}
Restart=no

[Install]
WantedBy=default.target
`;
}

function createExecStartCommand(
    options: LinuxSystemdAutostartOptions,
    dependencies: LinuxSystemdAutostartDependencies,
): string {
    const commandArguments = [
        dependencies.nodePath,
        dependencies.entrypointPath,
        'daemon',
        'start-sync',
    ];
    if (options.isTunnelEnabled) {
        commandArguments.push('--tunnel');
    }

    return commandArguments.map(escapeSystemdArgument).join(' ');
}

function escapeSystemdArgument(value: string): string {
    return `"${value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\$/g, () => '$$')
        .replace(/%/g, '%%')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')}"`;
}

async function rollbackFailedInstall(
    unitPath: string,
    previousContent: string | null,
    previousState: { isActive: boolean; isEnabled: boolean },
    dependencies: LinuxSystemdAutostartDependencies,
): Promise<void> {
    const rollbackErrors: unknown[] = [];
    await dependencies.runSystemctl(['--user', 'disable', '--now', UNIT_NAME]).catch((error: unknown) => {
        rollbackErrors.push(error);
    });

    try {
        if (previousContent === null) {
            await dependencies.filesystem.unlink(unitPath).catch((error: unknown) => {
                if (!isMissingFileError(error)) {
                    throw error;
                }
            });
        } else {
            await writeUnitAtomically(unitPath, previousContent, dependencies);
        }
    } catch (error) {
        rollbackErrors.push(error);
    }

    await dependencies.runSystemctl(['--user', 'daemon-reload']).catch((error: unknown) => {
        rollbackErrors.push(error);
    });

    if (previousContent !== null) {
        if (previousState.isEnabled) {
            await dependencies.runSystemctl(['--user', 'enable', UNIT_NAME]).catch((error: unknown) => {
                rollbackErrors.push(error);
            });
        }
        if (previousState.isActive) {
            await dependencies.runSystemctl(['--user', 'start', UNIT_NAME]).catch((error: unknown) => {
                rollbackErrors.push(error);
            });
        }
    }

    if (rollbackErrors.length > 0) {
        throw new AggregateError(
            rollbackErrors,
            `Could not restore the previous Linux systemd autostart state: ${unitPath}`,
        );
    }
}

async function isUnitActive(dependencies: LinuxSystemdAutostartDependencies): Promise<boolean> {
    try {
        await dependencies.runSystemctl(['--user', 'is-active', UNIT_NAME]);
        return true;
    } catch {
        return false;
    }
}

async function writeUnitAtomically(
    unitPath: string,
    unitContent: string,
    dependencies: LinuxSystemdAutostartDependencies,
): Promise<void> {
    const unitDirectory = join(dependencies.homeDirectory, ...UNIT_DIRECTORY_SEGMENTS);
    const temporaryPath = `${unitPath}.${randomUUID()}.tmp`;
    await dependencies.filesystem.mkdir(unitDirectory, { recursive: true });

    try {
        await dependencies.filesystem.writeFile(temporaryPath, unitContent, {
            encoding: 'utf8',
            flag: 'wx',
            mode: UNIT_FILE_MODE,
        });
        await dependencies.filesystem.chmod(temporaryPath, UNIT_FILE_MODE);
        await dependencies.filesystem.rename(temporaryPath, unitPath);
    } catch (error) {
        await dependencies.filesystem.unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

type UnitFileInspection =
    | { kind: 'missing' }
    | { kind: 'foreign' }
    | { kind: 'file'; content: string };

async function inspectUnitFile(
    unitPath: string,
    dependencies: LinuxSystemdAutostartDependencies,
): Promise<UnitFileInspection> {
    let stats: { isFile(): boolean; isSymbolicLink(): boolean };
    try {
        stats = await dependencies.filesystem.lstat(unitPath);
    } catch (error) {
        if (isMissingFileError(error)) {
            return { kind: 'missing' };
        }
        throw error;
    }

    if (stats.isSymbolicLink() || !stats.isFile()) {
        return { kind: 'foreign' };
    }

    return {
        kind: 'file',
        content: await dependencies.filesystem.readFile(unitPath, 'utf8'),
    };
}

function isMissingFileError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT';
}

function isOwnedUnit(unitContent: string): boolean {
    return unitContent.split('\n').some((line) => line.trim() === UNIT_OWNER_MARKER);
}

function getExecStartCommand(unitContent: string): string | null {
    const execStartLine = unitContent.split('\n').find((line) => line.startsWith('ExecStart='));
    return execStartLine?.slice('ExecStart='.length) ?? null;
}

function hasExactDirective(unitContent: string, name: string, value: string): boolean {
    return unitContent.split('\n').some((line) => line.trim() === `${name}=${value}`);
}

async function isUnitEnabled(dependencies: LinuxSystemdAutostartDependencies): Promise<boolean> {
    try {
        await dependencies.runSystemctl(['--user', 'is-enabled', UNIT_NAME]);
        return true;
    } catch {
        return false;
    }
}

function getMissingStatus(unitPath: string): LinuxSystemdAutostartStatus {
    return {
        unitPath,
        state: 'missing',
        hasStalePaths: false,
        hasUnsafePolicy: false,
        isEnabled: false,
        isTunnelEnabled: false,
    };
}
