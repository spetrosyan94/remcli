/**
 * Current-user macOS LaunchAgent adapter for daemon autostart.
 *
 * Only a strictly validated Remcli-owned plist is ever replaced or removed.
 * The launchctl boundary is injectable so tests never touch a real login domain.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { projectPath } from '@/projectPath';

const LAUNCHCTL_BINARY = 'launchctl';
const LAUNCH_AGENT_DIRECTORY_SEGMENTS = ['Library', 'LaunchAgents'];
const LAUNCH_AGENT_FILE_MODE = 0o644;
const OWNER_MARKER_KEY = 'RemcliOwnerMarker';
const OWNER_MARKER_VALUE = 'remcli-managed-autostart-v1';
const LAUNCHCTL_PRINT_MISSING_EXIT_CODE = 113;

export const MACOS_LAUNCH_AGENT_LABEL = 'com.remcli-cli.daemon';

export interface MacosLaunchAgentStatus {
    plistPath: string;
    state: 'missing' | 'foreign' | 'installed' | 'stale';
    isTunnelEnabled: boolean;
    staleParts: string[];
}

export interface MacosLaunchAgentDependencies {
    platform: NodeJS.Platform;
    homeDirectory: string;
    nodePath: string;
    entrypointPath: string;
    getUserId(): number;
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
    runLaunchctl(args: string[]): Promise<LaunchctlResult>;
}

export interface LaunchctlResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}

export interface MacosLaunchAgentAutostart {
    getStatus(): Promise<MacosLaunchAgentStatus>;
    install(isTunnelEnabled: boolean): Promise<MacosLaunchAgentStatus>;
    uninstall(): Promise<MacosLaunchAgentStatus>;
}

const defaultDependencies: MacosLaunchAgentDependencies = {
    platform: process.platform,
    homeDirectory: homedir(),
    nodePath: process.execPath,
    entrypointPath: join(projectPath(), 'dist', 'index.mjs'),
    getUserId: () => process.getuid?.() ?? -1,
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
    runLaunchctl: (args) => new Promise((resolve) => {
        execFile(LAUNCHCTL_BINARY, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
            resolve({
                exitCode: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
                stderr,
                stdout,
            });
        });
    }),
};

export function createMacosLaunchAgentAutostart(
    suppliedDependencies?: Partial<MacosLaunchAgentDependencies>,
): MacosLaunchAgentAutostart {
    const dependencies: MacosLaunchAgentDependencies = {
        ...defaultDependencies,
        ...suppliedDependencies,
    };

    return {
        getStatus: async () => getMacosLaunchAgentStatus(dependencies),
        install: async (isTunnelEnabled) => installMacosLaunchAgentAutostart(isTunnelEnabled, dependencies),
        uninstall: async () => uninstallMacosLaunchAgentAutostart(dependencies),
    };
}

export async function installMacosLaunchAgentAutostart(
    isTunnelEnabled: boolean,
    dependencies: MacosLaunchAgentDependencies = defaultDependencies,
): Promise<MacosLaunchAgentStatus> {
    assertInstallEnvironment(dependencies);

    const plistPath = getPlistPath(dependencies);
    const existingPlist = await inspectPlist(plistPath, dependencies);
    if (existingPlist.kind === 'foreign' || existingPlist.kind === 'unsafe') {
        throw new Error(`Refusing to replace ${existingPlist.kind} macOS LaunchAgent plist: ${plistPath}`);
    }

    const userId = dependencies.getUserId();
    const domain = `gui/${userId}`;
    const previousContent = existingPlist.kind === 'owned' ? existingPlist.content : null;
    const loadState = await getLaunchAgentLoadState(domain, dependencies);
    let hasReplacedPlist = false;
    let hasBootedOutDetachedAgent = false;
    let hasBootedOutPreviousAgent = false;
    let hasBootstrappedCurrentAgent = false;

    try {
        if (previousContent === null && loadState.kind === 'loaded') {
            if (!loadState.isVerifiedOwned) {
                throw new Error(`Refusing to replace a loaded foreign macOS LaunchAgent without an owned plist: ${MACOS_LAUNCH_AGENT_LABEL}`);
            }
            if (loadState.executionState !== 'not-running') {
                throw new Error(`The verified detached Remcli LaunchAgent is active; stop the daemon before reinstalling: ${MACOS_LAUNCH_AGENT_LABEL}`);
            }
            await runLaunchctlChecked(
                'bootout',
                ['bootout', '--wait', `${domain}/${MACOS_LAUNCH_AGENT_LABEL}`],
                dependencies,
            );
            hasBootedOutDetachedAgent = true;
        }
        if (previousContent !== null && loadState.kind === 'loaded') {
            if (!loadState.isVerifiedOwned) {
                throw new Error(`Refusing to replace a loaded foreign macOS LaunchAgent: ${MACOS_LAUNCH_AGENT_LABEL}`);
            }
            if (loadState.executionState !== 'not-running') {
                throw new Error(`The verified Remcli LaunchAgent is active; stop the daemon before reinstalling: ${MACOS_LAUNCH_AGENT_LABEL}`);
            }
            await runLaunchctlChecked('bootout', ['bootout', '--wait', `${domain}/${MACOS_LAUNCH_AGENT_LABEL}`], dependencies);
            hasBootedOutPreviousAgent = true;
        }
        await writePlistAtomically(plistPath, createPlistContent(isTunnelEnabled, dependencies), dependencies);
        hasReplacedPlist = true;
        await runLaunchctlChecked('bootstrap', ['bootstrap', domain, plistPath], dependencies);
        hasBootstrappedCurrentAgent = true;
    } catch (installError) {
        if (!hasReplacedPlist && (!hasBootedOutPreviousAgent || hasBootedOutDetachedAgent)) {
            throw installError;
        }

        try {
            await rollbackFailedInstall(
                plistPath,
                previousContent,
                domain,
                hasBootedOutPreviousAgent,
                hasBootstrappedCurrentAgent,
                dependencies,
            );
        } catch (rollbackError) {
            throw new AggregateError(
                [installError, rollbackError],
                `Failed to install and roll back macOS LaunchAgent: ${plistPath}`,
            );
        }
        throw installError;
    }

    return getMacosLaunchAgentStatus(dependencies);
}

export async function uninstallMacosLaunchAgentAutostart(
    dependencies: MacosLaunchAgentDependencies = defaultDependencies,
): Promise<MacosLaunchAgentStatus> {
    assertCurrentUserLaunchAgent(dependencies);
    const plistPath = getPlistPath(dependencies);
    const existingPlist = await inspectPlist(plistPath, dependencies);
    if (existingPlist.kind === 'missing') {
        return getMissingStatus(plistPath);
    }
    if (existingPlist.kind === 'foreign' || existingPlist.kind === 'unsafe') {
        throw new Error(`Refusing to remove ${existingPlist.kind} macOS LaunchAgent plist: ${plistPath}`);
    }

    const domain = `gui/${dependencies.getUserId()}`;
    const loadState = await getLaunchAgentLoadState(domain, dependencies);
    if (loadState.kind === 'loaded' && !loadState.isVerifiedOwned) {
        throw new Error(`Refusing to remove an unverified loaded macOS LaunchAgent: ${MACOS_LAUNCH_AGENT_LABEL}`);
    }
    if (loadState.kind === 'loaded' && loadState.executionState === 'not-running') {
        await runLaunchctlChecked('bootout', ['bootout', '--wait', `${domain}/${MACOS_LAUNCH_AGENT_LABEL}`], dependencies);
    }
    await dependencies.filesystem.unlink(plistPath);
    return getMissingStatus(plistPath);
}

export async function getMacosLaunchAgentStatus(
    dependencies: MacosLaunchAgentDependencies = defaultDependencies,
): Promise<MacosLaunchAgentStatus> {
    assertCurrentUserLaunchAgent(dependencies);

    const plistPath = getPlistPath(dependencies);
    const plist = await inspectPlist(plistPath, dependencies);
    const domain = `gui/${dependencies.getUserId()}`;
    const loadState = await getLaunchAgentLoadState(domain, dependencies);
    if (plist.kind === 'missing') {
        if (loadState.kind === 'loaded' && loadState.isVerifiedOwned) {
            return {
                plistPath,
                state: 'stale',
                isTunnelEnabled: loadState.isTunnelEnabled,
                staleParts: [getDetachedJobStalePart(loadState.executionState)],
            };
        }
        if (loadState.kind === 'loaded') {
            return {
                plistPath,
                state: 'foreign',
                isTunnelEnabled: false,
                staleParts: ['loaded-without-owned-plist'],
            };
        }
        return getMissingStatus(plistPath);
    }
    if (plist.kind === 'foreign' || plist.kind === 'unsafe') {
        return {
            plistPath,
            state: 'foreign',
            isTunnelEnabled: false,
            staleParts: plist.kind === 'unsafe' ? ['policy'] : [],
        };
    }
    if (loadState.kind === 'loaded' && !loadState.isVerifiedOwned) {
        return {
            plistPath,
            state: 'foreign',
            isTunnelEnabled: false,
            staleParts: ['loaded-foreign-job'],
        };
    }

    const staleParts: string[] = [];
    if (!dependencies.pathExists(dependencies.nodePath)
        || !hasSamePath(plist.programArguments[0], dependencies.nodePath)) {
        staleParts.push('nodePath');
    }
    if (!dependencies.pathExists(dependencies.entrypointPath)
        || !hasSamePath(plist.programArguments[1], dependencies.entrypointPath)) {
        staleParts.push('entrypointPath');
    }
    if (loadState.kind === 'missing') {
        staleParts.push('not-loaded');
    } else if (loadState.executionState === 'transitional') {
        staleParts.push('active-transition');
    }

    return {
        plistPath,
        state: staleParts.length === 0 ? 'installed' : 'stale',
        isTunnelEnabled: plist.programArguments.includes('--tunnel'),
        staleParts,
    };
}

function assertInstallEnvironment(dependencies: MacosLaunchAgentDependencies): void {
    assertCurrentUserLaunchAgent(dependencies);
    if (!isAbsolute(dependencies.nodePath) || !isAbsolute(dependencies.entrypointPath)) {
        throw new Error('macOS LaunchAgent autostart requires absolute Node and dist entrypoint paths');
    }
    if (!dependencies.pathExists(dependencies.nodePath)) {
        throw new Error(`Node executable does not exist: ${dependencies.nodePath}`);
    }
    if (!dependencies.pathExists(dependencies.entrypointPath)) {
        throw new Error(`Remcli daemon entrypoint does not exist: ${dependencies.entrypointPath}`);
    }
}

function assertCurrentUserLaunchAgent(dependencies: MacosLaunchAgentDependencies): void {
    assertMacosLaunchAgent(dependencies);
    if (dependencies.getUserId() <= 0) {
        throw new Error('macOS daemon autostart must run as a non-root user');
    }
}

function assertMacosLaunchAgent(dependencies: MacosLaunchAgentDependencies): void {
    if (dependencies.platform !== 'darwin') {
        throw new Error('macOS LaunchAgent autostart is only supported on macOS');
    }
}

function getPlistPath(dependencies: MacosLaunchAgentDependencies): string {
    return join(
        dependencies.homeDirectory,
        ...LAUNCH_AGENT_DIRECTORY_SEGMENTS,
        `${MACOS_LAUNCH_AGENT_LABEL}.plist`,
    );
}

function createPlistContent(isTunnelEnabled: boolean, dependencies: MacosLaunchAgentDependencies): string {
    const programArguments = [
        dependencies.nodePath,
        dependencies.entrypointPath,
        'daemon',
        'start-sync',
        ...(isTunnelEnabled ? ['--tunnel'] : []),
    ];

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(MACOS_LAUNCH_AGENT_LABEL)}</string>
    <key>${OWNER_MARKER_KEY}</key>
    <string>${OWNER_MARKER_VALUE}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments.map((argument) => `        <string>${escapeXml(argument)}</string>`).join('\n')}
    </array>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
`;
}

async function rollbackFailedInstall(
    plistPath: string,
    previousContent: string | null,
    domain: string,
    hasBootedOutPreviousAgent: boolean,
    hasBootstrappedCurrentAgent: boolean,
    dependencies: MacosLaunchAgentDependencies,
): Promise<void> {
    const rollbackErrors: unknown[] = [];
    if (hasBootstrappedCurrentAgent) {
        try {
            const currentLoadState = await getLaunchAgentLoadState(domain, dependencies);
            if (currentLoadState.kind !== 'loaded'
                || !currentLoadState.isVerifiedOwned
                || currentLoadState.executionState !== 'not-running') {
                throw new Error(`Refusing to boot out an unverified macOS LaunchAgent during rollback: ${MACOS_LAUNCH_AGENT_LABEL}`);
            }
            await runLaunchctlChecked('bootout', ['bootout', '--wait', `${domain}/${MACOS_LAUNCH_AGENT_LABEL}`], dependencies);
        } catch (error) {
            rollbackErrors.push(error);
        }
    }

    try {
        if (previousContent === null) {
            await dependencies.filesystem.unlink(plistPath).catch((error: unknown) => {
                if (!isMissingFileError(error)) {
                    throw error;
                }
            });
        } else {
            await writePlistAtomically(plistPath, previousContent, dependencies);
        }
    } catch (error) {
        rollbackErrors.push(error);
    }

    if (previousContent !== null && hasBootedOutPreviousAgent) {
        await runLaunchctlChecked('bootstrap', ['bootstrap', domain, plistPath], dependencies).catch((error: unknown) => {
            rollbackErrors.push(error);
        });
    }

    if (rollbackErrors.length > 0) {
        throw new AggregateError(rollbackErrors, `Could not restore macOS LaunchAgent state: ${plistPath}`);
    }
}

type LaunchAgentExecutionState = 'not-running' | 'running' | 'transitional';

type LaunchAgentLoadState =
    | { kind: 'missing' }
    | {
        kind: 'loaded';
        executionState: LaunchAgentExecutionState;
        isVerifiedOwned: boolean;
        isTunnelEnabled: boolean;
    };

async function getLaunchAgentLoadState(
    domain: string,
    dependencies: MacosLaunchAgentDependencies,
): Promise<LaunchAgentLoadState> {
    const result = await dependencies.runLaunchctl(['print', `${domain}/${MACOS_LAUNCH_AGENT_LABEL}`]);
    if (result.exitCode === 0) {
        const executionState = getLaunchAgentExecutionState(result.stdout);
        const verifiedJob = getVerifiedOwnedJob(result.stdout, dependencies);
        return {
            kind: 'loaded',
            isVerifiedOwned: verifiedJob !== null,
            executionState,
            isTunnelEnabled: verifiedJob?.isTunnelEnabled ?? false,
        };
    }
    if (result.exitCode === LAUNCHCTL_PRINT_MISSING_EXIT_CODE) {
        return { kind: 'missing' };
    }
    throw new Error(`launchctl print failed with exit code ${result.exitCode}.`);
}

function getLaunchAgentExecutionState(output: string): LaunchAgentExecutionState {
    if (/^[\t ]*state = running[\t ]*$/m.test(output)) {
        return 'running';
    }
    if (/^[\t ]*state = not running[\t ]*$/m.test(output)) {
        return 'not-running';
    }
    return 'transitional';
}

function getDetachedJobStalePart(executionState: LaunchAgentExecutionState): string {
    if (executionState === 'not-running') {
        return 'detached-owned-job';
    }
    if (executionState === 'running') {
        return 'detached-owned-running';
    }
    return 'detached-owned-active';
}

function getVerifiedOwnedJob(
    output: string,
    dependencies: MacosLaunchAgentDependencies,
): { isTunnelEnabled: boolean } | null {
    // launchctl has no atomic verify-and-bootout primitive; this is a best-effort
    // same-user ownership check before operating on the service target.
    const plistPath = getPlistPath(dependencies);
    const expectedArguments = [
        dependencies.nodePath,
        dependencies.entrypointPath,
        'daemon',
        'start-sync',
    ];
    const path = getSingleLaunchctlValue(output, 'path');
    const program = getSingleLaunchctlValue(output, 'program');
    const argumentsList = getLaunchctlArguments(output);
    if (path === null
        || program === null
        || argumentsList === null
        || !hasSamePath(path, plistPath)
        || !hasSamePath(program, dependencies.nodePath)
        || !hasExpectedProgramArguments(argumentsList, expectedArguments)) {
        return null;
    }

    return { isTunnelEnabled: argumentsList.includes('--tunnel') };
}

function getSingleLaunchctlValue(output: string, key: 'path' | 'program'): string | null {
    const matches = [...output.matchAll(new RegExp(`^[\\t ]*${key} = (.+?)\\s*$`, 'gm'))];
    if (matches.length !== 1) {
        return null;
    }

    const value = matches[0]?.[1] ?? '';
    return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function getLaunchctlArguments(output: string): string[] | null {
    const blocks = [...output.matchAll(/^[\t ]*arguments = \{\n([\s\S]*?)^[\t ]*\}\s*$/gm)];
    if (blocks.length !== 1) {
        return null;
    }

    return (blocks[0]?.[1] ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => line.startsWith('"') && line.endsWith('"') ? line.slice(1, -1) : line);
}

function hasExpectedProgramArguments(actualArguments: string[], expectedArguments: string[]): boolean {
    const hasTunnelArgument = actualArguments.length === expectedArguments.length + 1
        && actualArguments.at(-1) === '--tunnel';
    const expectedLength = hasTunnelArgument ? expectedArguments.length + 1 : expectedArguments.length;
    return actualArguments.length === expectedLength
        && expectedArguments.every((argument, index) => actualArguments[index] === argument);
}

async function runLaunchctlChecked(
    action: string,
    args: string[],
    dependencies: MacosLaunchAgentDependencies,
): Promise<void> {
    const result = await dependencies.runLaunchctl(args);
    if (result.exitCode !== 0) {
        throw new Error(`launchctl ${action} failed with exit code ${result.exitCode}.`);
    }
}

async function writePlistAtomically(
    plistPath: string,
    plistContent: string,
    dependencies: MacosLaunchAgentDependencies,
): Promise<void> {
    const plistDirectory = join(dependencies.homeDirectory, ...LAUNCH_AGENT_DIRECTORY_SEGMENTS);
    const temporaryPath = `${plistPath}.${randomUUID()}.tmp`;
    await dependencies.filesystem.mkdir(plistDirectory, { recursive: true });

    try {
        await dependencies.filesystem.writeFile(temporaryPath, plistContent, {
            encoding: 'utf8',
            flag: 'wx',
            mode: LAUNCH_AGENT_FILE_MODE,
        });
        await dependencies.filesystem.chmod(temporaryPath, LAUNCH_AGENT_FILE_MODE);
        await dependencies.filesystem.rename(temporaryPath, plistPath);
    } catch (error) {
        await dependencies.filesystem.unlink(temporaryPath).catch(() => undefined);
        throw error;
    }
}

type PlistInspection =
    | { kind: 'missing' }
    | { kind: 'foreign' }
    | { kind: 'unsafe' }
    | { kind: 'owned'; content: string; programArguments: string[] };

async function inspectPlist(
    plistPath: string,
    dependencies: MacosLaunchAgentDependencies,
): Promise<PlistInspection> {
    let stats: { isFile(): boolean; isSymbolicLink(): boolean };
    try {
        stats = await dependencies.filesystem.lstat(plistPath);
    } catch (error) {
        if (isMissingFileError(error)) {
            return { kind: 'missing' };
        }
        throw error;
    }

    if (stats.isSymbolicLink() || !stats.isFile()) {
        return { kind: 'foreign' };
    }

    const content = await dependencies.filesystem.readFile(plistPath, 'utf8');
    if (!hasExactOwnership(content)) {
        return { kind: 'foreign' };
    }

    const programArguments = getProgramArguments(content);
    if (programArguments === null || !hasSafeLaunchAgentPolicy(content, programArguments)) {
        return { kind: 'unsafe' };
    }

    return { kind: 'owned', content, programArguments };
}

function hasExactOwnership(content: string): boolean {
    return getSingleStringValue(content, 'Label') === MACOS_LAUNCH_AGENT_LABEL
        && getSingleStringValue(content, OWNER_MARKER_KEY) === OWNER_MARKER_VALUE;
}

function hasSafeLaunchAgentPolicy(content: string, programArguments: string[]): boolean {
    const keyNames = getKeyNames(content);
    const allowedKeyNames = new Set(['Label', OWNER_MARKER_KEY, 'ProgramArguments', 'RunAtLoad']);
    const hasOnlyExpectedKeys = keyNames.length === allowedKeyNames.size
        && keyNames.every((keyName) => allowedKeyNames.has(keyName));
    const hasExpectedArgumentCount = programArguments.length === 4 || programArguments.length === 5;
    const hasExpectedArguments = hasExpectedArgumentCount
        && isAbsolute(programArguments[0] ?? '')
        && isAbsolute(programArguments[1] ?? '')
        && programArguments[2] === 'daemon'
        && programArguments[3] === 'start-sync'
        && (programArguments.length === 4 || programArguments[4] === '--tunnel');

    return hasOnlyExpectedKeys
        && getKeyOccurrences(content, 'Label') === 1
        && getKeyOccurrences(content, OWNER_MARKER_KEY) === 1
        && getKeyOccurrences(content, 'ProgramArguments') === 1
        && hasTrueValue(content, 'RunAtLoad')
        && hasExpectedArguments;
}

function getProgramArguments(content: string): string[] | null {
    const pattern = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/g;
    const matches = [...content.matchAll(pattern)];
    if (matches.length !== 1) {
        return null;
    }

    const arrayContent = matches[0]?.[1] ?? '';
    const argumentsList = [...arrayContent.matchAll(/<string>([^<]*)<\/string>/g)]
        .map((match) => decodeXml(match[1] ?? ''));
    const nonStringContent = arrayContent.replace(/<string>[^<]*<\/string>/g, '').trim();
    return nonStringContent === '' ? argumentsList : null;
}

function getSingleStringValue(content: string, key: string): string | null {
    const escapedKey = escapeRegularExpression(key);
    const pattern = new RegExp(`<key>\\s*${escapedKey}\\s*<\\/key>\\s*<string>([^<]*)<\\/string>`, 'g');
    const matches = [...content.matchAll(pattern)];
    return matches.length === 1 ? decodeXml(matches[0]?.[1] ?? '') : null;
}

function getKeyOccurrences(content: string, key: string): number {
    const escapedKey = escapeRegularExpression(key);
    return [...content.matchAll(new RegExp(`<key>\\s*${escapedKey}\\s*<\\/key>`, 'g'))].length;
}

function getKeyNames(content: string): string[] {
    return [...content.matchAll(/<key>\s*([^<]+?)\s*<\/key>/g)]
        .map((match) => decodeXml(match[1] ?? ''));
}

function hasTrueValue(content: string, key: string): boolean {
    const escapedKey = escapeRegularExpression(key);
    const pattern = new RegExp(`<key>\\s*${escapedKey}\\s*<\\/key>\\s*<true\\s*\\/>`, 'g');
    return [...content.matchAll(pattern)].length === 1;
}

function getMissingStatus(plistPath: string): MacosLaunchAgentStatus {
    return {
        plistPath,
        state: 'missing',
        isTunnelEnabled: false,
        staleParts: [],
    };
}

function hasSamePath(left: string, right: string): boolean {
    return normalize(left) === normalize(right);
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function decodeXml(value: string): string {
    return value
        .replace(/&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&gt;/g, '>')
        .replace(/&lt;/g, '<')
        .replace(/&amp;/g, '&');
}

function escapeRegularExpression(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isMissingFileError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && error.code === 'ENOENT';
}
