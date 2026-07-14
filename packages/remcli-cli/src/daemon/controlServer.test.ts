import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import {
    bindDaemonCodexThread,
    openDaemonCodexRemoteTui,
} from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { forgetSessionRunnerCredential, P2PRunnerCredentialStore } from './p2p/p2pRunnerCredentials';
import type {
    CodexRemoteTuiOpenRequest,
    CodexRemoteTuiOpenResult,
    NativeCodexThreadBinding,
    NativeCodexThreadBindingResult,
    StopSessionResult,
} from './types';

const sessionMetadata: Metadata = {
    path: '/tmp/remcli',
    host: 'localhost',
    homeDir: '/tmp',
    remcliHomeDir: '/tmp/.remcli',
    remcliLibDir: '/tmp/.remcli/lib',
    remcliToolsDir: '/tmp/.remcli/tools',
    hostPid: process.pid,
    flavor: 'codex',
};

interface ControlServerTestOptions {
    stopSession?: (sessionId: string) => StopSessionResult | Promise<StopSessionResult>;
    onRemcliSessionWebhook?: (sessionId: string, metadata: Metadata, runnerToken?: string) => {
        accepted: boolean;
        daemonOwned: boolean;
        shouldIssueRunnerCredential?: boolean;
        runnerCredentialOwner?: string;
        error?: string;
    };
    issueSessionRunnerCredential?: (sessionId: string, owner: string) => string | undefined;
    verifySessionRunnerCredential?: (sessionId: string, credential: string) => boolean;
    bindNativeCodexThread?: (binding: NativeCodexThreadBinding) => Promise<NativeCodexThreadBindingResult>;
    openCodexRemoteTui?: (request: CodexRemoteTuiOpenRequest) => Promise<CodexRemoteTuiOpenResult>;
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });

    if (!resolvePromise) {
        throw new Error('Could not create deferred promise');
    }

    return { promise, resolve: resolvePromise };
}

async function startControlServerForTest(options: ControlServerTestOptions = {}) {
    return startDaemonControlServer({
        getChildren: () => [],
        stopSession: options.stopSession ?? (() => ({ success: false })),
        spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        requestShutdown: () => {},
        onRemcliSessionWebhook: options.onRemcliSessionWebhook ?? (() => ({ accepted: true, daemonOwned: false })),
        issueSessionRunnerCredential: options.issueSessionRunnerCredential ?? (() => undefined),
        verifySessionRunnerCredential: options.verifySessionRunnerCredential ?? (() => false),
        bindNativeCodexThread: options.bindNativeCodexThread ?? (async (binding) => ({
            type: 'wrapper-not-tracked',
            binding,
        })),
        openCodexRemoteTui: options.openCodexRemoteTui ?? (async (request) => ({
            type: 'wrapper-not-tracked',
            request,
        })),
    });
}

