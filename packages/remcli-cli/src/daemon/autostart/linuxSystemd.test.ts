import { describe, expect, it } from 'vitest';
import {
    getLinuxSystemdAutostartStatus,
    installLinuxSystemdAutostart,
    LinuxSystemdAutostartDependencies,
    uninstallLinuxSystemdAutostart,
} from './linuxSystemd';

const UNIT_PATH = '/home/remcli user/.config/systemd/user/remcli.service';

interface InMemoryFilesystem {
    files: Map<string, string>;
    calls: string[];
    modes: Map<string, number>;
    symbolicLinks: Set<string>;
    dependencies: LinuxSystemdAutostartDependencies;
}

function createInMemoryFilesystem(): InMemoryFilesystem {
    const files = new Map<string, string>();
    const calls: string[] = [];
    const modes = new Map<string, number>();
    const symbolicLinks = new Set<string>();
    const dependencies: LinuxSystemdAutostartDependencies = {
        platform: 'linux',
        homeDirectory: '/home/remcli user',
        nodePath: '/opt/Remcli 100%/$channel/node "stable"/node',
        entrypointPath: '/opt/Remcli 100%/dist/index.mjs',
        pathExists: () => true,
        filesystem: {
            async chmod(path: string, mode: number): Promise<void> {
                calls.push(`chmod:${path}:${mode.toString(8)}`);
                modes.set(path, mode);
            },
            async lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }> {
                if (symbolicLinks.has(path)) {
                    return {
                        isFile: () => false,
                        isSymbolicLink: () => true,
                    };
                }
                if (!files.has(path)) {
                    const error = new Error(`Missing file: ${path}`) as NodeJS.ErrnoException;
                    error.code = 'ENOENT';
                    throw error;
                }
                return {
                    isFile: () => true,
                    isSymbolicLink: () => false,
                };
            },
            async mkdir(path: string): Promise<void> {
                calls.push(`mkdir:${path}`);
            },
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
                calls.push(`rename:${oldPath}:${newPath}`);
                const content = files.get(oldPath);
                if (content === undefined) {
                    throw new Error(`Missing temporary unit: ${oldPath}`);
                }
                files.set(newPath, content);
                files.delete(oldPath);
            },
            async unlink(path: string): Promise<void> {
                calls.push(`unlink:${path}`);
                files.delete(path);
            },
            async writeFile(path: string, content: string, options: { encoding: 'utf8'; flag: 'wx'; mode: number }): Promise<void> {
                calls.push(`write:${path}:${options.mode.toString(8)}`);
                if (files.has(path)) {
                    throw new Error(`Temporary unit already exists: ${path}`);
                }
                files.set(path, content);
                modes.set(path, options.mode);
            },
        },
        async runSystemctl(args: string[]): Promise<string> {
            calls.push(`systemctl:${args.join(' ')}`);
            return '';
        },
    };

    return { files, calls, modes, symbolicLinks, dependencies };
}

