import { describe, expect, it, vi } from 'vitest';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';
import type { AgentState } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { CursorPermissionHandler } from './cursorPermissionHandler';

type PermissionRpcHandler = (response: {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
}) => Promise<void>;

function createSessionMock(): {
    session: ApiSessionClient;
    getState: () => AgentState;
    getPermissionHandler: () => PermissionRpcHandler;
} {
    let state: AgentState = {};
    let permissionHandler: PermissionRpcHandler | undefined;
    const sessionShape = {
        rpcHandlerManager: {
            registerHandler: vi.fn((_method: string, handler: PermissionRpcHandler) => {
                permissionHandler = handler;
            }),
        },
        updateAgentState: (handler: (currentState: AgentState) => AgentState) => {
            state = handler(state);
        },
    };

    return {
        session: sessionShape as unknown as ApiSessionClient,
        getState: () => state,
        getPermissionHandler: () => {
            if (!permissionHandler) throw new Error('Permission RPC handler is not registered');
            return permissionHandler;
        },
    };
}

function request(): RequestPermissionRequest {
    return {
        sessionId: 'cursor-session',
        toolCall: {
            toolCallId: 'tool-call-1',
            title: 'Run command',
            kind: 'execute',
            rawInput: {
                command: 'git status --short',
                apiKey: 'must-not-be-persisted',
            },
        },
        options: [
            { optionId: 'once-option', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'always-option', name: 'Allow always', kind: 'allow_always' },
            { optionId: 'reject-option', name: 'Reject', kind: 'reject_once' },
        ],
    };
}

describe('CursorPermissionHandler', () => {
    it.each([
        ['approved', true, 'approved', 'allow_once'],
        ['approved_for_session', true, 'approved_for_session', 'allow_always'],
        ['denied', false, 'denied', 'reject_once'],
        ['abort', false, 'abort', 'reject_once'],
    ] as const)('maps UI decision %s to Cursor ACP %s', async (_label, approved, decision, expected) => {
        const first = createSessionMock();
        const handler = new CursorPermissionHandler(first.session);
        const pending = handler.handleRequest(request());

        expect(first.getState().requests?.['tool-call-1']).toMatchObject({
            tool: 'Run command',
            arguments: {
                kind: 'execute',
                rawInput: {
                    command: 'git status --short',
                    apiKey: '[REDACTED]',
                },
            },
        });

        await first.getPermissionHandler()({ id: 'tool-call-1', approved, decision });
        await expect(pending).resolves.toBe(expected);
        expect(first.getState().requests?.['tool-call-1']).toBeUndefined();
        expect(first.getState().completedRequests?.['tool-call-1']).toMatchObject({
            status: approved ? 'approved' : 'denied',
            decision,
        });
    });

    it('re-publishes pending state after reconnect and resolves through the new session', async () => {
        const first = createSessionMock();
        const handler = new CursorPermissionHandler(first.session);
        const pending = handler.handleRequest(request());
        const reconnected = createSessionMock();

        handler.updateSession(reconnected.session);

        expect(reconnected.getState().requests?.['tool-call-1']).toMatchObject({
            tool: 'Run command',
            arguments: { kind: 'execute' },
        });

        await reconnected.getPermissionHandler()({
            id: 'tool-call-1',
            approved: true,
            decision: 'approved_for_session',
        });

        await expect(pending).resolves.toBe('allow_always');
        expect(reconnected.getState().requests?.['tool-call-1']).toBeUndefined();
    });

    it('maps reset and cancel to a one-time rejection and clears pending state', async () => {
        const first = createSessionMock();
        const handler = new CursorPermissionHandler(first.session);
        const pending = handler.handleRequest(request());

        handler.cancel();

        await expect(pending).resolves.toBe('reject_once');
        expect(first.getState().requests).toEqual({});
        expect(first.getState().completedRequests?.['tool-call-1']).toMatchObject({
            status: 'canceled',
            reason: 'Session reset',
        });
    });
});
