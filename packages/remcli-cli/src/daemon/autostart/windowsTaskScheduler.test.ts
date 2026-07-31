import { describe, expect, it } from 'vitest';

import {
    createWindowsTaskSchedulerAutostart,
    WINDOWS_AUTOSTART_OWNER_MARKER,
    WINDOWS_AUTOSTART_TASK_NAME,
    type WindowsTaskSchedulerDependencies,
} from './windowsTaskScheduler';

const USER_SID = 'S-1-5-21-1000-2000-3000-1001';
const TASK_NOT_FOUND_HRESULT = 0x80070002;
const OWNED_TASK_DESCRIPTION = `Remcli daemon autostart (${WINDOWS_AUTOSTART_OWNER_MARKER})`;

interface Harness {
    calls: string[][];
    dependencies: WindowsTaskSchedulerDependencies;
    getTemporaryXml: () => string | undefined;
    removedPaths: string[];
}

function taskXml(
    description: string,
    command = 'C:\\Program Files\\nodejs\\node.exe',
    argumentsText = '"C:\\Users\\Jane Doe\\remcli\\dist\\index.mjs" "daemon" "start-sync"',
): string {
    return `<?xml version="1.0"?><Task><RegistrationInfo><Description>${description}</Description></RegistrationInfo><Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${USER_SID}</UserId></LogonTrigger></Triggers><Principals><Principal id="CurrentUser"><UserId>${USER_SID}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><AllowHardTerminate>false</AllowHardTerminate><Enabled>true</Enabled></Settings><Actions Context="CurrentUser"><Exec><Command>${command}</Command><Arguments>${argumentsText}</Arguments></Exec></Actions></Task>`;
}

function createHarness(queryResult: { exitCode: number; stderr?: string; stdout?: string }): Harness {
    const calls: string[][] = [];
    const removedPaths: string[] = [];
    let temporaryXml: string | undefined;

    return {
        calls,
        dependencies: {
            createTemporaryXml: async (xml) => {
                temporaryXml = xml;
                return 'C:\\Temp\\remcli-autostart-1\\task.xml';
            },
            entrypointPath: 'C:\\Users\\Jane Doe\\remcli\\dist\\index.mjs',
            nodePath: 'C:\\Program Files\\nodejs\\node.exe',
            pathExists: () => true,
            platform: 'win32',
            removeTemporaryXml: async (path) => {
                removedPaths.push(path);
            },
            resolveUserId: async () => USER_SID,
            runFile: async (_file, args) => {
                calls.push(args);
                if (args[0] === '/Query') {
                    return {
                        exitCode: queryResult.exitCode,
                        stderr: queryResult.stderr ?? '',
                        stdout: queryResult.stdout ?? '',
                    };
                }
                return { exitCode: 0, stderr: '', stdout: '' };
            },
        },
        getTemporaryXml: () => temporaryXml,
        removedPaths,
    };
}

