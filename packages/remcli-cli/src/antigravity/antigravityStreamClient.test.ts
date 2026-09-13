import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { AntigravityStreamClient, buildAntigravityStreamArgs, type AntigravityChild, type AntigravitySpawn } from './antigravityStreamClient';

class BackpressureInput extends PassThrough {
    override write(
        _chunk: unknown,
        encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
        callback?: (error?: Error | null) => void,
    ): boolean {
        const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
        queueMicrotask(() => {
            done?.();
            this.emit('drain');
        });
        return false;
    }
}

function fakeChild(options: { pid?: number; closeOnKill?: boolean; backpressure?: boolean } = {}) {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = options.backpressure ? new BackpressureInput() : new PassThrough();
    const childEmitter = new EventEmitter();
    const child = {
        stdin, stdout, stderr, pid: options.pid, exitCode: null, signalCode: null,
        kill: vi.fn((signal: NodeJS.Signals) => {
            child.signalCode = signal;
            childEmitter.emit('exit', null, signal);
            if (options.closeOnKill !== false) childEmitter.emit('close', null, signal);
            return true;
        }),
        on: childEmitter.on.bind(childEmitter),
        once: childEmitter.once.bind(childEmitter),
        removeListener: childEmitter.removeListener.bind(childEmitter),
        emit: childEmitter.emit.bind(childEmitter),
    } as unknown as AntigravityChild & { emit: typeof stdout.emit };
    return { child, stdout, stderr, input: child.stdin as PassThrough };
}

function setup(options: { pid?: number; closeOnKill?: boolean; backpressure?: boolean } = {}) {
    const fake = fakeChild(options);
    const spawn = vi.fn((...args: Parameters<AntigravitySpawn>) => { void args; return fake.child; });
    const client = new AntigravityStreamClient({ cwd: '/workspace', conversationId: 'conv-1', spawn, shutdownTimeoutMs: 1 });
    fake.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'conv-1', init: {} }) + '\n');
    return { fake, spawn, client };
}

function emit(fake: ReturnType<typeof fakeChild>, value: unknown) { fake.stdout.write(typeof value === 'string' ? value : JSON.stringify(value) + '\n'); }

