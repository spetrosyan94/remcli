/**
 * Current-user Windows Task Scheduler adapter for daemon autostart.
 *
 * The adapter deliberately uses schtasks.exe without a shell and stores only
 * the daemon launch argv in task XML. Pairing credentials and environment are
 * never part of the scheduled task definition.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, win32 } from 'node:path';

import { projectPath } from '@/projectPath';

export const WINDOWS_AUTOSTART_TASK_NAME = 'RemcliDaemonAutostart';
export const WINDOWS_AUTOSTART_OWNER_MARKER = 'remcli-managed-autostart-v1';
const TASK_NOT_FOUND_HRESULT = 0x80070002;

interface CommandResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}

export interface WindowsTaskSchedulerDependencies {
    createTemporaryXml: (xml: string) => Promise<string>;
    entrypointPath: string;
    nodePath: string;
    pathExists: (path: string) => boolean;
    platform: NodeJS.Platform;
    removeTemporaryXml: (path: string) => Promise<void>;
    resolveUserId: () => Promise<string>;
    runFile: (file: string, args: string[]) => Promise<CommandResult>;
}

export interface WindowsAutostartTaskStatus {
    isTunnelEnabled: boolean;
    staleParts: Array<'arguments' | 'command' | 'entrypoint' | 'policy'>;
    state: 'foreign' | 'missing' | 'owned' | 'stale';
}

export interface WindowsTaskSchedulerAutostart {
    getStatus: () => Promise<WindowsAutostartTaskStatus>;
    install: (isTunnelEnabled: boolean) => Promise<void>;
    uninstall: () => Promise<void>;
}

const TASK_DESCRIPTION = `Remcli daemon autostart (${WINDOWS_AUTOSTART_OWNER_MARKER})`;

function escapeXml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}

function decodeXml(value: string): string {
    return value
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&amp;', '&');
}

interface XmlElement {
    attributes: string;
    content: string;
}

function getXmlElement(xml: string, tagName: string): XmlElement | undefined {
    const match = new RegExp(`<${tagName}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tagName}>`, 'i').exec(xml);
    return match === null ? undefined : {
        attributes: match[1] ?? '',
        content: match[2],
    };
}

function getXmlTag(xml: string, tagName: string): string | undefined {
    const element = getXmlElement(xml, tagName);
    return element === undefined ? undefined : decodeXml(element.content.trim());
}

function getXmlAttribute(element: XmlElement, attributeName: string): string | undefined {
    const match = new RegExp(`\\b${attributeName}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(element.attributes);
    return match === null ? undefined : decodeXml(match[2]);
}

function getDirectChildTagNames(xml: string): string[] {
    const tagNames: string[] = [];
    const tagPattern = /<(\/)?([A-Za-z_][\w:.-]*)(?:\s[^<>]*?)?(\/)?\s*>/g;
    let depth = 0;

    for (const match of xml.matchAll(tagPattern)) {
        const isClosingTag = match[1] === '/';
        const isSelfClosingTag = match[3] === '/';
        if (isClosingTag) {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (depth === 0) {
            tagNames.push(match[2]);
        }
        if (!isSelfClosingTag) {
            depth += 1;
        }
    }

    return tagNames;
}

function isOwnedTaskXml(xml: string): boolean {
    return getXmlTag(xml, 'Description') === TASK_DESCRIPTION;
}

function isMissingTaskResult(result: CommandResult): boolean {
    return (result.exitCode >>> 0) === TASK_NOT_FOUND_HRESULT;
}

function quoteWindowsArgument(argument: string): string {
    let quoted = '"';
    let backslashCount = 0;

    for (const character of argument) {
        if (character === '\\') {
            backslashCount += 1;
            continue;
        }

        if (character === '"') {
            quoted += '\\'.repeat((backslashCount * 2) + 1);
            quoted += '"';
            backslashCount = 0;
            continue;
        }

        quoted += '\\'.repeat(backslashCount);
        quoted += character;
        backslashCount = 0;
    }

    quoted += '\\'.repeat(backslashCount * 2);
    return `${quoted}"`;
}

function parseWindowsArguments(commandLine: string): string[] {
    const argumentsList: string[] = [];
    let index = 0;

    while (index < commandLine.length) {
        while (/\s/.test(commandLine[index] ?? '')) {
            index += 1;
        }
        if (index >= commandLine.length) {
            break;
        }

        let argument = '';
        let isQuoted = false;

        while (index < commandLine.length) {
            let backslashCount = 0;
            while (commandLine[index] === '\\') {
                backslashCount += 1;
                index += 1;
            }

            if (commandLine[index] === '"') {
                argument += '\\'.repeat(Math.floor(backslashCount / 2));
                if (backslashCount % 2 === 1) {
                    argument += '"';
                } else {
                    isQuoted = !isQuoted;
                }
                index += 1;
                continue;
            }

            argument += '\\'.repeat(backslashCount);
            const character = commandLine[index];
            if (character === undefined || (!isQuoted && /\s/.test(character))) {
                break;
            }
            argument += character;
            index += 1;
        }

        argumentsList.push(argument);
    }

    return argumentsList;
}

function isAbsoluteRuntimePath(path: string): boolean {
    return isAbsolute(path) || win32.isAbsolute(path);
}

function assertAbsoluteRuntimePaths(dependencies: WindowsTaskSchedulerDependencies): void {
    if (dependencies.platform !== 'win32') {
        throw new Error('Windows Task Scheduler autostart is only supported on Windows.');
    }
    if (!isAbsoluteRuntimePath(dependencies.nodePath) || !isAbsoluteRuntimePath(dependencies.entrypointPath)) {
        throw new Error('Windows daemon autostart requires absolute Node and dist entrypoint paths.');
    }
    if (!dependencies.pathExists(dependencies.nodePath)) {
        throw new Error(`Node executable does not exist: ${dependencies.nodePath}`);
    }
    if (!dependencies.pathExists(dependencies.entrypointPath)) {
        throw new Error(`Remcli daemon entrypoint does not exist: ${dependencies.entrypointPath}`);
    }
}

function createTaskXml(
    dependencies: WindowsTaskSchedulerDependencies,
    userId: string,
    isTunnelEnabled: boolean,
): string {
    const daemonArguments = [
        dependencies.entrypointPath,
        'daemon',
        'start-sync',
        ...(isTunnelEnabled ? ['--tunnel'] : []),
    ].map(quoteWindowsArgument).join(' ');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(TASK_DESCRIPTION)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escapeXml(userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="CurrentUser">
      <UserId>${escapeXml(userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>false</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="CurrentUser">
    <Exec>
      <Command>${escapeXml(dependencies.nodePath)}</Command>
      <Arguments>${escapeXml(daemonArguments)}</Arguments>
    </Exec>
  </Actions>
</Task>`;
}

async function runSchtasks(
    dependencies: WindowsTaskSchedulerDependencies,
    action: string,
    args: string[],
): Promise<CommandResult> {
    const result = await dependencies.runFile('schtasks.exe', args);
    if (result.exitCode !== 0) {
        throw new Error(`Task Scheduler ${action} failed with exit code ${result.exitCode}.`);
    }
    return result;
}

async function readTaskXml(dependencies: WindowsTaskSchedulerDependencies): Promise<string | undefined> {
    const result = await dependencies.runFile('schtasks.exe', [
        '/Query',
        '/TN',
        WINDOWS_AUTOSTART_TASK_NAME,
        '/XML',
        '/HRESULT',
    ]);
    if (result.exitCode === 0) {
        return result.stdout;
    }
    if (isMissingTaskResult(result)) {
        return undefined;
    }
    throw new Error(`Task Scheduler query failed with exit code ${result.exitCode}.`);
}

function createDefaultDependencies(): WindowsTaskSchedulerDependencies {
    const runFile = (file: string, args: string[]): Promise<CommandResult> => new Promise((resolve) => {
        execFile(file, args, { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
            const exitCode = error === null ? 0 : (typeof error.code === 'number' ? error.code : 1);
            resolve({ exitCode, stderr, stdout });
        });
    });

    return {
        createTemporaryXml: async (xml) => {
            const directory = await mkdtemp(join(tmpdir(), 'remcli-autostart-'));
            const filePath = join(directory, 'task.xml');
            await writeFile(filePath, xml, { encoding: 'utf8', mode: 0o600 });
            return filePath;
        },
        entrypointPath: join(projectPath(), 'dist', 'index.mjs'),
        nodePath: process.execPath,
        pathExists: existsSync,
        platform: process.platform,
        removeTemporaryXml: async (filePath) => rm(dirname(filePath), { force: true, recursive: true }),
        resolveUserId: async () => {
            const result = await runFile('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
            const sid = /"(S-\d+(?:-\d+)+)"\s*$/i.exec(result.stdout.trim())?.[1];
            if (result.exitCode !== 0 || sid === undefined) {
                throw new Error('Could not resolve the current Windows user SID for Task Scheduler.');
            }
            return sid;
        },
        runFile,
    };
}

export function createWindowsTaskSchedulerAutostart(
    suppliedDependencies?: Partial<WindowsTaskSchedulerDependencies>,
): WindowsTaskSchedulerAutostart {
    const defaultDependencies = createDefaultDependencies();
    const dependencies: WindowsTaskSchedulerDependencies = {
        ...defaultDependencies,
        ...suppliedDependencies,
    };

    return {
        getStatus: async () => {
            const xml = await readTaskXml(dependencies);
            if (xml === undefined) {
                return { isTunnelEnabled: false, staleParts: [], state: 'missing' };
            }
            if (!isOwnedTaskXml(xml)) {
                return { isTunnelEnabled: false, staleParts: [], state: 'foreign' };
            }
            const userId = await dependencies.resolveUserId();

            const actions = getXmlElement(xml, 'Actions');
            const action = actions === undefined ? undefined : getXmlElement(actions.content, 'Exec');
            const command = action === undefined ? undefined : getXmlTag(action.content, 'Command');
            const argumentsText = action === undefined ? undefined : getXmlTag(action.content, 'Arguments');
            const [entrypoint, daemonCommand, startMode, ...additionalArguments] = argumentsText === undefined
                ? []
                : parseWindowsArguments(argumentsText);
            const staleParts: WindowsAutostartTaskStatus['staleParts'] = [];

            if (command === undefined
                || !isAbsoluteRuntimePath(command)
                || !dependencies.pathExists(command)
                || !hasSameWindowsPath(command, dependencies.nodePath)) {
                staleParts.push('command');
            }
            if (entrypoint === undefined
                || !isAbsoluteRuntimePath(entrypoint)
                || !dependencies.pathExists(entrypoint)
                || !hasSameWindowsPath(entrypoint, dependencies.entrypointPath)) {
                staleParts.push('entrypoint');
            }
            if (daemonCommand !== 'daemon' || startMode !== 'start-sync'
                || additionalArguments.length > 1
                || additionalArguments.some((argument) => argument !== '--tunnel')) {
                staleParts.push('arguments');
            }
            if (!hasSafeTaskPolicy(xml, userId)) {
                staleParts.push('policy');
            }

            return {
                isTunnelEnabled: additionalArguments.includes('--tunnel'),
                staleParts,
                state: staleParts.length === 0 ? 'owned' : 'stale',
            };
        },
        install: async (isTunnelEnabled) => {
            assertAbsoluteRuntimePaths(dependencies);
            const existingTaskXml = await readTaskXml(dependencies);
            if (existingTaskXml !== undefined && !isOwnedTaskXml(existingTaskXml)) {
                throw new Error(`Refusing to replace foreign Task Scheduler task ${WINDOWS_AUTOSTART_TASK_NAME}.`);
            }
            const userId = await dependencies.resolveUserId();

            const temporaryXmlPath = await dependencies.createTemporaryXml(
                createTaskXml(dependencies, userId, isTunnelEnabled),
            );
            try {
                await runSchtasks(dependencies, 'create', [
                    '/Create',
                    '/TN',
                    WINDOWS_AUTOSTART_TASK_NAME,
                    '/XML',
                    temporaryXmlPath,
                    '/F',
                ]);
                await runSchtasks(dependencies, 'run', [
                    '/Run',
                    '/TN',
                    WINDOWS_AUTOSTART_TASK_NAME,
                ]);
            } finally {
                await dependencies.removeTemporaryXml(temporaryXmlPath);
            }
        },
        uninstall: async () => {
            const existingTaskXml = await readTaskXml(dependencies);
            if (existingTaskXml === undefined) {
                return;
            }
            if (!isOwnedTaskXml(existingTaskXml)) {
                throw new Error(`Refusing to remove foreign Task Scheduler task ${WINDOWS_AUTOSTART_TASK_NAME}.`);
            }
            await runSchtasks(dependencies, 'delete', [
                '/Delete',
                '/TN',
                WINDOWS_AUTOSTART_TASK_NAME,
                '/F',
            ]);
        },
    };
}

function hasSameWindowsPath(left: string, right: string): boolean {
    return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function hasSafeTaskPolicy(xml: string, userId: string): boolean {
    const triggers = getXmlElement(xml, 'Triggers');
    const logonTrigger = triggers === undefined ? undefined : getXmlElement(triggers.content, 'LogonTrigger');
    const principals = getXmlElement(xml, 'Principals');
    const principal = principals === undefined ? undefined : getXmlElement(principals.content, 'Principal');
    const settings = getXmlElement(xml, 'Settings');
    const actions = getXmlElement(xml, 'Actions');
    const action = actions === undefined ? undefined : getXmlElement(actions.content, 'Exec');
    const triggerTagNames = triggers === undefined ? [] : getDirectChildTagNames(triggers.content);
    const principalTagNames = principals === undefined ? [] : getDirectChildTagNames(principals.content);
    const actionTagNames = actions === undefined ? [] : getDirectChildTagNames(actions.content);

    return triggerTagNames.length === 1
        && triggerTagNames[0] === 'LogonTrigger'
        && logonTrigger !== undefined
        && getXmlTag(logonTrigger.content, 'Enabled') === 'true'
        && getXmlTag(logonTrigger.content, 'UserId') === userId
        && principalTagNames.length === 1
        && principalTagNames[0] === 'Principal'
        && principal !== undefined
        && getXmlAttribute(principal, 'id') === 'CurrentUser'
        && getXmlTag(principal.content, 'UserId') === userId
        && getXmlTag(principal.content, 'LogonType') === 'InteractiveToken'
        && getXmlTag(principal.content, 'RunLevel') === 'LeastPrivilege'
        && settings !== undefined
        && getXmlTag(settings.content, 'MultipleInstancesPolicy') === 'IgnoreNew'
        && getXmlTag(settings.content, 'AllowHardTerminate') === 'false'
        && getXmlTag(settings.content, 'Enabled') === 'true'
        && actions !== undefined
        && getXmlAttribute(actions, 'Context') === 'CurrentUser'
        && actionTagNames.length === 1
        && actionTagNames[0] === 'Exec'
        && action !== undefined
        && !xml.includes('<RestartOnFailure>')
        && !xml.includes('<Environment>');
}
