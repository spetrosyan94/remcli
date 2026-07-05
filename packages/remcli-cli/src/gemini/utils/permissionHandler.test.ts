import { describe, expect, it, vi } from 'vitest';
import type { AgentState } from '@/api/types';
import type { ApiSessionClient } from '@/api/apiSession';
import { GeminiPermissionHandler } from './permissionHandler';

function createSessionMock(): { session: ApiSessionClient; getState: () => AgentState } {
    let state: AgentState = {};
    const sessionShape = {
        rpcHandlerManager: {
            registerHandler: vi.fn(),
        },
        updateAgentState: (handler: (metadata: AgentState) => AgentState) => {
            state = handler(state);
        },
    };

    return {
        session: sessionShape as unknown as ApiSessionClient,
        getState: () => state,
    };
}

describe('GeminiPermissionHandler permission modes', () => {
    it('auto-approves edit tools in auto_edit mode', async () => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session);
        handler.setPermissionMode('auto_edit');

        const result = await handler.handleToolCall('write-1', 'WriteFile', { path: 'src/index.ts' });

        expect(result).toEqual({ decision: 'approved' });
        expect(getState().completedRequests?.['write-1']).toMatchObject({
            tool: 'WriteFile',
            status: 'approved',
            decision: 'approved',
        });
    });

    it('asks before delete tools in auto_edit mode', () => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session);
        handler.setPermissionMode('auto_edit');

        void handler.handleToolCall('delete-1', 'DeleteFile', { path: 'src/index.ts' });

        expect(getState().requests?.['delete-1']).toMatchObject({
            tool: 'DeleteFile',
            arguments: { path: 'src/index.ts' },
        });
        expect(getState().completedRequests?.['delete-1']).toBeUndefined();
    });

    it('denies write tools in plan mode', async () => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session);
        handler.setPermissionMode('plan');

        const result = await handler.handleToolCall('write-1', 'WriteFile', { path: 'src/index.ts' });

        expect(result).toEqual({ decision: 'denied' });
        expect(getState().requests?.['write-1']).toBeUndefined();
        expect(getState().completedRequests?.['write-1']).toMatchObject({
            tool: 'WriteFile',
            status: 'denied',
            decision: 'denied',
        });
    });

    it('does not auto-approve shell commands in plan mode', async () => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session);
        handler.setPermissionMode('plan');

        const result = await handler.handleToolCall('shell-1', 'Shell', { command: 'git status --short' });

        expect(result).toEqual({ decision: 'denied' });
        expect(getState().completedRequests?.['shell-1']).toMatchObject({
            tool: 'Shell',
            status: 'denied',
            decision: 'denied',
        });
    });

    it('denies unknown tools in plan mode', async () => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session);
        handler.setPermissionMode('plan');

        const result = await handler.handleToolCall('unknown-1', 'Shell', { command: 'python script.py' });

        expect(result).toEqual({ decision: 'denied' });
        expect(getState().requests?.['unknown-1']).toBeUndefined();
        expect(getState().completedRequests?.['unknown-1']).toMatchObject({
            tool: 'Shell',
            status: 'denied',
            decision: 'denied',
        });
    });

    it('does not auto-approve memory writes in plan mode', async () => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session);
        handler.setPermissionMode('plan');

        const result = await handler.handleToolCall('save-memory-1', 'save_memory', { memory: 'remember this' });

        expect(result).toEqual({ decision: 'denied' });
        expect(getState().requests?.['save-memory-1']).toBeUndefined();
        expect(getState().completedRequests?.['save-memory-1']).toMatchObject({
            tool: 'save_memory',
            status: 'denied',
            decision: 'denied',
        });
    });

    it('asks before memory writes in auto_edit mode', () => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session);
        handler.setPermissionMode('auto_edit');

        void handler.handleToolCall('save-memory-1', 'save_memory', { memory: 'remember this' });

        expect(getState().requests?.['save-memory-1']).toMatchObject({
            tool: 'save_memory',
            arguments: { memory: 'remember this' },
        });
        expect(getState().completedRequests?.['save-memory-1']).toBeUndefined();
    });

    it('does not auto-approve write shell commands in auto_edit mode', () => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session);
        handler.setPermissionMode('auto_edit');

        void handler.handleToolCall('shell-1', 'Shell', { command: 'rm -rf dist' });

        expect(getState().requests?.['shell-1']).toMatchObject({
            tool: 'Shell',
            arguments: { command: 'rm -rf dist' },
        });
        expect(getState().completedRequests?.['shell-1']).toBeUndefined();
    });

    it.each([
        'find . -delete',
        'find . -exec rm {} \\;',
        'git branch -D feature',
        'cat $(rm -rf dist)',
    ])('does not auto-approve destructive-looking shell command in auto_edit mode: %s', (command) => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session);
        handler.setPermissionMode('auto_edit');

        void handler.handleToolCall(command, 'Shell', { command });

        expect(getState().requests?.[command]).toMatchObject({
            tool: 'Shell',
            arguments: { command },
        });
        expect(getState().completedRequests?.[command]).toBeUndefined();
    });

    it.each(['default', 'auto_edit', 'plan', 'yolo'] as const)('auto-approves change_title in %s mode', async (mode) => {
        const { session, getState } = createSessionMock();
        const handler = new GeminiPermissionHandler(session);
        handler.setPermissionMode(mode);

        const result = await handler.handleToolCall(`change-title-${mode}`, 'change_title', { title: 'New title' });

        expect(result).toEqual({ decision: mode === 'yolo' ? 'approved_for_session' : 'approved' });
        expect(getState().completedRequests?.[`change-title-${mode}`]).toMatchObject({
            tool: 'change_title',
            status: 'approved',
            decision: mode === 'yolo' ? 'approved_for_session' : 'approved',
        });
    });
});