describe('AntigravityStreamClient', () => {
    it('spawns the exact stream-json command and resumes only the requested conversation', async () => {
        const h = setup();
        await expect(h.client.start()).resolves.toBe('conv-1');
        expect(h.spawn).toHaveBeenCalledWith('agy', ['--input-format', 'stream-json', '--output-format', 'stream-json', '--conversation', 'conv-1'], expect.objectContaining({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] }));
        expect(h.spawn.mock.calls[0]?.[1]).not.toContain('--continue');
    });

    it('uses native mode controls and rejects empty or NUL-delimited options', () => {
        expect(() => buildAntigravityStreamArgs({ cwd: '/workspace', mode: 'invalid' as never })).toThrow();
        expect(() => buildAntigravityStreamArgs({ cwd: '/workspace', mode: 'plan', model: '\u0000' })).toThrow();
        expect(() => buildAntigravityStreamArgs({ cwd: '/workspace', effort: '' as never })).toThrow();
        expect(() => buildAntigravityStreamArgs({ cwd: '/workspace', conversationId: ' ' })).toThrow();
        expect(buildAntigravityStreamArgs({ cwd: '/workspace', mode: 'accept-edits', sandbox: true, dangerouslySkipPermissions: true })).toContain('--sandbox');
    });

    it.each([
        ['malformed JSON', '{not-json}\n'],
        ['missing init', JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 0, state: 'DONE', step_type: 'agent_response' } }) + '\n'],
        ['foreign ID', JSON.stringify({ event: 'init', conversation_id: 'foreign', init: {} }) + '\n'],
    ])('rejects %s', async (_name, line) => {
        const fake = fakeChild();
        const client = new AntigravityStreamClient({ cwd: '/workspace', conversationId: 'conv-1', spawn: vi.fn(() => fake.child), shutdownTimeoutMs: 1 });
        const started = client.start();
        fake.stdout.write(line);
        await expect(started).rejects.toBeInstanceOf(Error);
        await client.dispose();
    });

    it('awaits failed-start cleanup and surfaces an unconfirmed process close', async () => {
        const fake = fakeChild({ closeOnKill: false });
        const client = new AntigravityStreamClient({
            cwd: '/workspace',
            spawn: vi.fn(() => fake.child),
            shutdownTimeoutMs: 1,
        });
        const started = client.start();
        fake.stdout.write('{malformed}\n');

        await expect(started).rejects.toThrow('did not exit after SIGKILL');
        expect(fake.child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
        expect(fake.child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
        expect(fake.stderr.listenerCount('data')).toBe(0);
    });

    it('keeps failed start pending until process close is confirmed', async () => {
        const fake = fakeChild({ closeOnKill: false });
        const client = new AntigravityStreamClient({
            cwd: '/workspace',
            spawn: vi.fn(() => fake.child),
            shutdownTimeoutMs: 10_000,
        });
        const started = client.start();
        let settled = false;
        const observed = started.catch((error: unknown) => {
            settled = true;
            throw error;
        });
        fake.stdout.write('{malformed}\n');

        await Promise.resolve();
        await Promise.resolve();
        expect(settled).toBe(false);
        fake.child.emit('close', 0, null);
        await expect(observed).rejects.toThrow('malformed NDJSON');
    });

    it('validates an exact resume ID before publishing init', async () => {
        const fake = fakeChild();
        const onEvent = vi.fn();
        const client = new AntigravityStreamClient({ cwd: '/workspace', conversationId: 'expected', spawn: vi.fn(() => fake.child), onEvent, shutdownTimeoutMs: 1 });
        const started = client.start();
        emit(fake, { event: 'init', conversation_id: 'foreign', init: {} });
        await expect(started).rejects.toThrow('does not match');
        expect(onEvent).not.toHaveBeenCalled();
        expect(client.conversationId).toBeNull();
        await client.dispose();
    });

    it('rejects duplicate init, result errors, and foreign step events', async () => {
        const h = setup();
        await h.client.start();
        emit(h.fake, { event: 'init', conversation_id: 'conv-1', init: {} });
        const prompt = h.client.prompt('secret prompt');
        emit(h.fake, { event: 'step_update', step_update: { conversation_id: 'foreign', step_index: 0, state: 'DONE', step_type: 'tool', tool_name: 'run_command' } });
        await expect(prompt).rejects.toThrow();
        const unused = new AntigravityStreamClient({ cwd: '/workspace', spawn: vi.fn(() => h.fake.child) });
        expect(unused).toBeDefined();
    });

    it('skips unknown future events with bounded diagnostics', async () => {
        const h = setup();
        await h.client.start();
        emit(h.fake, { event: 'future_event', payload: 'x'.repeat(100_000) });
        expect(h.client.sessionId).toBe('conv-1');
        const turn = h.client.sendTurn('after future event');
        await Promise.resolve();
        emit(h.fake, { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'ok' } });
        await expect(turn).resolves.toMatchObject({ status: 'SUCCESS' });
    });

    it('records child error and idle exit as fatal and cleans up a malformed stream', async () => {
        const h = fakeChild();
        const client = new AntigravityStreamClient({ cwd: '/workspace', spawn: vi.fn(() => h.child), shutdownTimeoutMs: 1 });
        const started = client.start();
        h.stdout.write('{bad}\n');
        await expect(started).rejects.toThrow();
        await client.dispose();
        expect(h.child.kill).toHaveBeenCalled();

        const idle = fakeChild();
        const idleClient = new AntigravityStreamClient({ cwd: '/workspace', spawn: vi.fn(() => idle.child), shutdownTimeoutMs: 1 });
        const idleStart = idleClient.start();
        idle.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'idle-conv', init: {} }) + '\n');
        await expect(idleStart).resolves.toBe('idle-conv');
        idle.child.emit('exit', 0, null);
        await expect(idleClient.sendTurn('after idle exit')).rejects.toThrow('unexpectedly');
        await idleClient.dispose();

        const errored = fakeChild();
        const erroredClient = new AntigravityStreamClient({ cwd: '/workspace', spawn: vi.fn(() => errored.child), shutdownTimeoutMs: 1 });
        const erroredStart = erroredClient.start();
        errored.child.emit('error', new Error('provider failed'));
        await expect(erroredStart).rejects.toThrow();
        await erroredClient.dispose();
    });

    it('settles pending start and an active turn immediately when stopped', async () => {
        const pending = fakeChild();
        const pendingClient = new AntigravityStreamClient({ cwd: '/workspace', spawn: vi.fn(() => pending.child), initTimeoutMs: 50, shutdownTimeoutMs: 1 });
        const start = pendingClient.start();
        const stopped = pendingClient.stop();
        await expect(start).rejects.toMatchObject({ status: 'CANCELED' });
        await stopped;

        const active = setup();
        await active.client.start();
        const turn = active.client.sendTurn('active');
        await Promise.resolve();
        const activeStopped = active.client.stop();
        await expect(turn).rejects.toMatchObject({ status: 'CANCELED' });
        await activeStopped;
    });

    it('settles a zero-yield sendTurn and stop race', async () => {
        const h = setup();
        await h.client.start();

        const turn = h.client.sendTurn('raced');
        const stopping = h.client.stop();

        await expect(turn).rejects.toMatchObject({ status: 'CANCELED' });
        await stopping;
    });

    it('rejects unserializable or invalid prompt payloads without poisoning the next turn', async () => {
        const h = setup();
        await h.client.start();
        const cyclic: unknown[] = [];
        cyclic.push(cyclic);

        await expect(h.client.sendTurn(cyclic as never)).rejects.toThrow('Prompt content is invalid');
        await expect(h.client.sendTurn(1n as never)).rejects.toThrow('Prompt content is invalid');
        await expect(h.client.sendTurn([{ type: 'image', text: 'invalid' }] as never)).rejects.toThrow('Prompt content is invalid');

        const valid = h.client.sendTurn([{ type: 'text', text: 'valid' }]);
        await Promise.resolve();
        emit(h.fake, { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'ok' } });
        await expect(valid).resolves.toMatchObject({ status: 'SUCCESS', response: 'ok' });
    });

    it('allows stdout to drain a result between exit and close', async () => {
        const h = setup({ closeOnKill: false });
        await h.client.start();
        const turn = h.client.sendTurn('drain after exit');
        await Promise.resolve();
        let settled = false;
        void turn.then(() => { settled = true; }, () => { settled = true; });

        h.fake.child.exitCode = 0;
        h.fake.child.emit('exit', 0, null);
        await Promise.resolve();
        expect(settled).toBe(false);
        emit(h.fake, { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'drained' } });
        await expect(turn).resolves.toMatchObject({ response: 'drained' });
        h.fake.child.emit('close', 0, null);
    });

    it('starts confirmed cleanup when exit is not followed by close', async () => {
        const h = setup();
        await h.client.start();
        const turn = h.client.sendTurn('missing close');
        await Promise.resolve();

        h.fake.child.exitCode = 0;
        h.fake.child.emit('exit', 0, null);

        await expect(turn).rejects.toThrow('before the turn completed');
        expect(h.fake.child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('isolates synchronous and asynchronous callback failures', async () => {
        const fake = fakeChild();
        const onEvent = vi.fn((event: unknown) => {
            if ((event as { event?: unknown }).event === 'init') throw new Error('sync callback failure');
            return Promise.reject(new Error('async callback failure'));
        });
        const onStderr = vi.fn(() => Promise.reject(new Error('stderr callback failure')));
        const client = new AntigravityStreamClient({ cwd: '/workspace', spawn: vi.fn(() => fake.child), onEvent, onStderr, shutdownTimeoutMs: 1 });
        const started = client.start();
        emit(fake, { event: 'init', conversation_id: 'callback-conv', init: {} });
        await expect(started).resolves.toBe('callback-conv');
        const turn = client.sendTurn('callback test');
        await Promise.resolve();
        emit(fake, { event: 'step_update', step_update: { conversation_id: 'callback-conv', step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'ok' } });
        emit(fake, { event: 'result', result: { conversation_id: 'callback-conv', status: 'SUCCESS', response: 'ok' } });
        await expect(turn).resolves.toMatchObject({ status: 'SUCCESS' });
        fake.stderr.write('safe diagnostic');
        await client.stop();
        await Promise.resolve();
        expect(onEvent).toHaveBeenCalledTimes(3);
        expect(onStderr).toHaveBeenCalledTimes(1);
    });

    it('settles a result before a re-entrant callback cancels the client', async () => {
        const h = setup();
        let cancelPromise: Promise<void> | null = null;
        const client = new AntigravityStreamClient({
            cwd: '/workspace',
            conversationId: 'conv-1',
            spawn: h.spawn,
            onEvent: (event) => {
                if (event.event === 'result') cancelPromise = client.cancel();
            },
            shutdownTimeoutMs: 1,
        });
        await client.start();

        const turn = client.sendTurn('complete before callback');
        await Promise.resolve();
        emit(h.fake, { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'done' } });

        await expect(turn).resolves.toMatchObject({ status: 'SUCCESS', response: 'done' });
        expect(cancelPromise).not.toBeNull();
        await cancelPromise;
    });

    it('enforces the NDJSON limit in bytes for multibyte content', async () => {
        const h = setup();
        await h.client.start();
        const turn = h.client.sendTurn('multibyte');
        await Promise.resolve();
        emit(h.fake, { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: '😀'.repeat(70_000) } });
        await expect(turn).rejects.toThrow('byte bound');
        await h.client.dispose();
    });

    it('honors stdin backpressure and detaches stream listeners on stop', async () => {
        const events: unknown[] = [];
        const diagnostics: string[] = [];
        const h = setup({ backpressure: true });
        const client = new AntigravityStreamClient({
            cwd: '/workspace',
            conversationId: 'conv-1',
            spawn: h.spawn,
            onEvent: (event) => events.push(event),
            onStderr: (value) => diagnostics.push(value),
            shutdownTimeoutMs: 1,
        });
        await client.start();
        const turn = client.sendTurn('backpressure');
        await Promise.resolve();
        await Promise.resolve();
        expect(h.fake.input.listenerCount('drain')).toBe(0);
        const stopping = client.stop();
        await expect(turn).rejects.toMatchObject({ status: 'CANCELED' });
        await stopping;
        await expect(client.sendTurn('after stop')).rejects.toMatchObject({ status: 'CANCELED' });
        emit(h.fake, { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'late' } });
        h.fake.stderr.write('authorization: Bearer late-secret');
        expect(events).toHaveLength(1);
        expect(diagnostics).toHaveLength(0);
    });

    it('delivers agent response and tool events, then serializes prompts', async () => {
        const events: unknown[] = [];
        const h = setup();
        const client = new AntigravityStreamClient({ cwd: '/workspace', conversationId: 'conv-1', spawn: h.spawn, onEvent: (event) => events.push(event), shutdownTimeoutMs: 1 });
        await client.start();
        const first = client.prompt('first');
        await expect(client.prompt('second')).rejects.toThrow('already active');
        emit(h.fake, { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'ok' } });
        emit(h.fake, { event: 'step_update', step_update: { conversation_id: 'conv-1', step_index: 2, state: 'DONE', step_type: 'tool', tool_name: 'run_command' } });
        emit(h.fake, { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'ok' } });
        await expect(first).resolves.toMatchObject({ status: 'SUCCESS', response: 'ok' });
        expect(events).toHaveLength(4);
        const second = client.prompt('second');
        await Promise.resolve();
        emit(h.fake, { event: 'result', result: { conversation_id: 'conv-1', status: 'ERROR', response: '', error: 'provider error' } });
        await expect(second).resolves.toMatchObject({ status: 'ERROR', error: 'provider error' });
    });

    it('byte-bounds stderr and redacts secrets split across chunks', async () => {
        const h = setup();
        const diagnostics: string[] = [];
        const client = new AntigravityStreamClient({ cwd: '/workspace', spawn: h.spawn, onStderr: (value) => diagnostics.push(value), shutdownTimeoutMs: 1 });
        await client.start();
        h.fake.stderr.write('authorization: Bea');
        h.fake.stderr.write(`rer secret-token ${'x'.repeat(100_000)}`);
        expect(diagnostics).toHaveLength(0);
        await client.stop();
        expect(diagnostics.join()).not.toContain('secret-token');
        expect(Buffer.byteLength(diagnostics.join(), 'utf8')).toBeLessThanOrEqual(2_000);
    });

    it('drains redacted stderr for every result and flushes late diagnostics on close', async () => {
        const h = setup();
        const diagnostics: string[] = [];
        const client = new AntigravityStreamClient({
            cwd: '/workspace',
            conversationId: 'conv-1',
            spawn: h.spawn,
            onStderr: (value) => diagnostics.push(value),
            shutdownTimeoutMs: 1,
        });
        await client.start();

        const first = client.sendTurn('first');
        await Promise.resolve();
        h.fake.stderr.write('authorization: Bea');
        h.fake.stderr.write('rer first-turn-secret\n');
        emit(h.fake, { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'first' } });
        await expect(first).resolves.toMatchObject({ response: 'first' });
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]).not.toContain('first-turn-secret');

        const second = client.sendTurn('second');
        await Promise.resolve();
        h.fake.stderr.write('x-api-');
        h.fake.stderr.write('key: second-turn-secret\n');
        emit(h.fake, { event: 'result', result: { conversation_id: 'conv-1', status: 'ERROR', response: '', error: 'denied' } });
        await expect(second).resolves.toMatchObject({ status: 'ERROR', error: 'denied' });
        expect(diagnostics).toHaveLength(2);
        expect(diagnostics[1]).not.toContain('second-turn-secret');

        h.fake.stderr.write('late safe diagnostic');
        h.fake.child.emit('close', 0, null);
        expect(diagnostics).toHaveLength(3);
        expect(diagnostics[2]).toContain('late safe diagnostic');
        expect(h.fake.stderr.listenerCount('data')).toBe(0);
    });

    it('preserves redaction context when a bearer secret is split across results', async () => {
        const h = setup();
        const diagnostics: string[] = [];
        const client = new AntigravityStreamClient({
            cwd: '/workspace',
            conversationId: 'conv-1',
            spawn: h.spawn,
            onStderr: (value) => diagnostics.push(value),
            shutdownTimeoutMs: 1,
        });
        await client.start();

        const first = client.sendTurn('first');
        await Promise.resolve();
        h.fake.stderr.write('authorization: Bea');
        emit(h.fake, { event: 'result', result: { conversation_id: 'conv-1', status: 'SUCCESS', response: 'first' } });
        await first;
        expect(diagnostics).toHaveLength(0);

        const second = client.sendTurn('second');
        await Promise.resolve();
        h.fake.stderr.write('rer cross-result-secret\nvisible diagnostic');
        emit(h.fake, { event: 'result', result: { conversation_id: 'conv-1', status: 'ERROR', response: '', error: 'denied' } });
        await second;

        expect(diagnostics).toHaveLength(1);
        expect(diagnostics.join('\n')).not.toContain('cross-result-secret');
        await client.stop();
        expect(diagnostics).toHaveLength(2);
        expect(diagnostics[1]).toContain('visible diagnostic');
        expect(diagnostics.every((value) => Buffer.byteLength(value, 'utf8') <= 2_000)).toBe(true);
    });

    it('does not let an overlong stderr line hide later diagnostics', async () => {
        const h = setup();
        const diagnostics: string[] = [];
        const client = new AntigravityStreamClient({
            cwd: '/workspace',
            conversationId: 'conv-1',
            spawn: h.spawn,
            onStderr: (value) => diagnostics.push(value),
            shutdownTimeoutMs: 1,
        });
        await client.start();

        h.fake.stderr.write(`authorization: Bearer hidden-secret ${'x'.repeat(100_000)}\r\n`);
        h.fake.stderr.write('late diagnostic remains visible\n');
        await client.stop();

        expect(diagnostics.join('\n')).not.toContain('hidden-secret');
        expect(diagnostics).toContain('late diagnostic remains visible');
        expect(diagnostics.every((value) => Buffer.byteLength(value, 'utf8') <= 2_000)).toBe(true);
    });

    it('retains the newest stderr diagnostics when the bounded queue saturates', async () => {
        const h = setup();
        const diagnostics: string[] = [];
        const client = new AntigravityStreamClient({
            cwd: '/workspace',
            conversationId: 'conv-1',
            spawn: h.spawn,
            onStderr: (value) => diagnostics.push(value),
            shutdownTimeoutMs: 1,
        });
        await client.start();

        for (let index = 0; index < 20; index += 1) {
            h.fake.stderr.write(`noise-${String(index).padStart(2, '0')} ${'x'.repeat(3_000)}\n`);
        }
        h.fake.stderr.write('late failure reason\n');
        await client.stop();

        expect(diagnostics.join('\n')).toContain('late failure reason');
        expect(diagnostics.join('\n')).not.toContain('noise-00');
        expect(diagnostics.every((value) => Buffer.byteLength(value, 'utf8') <= 2_000)).toBe(true);
    });

    it('closes stdin and falls back from SIGTERM to SIGKILL', async () => {
        const h = setup({ pid: 1234, closeOnKill: false });
        await h.client.start();
        const processKill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
            if (signal === 'SIGKILL') {
                h.fake.child.signalCode = 'SIGKILL';
                h.fake.child.emit('exit', null, 'SIGKILL');
                h.fake.child.emit('close', null, 'SIGKILL');
            }
            return true;
        });
        h.fake.child.kill = vi.fn(() => true);
        await h.client.stop();
        expect(h.fake.input.writableEnded).toBe(true);
        expect(processKill).toHaveBeenNthCalledWith(1, -1234, 'SIGTERM');
        expect(processKill).toHaveBeenNthCalledWith(2, -1234, 'SIGKILL');
        expect(h.fake.child.kill).not.toHaveBeenCalled();
        processKill.mockRestore();
    });

    it('falls back to child.kill and rejects a stubborn child after SIGKILL', async () => {
        const h = setup({ pid: 1234, closeOnKill: false });
        await h.client.start();
        const processKill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('group unavailable'); });
        h.fake.child.kill = vi.fn(() => true);
        await expect(h.client.stop()).rejects.toMatchObject({ name: 'AntigravityStreamClientError', status: 'INTERRUPTED' });
        expect(h.fake.child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
        expect(h.fake.child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
        processKill.mockRestore();
    });

    it('propagates fatal cleanup failure to the active turn', async () => {
        const h = setup({ closeOnKill: false });
        await h.client.start();
        const turn = h.client.sendTurn('fatal cleanup');
        await Promise.resolve();

        h.fake.stdout.write('{malformed}\n');

        await expect(turn).rejects.toMatchObject({
            message: 'Antigravity process did not exit after SIGKILL.',
            status: 'INTERRUPTED',
        });
    });

    it('settles cancel only after cleanup and rejects the turn when cleanup fails', async () => {
        const closing = setup({ closeOnKill: false });
        const closingClient = new AntigravityStreamClient({
            cwd: '/workspace',
            conversationId: 'conv-1',
            spawn: closing.spawn,
            shutdownTimeoutMs: 10_000,
        });
        await closingClient.start();
        const canceledTurn = closingClient.sendTurn('cancel after close');
        await Promise.resolve();
        let turnSettled = false;
        void canceledTurn.then(() => { turnSettled = true; }, () => { turnSettled = true; });
        const canceling = closingClient.cancel();
        await Promise.resolve();
        await Promise.resolve();
        expect(turnSettled).toBe(false);
        closing.fake.child.emit('close', 0, null);
        await expect(canceling).resolves.toBeUndefined();
        await expect(canceledTurn).resolves.toMatchObject({ status: 'CANCELED' });

        const stubborn = setup({ closeOnKill: false });
        await stubborn.client.start();
        const interruptedTurn = stubborn.client.sendTurn('cancel without close');
        await Promise.resolve();
        const interruptedOutcome = interruptedTurn.catch((error: unknown) => error);
        const failedCancel = stubborn.client.cancel();
        await expect(failedCancel).rejects.toMatchObject({ status: 'INTERRUPTED' });
        await expect(interruptedOutcome).resolves.toMatchObject({ status: 'INTERRUPTED' });
    });

    it('times out initialization and cleans up a child that never emits init', async () => {
        const h = fakeChild();
        const client = new AntigravityStreamClient({ cwd: '/workspace', spawn: vi.fn(() => h.child), initTimeoutMs: 1, shutdownTimeoutMs: 1 });
        await expect(client.start()).rejects.toThrow('init timed out');
        await client.dispose();
        expect(h.child.kill).toHaveBeenCalled();
    });

    it('uses only the immutable child handle for Windows cleanup and confirms close', async () => {
        const h = setup({ pid: 4321 });
        const client = new AntigravityStreamClient({
            cwd: '/workspace',
            conversationId: 'conv-1',
            spawn: h.spawn,
            platform: 'win32',
            shutdownTimeoutMs: 1,
        });
        await client.start();
        await client.stop();
        expect(h.fake.child.kill).toHaveBeenCalledWith('SIGKILL');
        expect(h.spawn).toHaveBeenCalledWith('agy', expect.any(Array), expect.objectContaining({ detached: false, shell: false }));
    });

    it('rejects Windows cleanup when the immutable child handle does not confirm close', async () => {
        const h = setup({ pid: 4321, closeOnKill: false });
        const client = new AntigravityStreamClient({
            cwd: '/workspace',
            conversationId: 'conv-1',
            spawn: h.spawn,
            platform: 'win32',
            shutdownTimeoutMs: 1,
        });
        await client.start();
        await expect(client.stop()).rejects.toThrow('did not confirm close');
        expect(h.fake.child.kill).toHaveBeenCalledWith('SIGKILL');
    });
});