describe('Linux systemd autostart', () => {
    it('fails closed for a foreign existing unit', async () => {
        const fixture = createInMemoryFilesystem();
        fixture.files.set(UNIT_PATH, '[Service]\nExecStart=/usr/bin/other-daemon\n');

        await expect(installLinuxSystemdAutostart({ isTunnelEnabled: false }, fixture.dependencies))
            .rejects.toThrow('Refusing to replace foreign systemd user unit');

        expect(fixture.files.get(UNIT_PATH)).toContain('/usr/bin/other-daemon');
        expect(fixture.calls).toEqual(['systemctl:--user show-environment']);
    });

    it('writes an owned, escaped unit atomically and enables it immediately', async () => {
        const fixture = createInMemoryFilesystem();

        const status = await installLinuxSystemdAutostart({ isTunnelEnabled: true }, fixture.dependencies);
        const unitContent = fixture.files.get(UNIT_PATH);

        expect(status).toEqual({
            unitPath: UNIT_PATH,
            state: 'installed',
            hasStalePaths: false,
            hasUnsafePolicy: false,
            isEnabled: true,
            isTunnelEnabled: true,
        });
        expect(unitContent).toContain('# remcli-managed-autostart-v1');
        expect(unitContent).toContain('ExecStart="/opt/Remcli 100%%/$$channel/node \\"stable\\"/node" "/opt/Remcli 100%%/dist/index.mjs" "daemon" "start-sync" "--tunnel"');
        expect(unitContent).toContain('Restart=no');
        expect(unitContent).not.toContain('Environment=');
        expect(unitContent).not.toMatch(/secret|token|key/i);
        expect(fixture.calls).toContain('systemctl:--user daemon-reload');
        expect(fixture.calls).toContain('systemctl:--user enable --now remcli.service');
        expect(fixture.calls.some((call) => call.startsWith('write:'))).toBe(true);
        expect(fixture.calls.some((call) => call.startsWith('chmod:') && call.endsWith(':644'))).toBe(true);
        expect(fixture.calls.some((call) => call.startsWith('rename:') && call.endsWith(`:${UNIT_PATH}`))).toBe(true);
    });

    it('does not write a unit when the user manager is unavailable', async () => {
        const fixture = createInMemoryFilesystem();
        fixture.dependencies.runSystemctl = async (): Promise<string> => {
            throw new Error('Failed to connect to bus');
        };

        await expect(installLinuxSystemdAutostart({ isTunnelEnabled: false }, fixture.dependencies))
            .rejects.toThrow('systemd user manager is unavailable');

        expect(fixture.files.size).toBe(0);
        expect(fixture.calls).toEqual([]);
    });

    it('fails closed for a dangling unit symlink', async () => {
        const fixture = createInMemoryFilesystem();
        fixture.symbolicLinks.add(UNIT_PATH);

        await expect(installLinuxSystemdAutostart({ isTunnelEnabled: false }, fixture.dependencies))
            .rejects.toThrow('Refusing to replace foreign systemd user unit');
        await expect(uninstallLinuxSystemdAutostart(fixture.dependencies))
            .rejects.toThrow('Refusing to remove foreign systemd user unit');
        await expect(getLinuxSystemdAutostartStatus(fixture.dependencies)).resolves.toMatchObject({
            state: 'foreign',
        });
    });

    it('removes a partially installed unit when systemd enable fails', async () => {
        const fixture = createInMemoryFilesystem();
        const originalRunSystemctl = fixture.dependencies.runSystemctl;
        fixture.dependencies.runSystemctl = async (args): Promise<string> => {
            if (args.includes('enable')) {
                fixture.calls.push(`systemctl:${args.join(' ')}`);
                throw new Error('enable failed');
            }
            return originalRunSystemctl(args);
        };

        await expect(installLinuxSystemdAutostart({ isTunnelEnabled: false }, fixture.dependencies))
            .rejects.toThrow('enable failed');

        expect(fixture.files.has(UNIT_PATH)).toBe(false);
        expect(fixture.calls).toContain('systemctl:--user disable --now remcli.service');
        expect(fixture.calls.filter((call) => call === 'systemctl:--user daemon-reload')).toHaveLength(2);
    });

    it('restores an existing disabled unit after a failed update', async () => {
        const fixture = createInMemoryFilesystem();
        const previousContent = '# remcli-managed-autostart-v1\n[Service]\nExecStart="/previous/node"\nRestart=no\n';
        fixture.files.set(UNIT_PATH, previousContent);
        fixture.dependencies.runSystemctl = async (args): Promise<string> => {
            fixture.calls.push(`systemctl:${args.join(' ')}`);
            if (args.includes('is-active') || args.includes('is-enabled')) {
                throw new Error('disabled');
            }
            if (args.includes('enable') && args.includes('--now')) {
                throw new Error('enable failed');
            }
            return '';
        };

        await expect(installLinuxSystemdAutostart({ isTunnelEnabled: true }, fixture.dependencies))
            .rejects.toThrow('enable failed');

        expect(fixture.files.get(UNIT_PATH)).toBe(previousContent);
        expect(fixture.calls).toContain('systemctl:--user disable --now remcli.service');
        expect(fixture.calls).not.toContain('systemctl:--user enable remcli.service');
        expect(fixture.calls).not.toContain('systemctl:--user start remcli.service');
    });

    it('uninstalls only its owned unit', async () => {
        const fixture = createInMemoryFilesystem();
        await installLinuxSystemdAutostart({ isTunnelEnabled: false }, fixture.dependencies);
        fixture.calls.length = 0;

        const status = await uninstallLinuxSystemdAutostart(fixture.dependencies);

        expect(status.state).toBe('missing');
        expect(fixture.files.has(UNIT_PATH)).toBe(false);
        expect(fixture.calls).toContain('systemctl:--user disable remcli.service');
        expect(fixture.calls).toContain(`unlink:${UNIT_PATH}`);
        expect(fixture.calls).toContain('systemctl:--user daemon-reload');
    });

    it('reports missing, stale paths, and the persisted tunnel setting', async () => {
        const fixture = createInMemoryFilesystem();

        await expect(getLinuxSystemdAutostartStatus(fixture.dependencies)).resolves.toEqual({
            unitPath: UNIT_PATH,
            state: 'missing',
            hasStalePaths: false,
            hasUnsafePolicy: false,
            isEnabled: false,
            isTunnelEnabled: false,
        });

        fixture.files.set(UNIT_PATH, `# remcli-managed-autostart-v1\n[Service]\nExecStart="/old/node" "/old/dist/index.mjs" "daemon" "start-sync" "--tunnel"\nRestart=no\n`);

        await expect(getLinuxSystemdAutostartStatus(fixture.dependencies)).resolves.toEqual({
            unitPath: UNIT_PATH,
            state: 'stale',
            hasStalePaths: true,
            hasUnsafePolicy: false,
            isEnabled: true,
            isTunnelEnabled: true,
        });
    });

    it('does not require a live systemctl call for status inspection', async () => {
        const fixture = createInMemoryFilesystem();
        fixture.files.set(UNIT_PATH, '# unrelated systemd unit\n');

        await expect(getLinuxSystemdAutostartStatus(fixture.dependencies)).resolves.toMatchObject({
            state: 'foreign',
        });
        expect(fixture.calls).toEqual([]);
    });

    it('reports a healthy tunnel unit independently from the status caller', async () => {
        const fixture = createInMemoryFilesystem();
        await installLinuxSystemdAutostart({ isTunnelEnabled: true }, fixture.dependencies);

        await expect(getLinuxSystemdAutostartStatus(fixture.dependencies)).resolves.toEqual({
            unitPath: UNIT_PATH,
            state: 'installed',
            hasStalePaths: false,
            hasUnsafePolicy: false,
            isEnabled: true,
            isTunnelEnabled: true,
        });
    });

    it('marks missing runtime files or unsafe service policy as stale', async () => {
        const fixture = createInMemoryFilesystem();
        await installLinuxSystemdAutostart({ isTunnelEnabled: false }, fixture.dependencies);
        fixture.dependencies.pathExists = (path) => path !== fixture.dependencies.nodePath;

        await expect(getLinuxSystemdAutostartStatus(fixture.dependencies)).resolves.toMatchObject({
            state: 'stale',
            hasStalePaths: true,
        });

        const content = fixture.files.get(UNIT_PATH) ?? '';
        fixture.files.set(UNIT_PATH, content.replace('Restart=no', 'Restart=always'));
        fixture.dependencies.pathExists = () => true;
        await expect(getLinuxSystemdAutostartStatus(fixture.dependencies)).resolves.toMatchObject({
            state: 'stale',
            hasStalePaths: false,
        });
    });

    it('marks an owned but disabled unit as stale', async () => {
        const fixture = createInMemoryFilesystem();
        await installLinuxSystemdAutostart({ isTunnelEnabled: false }, fixture.dependencies);
        const originalRunSystemctl = fixture.dependencies.runSystemctl;
        fixture.dependencies.runSystemctl = async (args): Promise<string> => {
            if (args.includes('is-enabled')) {
                throw new Error('disabled');
            }
            return originalRunSystemctl(args);
        };

        await expect(getLinuxSystemdAutostartStatus(fixture.dependencies)).resolves.toMatchObject({
            state: 'stale',
            isEnabled: false,
        });
    });
});
