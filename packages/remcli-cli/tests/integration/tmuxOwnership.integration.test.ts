import { execFile, type SpawnOptions } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TmuxUtilities, type TmuxPaneInfo } from '@/utils/tmux';

const execFileAsync = promisify(execFile);
const isolatedTmuxServers = new Map<string, string>();
const TMUX_OWNED_PANE_FORMAT = '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{@remcli_owner}';
const CURSOR_LEGACY_PERMISSION_ENV_KEY = 'REMCLI_CURSOR_PERMISSION_MODE';

interface IsolatedTmuxServer {
    socketDirectory: string;
    socketPath: string;
    sessionName: string;
    utilities: TmuxUtilities;
}

interface TmuxCommandRunner {
    runCommand(
        args: string[],
        options?: SpawnOptions,
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

async function isTmuxAvailable(): Promise<boolean> {
    try {
        await execFileAsync('tmux', ['-V']);
        return true;
    } catch {
        return false;
    }
}

async function createIsolatedTmuxServer(
    windowIndexGenerator?: () => number,
): Promise<IsolatedTmuxServer> {
    const socketDirectory = await mkdtemp(join(tmpdir(), 'remcli-tmux-'));
    const socketPath = join(socketDirectory, 'tmux.sock');
    isolatedTmuxServers.set(socketPath, socketDirectory);

    return {
        socketDirectory,
        socketPath,
        sessionName: `remcli-tmux-${randomUUID()}`,
        utilities: new TmuxUtilities(undefined, socketPath, windowIndexGenerator),
    };
}

function loseNextTmuxCreationResponse(
    utilities: TmuxUtilities,
    isCreationCommand: (args: string[]) => boolean,
): ReturnType<typeof vi.spyOn> {
    const commandRunner = utilities as unknown as TmuxCommandRunner;
    const runCommand = commandRunner.runCommand.bind(utilities);
    let hasLostResponse = false;

    return vi.spyOn(commandRunner, 'runCommand').mockImplementation(async (args, options) => {
        const result = await runCommand(args, options);
        if (!hasLostResponse && isCreationCommand(args)) {
            hasLostResponse = true;
            throw new Error('simulated tmux client response loss');
        }
        return result;
    });
}

async function listWindowIds(server: IsolatedTmuxServer): Promise<string[]> {
    const { stdout } = await execFileAsync('tmux', [
        '-S',
        server.socketPath,
        'list-windows',
        '-t',
        server.sessionName,
        '-F',
        '#{window_id}',
    ]);

    return stdout.trim().split('\n').filter(Boolean);
}

async function listWindowNames(server: IsolatedTmuxServer): Promise<string[]> {
    const { stdout } = await execFileAsync('tmux', [
        '-S',
        server.socketPath,
        'list-windows',
        '-t',
        server.sessionName,
        '-F',
        '#{window_name}',
    ]);

    return stdout.trim().split('\n').filter(Boolean);
}

function parseOwnedPane(stdout: string): TmuxPaneInfo {
    const [sessionName, windowId, paneId, panePidValue, ownerMarker] = stdout.trim().split('\t');
    const panePid = Number.parseInt(panePidValue ?? '', 10);
    if (!sessionName || !windowId || !paneId || !ownerMarker || !Number.isSafeInteger(panePid) || panePid <= 0) {
        throw new Error(`Expected one valid owned tmux pane, received: ${stdout}`);
    }

    return { sessionName, windowId, paneId, panePid, ownerMarker };
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

async function createManuallyOwnedHost(
    server: IsolatedTmuxServer,
    ownerMarker: string,
): Promise<TmuxPaneInfo> {
    const { stdout } = await execFileAsync('tmux', [
        '-S',
        server.socketPath,
        'new-session',
        '-d',
        '-s',
        server.sessionName,
        '-n',
        'host',
        ';',
        'set-option',
        '-p',
        '-t',
        `${server.sessionName}:host`,
        '@remcli_owner',
        ownerMarker,
        ';',
        'display-message',
        '-p',
        '-t',
        `${server.sessionName}:host`,
        TMUX_OWNED_PANE_FORMAT,
    ]);

    return parseOwnedPane(stdout);
}

async function createManuallyOwnedWindow(
    server: IsolatedTmuxServer,
    windowName: string,
    ownerMarker: string,
    windowIndex = 100,
): Promise<TmuxPaneInfo> {
    const { stdout } = await execFileAsync('tmux', [
        '-S',
        server.socketPath,
        'new-window',
        '-d',
        '-t',
        `=${server.sessionName}:${windowIndex}`,
        '-n',
        windowName,
        'sleep 30',
        ';',
        'set-option',
        '-p',
        '-t',
        `=${server.sessionName}:${windowIndex}`,
        '@remcli_owner',
        ownerMarker,
        ';',
        'display-message',
        '-p',
        '-t',
        `=${server.sessionName}:${windowIndex}`,
        TMUX_OWNED_PANE_FORMAT,
    ]);

    return parseOwnedPane(stdout);
}

afterEach(async () => {
    await Promise.all(Array.from(isolatedTmuxServers, async ([socketPath, socketDirectory]) => {
        isolatedTmuxServers.delete(socketPath);
        await execFileAsync('tmux', ['-S', socketPath, 'kill-server']).catch(() => {});
        await rm(socketDirectory, { recursive: true, force: true });
    }));
});

describe.skipIf(!await isTmuxAvailable())('tmux immutable ownership integration', () => {
    it('scrubs a stale Cursor legacy permission variable at the child command boundary', async () => {
        const server = await createIsolatedTmuxServer();
        const host = await createManuallyOwnedHost(server, randomUUID());
        const resultPath = join(server.socketDirectory, 'cursor-legacy-permission-env.txt');

        await execFileAsync('tmux', [
            '-S',
            server.socketPath,
            'set-environment',
            '-g',
            CURSOR_LEGACY_PERMISSION_ENV_KEY,
            'legacy-permission-alias',
        ]);
        const { stdout: staleEnvironment } = await execFileAsync('tmux', [
            '-S',
            server.socketPath,
            'show-environment',
            '-g',
            CURSOR_LEGACY_PERMISSION_ENV_KEY,
        ]);
        expect(staleEnvironment.trim()).toBe(`${CURSOR_LEGACY_PERMISSION_ENV_KEY}=legacy-permission-alias`);

        const command = [
            '/usr/bin/env',
            '-u',
            CURSOR_LEGACY_PERMISSION_ENV_KEY,
            '/bin/sh',
            '-c',
            shellQuote(`if [ -n "\${${CURSOR_LEGACY_PERMISSION_ENV_KEY}+x}" ]; then printf present > ${shellQuote(resultPath)}; else printf absent > ${shellQuote(resultPath)}; fi; sleep 30`),
        ].join(' ');
        const runner = await server.utilities.spawnInTmux(
            [command],
            {
                sessionName: server.sessionName,
                windowName: 'cursor-runner',
                ownershipMarker: randomUUID(),
            },
        );

        expect(runner.success).toBe(true);
        if (!runner.success) return;
        await vi.waitFor(async () => {
            await expect(readFile(resultPath, 'utf8')).resolves.toBe('absent');
        });
        expect(await server.utilities.getPaneInfo(runner.ownership.paneId)).toEqual({
            status: 'exists',
            pane: runner.ownership,
        });

        const { stdout: serverEnvironmentAfterSpawn } = await execFileAsync('tmux', [
            '-S',
            server.socketPath,
            'show-environment',
            '-g',
            CURSOR_LEGACY_PERMISSION_ENV_KEY,
        ]);
        expect(serverEnvironmentAfterSpawn.trim()).toBe(`${CURSOR_LEGACY_PERMISSION_ENV_KEY}=legacy-permission-alias`);
        expect(host.paneId).not.toBe(runner.ownership.paneId);
    });

    it('recovers a normal runner from response loss with one marked pane', async () => {
        const server = await createIsolatedTmuxServer();
        const ownerMarker = randomUUID();
        const responseLoss = loseNextTmuxCreationResponse(
            server.utilities,
            (args) => args.includes('new-session'),
        );

        try {
            const runner = await server.utilities.spawnInTmux(
                ['sleep 30'],
                {
                    sessionName: server.sessionName,
                    windowName: 'runner',
                    ownershipMarker: ownerMarker,
                },
            );

            expect(runner.success).toBe(true);
            if (!runner.success) return;
            expect(runner.ownership.ownerMarker).toBe(ownerMarker);
            expect(await server.utilities.getPaneInfo(runner.ownership.paneId)).toEqual({
                status: 'exists',
                pane: runner.ownership,
            });
            expect(await listWindowIds(server)).toEqual([runner.ownership.windowId]);
        } finally {
            responseLoss.mockRestore();
        }
    });

    it('marks a normal runner even when a foreign window has the same display name', async () => {
        const server = await createIsolatedTmuxServer();
        const host = await server.utilities.createSessionWithPane(
            server.sessionName,
            'host',
            randomUUID(),
        );
        expect(host.success).toBe(true);
        if (!host.success) return;

        const foreignRunner = await createManuallyOwnedWindow(server, 'runner', randomUUID());
        const runnerMarker = randomUUID();
        const runner = await server.utilities.spawnInTmux(
            ['sleep 30'],
            {
                sessionName: server.sessionName,
                windowName: 'runner',
                ownershipMarker: runnerMarker,
            },
        );

        expect(runner.success).toBe(true);
        if (!runner.success) return;
        expect(await server.utilities.getPaneInfo(runner.ownership.paneId)).toEqual({
            status: 'exists',
            pane: runner.ownership,
        });
        expect(await server.utilities.getPaneInfo(foreignRunner.paneId)).toEqual({
            status: 'exists',
            pane: foreignRunner,
        });
        expect((await listWindowNames(server)).filter((windowName) => windowName === 'runner')).toHaveLength(2);
        expect(await listWindowIds(server)).toHaveLength(3);
    });

    it('retries an occupied numeric index without leaving an unmarked runner', async () => {
        const occupiedIndex = 1_000_000;
        const availableIndex = 1_000_001;
        const windowIndexes = [occupiedIndex, availableIndex];
        const server = await createIsolatedTmuxServer(() => {
            const windowIndex = windowIndexes.shift();
            if (windowIndex === undefined) {
                throw new Error('Expected tmux window creation to stop after the available index.');
            }
            return windowIndex;
        });
        const host = await server.utilities.createSessionWithPane(
            server.sessionName,
            'host',
            randomUUID(),
        );
        expect(host.success).toBe(true);
        if (!host.success) return;

        const foreignWindow = await createManuallyOwnedWindow(
            server,
            'foreign',
            randomUUID(),
            occupiedIndex,
        );
        const windowsBefore = await listWindowIds(server);
        const runner = await server.utilities.spawnInTmux(
            ['sleep 30'],
            {
                sessionName: server.sessionName,
                windowName: 'runner',
                ownershipMarker: randomUUID(),
            },
        );

        expect(runner.success).toBe(true);
        if (!runner.success) return;
        expect(await server.utilities.getPaneInfo(runner.ownership.paneId)).toEqual({
            status: 'exists',
            pane: runner.ownership,
        });
        expect(await server.utilities.getPaneInfo(foreignWindow.paneId)).toEqual({
            status: 'exists',
            pane: foreignWindow,
        });
        expect(await listWindowIds(server)).toHaveLength(windowsBefore.length + 1);

        await expect(server.utilities.releaseOwnedPane(runner.ownership)).resolves.toBe('released');
        await expect(listWindowIds(server)).resolves.toEqual(windowsBefore);
    });

    it('retries an occupied numeric index without leaving an unmarked guarded child', async () => {
        const occupiedIndex = 1_000_000;
        const availableIndex = 1_000_001;
        const windowIndexes = [occupiedIndex, availableIndex];
        const server = await createIsolatedTmuxServer(() => {
            const windowIndex = windowIndexes.shift();
            if (windowIndex === undefined) {
                throw new Error('Expected guarded tmux window creation to stop after the available index.');
            }
            return windowIndex;
        });
        const host = await server.utilities.createSessionWithPane(
            server.sessionName,
            'host',
            randomUUID(),
        );
        expect(host.success).toBe(true);
        if (!host.success) return;

        const foreignWindow = await createManuallyOwnedWindow(
            server,
            'foreign',
            randomUUID(),
            occupiedIndex,
        );
        const windowsBefore = await listWindowIds(server);
        const child = await server.utilities.spawnInOwnedTmuxSession(
            ['sleep 30'],
            {
                hostOwnership: host.ownership,
                windowName: 'child',
                ownershipMarker: randomUUID(),
            },
        );

        expect(child.success).toBe(true);
        if (!child.success) return;
        expect(await server.utilities.getPaneInfo(child.ownership.paneId)).toEqual({
            status: 'exists',
            pane: child.ownership,
        });
        expect(await server.utilities.getPaneInfo(foreignWindow.paneId)).toEqual({
            status: 'exists',
            pane: foreignWindow,
        });
        expect(await listWindowIds(server)).toHaveLength(windowsBefore.length + 1);

        await expect(server.utilities.releaseOwnedPane(child.ownership)).resolves.toBe('released');
        await expect(listWindowIds(server)).resolves.toEqual(windowsBefore);
    });

    it('opens a child window from an exact guarded host tuple', async () => {
        const server = await createIsolatedTmuxServer();
        const host = await server.utilities.createSessionWithPane(
            server.sessionName,
            'host',
            randomUUID(),
        );
        expect(host.success).toBe(true);
        if (!host.success) return;

        const child = await server.utilities.spawnInOwnedTmuxSession(
            ['sleep 30'],
            {
                hostOwnership: host.ownership,
                windowName: 'child',
                ownershipMarker: randomUUID(),
            },
        );

        expect(child.success).toBe(true);
        if (!child.success) return;
        expect(await server.utilities.getPaneInfo(child.ownership.paneId)).toEqual({
            status: 'exists',
            pane: child.ownership,
        });
        expect(await listWindowIds(server)).toEqual(expect.arrayContaining([
            host.ownership.windowId,
            child.ownership.windowId,
        ]));
    });

    it('recovers a guarded child from response loss, releases it, and creates no duplicate', async () => {
        const server = await createIsolatedTmuxServer();
        const host = await server.utilities.createSessionWithPane(
            server.sessionName,
            'host',
            randomUUID(),
        );
        expect(host.success).toBe(true);
        if (!host.success) return;

        const childMarker = randomUUID();
        const responseLoss = loseNextTmuxCreationResponse(
            server.utilities,
            (args) => args.includes('if-shell') && args.some((argument) => argument.includes('"new-window"')),
        );
        let child: Awaited<ReturnType<TmuxUtilities['spawnInOwnedTmuxSession']>>;
        try {
            child = await server.utilities.spawnInOwnedTmuxSession(
                ['sleep 30'],
                {
                    hostOwnership: host.ownership,
                    windowName: 'child',
                    ownershipMarker: childMarker,
                },
            );
        } finally {
            responseLoss.mockRestore();
        }

        expect(child.success).toBe(true);
        if (!child.success) return;
        expect(child.ownership.ownerMarker).toBe(childMarker);
        expect(await server.utilities.getPaneInfo(child.ownership.paneId)).toEqual({
            status: 'exists',
            pane: child.ownership,
        });
        expect(await listWindowIds(server)).toEqual(expect.arrayContaining([
            host.ownership.windowId,
            child.ownership.windowId,
        ]));
        expect(await listWindowIds(server)).toHaveLength(2);

        await expect(server.utilities.releaseOwnedPane(child.ownership)).resolves.toBe('released');
        await expect(listWindowIds(server)).resolves.toEqual([host.ownership.windowId]);
    });

    it('refuses a wrong host marker without creating a child window', async () => {
        const server = await createIsolatedTmuxServer();
        const host = await server.utilities.createSessionWithPane(
            server.sessionName,
            'host',
            randomUUID(),
        );
        expect(host.success).toBe(true);
        if (!host.success) return;

        const windowsBefore = await listWindowIds(server);
        const child = await server.utilities.spawnInOwnedTmuxSession(
            ['sleep 30'],
            {
                hostOwnership: {
                    ...host.ownership,
                    ownerMarker: randomUUID(),
                },
                windowName: 'rejected-child',
                ownershipMarker: randomUUID(),
            },
        );

        expect(child).toMatchObject({
            success: false,
            error: expect.stringContaining('host ownership no longer matches'),
        });
        expect(await listWindowIds(server)).toEqual(windowsBefore);
    });

    it('marks a guarded child even when a foreign window has the same display name', async () => {
        const server = await createIsolatedTmuxServer();
        const host = await server.utilities.createSessionWithPane(
            server.sessionName,
            'host',
            randomUUID(),
        );
        expect(host.success).toBe(true);
        if (!host.success) return;

        const foreignChild = await createManuallyOwnedWindow(server, 'child', randomUUID());
        const childMarker = randomUUID();
        const child = await server.utilities.spawnInOwnedTmuxSession(
            ['sleep 30'],
            {
                hostOwnership: host.ownership,
                windowName: 'child',
                ownershipMarker: childMarker,
            },
        );

        expect(child.success).toBe(true);
        if (!child.success) return;
        expect(await server.utilities.getPaneInfo(child.ownership.paneId)).toEqual({
            status: 'exists',
            pane: child.ownership,
        });
        expect(await server.utilities.getPaneInfo(foreignChild.paneId)).toEqual({
            status: 'exists',
            pane: foreignChild,
        });
        expect(child.ownership.ownerMarker).toBe(childMarker);
        expect((await listWindowNames(server)).filter((windowName) => windowName === 'child')).toHaveLength(2);
        expect(await listWindowIds(server)).toHaveLength(3);
    });

    it('recovers a server-marked host after response loss and releases only that pane', async () => {
        const server = await createIsolatedTmuxServer();
        const ownerMarker = randomUUID();
        const originalHost = await createManuallyOwnedHost(server, ownerMarker);
        const foreignPane = await createManuallyOwnedWindow(server, 'foreign', randomUUID());

        const recoveredHost = await server.utilities.createSessionWithPane(
            server.sessionName,
            'host',
            ownerMarker,
        );

        expect(recoveredHost).toEqual({
            success: true,
            sessionId: `${server.sessionName}:host`,
            ownership: originalHost,
        });
        if (!recoveredHost.success) return;

        await expect(server.utilities.releaseOwnedPane(recoveredHost.ownership)).resolves.toBe('released');
        await expect(server.utilities.getPaneInfo(foreignPane.paneId)).resolves.toEqual({
            status: 'exists',
            pane: foreignPane,
        });
        await expect(listWindowIds(server)).resolves.toEqual([foreignPane.windowId]);
    });

    it('does not adopt or delete a same-named foreign host with another marker', async () => {
        const server = await createIsolatedTmuxServer();
        const foreignHost = await createManuallyOwnedHost(server, randomUUID());

        const collision = await server.utilities.createSessionWithPane(
            server.sessionName,
            'host',
            randomUUID(),
        );

        expect(collision).toMatchObject({ success: false });
        await expect(server.utilities.getPaneInfo(foreignHost.paneId)).resolves.toEqual({
            status: 'exists',
            pane: foreignHost,
        });
        await expect(listWindowIds(server)).resolves.toEqual([foreignHost.windowId]);
    });

    it('preserves a foreign same-named window when a colliding create fails', async () => {
        const server = await createIsolatedTmuxServer();
        const foreignWindow = await server.utilities.createSessionWithPane(
            server.sessionName,
            'foreign',
            randomUUID(),
        );
        expect(foreignWindow.success).toBe(true);
        if (!foreignWindow.success) return;

        const collidingCreate = await server.utilities.createSessionWithPane(
            server.sessionName,
            'foreign',
            randomUUID(),
        );

        expect(collidingCreate).toMatchObject({ success: false });
        expect(await server.utilities.getPaneInfo(foreignWindow.ownership.paneId)).toEqual({
            status: 'exists',
            pane: foreignWindow.ownership,
        });
        expect(await listWindowIds(server)).toEqual([foreignWindow.ownership.windowId]);
    });
});