describe('startDaemonControlServer', () => {
    let stopServer: (() => Promise<void>) | undefined;

    afterEach(async () => {
        await stopServer?.();
        stopServer = undefined;
    });

    it('waits for an asynchronous stop before replying from /stop-session', async () => {
        const sessionId = 'remcli-deferred-stop';
        const deferredStop = createDeferred<StopSessionResult>();
        const stopSession = vi.fn(() => deferredStop.promise);
        const controlServer = await startControlServerForTest({ stopSession });
        stopServer = controlServer.stop;

        let hasResponded = false;
        const responsePromise = fetch(`http://127.0.0.1:${controlServer.port}/stop-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId }),
        }).then((response) => {
            hasResponded = true;
            return response;
        });

        await vi.waitFor(() => {
            expect(stopSession).toHaveBeenCalledWith(sessionId);
        });
        expect(hasResponded).toBe(false);

        deferredStop.resolve({ success: true, stoppedSessionId: sessionId });

        const response = await responsePromise;
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ success: true });
    });

    it('issues a daemon-owned runner credential and verifies it before binding a Codex thread', async () => {
        const credentialStore = new P2PRunnerCredentialStore();
        const runnerCredentialOwner = 'runner-owner-123';
        const onRemcliSessionWebhook = vi.fn(() => ({
            accepted: true,
            daemonOwned: true,
            runnerCredentialOwner,
        }));
        const issueSessionRunnerCredential = vi.fn((sessionId: string, owner: string) => credentialStore.issue(sessionId, owner));
        const verifySessionRunnerCredential = vi.fn((sessionId: string, credential: string) => {
            return credentialStore.verify(sessionId, credential);
        });
        const bindingResult: NativeCodexThreadBindingResult = {
            type: 'bound',
            wrapper: {
                agent: 'codex',
                nativeThreadId: 'thread-123',
                remcliSessionId: 'remcli-123',
            },
        };
        const bindNativeCodexThread = vi.fn(async () => bindingResult);
        const controlServer = await startControlServerForTest({
            onRemcliSessionWebhook,
            issueSessionRunnerCredential,
            verifySessionRunnerCredential,
            bindNativeCodexThread,
        });
        stopServer = controlServer.stop;

        const sessionStartedResponse = await fetch(`http://127.0.0.1:${controlServer.port}/session-started`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: 'remcli-123',
                metadata: sessionMetadata,
                runnerToken: 'daemon-spawn-token',
            }),
        });
        const sessionStartedBody = await sessionStartedResponse.json() as {
            status: 'ok';
            runnerCredential?: string;
        };
        const runnerCredential = sessionStartedBody.runnerCredential;
        if (!runnerCredential) {
            throw new Error('Expected a runner credential for the daemon-owned session');
        }

        const binding: NativeCodexThreadBinding = {
            agent: 'codex',
            nativeThreadId: 'thread-123',
            remcliSessionId: 'remcli-123',
        };
        const bindingResponse = await fetch(`http://127.0.0.1:${controlServer.port}/codex-thread-bound`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...binding, runnerCredential }),
        });

        expect(sessionStartedResponse.status).toBe(200);
        expect(sessionStartedBody.status).toBe('ok');
        expect(onRemcliSessionWebhook).toHaveBeenCalledWith(
            'remcli-123',
            sessionMetadata,
            'daemon-spawn-token',
        );
        expect(issueSessionRunnerCredential).toHaveBeenCalledWith('remcli-123', runnerCredentialOwner);
        expect(bindingResponse.status).toBe(200);
        await expect(bindingResponse.json()).resolves.toEqual(bindingResult);
        expect(verifySessionRunnerCredential).toHaveBeenCalledWith('remcli-123', runnerCredential);
        expect(bindNativeCodexThread).toHaveBeenCalledWith(binding);
    });

    it('does not issue a credential for an accepted manual session', async () => {
        const onRemcliSessionWebhook = vi.fn(() => ({ accepted: true, daemonOwned: false }));
        const issueSessionRunnerCredential = vi.fn(() => 'credential-must-not-be-issued');
        const controlServer = await startControlServerForTest({
            onRemcliSessionWebhook,
            issueSessionRunnerCredential,
        });
        stopServer = controlServer.stop;

        const response = await fetch(`http://127.0.0.1:${controlServer.port}/session-started`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'manual-123', metadata: sessionMetadata }),
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'ok' });
        expect(onRemcliSessionWebhook).toHaveBeenCalledWith('manual-123', sessionMetadata, undefined);
        expect(issueSessionRunnerCredential).not.toHaveBeenCalled();
    });

    it('returns the same credential when a daemon runner retries after losing a successful response', async () => {
        const credentialStore = new P2PRunnerCredentialStore();
        const runnerCredentialOwner = 'runner-owner-retry-safe';
        const issueSessionRunnerCredential = vi.fn((sessionId: string, owner: string) => {
            return credentialStore.issue(sessionId, owner);
        });
        const onRemcliSessionWebhook = vi.fn(() => ({
            accepted: true,
            daemonOwned: true,
            runnerCredentialOwner,
        }));
        const controlServer = await startControlServerForTest({
            onRemcliSessionWebhook,
            issueSessionRunnerCredential,
        });
        stopServer = controlServer.stop;

        const request = {
            sessionId: 'remcli-credential-once',
            metadata: sessionMetadata,
            runnerToken: 'daemon-spawn-token',
        };
        const firstResponse = await fetch(`http://127.0.0.1:${controlServer.port}/session-started`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
        });
        const repeatedResponse = await fetch(`http://127.0.0.1:${controlServer.port}/session-started`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
        });

        expect(firstResponse.status).toBe(200);
        expect(repeatedResponse.status).toBe(200);
        const retryBody = await repeatedResponse.json() as { status: 'ok'; runnerCredential?: string };
        const firstIssuedCredential = issueSessionRunnerCredential.mock.results[0]?.value;

        expect(firstIssuedCredential).toEqual(expect.any(String));
        expect(retryBody).toEqual({ status: 'ok', runnerCredential: firstIssuedCredential });
        expect(issueSessionRunnerCredential).toHaveBeenCalledTimes(2);
        expect(issueSessionRunnerCredential).toHaveBeenNthCalledWith(1, 'remcli-credential-once', runnerCredentialOwner);
        expect(issueSessionRunnerCredential).toHaveBeenNthCalledWith(2, 'remcli-credential-once', runnerCredentialOwner);
    });

    it('rejects a retry that presents another runner as the credential owner', async () => {
        const credentialStore = new P2PRunnerCredentialStore();
        const onRemcliSessionWebhook = vi.fn()
            .mockReturnValueOnce({
                accepted: true,
                daemonOwned: true,
                runnerCredentialOwner: 'runner-owner-a',
            })
            .mockReturnValueOnce({
                accepted: true,
                daemonOwned: true,
                runnerCredentialOwner: 'runner-owner-b',
            });
        const controlServer = await startControlServerForTest({
            onRemcliSessionWebhook,
            issueSessionRunnerCredential: (sessionId, owner) => credentialStore.issue(sessionId, owner),
        });
        stopServer = controlServer.stop;

        const request = {
            sessionId: 'remcli-owner-bound-credential',
            metadata: sessionMetadata,
            runnerToken: 'daemon-spawn-token',
        };
        const firstResponse = await fetch(`http://127.0.0.1:${controlServer.port}/session-started`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
        });
        const foreignRetryResponse = await fetch(`http://127.0.0.1:${controlServer.port}/session-started`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
        });

        expect(firstResponse.status).toBe(200);
        expect(foreignRetryResponse.status).toBe(403);
        await expect(foreignRetryResponse.json()).resolves.toEqual({ error: 'session-webhook-rejected' });
    });

    it('opens a remote TUI only after the daemon-issued runner credential verifies', async () => {
        const credentialStore = new P2PRunnerCredentialStore();
        const remoteTuiResult: CodexRemoteTuiOpenResult = {
            type: 'opened',
            wrapper: {
                agent: 'codex',
                nativeThreadId: 'thread-123',
                remcliSessionId: 'remcli-123',
            },
            tmuxWindowId: 'remcli-codex-tui-1:codex-window',
        };
        const openCodexRemoteTui = vi.fn(async () => remoteTuiResult);
        const controlServer = await startControlServerForTest({
            onRemcliSessionWebhook: () => ({
                accepted: true,
                daemonOwned: true,
                runnerCredentialOwner: 'runner-owner-remote-tui',
            }),
            issueSessionRunnerCredential: (sessionId, owner) => credentialStore.issue(sessionId, owner),
            verifySessionRunnerCredential: (sessionId, credential) => credentialStore.verify(sessionId, credential),
            openCodexRemoteTui,
        });
        stopServer = controlServer.stop;

        const sessionStartedResponse = await fetch(`http://127.0.0.1:${controlServer.port}/session-started`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'remcli-123', metadata: sessionMetadata, runnerToken: 'daemon-token' }),
        });
        const sessionStartedBody = await sessionStartedResponse.json() as { runnerCredential?: string };
        if (!sessionStartedBody.runnerCredential) {
            throw new Error('Expected daemon-owned runner credential.');
        }

        const request: CodexRemoteTuiOpenRequest = {
            agent: 'codex',
            nativeThreadId: 'thread-123',
            remcliSessionId: 'remcli-123',
            endpoint: 'ws://127.0.0.1:45123',
            reasoningEffort: 'high',
            model: 'gpt-5.6-luna',
        };
        const response = await fetch(`http://127.0.0.1:${controlServer.port}/codex-remote-tui-open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...request, runnerCredential: sessionStartedBody.runnerCredential }),
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual(remoteTuiResult);
        expect(openCodexRemoteTui).toHaveBeenCalledWith(request);
    });

    it('does not let a valid runner credential for session A control session B', async () => {
        const credentialStore = new P2PRunnerCredentialStore();
        const credentialA = credentialStore.issue('remcli-session-a', 'runner-owner-a');
        const credentialB = credentialStore.issue('remcli-session-b', 'runner-owner-b');
        if (!credentialA || !credentialB) {
            throw new Error('Expected credentials for both isolated daemon runners.');
        }
        expect(credentialStore.issue('remcli-session-b', 'runner-owner-a')).toBeUndefined();

        const bindNativeCodexThread = vi.fn();
        const openCodexRemoteTui = vi.fn();
        const controlServer = await startControlServerForTest({
            verifySessionRunnerCredential: (sessionId, credential) => credentialStore.verify(sessionId, credential),
            bindNativeCodexThread,
            openCodexRemoteTui,
        });
        stopServer = controlServer.stop;

        const binding: NativeCodexThreadBinding = {
            agent: 'codex',
            nativeThreadId: 'thread-b',
            remcliSessionId: 'remcli-session-b',
        };
        const remoteTuiRequest: CodexRemoteTuiOpenRequest = {
            ...binding,
            endpoint: 'ws://127.0.0.1:45123',
        };

        const bindingResponse = await fetch(`http://127.0.0.1:${controlServer.port}/codex-thread-bound`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...binding, runnerCredential: credentialA }),
        });
        const remoteTuiResponse = await fetch(`http://127.0.0.1:${controlServer.port}/codex-remote-tui-open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...remoteTuiRequest, runnerCredential: credentialA }),
        });

        expect(bindingResponse.status).toBe(403);
        await expect(bindingResponse.json()).resolves.toEqual({ error: 'invalid-runner-credential' });
        expect(remoteTuiResponse.status).toBe(403);
        await expect(remoteTuiResponse.json()).resolves.toEqual({ error: 'invalid-runner-credential' });
        expect(bindNativeCodexThread).not.toHaveBeenCalled();
        expect(openCodexRemoteTui).not.toHaveBeenCalled();
        expect(credentialStore.verify('remcli-session-b', credentialB)).toBe(true);
    });

    it('rejects an unaccepted session webhook without issuing a runner credential', async () => {
        const onRemcliSessionWebhook = vi.fn(() => ({
            accepted: false,
            daemonOwned: false,
            error: 'unknown-runner-token',
        }));
        const issueSessionRunnerCredential = vi.fn(() => 'credential-must-not-be-issued');
        const controlServer = await startControlServerForTest({
            onRemcliSessionWebhook,
            issueSessionRunnerCredential,
        });
        stopServer = controlServer.stop;

        const response = await fetch(`http://127.0.0.1:${controlServer.port}/session-started`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sessionId: 'unknown-daemon-session',
                metadata: sessionMetadata,
                runnerToken: 'invalid-token',
            }),
        });

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({ error: 'session-webhook-rejected' });
        expect(issueSessionRunnerCredential).not.toHaveBeenCalled();
    });

    it('rejects missing and wrong credentials before binding a Codex thread', async () => {
        const bindNativeCodexThread = vi.fn();
        const verifySessionRunnerCredential = vi.fn((sessionId: string, credential: string) => {
            return sessionId === 'remcli-123' && credential === 'valid-credential';
        });
        const controlServer = await startControlServerForTest({
            verifySessionRunnerCredential,
            bindNativeCodexThread,
        });
        stopServer = controlServer.stop;

        const binding: NativeCodexThreadBinding = {
            agent: 'codex',
            nativeThreadId: 'thread-123',
            remcliSessionId: 'remcli-123',
        };
        const missingCredentialResponse = await fetch(`http://127.0.0.1:${controlServer.port}/codex-thread-bound`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(binding),
        });
        const wrongCredentialResponse = await fetch(`http://127.0.0.1:${controlServer.port}/codex-thread-bound`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...binding, runnerCredential: 'wrong-credential' }),
        });

        expect(missingCredentialResponse.status).toBe(403);
        await expect(missingCredentialResponse.json()).resolves.toEqual({ error: 'invalid-runner-credential' });
        expect(wrongCredentialResponse.status).toBe(403);
        await expect(wrongCredentialResponse.json()).resolves.toEqual({ error: 'invalid-runner-credential' });
        expect(verifySessionRunnerCredential).toHaveBeenCalledWith('remcli-123', 'wrong-credential');
        expect(bindNativeCodexThread).not.toHaveBeenCalled();
    });

    it('rejects missing and wrong credentials before opening a remote TUI', async () => {
        const openCodexRemoteTui = vi.fn();
        const verifySessionRunnerCredential = vi.fn((sessionId: string, credential: string) => {
            return sessionId === 'remcli-123' && credential === 'valid-credential';
        });
        const controlServer = await startControlServerForTest({
            verifySessionRunnerCredential,
            openCodexRemoteTui,
        });
        stopServer = controlServer.stop;

        const remoteTuiRequest: CodexRemoteTuiOpenRequest = {
            agent: 'codex',
            nativeThreadId: 'thread-123',
            remcliSessionId: 'remcli-123',
            endpoint: 'ws://127.0.0.1:45123',
        };
        const missingCredentialResponse = await fetch(`http://127.0.0.1:${controlServer.port}/codex-remote-tui-open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(remoteTuiRequest),
        });
        const wrongCredentialResponse = await fetch(`http://127.0.0.1:${controlServer.port}/codex-remote-tui-open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...remoteTuiRequest, runnerCredential: 'wrong-credential' }),
        });

        expect(missingCredentialResponse.status).toBe(403);
        await expect(missingCredentialResponse.json()).resolves.toEqual({ error: 'invalid-runner-credential' });
        expect(wrongCredentialResponse.status).toBe(403);
        await expect(wrongCredentialResponse.json()).resolves.toEqual({ error: 'invalid-runner-credential' });
        expect(verifySessionRunnerCredential).toHaveBeenCalledWith('remcli-123', 'wrong-credential');
        expect(openCodexRemoteTui).not.toHaveBeenCalled();
    });

    it('rejects a malformed remote TUI endpoint before it reaches the session manager', async () => {
        const openCodexRemoteTui = vi.fn();
        const verifySessionRunnerCredential = vi.fn(() => true);
        const controlServer = await startControlServerForTest({
            verifySessionRunnerCredential,
            openCodexRemoteTui,
        });
        stopServer = controlServer.stop;

        const response = await fetch(`http://127.0.0.1:${controlServer.port}/codex-remote-tui-open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent: 'codex',
                nativeThreadId: 'thread-123',
                remcliSessionId: 'remcli-123',
                runnerCredential: 'valid-credential',
                endpoint: 'not a WebSocket endpoint',
            }),
        });

        expect(response.status).toBe(400);
        expect(verifySessionRunnerCredential).not.toHaveBeenCalled();
        expect(openCodexRemoteTui).not.toHaveBeenCalled();
    });

    it('fails protected client calls locally when their session has no runner credential', async () => {
        const sessionId = 'client-without-runner-credential';
        forgetSessionRunnerCredential(sessionId);

        const bindingResult = await bindDaemonCodexThread({
            agent: 'codex',
            nativeThreadId: 'thread-123',
            remcliSessionId: sessionId,
        });
        const remoteTuiResult = await openDaemonCodexRemoteTui({
            agent: 'codex',
            nativeThreadId: 'thread-123',
            remcliSessionId: sessionId,
            endpoint: 'ws://127.0.0.1:45123',
        });

        expect(bindingResult).toEqual({ ok: false, error: 'Missing session runner credential' });
        expect(remoteTuiResult).toEqual({ ok: false, error: 'Missing session runner credential' });
    });
});
