import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';
import {
    acquireDaemonCursorHeadlessWriterLease,
    bindDaemonCodexThread,
    bindDaemonCursorSession,
    openDaemonCodexRemoteTui,
    releaseDaemonCursorNativeWriterLease,
} from './controlClient';
import { startDaemonControlServer } from './controlServer';
import { forgetSessionRunnerCredential, P2PRunnerCredentialStore } from './p2p/p2pRunnerCredentials';
import type {
    CodexRemoteTuiOpenRequest,
    CodexRemoteTuiOpenResult,
    CursorHeadlessWriterLeaseAcquireRequest,
    CursorHeadlessWriterLeaseAcquireResult,
    CursorNativeWriterLeaseReleaseRequest,
    CursorNativeWriterLeaseReleaseResult,
    CursorRunnerBootstrapFailureRequest,
    CursorRunnerBootstrapFailureResult,
    CursorRunnerPreflightRequest,
    CursorRunnerPreflightResult,
    DaemonRunnerLifecycleResult,
    NativeCodexThreadBinding,
    NativeCodexThreadBindingResult,
    NativeCursorSessionBinding,
    NativeCursorSessionBindingResult,
    StopSessionResult,
} from './types';
import type { PairingRekeyApprovalResult } from './p2p/pairingRekey';

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
    instanceId?: string;
    onExplicitStopRequested?: () => void;
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
    bindNativeCursorSession?: (binding: NativeCursorSessionBinding) => Promise<NativeCursorSessionBindingResult>;
    acquireCursorHeadlessWriterLease?: (
        request: CursorHeadlessWriterLeaseAcquireRequest,
    ) => Promise<CursorHeadlessWriterLeaseAcquireResult>;
    releaseCursorNativeWriterLease?: (
        request: CursorNativeWriterLeaseReleaseRequest,
    ) => Promise<CursorNativeWriterLeaseReleaseResult>;
    preflightCursorRunner?: (
        request: CursorRunnerPreflightRequest,
    ) => Promise<CursorRunnerPreflightResult>;
    reportCursorRunnerBootstrapFailure?: (
        request: CursorRunnerBootstrapFailureRequest,
    ) => Promise<CursorRunnerBootstrapFailureResult>;
    markDaemonRunnerStopping?: (sessionId: string) => DaemonRunnerLifecycleResult;
    completeDaemonRunnerStopping?: (sessionId: string) => Promise<DaemonRunnerLifecycleResult>;
    openCodexRemoteTui?: (request: CodexRemoteTuiOpenRequest) => Promise<CodexRemoteTuiOpenResult>;
    approvePairingRekey?: (requestId: string, approvalCode: string) => Promise<PairingRekeyApprovalResult>;
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
        instanceId: options.instanceId,
        getChildren: () => [],
        stopSession: options.stopSession ?? (() => ({ success: false })),
        spawnSession: async () => ({
            type: 'success',
            sessionId: 'unused',
            terminal: { type: 'not-requested' },
        }),
        requestShutdown: () => {},
        onExplicitStopRequested: options.onExplicitStopRequested,
        onRemcliSessionWebhook: options.onRemcliSessionWebhook ?? (() => ({ accepted: true, daemonOwned: false })),
        issueSessionRunnerCredential: options.issueSessionRunnerCredential ?? (() => undefined),
        verifySessionRunnerCredential: options.verifySessionRunnerCredential ?? (() => false),
        bindNativeCodexThread: options.bindNativeCodexThread ?? (async (binding) => ({
            type: 'wrapper-not-tracked',
            binding,
        })),
        bindNativeCursorSession: options.bindNativeCursorSession ?? (async (binding) => ({
            type: 'wrapper-not-tracked',
            binding,
        })),
        acquireCursorHeadlessWriterLease: options.acquireCursorHeadlessWriterLease ?? (async (request) => ({
            type: 'wrapper-not-tracked',
            request,
        })),
        releaseCursorNativeWriterLease: options.releaseCursorNativeWriterLease ?? (async () => ({ released: false })),
        preflightCursorRunner: options.preflightCursorRunner ?? (async () => ({ type: 'rejected' })),
        reportCursorRunnerBootstrapFailure: options.reportCursorRunnerBootstrapFailure ?? (async () => ({ accepted: false })),
        markDaemonRunnerStopping: options.markDaemonRunnerStopping ?? (() => ({ accepted: false })),
        completeDaemonRunnerStopping: options.completeDaemonRunnerStopping ?? (async () => ({ accepted: false })),
        openCodexRemoteTui: options.openCodexRemoteTui ?? (async (request) => ({
            type: 'wrapper-not-tracked',
            request,
        })),
        approvePairingRekey: options.approvePairingRekey ?? (async () => ({ type: 'not-found' })),
    });
}

