import { describe, expect, it, vi } from 'vitest';
import {
    createMacosLaunchAgentAutostart,
    type MacosLaunchAgentDependencies,
} from './macosLaunchAgent';
import {
    getDaemonAutostartStatus,
    install as installAutostart,
    installDaemonAutostart,
    type DaemonAutostartDependencies,
} from '../install';
import {
    uninstall as uninstallAutostart,
    uninstallDaemonAutostart,
    type DaemonAutostartUninstallDependencies,
} from '../uninstall';

const PLIST_PATH = '/Users/remcli user/Library/LaunchAgents/com.remcli-cli.daemon.plist';

interface Harness {
    calls: string[][];
    dependencies: MacosLaunchAgentDependencies;
    files: Map<string, string>;
    modes: Map<string, number>;
    setLoaded(isLoaded: boolean): void;
    setLoadedState(state: 'missing' | 'not running' | 'running'): void;
    symbolicLinks: Set<string>;
}

function createHarness(): Harness {
    const calls: string[][] = [];
    const files = new Map<string, string>();
    const modes = new Map<string, number>();
    const symbolicLinks = new Set<string>();
    let loadState: 'missing' | 'not running' | 'running' = 'missing';
    const dependencies: MacosLaunchAgentDependencies = {
        platform: 'darwin',
        homeDirectory: '/Users/remcli user',
        nodePath: '/Applications/Remcli/node',
        entrypointPath: '/Applications/Remcli/dist/index.mjs',
        getUserId: () => 501,
        pathExists: () => true,
        filesystem: {
            async chmod(path: string, mode: number): Promise<void> {
                modes.set(path, mode);
            },
            async lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }> {
                if (symbolicLinks.has(path)) {
                    return { isFile: () => false, isSymbolicLink: () => true };
                }
                if (!files.has(path)) {
                    const error = new Error(`Missing file: ${path}`) as NodeJS.ErrnoException;
                    error.code = 'ENOENT';
                    throw error;
                }
                return { isFile: () => true, isSymbolicLink: () => false };
            },
            async mkdir(): Promise<void> {},
            async readFile(path: string): Promise<string> {
                const content = files.get(path);
                if (content === undefined) {
                    const error = new Error(`Missing file: ${path}`) as NodeJS.ErrnoException;
                    error.code = 'ENOENT';
                    throw error;
                }
                return content;
            },
            async rename(oldPath: string, newPath: string): Promise<void> {
                const content = files.get(oldPath);
                if (content === undefined) {
                    throw new Error(`Missing temporary plist: ${oldPath}`);
                }
                files.set(newPath, content);
                files.delete(oldPath);
                const mode = modes.get(oldPath);
                if (mode !== undefined) {
                    modes.set(newPath, mode);
                    modes.delete(oldPath);
                }
            },
            async unlink(path: string): Promise<void> {
                files.delete(path);
            },
            async writeFile(path: string, content: string, options): Promise<void> {
                if (files.has(path)) {
                    throw new Error(`Temporary plist already exists: ${path}`);
                }
                files.set(path, content);
                modes.set(path, options.mode);
            },
        },
        async runLaunchctl(args: string[]) {
            calls.push(args);
            if (args[0] === 'print') {
                if (loadState === 'missing') {
                    return { exitCode: 113, stderr: '', stdout: '' };
                }
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: ownedJobPrint(loadState),
                };
            }
            if (args[0] === 'bootstrap') {
                loadState = 'running';
            }
            if (args[0] === 'bootout') {
                loadState = 'missing';
            }
            return { exitCode: 0, stderr: '', stdout: '' };
        },
    };

    return {
        calls,
        dependencies,
        files,
        modes,
        setLoaded: (value) => {
            loadState = value ? 'running' : 'missing';
        },
        setLoadedState: (value) => {
            loadState = value;
        },
        symbolicLinks,
    };
}

function ownedJobPrint(state: 'not running' | 'running' | 'waiting'): string {
    return `\tstate = ${state}
\tpath = ${PLIST_PATH}
\tprogram = /Applications/Remcli/node
\targuments = {
\t    /Applications/Remcli/node
\t    /Applications/Remcli/dist/index.mjs
\t    daemon
\t    start-sync
\t}`;
}

