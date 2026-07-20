/**
 * Unit tests for tmux utilities
 *
 * NOTE: These are pure unit tests that test parsing and validation logic.
 * They do NOT require tmux to be installed on the system.
 * All tests mock environment variables and test string parsing only.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({
    spawn: vi.fn(),
}));

vi.mock('child_process', () => ({
    spawn: childProcessMocks.spawn,
}));
import {
    parseTmuxSessionIdentifier,
    formatTmuxSessionIdentifier,
    validateTmuxSessionIdentifier,
    buildTmuxSessionIdentifier,
    TmuxSessionIdentifierError,
    TmuxUtilities,
    type TmuxSessionIdentifier,
} from './tmux';

interface MockTmuxChild extends EventEmitter {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal: NodeJS.Signals) => boolean;
}

function mockTmuxChild(): MockTmuxChild {
    const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: vi.fn(() => true),
    }) as MockTmuxChild;
    childProcessMocks.spawn.mockReturnValueOnce(child);
    return child;
}

function readOwnedPaneOutcomeMarker(command: string[]): string {
    const match = command.join(' ').match(/__remcli_owned_pane_(?:capture|input)_[0-9a-f-]+__/i);
    if (!match) {
        throw new Error('Expected a per-call owned-pane outcome marker.');
    }
    return match[0];
}

afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
});

describe('TmuxUtilities cleanup commands', () => {
    const ownerMarker = '11111111-1111-4111-8111-111111111111';

    it('checks tmux session existence through one bounded non-shell command', async () => {
        const child = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const result = utilities.getSessionStatus('remcli-session');

        expect(childProcessMocks.spawn).toHaveBeenCalledWith(
            'tmux',
            ['has-session', '-t', 'remcli-session'],
            expect.objectContaining({ shell: false })
        );

        child.emit('close', 0, null);

        await expect(result).resolves.toBe('exists');
    });

    it('returns unknown when tmux cannot confirm session absence', async () => {
        const child = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const result = utilities.getSessionStatus('remcli-session');

        child.emit('error', new Error('tmux unavailable'));

        await expect(result).resolves.toBe('unknown');
    });

    it('returns unknown when the tmux session probe times out', async () => {
        vi.useFakeTimers();
        const child = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const result = utilities.getSessionStatus('remcli-session');

        await vi.advanceTimersByTimeAsync(5_000);

        await expect(result).resolves.toBe('unknown');
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });

    it('kills a parsed window through one tmux target argument', async () => {
        const child = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const result = utilities.killWindow('remcli-session:main.2');

        expect(childProcessMocks.spawn).toHaveBeenCalledWith(
            'tmux',
            ['kill-window', '-t', 'remcli-session:main.2'],
            expect.objectContaining({ shell: false })
        );

        child.emit('close', 0, null);

        await expect(result).resolves.toBe(true);
    });

    it('inspects and kills a verified immutable tmux window id without a shell', async () => {
        const inspectChild = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const inspection = utilities.getWindowInfo('@42');

        expect(childProcessMocks.spawn).toHaveBeenCalledWith(
            'tmux',
            ['display-message', '-p', '-t', '@42', '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}'],
            expect.objectContaining({ shell: false })
        );
        inspectChild.stdout.emit('data', Buffer.from('remcli-owned\t@42\t%9\t1234\n'));
        inspectChild.emit('close', 0, null);

        await expect(inspection).resolves.toEqual({
            status: 'exists',
            window: {
                sessionName: 'remcli-owned',
                windowId: '@42',
                paneId: '%9',
                panePid: 1234,
            },
        });

        const killChild = mockTmuxChild();
        const kill = utilities.killWindowById('@42');
        expect(childProcessMocks.spawn).toHaveBeenLastCalledWith(
            'tmux',
            ['kill-window', '-t', '@42'],
            expect.objectContaining({ shell: false })
        );
        killChild.emit('close', 0, null);
        await expect(kill).resolves.toBe(true);
    });

    it('does not execute a command for an invalid immutable tmux window id', async () => {
        const utilities = new TmuxUtilities();

        await expect(utilities.getWindowInfo('remcli:main')).resolves.toEqual({ status: 'unknown' });
        await expect(utilities.killWindowById('remcli:main')).resolves.toBe(false);
        expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    });

    it('creates, inspects, and atomically releases one immutable owned pane', async () => {
        const createChild = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const created = utilities.createSessionWithPane('remcli-owned', 'host', ownerMarker);

        expect(childProcessMocks.spawn).toHaveBeenCalledWith(
            'tmux',
            [
                'new-session', '-d', '-s', 'remcli-owned', '-n', 'host',
                ';', 'set-option', '-p', '@remcli_owner', ownerMarker,
                ';', 'display-message', '-p',
                '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{@remcli_owner}',
            ],
            expect.objectContaining({ shell: false })
        );
        createChild.stdout.emit('data', Buffer.from(`remcli-owned\t@43\t%10\t1235\t${ownerMarker}\n`));
        createChild.emit('close', 0, null);

        await expect(created).resolves.toEqual({
            success: true,
            sessionId: 'remcli-owned:host',
            ownership: {
                sessionName: 'remcli-owned',
                windowId: '@43',
                paneId: '%10',
                panePid: 1235,
                ownerMarker,
            },
        });

        const ownershipInspectChild = mockTmuxChild();
        const inspection = utilities.getPaneInfo('%10');
        expect(childProcessMocks.spawn).toHaveBeenLastCalledWith(
            'tmux',
            ['display-message', '-p', '-t', '%10', '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{@remcli_owner}'],
            expect.objectContaining({ shell: false })
        );
        ownershipInspectChild.stdout.emit('data', Buffer.from(`remcli-owned\t@43\t%10\t1235\t${ownerMarker}\n`));
        ownershipInspectChild.emit('close', 0, null);
        await expect(inspection).resolves.toEqual({
            status: 'exists',
            pane: {
                sessionName: 'remcli-owned',
                windowId: '@43',
                paneId: '%10',
                panePid: 1235,
                ownerMarker,
            },
        });

        const killChild = mockTmuxChild();
        const release = utilities.releaseOwnedPane({
            sessionName: 'remcli-owned',
            windowId: '@43',
            paneId: '%10',
            panePid: 1235,
            ownerMarker,
        });
        expect(childProcessMocks.spawn).toHaveBeenLastCalledWith(
            'tmux',
            [
                'if-shell', '-t', '%10', '-F',
                expect.stringContaining(`#{==:#{@remcli_owner},${ownerMarker}}`),
                'kill-pane -t %10',
                'display-message -p __remcli_ownership_mismatch__',
            ],
            expect.objectContaining({ shell: false })
        );
        killChild.emit('close', 0, null);
        await expect(release).resolves.toBe('released');
    });

    it('recovers one server-marked pane when the create response is lost', async () => {
        const createChild = mockTmuxChild();
        const recoveryChild = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const created = utilities.createSessionWithPane('remcli-owned', 'host', ownerMarker);

        createChild.emit('error', new Error('tmux client response lost'));

        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2));
        expect(childProcessMocks.spawn).toHaveBeenLastCalledWith(
            'tmux',
            [
                'list-panes', '-a',
                '-F', '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{@remcli_owner}',
                '-f', expect.stringContaining(`#{==:#{@remcli_owner},${ownerMarker}}`),
            ],
            expect.objectContaining({ shell: false }),
        );
        recoveryChild.stdout.emit('data', Buffer.from(`remcli-owned\t@43\t%10\t1235\t${ownerMarker}\n`));
        recoveryChild.emit('close', 0, null);

        await expect(created).resolves.toEqual({
            success: true,
            sessionId: 'remcli-owned:host',
            ownership: {
                sessionName: 'remcli-owned',
                windowId: '@43',
                paneId: '%10',
                panePid: 1235,
                ownerMarker,
            },
        });
        expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);
    });

    it('recovers a normal runner after response loss without a second ownership claim', async () => {
        const availabilityChild = mockTmuxChild();
        const sessionLookupChild = mockTmuxChild();
        const createChild = mockTmuxChild();
        const recoveryChild = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const spawned = utilities.spawnInTmux(['sleep 30'], {
            sessionName: 'remcli-runner',
            windowName: 'main',
            ownershipMarker: ownerMarker,
        });

        availabilityChild.emit('close', 1, null);
        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2));
        sessionLookupChild.emit('close', 1, null);

        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(3));
        expect(childProcessMocks.spawn).toHaveBeenLastCalledWith(
            'tmux',
            [
                'new-session', '-d', '-s', 'remcli-runner', '-n', 'main', 'sleep 30',
                ';', 'set-option', '-p', '@remcli_owner', ownerMarker,
                ';', 'display-message', '-p',
                '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{@remcli_owner}',
            ],
            expect.objectContaining({ shell: false }),
        );

        createChild.emit('error', new Error('tmux client response lost'));

        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(4));
        recoveryChild.stdout.emit('data', Buffer.from(`remcli-runner\t@43\t%10\t1235\t${ownerMarker}\n`));
        recoveryChild.emit('close', 0, null);

        await expect(spawned).resolves.toEqual({
            success: true,
            sessionId: 'remcli-runner:main',
            ownership: {
                sessionName: 'remcli-runner',
                windowId: '@43',
                paneId: '%10',
                panePid: 1235,
                ownerMarker,
            },
        });
        expect(childProcessMocks.spawn).toHaveBeenCalledTimes(4);
    });

    it('marks a window added to an existing session in the creation command', async () => {
        const sessionListChild = mockTmuxChild();
        const sessionLookupChild = mockTmuxChild();
        const createChild = mockTmuxChild();
        const utilities = new TmuxUtilities(undefined, undefined, () => 1_234_567);
        const spawned = utilities.spawnInTmux(['sleep 30'], {
            sessionName: 'remcli-runner',
            windowName: 'runner-child',
            ownershipMarker: ownerMarker,
        });

        sessionListChild.emit('close', 0, null);
        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2));
        sessionLookupChild.emit('close', 0, null);
        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(3));
        expect(childProcessMocks.spawn).toHaveBeenLastCalledWith(
            'tmux',
            [
                'new-window', '-t', '=remcli-runner:1234567', '-n', 'runner-child', 'sleep 30',
                ';', 'set-option', '-p', '-t', '=remcli-runner:1234567', '@remcli_owner', ownerMarker,
                ';', 'display-message', '-p', '-t', '=remcli-runner:1234567',
                '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{@remcli_owner}',
            ],
            expect.objectContaining({ shell: false }),
        );
        createChild.stdout.emit('data', Buffer.from(`remcli-runner\t@44\t%11\t1236\t${ownerMarker}\n`));
        createChild.emit('close', 0, null);

        await expect(spawned).resolves.toEqual({
            success: true,
            sessionId: 'remcli-runner:runner-child',
            ownership: {
                sessionName: 'remcli-runner',
                windowId: '@44',
                paneId: '%11',
                panePid: 1236,
                ownerMarker,
            },
        });
        expect(childProcessMocks.spawn).toHaveBeenCalledTimes(3);
    });

    it('retries an occupied numeric target without attempting marker recovery for it', async () => {
        const sessionListChild = mockTmuxChild();
        const sessionLookupChild = mockTmuxChild();
        const occupiedIndexChild = mockTmuxChild();
        const createChild = mockTmuxChild();
        const generateWindowIndex = vi.fn()
            .mockReturnValueOnce(1_234_567)
            .mockReturnValueOnce(1_234_568);
        const utilities = new TmuxUtilities(undefined, undefined, generateWindowIndex);
        const spawned = utilities.spawnInTmux(['sleep 30'], {
            sessionName: 'remcli-runner',
            windowName: 'runner-child',
            ownershipMarker: ownerMarker,
        });

        sessionListChild.emit('close', 0, null);
        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2));
        sessionLookupChild.emit('close', 0, null);
        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(3));
        expect(childProcessMocks.spawn).toHaveBeenLastCalledWith(
            'tmux',
            expect.arrayContaining(['new-window', '-t', '=remcli-runner:1234567']),
            expect.objectContaining({ shell: false }),
        );
        occupiedIndexChild.stderr.emit('data', Buffer.from('index 1234567 in use\n'));
        occupiedIndexChild.emit('close', 1, null);

        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(4));
        expect(childProcessMocks.spawn).toHaveBeenLastCalledWith(
            'tmux',
            expect.arrayContaining(['new-window', '-t', '=remcli-runner:1234568']),
            expect.objectContaining({ shell: false }),
        );
        createChild.stdout.emit('data', Buffer.from(`remcli-runner\t@44\t%11\t1236\t${ownerMarker}\n`));
        createChild.emit('close', 0, null);

        await expect(spawned).resolves.toEqual({
            success: true,
            sessionId: 'remcli-runner:runner-child',
            ownership: {
                sessionName: 'remcli-runner',
                windowId: '@44',
                paneId: '%11',
                panePid: 1236,
                ownerMarker,
            },
        });
        expect(generateWindowIndex).toHaveBeenCalledTimes(2);
        expect(childProcessMocks.spawn).toHaveBeenCalledTimes(4);
    });

    it('recovers a guarded child after response loss from its server-marked creation command', async () => {
        const createChild = mockTmuxChild();
        const recoveryChild = mockTmuxChild();
        const utilities = new TmuxUtilities(undefined, undefined, () => 1_234_568);
        const hostOwnership = {
            sessionName: 'remcli-owned',
            windowId: '@43',
            paneId: '%10',
            panePid: 1235,
            ownerMarker,
        };
        const childMarker = '22222222-2222-4222-8222-222222222222';
        const spawned = utilities.spawnInOwnedTmuxSession(['sleep 30'], {
            hostOwnership,
            windowName: 'child',
            ownershipMarker: childMarker,
        });

        expect(childProcessMocks.spawn).toHaveBeenLastCalledWith(
            'tmux',
            [
                'if-shell', '-t', '%10', '-F', expect.stringContaining(`#{==:#{@remcli_owner},${ownerMarker}}`),
                expect.stringContaining(`\"new-window\" \"-t\" \"=remcli-owned:1234568\" \"-n\" \"child\" \"sleep 30\" ; \"set-option\" \"-p\" \"-t\" \"=remcli-owned:1234568\" \"@remcli_owner\" \"${childMarker}\" ; \"display-message\" \"-p\" \"-t\" \"=remcli-owned:1234568\"`),
                'display-message -p __remcli_ownership_mismatch__',
            ],
            expect.objectContaining({ shell: false }),
        );
        createChild.emit('error', new Error('tmux client response lost'));

        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2));
        recoveryChild.stdout.emit('data', Buffer.from(`remcli-owned\t@44\t%11\t1236\t${childMarker}\n`));
        recoveryChild.emit('close', 0, null);

        await expect(spawned).resolves.toEqual({
            success: true,
            sessionId: 'remcli-owned:child',
            ownership: {
                sessionName: 'remcli-owned',
                windowId: '@44',
                paneId: '%11',
                panePid: 1236,
                ownerMarker: childMarker,
            },
        });
        expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);
    });

    it('does not recover when the strict session-marker query finds zero panes', async () => {
        const lookupChild = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const recovered = utilities.findOwnedPaneBySessionAndMarker('remcli-owned', ownerMarker);

        lookupChild.emit('close', 0, null);

        await expect(recovered).resolves.toBeNull();
    });

    it('does not recover when the strict session-marker query finds multiple panes', async () => {
        const lookupChild = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const recovered = utilities.findOwnedPaneBySessionAndMarker('remcli-owned', ownerMarker);

        lookupChild.stdout.emit('data', Buffer.from(
            `remcli-owned\t@43\t%10\t1235\t${ownerMarker}\nremcli-owned\t@44\t%11\t1236\t${ownerMarker}\n`,
        ));
        lookupChild.emit('close', 0, null);

        await expect(recovered).resolves.toBeNull();
    });

    it('does not recover a same-session pane with a foreign marker', async () => {
        const lookupChild = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const recovered = utilities.findOwnedPaneBySessionAndMarker('remcli-owned', ownerMarker);
        const foreignMarker = '22222222-2222-4222-8222-222222222222';

        lookupChild.stdout.emit('data', Buffer.from(`remcli-owned\t@43\t%10\t1235\t${foreignMarker}\n`));
        lookupChild.emit('close', 0, null);

        await expect(recovered).resolves.toBeNull();
    });

    it('does not issue a second kill command when the server-side ownership guard rejects a reused pane', async () => {
        const guardChild = mockTmuxChild();
        const lookupChild = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const release = utilities.releaseOwnedPane({
            sessionName: 'remcli-owned',
            windowId: '@43',
            paneId: '%10',
            panePid: 1235,
            ownerMarker,
        });

        guardChild.stdout.emit('data', Buffer.from('__remcli_ownership_mismatch__\n'));
        guardChild.emit('close', 0, null);

        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2));
        lookupChild.stdout.emit('data', Buffer.from('other-session\t@44\t%10\t9999\t22222222-2222-4222-8222-222222222222\n'));
        lookupChild.emit('close', 0, null);

        await expect(release).resolves.toBe('mismatch');
        expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2);
        expect(childProcessMocks.spawn).not.toHaveBeenCalledWith(
            'tmux',
            ['kill-pane', '-t', '%10'],
            expect.anything(),
        );
    });

    it('bounds a timed-out tmux session cleanup without a shell', async () => {
        vi.useFakeTimers();
        const child = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const result = utilities.killSession('remcli-session');

        expect(childProcessMocks.spawn).toHaveBeenCalledWith(
            'tmux',
            ['kill-session', '-t', 'remcli-session'],
            expect.objectContaining({ shell: false })
        );

        await vi.advanceTimersByTimeAsync(5_000);

        await expect(result).resolves.toBe(false);
        expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
});

describe('TmuxUtilities owned pane I/O', () => {
    const ownership = {
        sessionName: 'remcli-owned',
        windowId: '@43',
        paneId: '%10',
        panePid: 1235,
        ownerMarker: '11111111-1111-4111-8111-111111111111',
    };

    it('sends hostile text literally only through an atomically verified owned pane', async () => {
        const child = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const hostileInput = '--literal "; display-message -p pwned; $(echo nope) #{pane_id}\nnext';
        const sent = utilities.sendLiteralTextToOwnedPane(ownership, hostileInput);
        const command = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
        const outcomeMarker = readOwnedPaneOutcomeMarker(command);
        const condition = command[4] ?? '';
        const successCommand = command[5] ?? '';

        expect(command.slice(0, 4)).toEqual(['if-shell', '-t', '%10', '-F']);
        expect(condition).toContain(`#{==:#{@remcli_owner},${ownership.ownerMarker}}`);
        expect(condition).toContain(`#{==:#{session_name},${ownership.sessionName}}`);
        expect(condition).toContain(`#{==:#{window_id},${ownership.windowId}}`);
        expect(condition).toContain(`#{==:#{pane_id},${ownership.paneId}}`);
        expect(condition).toContain(`#{==:#{pane_pid},${ownership.panePid}}`);
        expect(successCommand).toBe(
            `send-keys -l -t %10 -- "--literal \\"; display-message -p pwned; $(echo nope) #{pane_id}\nnext" ; display-message -p ${outcomeMarker}`,
        );

        child.stdout.emit('data', Buffer.from(`${outcomeMarker}\n`));
        child.emit('close', 0, null);

        await expect(sent).resolves.toBe('applied');
    });

    it('captures a bounded owned-pane snapshot and strips only its private outcome marker', async () => {
        const child = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const capture = utilities.captureOwnedPane(ownership);
        const command = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
        const outcomeMarker = readOwnedPaneOutcomeMarker(command);

        expect(command[5]).toBe(
            `capture-pane -p -S -200 -t %10 ; display-message -p ${outcomeMarker}`,
        );
        child.stdout.emit('data', Buffer.from(`first line\nsecond line\n${outcomeMarker}\n`));
        child.emit('close', 0, null);

        await expect(capture).resolves.toEqual({
            status: 'captured',
            output: 'first line\nsecond line\n',
            truncated: false,
        });
    });

    it('keeps only the newest bounded capture payload', async () => {
        const child = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const capture = utilities.captureOwnedPane(ownership);
        const command = childProcessMocks.spawn.mock.calls[0]?.[1] as string[];
        const outcomeMarker = readOwnedPaneOutcomeMarker(command);
        const output = 'x'.repeat(33_000);

        child.stdout.emit('data', Buffer.from(`${output}${outcomeMarker}\n`));
        child.emit('close', 0, null);

        await expect(capture).resolves.toEqual({
            status: 'captured',
            output: 'x'.repeat(32_768),
            truncated: true,
        });
    });

    it('fails closed when the atomic guard rejects a foreign pane', async () => {
        const guardChild = mockTmuxChild();
        const lookupChild = mockTmuxChild();
        const utilities = new TmuxUtilities();
        const sent = utilities.sendLiteralTextToOwnedPane(ownership, 'safe text');

        guardChild.stdout.emit('data', Buffer.from('__remcli_ownership_mismatch__\n'));
        guardChild.emit('close', 0, null);
        await vi.waitFor(() => expect(childProcessMocks.spawn).toHaveBeenCalledTimes(2));
        lookupChild.stdout.emit('data', Buffer.from(
            'foreign-session\t@44\t%10\t9999\t22222222-2222-4222-8222-222222222222\n',
        ));
        lookupChild.emit('close', 0, null);

        await expect(sent).resolves.toBe('mismatch');
    });

    it('does not execute owned-pane I/O for invalid ownership or empty input', async () => {
        const utilities = new TmuxUtilities();

        await expect(utilities.sendLiteralTextToOwnedPane({ ...ownership, paneId: 'not-a-pane' }, 'text'))
            .resolves.toBe('unknown');
        await expect(utilities.sendLiteralTextToOwnedPane(ownership, '')).resolves.toBe('unknown');
        await expect(utilities.captureOwnedPane({ ...ownership, ownerMarker: 'invalid' }))
            .resolves.toEqual({ status: 'unknown' });
        expect(childProcessMocks.spawn).not.toHaveBeenCalled();
    });
});

describe('parseTmuxSessionIdentifier', () => {
    it('should parse session-only identifier', () => {
        const result = parseTmuxSessionIdentifier('my-session');
        expect(result).toEqual({
            session: 'my-session'
        });
    });

    it('should parse session:window identifier', () => {
        const result = parseTmuxSessionIdentifier('my-session:window-1');
        expect(result).toEqual({
            session: 'my-session',
            window: 'window-1'
        });
    });

    it('should parse session:window.pane identifier', () => {
        const result = parseTmuxSessionIdentifier('my-session:window-1.2');
        expect(result).toEqual({
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        });
    });

    it('should handle session names with dots, hyphens, and underscores', () => {
        const result = parseTmuxSessionIdentifier('my.test_session-1');
        expect(result).toEqual({
            session: 'my.test_session-1'
        });
    });

    it('should handle window names with hyphens and underscores', () => {
        const result = parseTmuxSessionIdentifier('session:my_test-window-1');
        expect(result).toEqual({
            session: 'session',
            window: 'my_test-window-1'
        });
    });

    it('should throw on empty string', () => {
        expect(() => parseTmuxSessionIdentifier('')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('')).toThrow('Session identifier must be a non-empty string');
    });

    it('should throw on null/undefined', () => {
        expect(() => parseTmuxSessionIdentifier(null as any)).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier(undefined as any)).toThrow(TmuxSessionIdentifierError);
    });

    it('should throw on invalid session name characters', () => {
        expect(() => parseTmuxSessionIdentifier('invalid session')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('invalid session')).toThrow('Only alphanumeric characters, dots, hyphens, and underscores are allowed');
    });

    it('should throw on special characters in session name', () => {
        expect(() => parseTmuxSessionIdentifier('session@name')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session#name')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session$name')).toThrow(TmuxSessionIdentifierError);
    });

    it('should throw on invalid window name characters', () => {
        expect(() => parseTmuxSessionIdentifier('session:invalid window')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session:invalid window')).toThrow('Only alphanumeric characters, dots, hyphens, and underscores are allowed');
    });

    it('should throw on non-numeric pane identifier', () => {
        expect(() => parseTmuxSessionIdentifier('session:window.abc')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session:window.abc')).toThrow('Only numeric values are allowed');
    });

    it('should throw on pane identifier with special characters', () => {
        expect(() => parseTmuxSessionIdentifier('session:window.1a')).toThrow(TmuxSessionIdentifierError);
        expect(() => parseTmuxSessionIdentifier('session:window.-1')).toThrow(TmuxSessionIdentifierError);
    });

    it('should trim whitespace from components', () => {
        const result = parseTmuxSessionIdentifier('session : window . 2');
        expect(result).toEqual({
            session: 'session',
            window: 'window',
            pane: '2'
        });
    });
});

describe('formatTmuxSessionIdentifier', () => {
    it('should format session-only identifier', () => {
        const identifier: TmuxSessionIdentifier = { session: 'my-session' };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session');
    });

    it('should format session:window identifier', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my-session',
            window: 'window-1'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session:window-1');
    });

    it('should format session:window.pane identifier', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session:window-1.2');
    });

    it('should ignore pane when window is not provided', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my-session',
            pane: '2'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my-session');
    });

    it('should throw when session is missing', () => {
        const identifier: TmuxSessionIdentifier = { session: '' };
        expect(() => formatTmuxSessionIdentifier(identifier)).toThrow(TmuxSessionIdentifierError);
        expect(() => formatTmuxSessionIdentifier(identifier)).toThrow('Session identifier must have a session name');
    });

    it('should handle complex valid names', () => {
        const identifier: TmuxSessionIdentifier = {
            session: 'my.test_session-1',
            window: 'my_test-window-2',
            pane: '3'
        };
        expect(formatTmuxSessionIdentifier(identifier)).toBe('my.test_session-1:my_test-window-2.3');
    });
});

describe('validateTmuxSessionIdentifier', () => {
    it('should return valid:true for valid session-only identifier', () => {
        const result = validateTmuxSessionIdentifier('my-session');
        expect(result).toEqual({ valid: true });
    });

    it('should return valid:true for valid session:window identifier', () => {
        const result = validateTmuxSessionIdentifier('my-session:window-1');
        expect(result).toEqual({ valid: true });
    });

    it('should return valid:true for valid session:window.pane identifier', () => {
        const result = validateTmuxSessionIdentifier('my-session:window-1.2');
        expect(result).toEqual({ valid: true });
    });

    it('should return valid:false for empty string', () => {
        const result = validateTmuxSessionIdentifier('');
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
    });

    it('should return valid:false for invalid session characters', () => {
        const result = validateTmuxSessionIdentifier('invalid session');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Only alphanumeric characters');
    });

    it('should return valid:false for invalid window characters', () => {
        const result = validateTmuxSessionIdentifier('session:invalid window');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Only alphanumeric characters');
    });

    it('should return valid:false for invalid pane identifier', () => {
        const result = validateTmuxSessionIdentifier('session:window.abc');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Only numeric values are allowed');
    });

    it('should handle complex valid identifiers', () => {
        const result = validateTmuxSessionIdentifier('my.test_session-1:my_test-window-2.3');
        expect(result).toEqual({ valid: true });
    });

    it('should not throw exceptions', () => {
        expect(() => validateTmuxSessionIdentifier('')).not.toThrow();
        expect(() => validateTmuxSessionIdentifier('invalid session')).not.toThrow();
        expect(() => validateTmuxSessionIdentifier(null as any)).not.toThrow();
    });
});

describe('buildTmuxSessionIdentifier', () => {
    it('should build session-only identifier', () => {
        const result = buildTmuxSessionIdentifier({ session: 'my-session' });
        expect(result).toEqual({
            success: true,
            identifier: 'my-session'
        });
    });

    it('should build session:window identifier', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'my-session',
            window: 'window-1'
        });
        expect(result).toEqual({
            success: true,
            identifier: 'my-session:window-1'
        });
    });

    it('should build session:window.pane identifier', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        });
        expect(result).toEqual({
            success: true,
            identifier: 'my-session:window-1.2'
        });
    });

    it('should return error for empty session name', () => {
        const result = buildTmuxSessionIdentifier({ session: '' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid session name');
    });

    it('should return error for invalid session characters', () => {
        const result = buildTmuxSessionIdentifier({ session: 'invalid session' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid session name');
    });

    it('should return error for invalid window characters', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'session',
            window: 'invalid window'
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid window name');
    });

    it('should return error for invalid pane identifier', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'session',
            window: 'window',
            pane: 'abc'
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('Invalid pane identifier');
    });

    it('should handle complex valid inputs', () => {
        const result = buildTmuxSessionIdentifier({
            session: 'my.test_session-1',
            window: 'my_test-window-2',
            pane: '3'
        });
        expect(result).toEqual({
            success: true,
            identifier: 'my.test_session-1:my_test-window-2.3'
        });
    });

    it('should not throw exceptions for invalid inputs', () => {
        expect(() => buildTmuxSessionIdentifier({ session: '' })).not.toThrow();
        expect(() => buildTmuxSessionIdentifier({ session: 'invalid session' })).not.toThrow();
        expect(() => buildTmuxSessionIdentifier({ session: null as any })).not.toThrow();
    });
});

describe('TmuxUtilities.detectTmuxEnvironment', () => {
    const originalTmuxEnv = process.env.TMUX;

    // Helper to set and restore environment
    const withTmuxEnv = (value: string | undefined, fn: () => void) => {
        process.env.TMUX = value;
        try {
            fn();
        } finally {
            if (originalTmuxEnv !== undefined) {
                process.env.TMUX = originalTmuxEnv;
            } else {
                delete process.env.TMUX;
            }
        }
    };

    it('should return null when TMUX env is not set', () => {
        withTmuxEnv(undefined, () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toBeNull();
        });
    });

    it('should parse valid TMUX environment variable', () => {
        withTmuxEnv('/tmp/tmux-1000/default,4219,0', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: '4219',
                window: '0',
                pane: '0',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });

    it('should parse TMUX env with session.window format', () => {
        withTmuxEnv('/tmp/tmux-1000/default,mysession.mywindow,2', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: 'mysession',
                window: 'mywindow',
                pane: '2',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });

    it('should handle TMUX env without session.window format', () => {
        withTmuxEnv('/tmp/tmux-1000/default,session123,1', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: 'session123',
                window: '0',
                pane: '1',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });

    it('should handle complex socket paths correctly', () => {
        // CRITICAL: Test that path parsing works with the fixed array indexing
        withTmuxEnv('/tmp/tmux-1000/my-socket,5678,3', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: '5678',
                window: '0',
                pane: '3',
                socket_path: '/tmp/tmux-1000/my-socket'
            });
        });
    });

    it('should handle socket path with multiple slashes', () => {
        // Test the array indexing fix - ensure we get the last component correctly
        withTmuxEnv('/var/run/tmux/1000/default,session.window,0', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toEqual({
                session: 'session',
                window: 'window',
                pane: '0',
                socket_path: '/var/run/tmux/1000/default'
            });
        });
    });

    it('should return null for malformed TMUX env (too few parts)', () => {
        withTmuxEnv('/tmp/tmux-1000/default,4219', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toBeNull();
        });
    });

    it('should return null for malformed TMUX env (empty string)', () => {
        withTmuxEnv('', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            expect(result).toBeNull();
        });
    });

    it('should handle TMUX env with extra parts (more than 3 comma-separated values)', () => {
        withTmuxEnv('/tmp/tmux-1000/default,4219,0,extra', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            // Should still parse the first 3 parts correctly
            expect(result).toEqual({
                session: '4219',
                window: '0',
                pane: '0',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });

    it('should handle edge case with dots in session identifier', () => {
        withTmuxEnv('/tmp/tmux-1000/default,my.session.name.5,2', () => {
            const utils = new TmuxUtilities();
            const result = utils.detectTmuxEnvironment();
            // Split on dot, so my.session becomes session=my, window=session
            expect(result).toEqual({
                session: 'my',
                window: 'session',
                pane: '2',
                socket_path: '/tmp/tmux-1000/default'
            });
        });
    });
});

describe('Round-trip consistency', () => {
    it('should parse and format consistently for session-only', () => {
        const original = 'my-session';
        const parsed = parseTmuxSessionIdentifier(original);
        const formatted = formatTmuxSessionIdentifier(parsed);
        expect(formatted).toBe(original);
    });

    it('should parse and format consistently for session:window', () => {
        const original = 'my-session:window-1';
        const parsed = parseTmuxSessionIdentifier(original);
        const formatted = formatTmuxSessionIdentifier(parsed);
        expect(formatted).toBe(original);
    });

    it('should parse and format consistently for session:window.pane', () => {
        const original = 'my-session:window-1.2';
        const parsed = parseTmuxSessionIdentifier(original);
        const formatted = formatTmuxSessionIdentifier(parsed);
        expect(formatted).toBe(original);
    });

    it('should build and parse consistently', () => {
        const params = {
            session: 'my-session',
            window: 'window-1',
            pane: '2'
        };
        const built = buildTmuxSessionIdentifier(params);
        expect(built.success).toBe(true);
        const parsed = parseTmuxSessionIdentifier(built.identifier!);
        expect(parsed).toEqual(params);
    });
});