describe('startDaemonControlServer', () => {
    let stopServer: (() => Promise<void>) | undefined;

    afterEach(async () => {
        await stopServer?.();
        stopServer = undefined;
    });

    it('exposes the daemon instance identity on loopback control only', async () => {
        const instanceId = '3d8c88c3-e2e4-4b0c-a4e1-5ff1f4bb2e7c';
        const server = await startControlServerForTest({ instanceId });
        stopServer = server.stop;

        const response = await fetch(`http://127.0.0.1:${server.port}/identity`);

        await expect(response.json()).resolves.toEqual({ instanceId });
    });

    it('cancels a pending auto-update synchronously when /stop is requested', async () => {
        const onExplicitStopRequested = vi.fn();
        const controlServer = await startControlServerForTest({ onExplicitStopRequested });
        stopServer = controlServer.stop;

        const response = await fetch(`http://127.0.0.1:${controlServer.port}/stop`, { method: 'POST' });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'stopping' });
        expect(onExplicitStopRequested).toHaveBeenCalledOnce();
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

    it('forwards pairing rekey approval only through the loopback control endpoint', async () => {
        const approvePairingRekey = vi.fn(async () => ({
            type: 'approved' as const,
            expiresAt: 1_784_324_800_000,
        }));
        const controlServer = await startControlServerForTest({ approvePairingRekey });
        stopServer = controlServer.stop;

        const approved = await fetch(`http://127.0.0.1:${controlServer.port}/pairing-rekey/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: 'request-0000000001', approvalCode: 'A1B2C3D4' }),
        });
        const malformed = await fetch(`http://127.0.0.1:${controlServer.port}/pairing-rekey/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId: '', approvalCode: '' }),
        });

        expect(approved.status).toBe(200);
        await expect(approved.json()).resolves.toEqual({ type: 'approved', expiresAt: 1_784_324_800_000 });
        expect(approvePairingRekey).toHaveBeenCalledWith('request-0000000001', 'A1B2C3D4');
        expect(malformed.status).toBe(400);
        expect(approvePairingRekey).toHaveBeenCalledOnce();
    });

    it('returns verified Cursor runner data only after the session manager accepts the preflight', async () => {
        const parentRemcliSessionId = 'trusted-parent-remcli-session';
        const preflightCursorRunner = vi.fn(async (request: CursorRunnerPreflightRequest) => {
            if (request.runnerToken !== 'valid-runner-token') {
                return { type: 'rejected' } as const;
            }
            if (!request.nativeResumeSessionId) {
                return { type: 'verified' } as const;
            }
            return {
                type: 'verified' as const,
                parentRemcliSessionId,
            };
        });
        const controlServer = await startControlServerForTest({ preflightCursorRunner });
        stopServer = controlServer.stop;

        const request = {
            agent: 'cursor',
            nativeResumeSessionId: 'cursor-native-session',
            pid: process.pid,
        } as const;
        const acceptedResponse = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-runner-preflight`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...request, runnerToken: 'valid-runner-token' }),
        });
        const freshResponse = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-runner-preflight`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: 'cursor', pid: process.pid, runnerToken: 'valid-runner-token' }),
        });
        const rejectedResponse = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-runner-preflight`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...request, runnerToken: 'forged-runner-token' }),
        });

        expect(acceptedResponse.status).toBe(200);
        await expect(acceptedResponse.json()).resolves.toEqual({
            type: 'verified',
            parentRemcliSessionId,
        });
        expect(preflightCursorRunner).toHaveBeenNthCalledWith(1, {
            ...request,
            runnerToken: 'valid-runner-token',
        });
        expect(freshResponse.status).toBe(200);
        await expect(freshResponse.json()).resolves.toEqual({ type: 'verified' });
        expect(preflightCursorRunner).toHaveBeenNthCalledWith(2, {
            agent: 'cursor',
            pid: process.pid,
            runnerToken: 'valid-runner-token',
        });
        expect(rejectedResponse.status).toBe(403);
        await expect(rejectedResponse.json()).resolves.toEqual({
            error: 'cursor-runner-preflight-rejected',
        });
        expect(preflightCursorRunner).toHaveBeenNthCalledWith(3, {
            ...request,
            runnerToken: 'forged-runner-token',
        });
    });

    it('forwards only a well-formed authenticated Cursor bootstrap failure report', async () => {
        const reportCursorRunnerBootstrapFailure = vi.fn(async (request: CursorRunnerBootstrapFailureRequest) => ({
            accepted: request.pid === process.pid && request.runnerToken === 'valid-runner-token',
        }));
        const controlServer = await startControlServerForTest({ reportCursorRunnerBootstrapFailure });
        stopServer = controlServer.stop;

        const acceptedResponse = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-runner-bootstrap-failed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: 'cursor', pid: process.pid, runnerToken: 'valid-runner-token' }),
        });
        const foreignResponse = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-runner-bootstrap-failed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: 'cursor', pid: process.pid + 1, runnerToken: 'forged-runner-token' }),
        });
        const malformedResponse = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-runner-bootstrap-failed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agent: 'codex', pid: process.pid, runnerToken: 'valid-runner-token' }),
        });

        expect(acceptedResponse.status).toBe(200);
        await expect(acceptedResponse.json()).resolves.toEqual({ accepted: true });
        expect(foreignResponse.status).toBe(403);
        await expect(foreignResponse.json()).resolves.toEqual({ error: 'cursor-runner-bootstrap-failure-rejected' });
        expect(malformedResponse.status).toBe(400);
        expect(reportCursorRunnerBootstrapFailure).toHaveBeenCalledTimes(2);
        expect(reportCursorRunnerBootstrapFailure).toHaveBeenNthCalledWith(1, {
            agent: 'cursor',
            pid: process.pid,
            runnerToken: 'valid-runner-token',
        });
    });

    it('accepts daemon runner lifecycle transitions only with the runner credential', async () => {
        const markDaemonRunnerStopping = vi.fn(() => ({ accepted: true }));
        const completeDaemonRunnerStopping = vi.fn(async () => ({ accepted: true }));
        const verifySessionRunnerCredential = vi.fn((sessionId: string, credential: string) => (
            sessionId === 'remcli-runner' && credential === 'runner-credential'
        ));
        const controlServer = await startControlServerForTest({
            verifySessionRunnerCredential,
            markDaemonRunnerStopping,
            completeDaemonRunnerStopping,
        });
        stopServer = controlServer.stop;

        const stoppingResponse = await fetch(`http://127.0.0.1:${controlServer.port}/daemon-runner-stopping`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'remcli-runner', runnerCredential: 'runner-credential' }),
        });
        const stoppedResponse = await fetch(`http://127.0.0.1:${controlServer.port}/daemon-runner-stopped`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'remcli-runner', runnerCredential: 'runner-credential' }),
        });
        const rejectedResponse = await fetch(`http://127.0.0.1:${controlServer.port}/daemon-runner-stopped`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: 'remcli-runner', runnerCredential: 'forged-credential' }),
        });

        expect(stoppingResponse.status).toBe(200);
        await expect(stoppingResponse.json()).resolves.toEqual({ accepted: true });
        expect(stoppedResponse.status).toBe(200);
        await expect(stoppedResponse.json()).resolves.toEqual({ accepted: true });
        expect(rejectedResponse.status).toBe(403);
        await expect(rejectedResponse.json()).resolves.toEqual({ error: 'invalid-runner-credential' });
        expect(markDaemonRunnerStopping).toHaveBeenCalledWith('remcli-runner');
        expect(completeDaemonRunnerStopping).toHaveBeenCalledWith('remcli-runner');
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

    it('binds a Cursor native session only after the daemon-issued runner credential verifies', async () => {
        const credentialStore = new P2PRunnerCredentialStore();
        const bindingResult = {
            type: 'bound',
            wrapper: {
                agent: 'cursor',
                nativeSessionId: 'cursor-native-123',
                remcliSessionId: 'remcli-123',
            },
            writerLease: {
                agent: 'cursor',
                leaseId: 'cursor-writer-lease-12345678901234567890',
                nativeSessionId: 'cursor-native-123',
                remcliSessionId: 'remcli-123',
                owner: 'headless',
            },
        } as const;
        const bindNativeCursorSession = vi.fn(async () => bindingResult);
        const controlServer = await startControlServerForTest({
            onRemcliSessionWebhook: () => ({
                accepted: true,
                daemonOwned: true,
                runnerCredentialOwner: 'runner-owner-cursor',
            }),
            issueSessionRunnerCredential: (sessionId, owner) => credentialStore.issue(sessionId, owner),
            verifySessionRunnerCredential: (sessionId, credential) => credentialStore.verify(sessionId, credential),
            bindNativeCursorSession,
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

        const binding: NativeCursorSessionBinding = {
            agent: 'cursor',
            nativeSessionId: 'cursor-native-123',
            remcliSessionId: 'remcli-123',
        };
        const bindingResponse = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-session-bound`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...binding, runnerCredential: sessionStartedBody.runnerCredential }),
        });

        expect(sessionStartedResponse.status).toBe(200);
        expect(bindingResponse.status).toBe(200);
        await expect(bindingResponse.json()).resolves.toEqual(bindingResult);
        expect(bindNativeCursorSession).toHaveBeenCalledWith(binding);
    });

    it('requires the daemon-issued runner credential and exact opaque capability for Cursor writer lease operations', async () => {
        const credentialStore = new P2PRunnerCredentialStore();
        const acquireCursorHeadlessWriterLease = vi.fn(async (request: CursorHeadlessWriterLeaseAcquireRequest) => ({
            type: 'acquired' as const,
            writerLease: {
                agent: 'cursor' as const,
                leaseId: 'cursor-writer-lease-12345678901234567890',
                nativeSessionId: request.nativeSessionId,
                remcliSessionId: request.remcliSessionId,
                owner: 'headless' as const,
            },
        }));
        const releaseCursorNativeWriterLease = vi.fn(async (request: CursorNativeWriterLeaseReleaseRequest) => ({
            released: request.leaseId === 'cursor-writer-lease-12345678901234567890',
        }));
        const controlServer = await startControlServerForTest({
            verifySessionRunnerCredential: (sessionId, credential) => credentialStore.verify(sessionId, credential),
            acquireCursorHeadlessWriterLease,
            releaseCursorNativeWriterLease,
        });
        stopServer = controlServer.stop;

        const runnerCredential = credentialStore.issue('remcli-lease-owner', 'cursor-runner-owner');
        const acquireBody = {
            agent: 'cursor',
            nativeSessionId: 'cursor-native-lease-owner',
            remcliSessionId: 'remcli-lease-owner',
        } as const;
        const rejectedAcquire = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-headless-writer-acquire`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...acquireBody, runnerCredential: 'forged-credential' }),
        });
        const acceptedAcquire = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-headless-writer-acquire`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...acquireBody, runnerCredential }),
        });
        const rejectedCredentialRelease = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-writer-release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent: 'cursor',
                leaseId: 'cursor-writer-lease-12345678901234567890',
                nativeSessionId: 'cursor-native-lease-owner',
                remcliSessionId: 'remcli-lease-owner',
                runnerCredential: 'forged-credential',
            }),
        });
        const crossSessionRelease = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-writer-release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent: 'cursor',
                leaseId: 'cursor-writer-lease-12345678901234567890',
                nativeSessionId: 'cursor-native-lease-owner',
                remcliSessionId: 'remcli-other-session',
                runnerCredential,
            }),
        });
        const rejectedRelease = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-writer-release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent: 'cursor',
                leaseId: 'forged-cursor-writer-lease-123456789012345678',
                nativeSessionId: 'cursor-native-lease-owner',
                remcliSessionId: 'remcli-lease-owner',
                runnerCredential,
            }),
        });
        const acceptedRelease = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-writer-release`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent: 'cursor',
                leaseId: 'cursor-writer-lease-12345678901234567890',
                nativeSessionId: 'cursor-native-lease-owner',
                remcliSessionId: 'remcli-lease-owner',
                runnerCredential,
            }),
        });

        expect(rejectedAcquire.status).toBe(403);
        expect(acceptedAcquire.status).toBe(200);
        expect(rejectedCredentialRelease.status).toBe(403);
        await expect(acceptedAcquire.json()).resolves.toEqual({
            type: 'acquired',
            writerLease: {
                agent: 'cursor',
                leaseId: 'cursor-writer-lease-12345678901234567890',
                nativeSessionId: 'cursor-native-lease-owner',
                remcliSessionId: 'remcli-lease-owner',
                owner: 'headless',
            },
        });
        expect(crossSessionRelease.status).toBe(403);
        await expect(rejectedRelease.json()).resolves.toEqual({ released: false });
        await expect(acceptedRelease.json()).resolves.toEqual({ released: true });
        expect(acquireCursorHeadlessWriterLease).toHaveBeenCalledOnce();
        expect(releaseCursorNativeWriterLease).toHaveBeenCalledTimes(2);
        expect(releaseCursorNativeWriterLease).toHaveBeenNthCalledWith(1, {
            agent: 'cursor',
            leaseId: 'forged-cursor-writer-lease-123456789012345678',
            nativeSessionId: 'cursor-native-lease-owner',
            remcliSessionId: 'remcli-lease-owner',
        });
        expect(releaseCursorNativeWriterLease).toHaveBeenNthCalledWith(2, {
            agent: 'cursor',
            leaseId: 'cursor-writer-lease-12345678901234567890',
            nativeSessionId: 'cursor-native-lease-owner',
            remcliSessionId: 'remcli-lease-owner',
        });
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

        const noReasoningRequest: CodexRemoteTuiOpenRequest = {
            ...request,
            reasoningEffort: null,
            model: 'gpt-5.6-no-reasoning',
        };
        const noReasoningResponse = await fetch(`http://127.0.0.1:${controlServer.port}/codex-remote-tui-open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...noReasoningRequest, runnerCredential: sessionStartedBody.runnerCredential }),
        });

        expect(noReasoningResponse.status).toBe(200);
        await expect(noReasoningResponse.json()).resolves.toEqual(remoteTuiResult);
        expect(openCodexRemoteTui).toHaveBeenLastCalledWith(noReasoningRequest);
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
            reasoningEffort: null,
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

    it('rejects missing and wrong credentials before binding a Cursor native session', async () => {
        const bindNativeCursorSession = vi.fn();
        const verifySessionRunnerCredential = vi.fn((sessionId: string, credential: string) => {
            return sessionId === 'remcli-123' && credential === 'valid-credential';
        });
        const controlServer = await startControlServerForTest({
            verifySessionRunnerCredential,
            bindNativeCursorSession,
        });
        stopServer = controlServer.stop;

        const binding: NativeCursorSessionBinding = {
            agent: 'cursor',
            nativeSessionId: 'cursor-native-123',
            remcliSessionId: 'remcli-123',
        };
        const missingCredentialResponse = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-session-bound`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(binding),
        });
        const wrongCredentialResponse = await fetch(`http://127.0.0.1:${controlServer.port}/cursor-session-bound`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...binding, runnerCredential: 'wrong-credential' }),
        });

        expect(missingCredentialResponse.status).toBe(403);
        await expect(missingCredentialResponse.json()).resolves.toEqual({ error: 'invalid-runner-credential' });
        expect(wrongCredentialResponse.status).toBe(403);
        await expect(wrongCredentialResponse.json()).resolves.toEqual({ error: 'invalid-runner-credential' });
        expect(verifySessionRunnerCredential).toHaveBeenCalledWith('remcli-123', 'wrong-credential');
        expect(bindNativeCursorSession).not.toHaveBeenCalled();
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
            reasoningEffort: null,
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

    it('rejects missing or malformed remote TUI reasoning effort before it reaches the session manager', async () => {
        const openCodexRemoteTui = vi.fn();
        const verifySessionRunnerCredential = vi.fn(() => true);
        const controlServer = await startControlServerForTest({
            verifySessionRunnerCredential,
            openCodexRemoteTui,
        });
        stopServer = controlServer.stop;

        const baseRequest = {
            agent: 'codex',
            nativeThreadId: 'thread-123',
            remcliSessionId: 'remcli-123',
            runnerCredential: 'valid-credential',
            endpoint: 'ws://127.0.0.1:45123',
        };
        const responses = await Promise.all([
            fetch(`http://127.0.0.1:${controlServer.port}/codex-remote-tui-open`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(baseRequest),
            }),
            fetch(`http://127.0.0.1:${controlServer.port}/codex-remote-tui-open`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...baseRequest, reasoningEffort: '   ' }),
            }),
            fetch(`http://127.0.0.1:${controlServer.port}/codex-remote-tui-open`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...baseRequest, reasoningEffort: 1 }),
            }),
        ]);

        expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
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
            reasoningEffort: null,
        });

        expect(bindingResult).toEqual({ ok: false, error: 'Missing session runner credential' });
        const cursorBindingResult = await bindDaemonCursorSession({
            agent: 'cursor',
            nativeSessionId: 'cursor-native-123',
            remcliSessionId: sessionId,
        });
        const cursorLeaseAcquireResult = await acquireDaemonCursorHeadlessWriterLease({
            agent: 'cursor',
            nativeSessionId: 'cursor-native-123',
            remcliSessionId: sessionId,
        });
        const cursorLeaseReleaseResult = await releaseDaemonCursorNativeWriterLease({
            agent: 'cursor',
            leaseId: 'cursor-writer-lease-12345678901234567890',
            nativeSessionId: 'cursor-native-123',
            remcliSessionId: sessionId,
        });
        expect(cursorBindingResult).toEqual({ ok: false, error: 'Missing session runner credential' });
        expect(cursorLeaseAcquireResult).toEqual({ ok: false, error: 'Missing session runner credential' });
        expect(cursorLeaseReleaseResult).toEqual({ ok: false, error: 'Missing session runner credential' });
        expect(remoteTuiResult).toEqual({ ok: false, error: 'Missing session runner credential' });
    });
});