describe('macOS LaunchAgent autostart', () => {
    it('reports a missing LaunchAgent without mutating the login domain', async () => {
        const harness = createHarness();
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.getStatus()).resolves.toEqual({
            plistPath: PLIST_PATH,
            state: 'missing',
            isTunnelEnabled: false,
            staleParts: [],
        });
        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
        ]);
    });

    it('writes an owned LaunchAgent atomically with the exact daemon argv and tunnel', async () => {
        const harness = createHarness();
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.install(true)).resolves.toEqual({
            plistPath: PLIST_PATH,
            state: 'installed',
            isTunnelEnabled: true,
            staleParts: [],
        });

        const plist = harness.files.get(PLIST_PATH) ?? '';
        expect(plist).toContain('<key>RemcliOwnerMarker</key>');
        expect(plist).toContain('<string>remcli-managed-autostart-v1</string>');
        expect(plist).toContain('<string>/Applications/Remcli/node</string>');
        expect(plist).toContain('<string>/Applications/Remcli/dist/index.mjs</string>');
        expect(plist).toContain('<string>daemon</string>');
        expect(plist).toContain('<string>start-sync</string>');
        expect(plist).toContain('<string>--tunnel</string>');
        expect(plist).toContain('<key>RunAtLoad</key>');
        expect(plist).toContain('<true/>');
        expect(plist).not.toContain('KeepAlive');
        expect(plist).not.toContain('EnvironmentVariables');
        expect(plist).not.toMatch(/secret|token|bearer/i);
        expect(harness.modes.get(PLIST_PATH)).toBe(0o644);
        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
            ['bootstrap', 'gui/501', PLIST_PATH],
            ['print', 'gui/501/com.remcli-cli.daemon'],
        ]);
    });

    it('writes exactly the non-tunnel daemon argv when tunnel mode is disabled', async () => {
        const harness = createHarness();
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await autostart.install(false);

        const plist = harness.files.get(PLIST_PATH) ?? '';
        const programArguments = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? '';
        expect([...programArguments.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1])).toEqual([
            '/Applications/Remcli/node',
            '/Applications/Remcli/dist/index.mjs',
            'daemon',
            'start-sync',
        ]);
        expect(programArguments).not.toContain('--tunnel');
    });

    it('fails closed for foreign, unsafe, and symlinked plists', async () => {
        const harness = createHarness();
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);
        harness.files.set(PLIST_PATH, '<plist><dict><key>Label</key><string>other</string></dict></plist>');

        await expect(autostart.install(false)).rejects.toThrow('Refusing to replace foreign');
        await expect(autostart.uninstall()).rejects.toThrow('Refusing to remove foreign');
        await expect(autostart.getStatus()).resolves.toMatchObject({ state: 'foreign' });

        harness.files.clear();
        harness.symbolicLinks.add(PLIST_PATH);
        await expect(autostart.install(false)).rejects.toThrow('Refusing to replace foreign');
        await expect(autostart.uninstall()).rejects.toThrow('Refusing to remove foreign');

        harness.symbolicLinks.clear();
        const unsafePolicies = [
            '<key>KeepAlive</key><true/>',
            '<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin</string></dict>',
            '<key>WatchPaths</key><array><string>/tmp</string></array>',
            '<key>StartInterval</key><integer>60</integer>',
        ];
        for (const unsafePolicy of unsafePolicies) {
            harness.files.set(PLIST_PATH, ownedPlist(harness, true).replace('</dict>', `${unsafePolicy}</dict>`));

            await expect(autostart.install(false)).rejects.toThrow('Refusing to replace unsafe');
            await expect(autostart.uninstall()).rejects.toThrow('Refusing to remove unsafe');
            await expect(autostart.getStatus()).resolves.toEqual({
                plistPath: PLIST_PATH,
                state: 'foreign',
                isTunnelEnabled: false,
                staleParts: ['policy'],
            });
        }
    });

    it('marks owned plists with outdated runtime paths as stale and preserves the tunnel setting', async () => {
        const harness = createHarness();
        harness.setLoadedState('not running');
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);
        harness.files.set(
            PLIST_PATH,
            ownedPlist(harness, true)
                .replace('/Applications/Remcli/node', '/Applications/Old Remcli/node')
                .replace('/Applications/Remcli/dist/index.mjs', '/Applications/Old Remcli/dist/index.mjs'),
        );

        await expect(autostart.getStatus()).resolves.toEqual({
            plistPath: PLIST_PATH,
            state: 'stale',
            isTunnelEnabled: true,
            staleParts: ['nodePath', 'entrypointPath'],
        });
    });

    it('does not boot out a label when bootstrap fails before this install owns it', async () => {
        const harness = createHarness();
        harness.dependencies.runLaunchctl = async (args) => {
            harness.calls.push(args);
            if (args[0] === 'print') {
                return { exitCode: 113, stderr: '', stdout: '' };
            }
            if (args[0] === 'bootstrap') {
                return { exitCode: 1, stderr: 'bootstrap failed', stdout: '' };
            }
            return { exitCode: 0, stderr: '', stdout: '' };
        };
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.install(false)).rejects.toThrow('bootstrap failed');

        expect(harness.files.has(PLIST_PATH)).toBe(false);
        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
            ['bootstrap', 'gui/501', PLIST_PATH],
        ]);
    });

    it('restores an existing owned LaunchAgent after a failed replacement', async () => {
        const harness = createHarness();
        const previousContent = ownedPlist(harness, false);
        harness.files.set(PLIST_PATH, previousContent);
        harness.setLoadedState('not running');
        let bootstrapCount = 0;
        harness.dependencies.runLaunchctl = async (args) => {
            harness.calls.push(args);
            if (args[0] === 'print') {
                return {
                    exitCode: 0,
                    stderr: '',
                    stdout: ownedJobPrint('not running'),
                };
            }
            if (args[0] === 'bootstrap') {
                bootstrapCount += 1;
                return { exitCode: bootstrapCount === 1 ? 1 : 0, stderr: '', stdout: '' };
            }
            return { exitCode: 0, stderr: '', stdout: '' };
        };
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.install(true)).rejects.toThrow('bootstrap failed');

        expect(harness.files.get(PLIST_PATH)).toBe(previousContent);
        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
            ['bootout', '--wait', 'gui/501/com.remcli-cli.daemon'],
            ['bootstrap', 'gui/501', PLIST_PATH],
            ['bootstrap', 'gui/501', PLIST_PATH],
        ]);
    });

    it('restores the previous owned LaunchAgent when the replacement write fails after bootout', async () => {
        const harness = createHarness();
        const previousContent = ownedPlist(harness, false);
        harness.files.set(PLIST_PATH, previousContent);
        harness.setLoadedState('not running');
        const originalWriteFile = harness.dependencies.filesystem.writeFile;
        let hasFailedReplacementWrite = false;
        harness.dependencies.filesystem.writeFile = async (path, content, options) => {
            if (!hasFailedReplacementWrite) {
                hasFailedReplacementWrite = true;
                throw new Error('replacement write failed');
            }
            await originalWriteFile(path, content, options);
        };
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.install(true)).rejects.toThrow('replacement write failed');

        expect(harness.files.get(PLIST_PATH)).toBe(previousContent);
        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
            ['bootout', '--wait', 'gui/501/com.remcli-cli.daemon'],
            ['bootstrap', 'gui/501', PLIST_PATH],
        ]);
    });

    it('removes only an owned plist and does not stop the running daemon', async () => {
        const harness = createHarness();
        harness.files.set(PLIST_PATH, ownedPlist(harness, false));
        harness.setLoaded(true);
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.uninstall()).resolves.toEqual({
            plistPath: PLIST_PATH,
            state: 'missing',
            isTunnelEnabled: false,
            staleParts: [],
        });

        expect(harness.files.has(PLIST_PATH)).toBe(false);
        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
        ]);
    });

    it('boots out a stopped owned LaunchAgent before removing its plist', async () => {
        const harness = createHarness();
        harness.files.set(PLIST_PATH, ownedPlist(harness, false));
        harness.setLoadedState('not running');
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.uninstall()).resolves.toEqual({
            plistPath: PLIST_PATH,
            state: 'missing',
            isTunnelEnabled: false,
            staleParts: [],
        });
        await expect(autostart.getStatus()).resolves.toEqual({
            plistPath: PLIST_PATH,
            state: 'missing',
            isTunnelEnabled: false,
            staleParts: [],
        });

        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
            ['bootout', '--wait', 'gui/501/com.remcli-cli.daemon'],
            ['print', 'gui/501/com.remcli-cli.daemon'],
        ]);
        const waitingBootouts = harness.calls.filter((args) => args[0] === 'bootout' && args[1] === '--wait');
        expect(waitingBootouts).toEqual([['bootout', '--wait', 'gui/501/com.remcli-cli.daemon']]);
        expect(waitingBootouts.every((args) => args.length === 3)).toBe(true);
    });

    it('reclaims a tab-indented stopped detached owned job before reinstalling after a running uninstall', async () => {
        const harness = createHarness();
        harness.files.set(PLIST_PATH, ownedPlist(harness, false));
        harness.setLoaded(true);
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await autostart.uninstall();
        harness.calls.length = 0;
        harness.setLoadedState('not running');

        await expect(autostart.getStatus()).resolves.toEqual({
            plistPath: PLIST_PATH,
            state: 'stale',
            isTunnelEnabled: false,
            staleParts: ['detached-owned-job'],
        });
        harness.calls.length = 0;

        await expect(autostart.install(false)).resolves.toMatchObject({ state: 'installed' });

        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
            ['bootout', '--wait', 'gui/501/com.remcli-cli.daemon'],
            ['bootstrap', 'gui/501', PLIST_PATH],
            ['print', 'gui/501/com.remcli-cli.daemon'],
        ]);
    });

    it('does not restore a stopped detached job when its replacement bootstrap fails', async () => {
        const harness = createHarness();
        let hasDetachedJob = true;
        harness.dependencies.runLaunchctl = async (args) => {
            harness.calls.push(args);
            if (args[0] === 'print') {
                if (!hasDetachedJob) {
                    return { exitCode: 113, stderr: '', stdout: '' };
                }
                return { exitCode: 0, stderr: '', stdout: ownedJobPrint('not running') };
            }
            if (args[0] === 'bootout') {
                hasDetachedJob = false;
                return { exitCode: 0, stderr: '', stdout: '' };
            }
            if (args[0] === 'bootstrap') {
                return { exitCode: 1, stderr: 'bootstrap failed', stdout: '' };
            }
            return { exitCode: 0, stderr: '', stdout: '' };
        };
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.install(false)).rejects.toThrow('launchctl bootstrap failed with exit code 1');

        expect(harness.files.has(PLIST_PATH)).toBe(false);
        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
            ['bootout', '--wait', 'gui/501/com.remcli-cli.daemon'],
            ['bootstrap', 'gui/501', PLIST_PATH],
        ]);
    });

    it('does not restore a stopped detached job when its replacement write fails', async () => {
        const harness = createHarness();
        harness.setLoadedState('not running');
        harness.dependencies.filesystem.writeFile = async (): Promise<void> => {
            throw new Error('replacement write failed');
        };
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.install(false)).rejects.toThrow('replacement write failed');

        expect(harness.files.has(PLIST_PATH)).toBe(false);
        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
            ['bootout', '--wait', 'gui/501/com.remcli-cli.daemon'],
        ]);
    });

    it('does not boot out a stopped foreign detached job', async () => {
        const harness = createHarness();
        harness.dependencies.runLaunchctl = async (args) => {
            harness.calls.push(args);
            if (args[0] !== 'print') {
                return { exitCode: 0, stderr: '', stdout: '' };
            }
            return {
                exitCode: 0,
                stderr: '',
                stdout: `state = not running
path = ${PLIST_PATH}
program = /usr/bin/other
arguments = {
    /usr/bin/other
    description: /Applications/Remcli/node /Applications/Remcli/dist/index.mjs daemon start-sync
}`,
            };
        };
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.install(false)).rejects.toThrow('Refusing to replace a loaded foreign macOS LaunchAgent');

        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
        ]);
    });

    it('does not boot out a foreign loaded label when the owned plist still exists', async () => {
        const harness = createHarness();
        harness.files.set(PLIST_PATH, ownedPlist(harness, false));
        harness.dependencies.runLaunchctl = async (args) => {
            harness.calls.push(args);
            if (args[0] !== 'print') {
                return { exitCode: 0, stderr: '', stdout: '' };
            }
            return {
                exitCode: 0,
                stderr: '',
                stdout: `state = running
path = ${PLIST_PATH}
program = /usr/bin/other
arguments = {
    /usr/bin/other
    description: /Applications/Remcli/node /Applications/Remcli/dist/index.mjs daemon start-sync
}`,
            };
        };
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.getStatus()).resolves.toEqual({
            plistPath: PLIST_PATH,
            state: 'foreign',
            isTunnelEnabled: false,
            staleParts: ['loaded-foreign-job'],
        });
        harness.calls.length = 0;

        await expect(autostart.install(false)).rejects.toThrow('Refusing to replace a loaded foreign macOS LaunchAgent');
        await expect(autostart.uninstall()).rejects.toThrow('Refusing to remove an unverified loaded macOS LaunchAgent');

        expect(harness.files.has(PLIST_PATH)).toBe(true);
        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
            ['print', 'gui/501/com.remcli-cli.daemon'],
        ]);
    });

    it('rejects root execution before changing persistent files', async () => {
        const harness = createHarness();
        harness.dependencies.getUserId = () => 0;
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.install(false)).rejects.toThrow('must run as a non-root user');
        await expect(autostart.uninstall()).rejects.toThrow('must run as a non-root user');
        await expect(autostart.getStatus()).rejects.toThrow('must run as a non-root user');
        expect(harness.files).toEqual(new Map());
    });

    it('reports a running verified detached job as stale and requires an explicit stop before reinstall', async () => {
        const harness = createHarness();
        harness.setLoaded(true);
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.getStatus()).resolves.toEqual({
            plistPath: PLIST_PATH,
            state: 'stale',
            isTunnelEnabled: false,
            staleParts: ['detached-owned-running'],
        });
        harness.calls.length = 0;

        await expect(autostart.install(false)).rejects.toThrow('stop the daemon before reinstalling');

        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
        ]);
        expect(harness.files.has(PLIST_PATH)).toBe(false);
    });

    it('treats a transitional state after bootstrap as stale without booting out the LaunchAgent', async () => {
        const harness = createHarness();
        let hasBootstrapped = false;
        harness.dependencies.runLaunchctl = async (args) => {
            harness.calls.push(args);
            if (args[0] === 'print') {
                if (!hasBootstrapped) {
                    return { exitCode: 113, stderr: '', stdout: '' };
                }
                return { exitCode: 0, stderr: '', stdout: ownedJobPrint('waiting') };
            }
            if (args[0] === 'bootstrap') {
                hasBootstrapped = true;
            }
            return { exitCode: 0, stderr: '', stdout: '' };
        };
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.install(false)).resolves.toEqual({
            plistPath: PLIST_PATH,
            state: 'stale',
            isTunnelEnabled: false,
            staleParts: ['active-transition'],
        });

        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
            ['bootstrap', 'gui/501', PLIST_PATH],
            ['print', 'gui/501/com.remcli-cli.daemon'],
        ]);
        expect(harness.calls.some((args) => args[0] === 'bootout')).toBe(false);
    });

    it('reports a transitional detached owned job as active and requires an explicit stop before reinstall', async () => {
        const harness = createHarness();
        harness.dependencies.runLaunchctl = async (args) => {
            harness.calls.push(args);
            if (args[0] !== 'print') {
                return { exitCode: 0, stderr: '', stdout: '' };
            }
            return { exitCode: 0, stderr: '', stdout: ownedJobPrint('waiting') };
        };
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.getStatus()).resolves.toEqual({
            plistPath: PLIST_PATH,
            state: 'stale',
            isTunnelEnabled: false,
            staleParts: ['detached-owned-active'],
        });
        harness.calls.length = 0;

        await expect(autostart.install(false)).rejects.toThrow('stop the daemon before reinstalling');

        expect(harness.calls).toEqual([
            ['print', 'gui/501/com.remcli-cli.daemon'],
        ]);
        expect(harness.calls.some((args) => args[0] === 'bootout')).toBe(false);
        expect(harness.files.has(PLIST_PATH)).toBe(false);
    });

    it('fails closed when launchctl print does not report the documented missing exit code', async () => {
        const harness = createHarness();
        harness.dependencies.runLaunchctl = async (args) => {
            harness.calls.push(args);
            return { exitCode: 1, stderr: 'operation not permitted', stdout: '' };
        };
        const autostart = createMacosLaunchAgentAutostart(harness.dependencies);

        await expect(autostart.install(false)).rejects.toThrow('launchctl print failed with exit code 1');
        await expect(autostart.getStatus()).rejects.toThrow('launchctl print failed with exit code 1');
        expect(harness.files.has(PLIST_PATH)).toBe(false);
    });

    it('routes public install, status, and uninstall to the macOS adapter', async () => {
        const install = vi.fn(async () => ({
            plistPath: PLIST_PATH,
            state: 'installed' as const,
            isTunnelEnabled: true,
            staleParts: [],
        }));
        const getStatus = vi.fn(async () => ({
            plistPath: PLIST_PATH,
            state: 'stale' as const,
            isTunnelEnabled: false,
            staleParts: ['entrypointPath'],
        }));
        const uninstall = vi.fn(async () => ({
            plistPath: PLIST_PATH,
            state: 'missing' as const,
            isTunnelEnabled: false,
            staleParts: [],
        }));
        const macosAutostart = { install, getStatus, uninstall };
        const installDependencies: DaemonAutostartDependencies = { platform: 'darwin', macosAutostart };
        const uninstallDependencies: DaemonAutostartUninstallDependencies = { platform: 'darwin', macosAutostart };

        await expect(installDaemonAutostart({ isTunnelEnabled: true }, installDependencies)).resolves.toEqual({
            platform: 'darwin',
            state: 'installed',
            resource: PLIST_PATH,
            isTunnelEnabled: true,
            details: [],
        });
        await expect(getDaemonAutostartStatus(installDependencies)).resolves.toEqual({
            platform: 'darwin',
            state: 'stale',
            resource: PLIST_PATH,
            isTunnelEnabled: false,
            details: ['entrypointPath'],
        });
        await expect(uninstallDaemonAutostart(uninstallDependencies)).resolves.toEqual({
            platform: 'darwin',
            state: 'missing',
            resource: PLIST_PATH,
            isTunnelEnabled: false,
            details: [],
        });
        await expect(installAutostart({ isTunnelEnabled: true }, installDependencies)).resolves.toMatchObject({
            platform: 'darwin',
            state: 'installed',
        });
        await expect(uninstallAutostart(uninstallDependencies)).resolves.toMatchObject({
            platform: 'darwin',
            state: 'missing',
        });
        expect(install).toHaveBeenCalledWith(true);
        expect(install).toHaveBeenCalledTimes(2);
        expect(getStatus).toHaveBeenCalledOnce();
        expect(uninstall).toHaveBeenCalledTimes(2);
    });
});

function ownedPlist(harness: Harness, isTunnelEnabled: boolean): string {
    return `<?xml version="1.0"?><plist><dict>
<key>Label</key><string>com.remcli-cli.daemon</string>
<key>RemcliOwnerMarker</key><string>remcli-managed-autostart-v1</string>
<key>ProgramArguments</key><array>
<string>${harness.dependencies.nodePath}</string>
<string>${harness.dependencies.entrypointPath}</string>
<string>daemon</string><string>start-sync</string>${isTunnelEnabled ? '<string>--tunnel</string>' : ''}
</array>
<key>RunAtLoad</key><true/>
</dict></plist>`;
}