describe('Windows Task Scheduler autostart', () => {
    it('fails closed without overwriting a foreign task', async () => {
        const harness = createHarness({ exitCode: 0, stdout: taskXml('another application') });
        const autostart = createWindowsTaskSchedulerAutostart(harness.dependencies);

        await expect(autostart.install(false)).rejects.toThrow('Refusing to replace foreign');

        expect(harness.calls).toEqual([['/Query', '/TN', WINDOWS_AUTOSTART_TASK_NAME, '/XML', '/HRESULT']]);
        expect(harness.getTemporaryXml()).toBeUndefined();
    });

    it('requires the exact ownership description', async () => {
        const harness = createHarness({
            exitCode: 0,
            stdout: taskXml(`backup-${WINDOWS_AUTOSTART_OWNER_MARKER}`),
        });
        const autostart = createWindowsTaskSchedulerAutostart(harness.dependencies);

        await expect(autostart.install(false)).rejects.toThrow('Refusing to replace foreign');
        await expect(autostart.uninstall()).rejects.toThrow('Refusing to remove foreign');
    });

    it('escapes XML and Windows argv without using a shell', async () => {
        const harness = createHarness({
            exitCode: TASK_NOT_FOUND_HRESULT,
            stderr: 'ОШИБКА: указанная задача не найдена.',
        });
        harness.dependencies.nodePath = 'C:\\Program Files\\node & tools\\node.exe';
        harness.dependencies.entrypointPath = 'C:\\Users\\Jane Doe\\remcli\\& <quoted> "release"\\dist\\index.mjs';
        const autostart = createWindowsTaskSchedulerAutostart(harness.dependencies);

        await autostart.install(true);

        const xml = harness.getTemporaryXml();
        expect(xml).toContain('C:\\Program Files\\node &amp; tools\\node.exe');
        expect(xml).toContain('&lt;quoted&gt;');
        expect(xml).toContain('\\&quot;release\\&quot;');
        expect(xml).toContain('&quot;--tunnel&quot;');
        expect(xml).toContain(`<UserId>${USER_SID}</UserId>`);
        expect(harness.calls).toEqual([
            ['/Query', '/TN', WINDOWS_AUTOSTART_TASK_NAME, '/XML', '/HRESULT'],
            ['/Create', '/TN', WINDOWS_AUTOSTART_TASK_NAME, '/XML', 'C:\\Temp\\remcli-autostart-1\\task.xml', '/F'],
            ['/Run', '/TN', WINDOWS_AUTOSTART_TASK_NAME],
        ]);
    });

    it('installs an owned task, starts it, and always removes temporary XML', async () => {
        const harness = createHarness({ exitCode: 0, stdout: taskXml(OWNED_TASK_DESCRIPTION) });
        const autostart = createWindowsTaskSchedulerAutostart(harness.dependencies);

        await autostart.install(false);

        expect(harness.calls).toEqual([
            ['/Query', '/TN', WINDOWS_AUTOSTART_TASK_NAME, '/XML', '/HRESULT'],
            ['/Create', '/TN', WINDOWS_AUTOSTART_TASK_NAME, '/XML', 'C:\\Temp\\remcli-autostart-1\\task.xml', '/F'],
            ['/Run', '/TN', WINDOWS_AUTOSTART_TASK_NAME],
        ]);
        expect(harness.removedPaths).toEqual(['C:\\Temp\\remcli-autostart-1\\task.xml']);
    });

    it('uninstalls only an owned task', async () => {
        const harness = createHarness({ exitCode: 0, stdout: taskXml(OWNED_TASK_DESCRIPTION) });
        const autostart = createWindowsTaskSchedulerAutostart(harness.dependencies);

        await autostart.uninstall();

        expect(harness.calls).toEqual([
            ['/Query', '/TN', WINDOWS_AUTOSTART_TASK_NAME, '/XML', '/HRESULT'],
            ['/Delete', '/TN', WINDOWS_AUTOSTART_TASK_NAME, '/F'],
        ]);
    });

    it('reports a missing task without attempting a mutation', async () => {
        const harness = createHarness({
            exitCode: TASK_NOT_FOUND_HRESULT,
            stderr: 'ОШИБКА: указанная задача не найдена.',
        });
        const autostart = createWindowsTaskSchedulerAutostart(harness.dependencies);

        await expect(autostart.getStatus()).resolves.toEqual({
            isTunnelEnabled: false,
            staleParts: [],
            state: 'missing',
        });
        await autostart.uninstall();

        expect(harness.calls).toEqual([
            ['/Query', '/TN', WINDOWS_AUTOSTART_TASK_NAME, '/XML', '/HRESULT'],
            ['/Query', '/TN', WINDOWS_AUTOSTART_TASK_NAME, '/XML', '/HRESULT'],
        ]);
    });

    it('does not mistake an unrelated localized query failure for a missing task', async () => {
        const harness = createHarness({
            exitCode: 1,
            stderr: 'ОШИБКА: доступ запрещен.',
        });
        const autostart = createWindowsTaskSchedulerAutostart(harness.dependencies);

        await expect(autostart.getStatus()).rejects.toThrow('Task Scheduler query failed with exit code 1');
    });

    it('reports stale owned paths and the configured tunnel flag', async () => {
        const harness = createHarness({
            exitCode: 0,
            stdout: taskXml(
                OWNED_TASK_DESCRIPTION,
                'C:\\Missing\\node.exe',
                '"C:\\Missing\\remcli\\dist\\index.mjs" "daemon" "start-sync" "--tunnel"',
            ),
        });
        harness.dependencies.pathExists = () => false;
        const autostart = createWindowsTaskSchedulerAutostart(harness.dependencies);

        await expect(autostart.getStatus()).resolves.toEqual({
            isTunnelEnabled: true,
            staleParts: ['command', 'entrypoint'],
            state: 'stale',
        });
    });

    it('does not persist restart settings, secrets, or environment values', async () => {
        const harness = createHarness({
            exitCode: TASK_NOT_FOUND_HRESULT,
            stderr: 'ОШИБКА: указанная задача не найдена.',
        });
        const autostart = createWindowsTaskSchedulerAutostart(harness.dependencies);

        await autostart.install(false);

        const xml = harness.getTemporaryXml();
        expect(xml).toContain(`<Description>Remcli daemon autostart (${WINDOWS_AUTOSTART_OWNER_MARKER})</Description>`);
        expect(xml).toContain('<LogonTrigger>');
        expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
        expect(xml).not.toContain('RestartOnFailure');
        expect(xml).not.toContain('<Environment>');
        expect(xml).not.toContain('sharedSecret');
        expect(xml).not.toContain('bearer');
    });

    it('marks existing but outdated runtime paths and unsafe policy as stale', async () => {
        const harness = createHarness({
            exitCode: 0,
            stdout: taskXml(
                OWNED_TASK_DESCRIPTION,
                'C:\\Old\\node.exe',
                '"C:\\Old\\remcli\\dist\\index.mjs" "daemon" "start-sync"',
            ).replace('<AllowHardTerminate>false</AllowHardTerminate>', '<AllowHardTerminate>true</AllowHardTerminate>'),
        });
        const autostart = createWindowsTaskSchedulerAutostart(harness.dependencies);

        await expect(autostart.getStatus()).resolves.toEqual({
            isTunnelEnabled: false,
            staleParts: ['command', 'entrypoint', 'policy'],
            state: 'stale',
        });
    });

    it('marks a task with a disabled logon trigger or mismatched action context as stale', async () => {
        const unsafeXml = taskXml(OWNED_TASK_DESCRIPTION)
            .replace('<LogonTrigger><Enabled>true</Enabled>', '<LogonTrigger><Enabled>false</Enabled>')
            .replace('<Actions Context="CurrentUser">', '<Actions Context="OtherPrincipal">');
        const harness = createHarness({ exitCode: 0, stdout: unsafeXml });
        const autostart = createWindowsTaskSchedulerAutostart(harness.dependencies);

        await expect(autostart.getStatus()).resolves.toEqual({
            isTunnelEnabled: false,
            staleParts: ['policy'],
            state: 'stale',
        });
    });

    it('rejects additional triggers and actions in an owned task', async () => {
        const expandedXml = taskXml(OWNED_TASK_DESCRIPTION)
            .replace('</Triggers>', '<TimeTrigger><Enabled>true</Enabled></TimeTrigger></Triggers>')
            .replace('</Actions>', '<Exec><Command>C:\\Windows\\System32\\calc.exe</Command></Exec></Actions>');
        const harness = createHarness({ exitCode: 0, stdout: expandedXml });
        const autostart = createWindowsTaskSchedulerAutostart(harness.dependencies);

        await expect(autostart.getStatus()).resolves.toEqual({
            isTunnelEnabled: false,
            staleParts: ['policy'],
            state: 'stale',
        });
    });
});
