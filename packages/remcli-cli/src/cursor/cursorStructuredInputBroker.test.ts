import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentState, CursorStructuredInputResponse } from '@/api/types';
import { CursorStructuredInputBroker, type CursorStructuredSession } from './cursorStructuredInputBroker';

type ResponseHandler = (response: CursorStructuredInputResponse) => Promise<{ status: 'submitted' | 'already-resolved' }>;

function createSession(): {
    session: CursorStructuredSession;
    state: () => AgentState;
    response: () => ResponseHandler;
} {
    let state: AgentState = {};
    let responseHandler: ResponseHandler | undefined;
    return {
        session: {
            rpcHandlerManager: {
                registerHandler: (_method, handler) => {
                    responseHandler = handler as unknown as ResponseHandler;
                },
            },
            updateAgentState: (update) => { state = update(state); },
        },
        state: () => state,
        response: () => {
            if (!responseHandler) throw new Error('response handler not registered');
            return responseHandler;
        },
    };
}

const questionParams = {
    toolCallId: 'question-tool',
    title: 'Review scope',
    questions: [
        {
            id: 'scope',
            prompt: 'What should be reviewed?',
            options: [
                { id: 'web', label: 'Web' },
                { id: 'daemon', label: 'Daemon' },
            ],
        },
        {
            id: 'checks',
            prompt: 'Which checks?',
            options: [
                { id: 'tests', label: 'Tests' },
                { id: 'browser', label: 'Browser' },
            ],
            allowMultiple: true,
        },
    ],
};

afterEach(() => vi.useRealTimers());

describe('CursorStructuredInputBroker', () => {
    it('publishes a safe question projection and maps answers to Cursor ACP', async () => {
        const fixture = createSession();
        const broker = new CursorStructuredInputBroker(fixture.session);
        const native = broker.handleRequest({
            method: 'cursor/ask_question',
            params: questionParams,
            nativeSessionId: 'native-1',
            turnGeneration: 1,
        });

        const request = Object.values(fixture.state().cursorStructuredRequests ?? {})[0]!;
        expect(request).toMatchObject({
            kind: 'cursor-question',
            message: 'Review scope',
            fields: [
                { id: 'scope', type: 'select', required: true },
                { id: 'checks', type: 'multiselect', required: true, minItems: 1 },
            ],
        });
        expect(JSON.stringify(request)).not.toContain('question-tool');

        await expect(fixture.response()({
            requestKey: request.requestKey,
            submissionId: 'submission-1',
            action: 'submit',
            answers: { scope: ['web'], checks: ['tests', 'browser'] },
        })).resolves.toEqual({ status: 'submitted' });
        await expect(native).resolves.toEqual({
            outcome: {
                outcome: 'answered',
                answers: [
                    { questionId: 'scope', selectedOptionIds: ['web'] },
                    { questionId: 'checks', selectedOptionIds: ['tests', 'browser'] },
                ],
            },
        });
        expect(fixture.state().cursorStructuredRequests).toBeUndefined();
    });

    it('maps plan decisions and never publishes provider toolCallId', async () => {
        const fixture = createSession();
        const broker = new CursorStructuredInputBroker(fixture.session);
        const native = broker.handleRequest({
            method: 'cursor/create_plan',
            params: {
                toolCallId: 'plan-tool',
                name: 'Ship forms',
                overview: 'Add native approvals.',
                plan: '1. Validate\n2. Bridge\n3. Verify',
                todos: [{ id: 'one', content: 'Validate payload', status: 'completed' }],
                phases: [{ name: 'Delivery', todos: [{ id: 'two', content: 'Verify UI', status: 'pending' }] }],
                isProject: true,
            },
            nativeSessionId: 'native-1',
            turnGeneration: 2,
        });
        const request = Object.values(fixture.state().cursorStructuredRequests ?? {})[0]!;
        expect(request).toMatchObject({ kind: 'cursor-plan', plan: { name: 'Ship forms', isProject: true } });
        expect(JSON.stringify(request)).not.toContain('plan-tool');

        await fixture.response()({
            requestKey: request.requestKey,
            submissionId: 'submission-2',
            action: 'decline',
        });
        await expect(native).resolves.toEqual({ outcome: { outcome: 'rejected' } });
    });

    it('rejects invalid payloads fail-closed without publishing them', async () => {
        const fixture = createSession();
        const warning = vi.fn();
        const broker = new CursorStructuredInputBroker(fixture.session, { onWarning: warning });
        await expect(broker.handleRequest({
            method: 'cursor/ask_question',
            params: { ...questionParams, secret: 'must-not-persist' },
            nativeSessionId: 'native-1',
            turnGeneration: 1,
        })).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
        expect(fixture.state().cursorStructuredRequests).toBeUndefined();
        expect(warning).toHaveBeenCalledOnce();
    });

    it('cancels pending requests on timeout and turn cleanup', async () => {
        vi.useFakeTimers();
        const fixture = createSession();
        const broker = new CursorStructuredInputBroker(fixture.session, { timeoutMs: 50 });
        const timedOut = broker.handleRequest({ method: 'cursor/ask_question', params: questionParams, nativeSessionId: 'native-1', turnGeneration: 1 });
        await vi.advanceTimersByTimeAsync(50);
        await expect(timedOut).resolves.toEqual({ outcome: { outcome: 'cancelled' } });

        const cleared = broker.handleRequest({ method: 'cursor/ask_question', params: { ...questionParams, toolCallId: 'question-2' }, nativeSessionId: 'native-1', turnGeneration: 2 });
        broker.clearForTurn('native-1', 2);
        await expect(cleared).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    });

    it('republishes pending state on session swap and rejects the old RPC epoch', async () => {
        const first = createSession();
        const second = createSession();
        const broker = new CursorStructuredInputBroker(first.session);
        const native = broker.handleRequest({ method: 'cursor/ask_question', params: questionParams, nativeSessionId: 'native-1', turnGeneration: 1 });
        const request = broker.getPendingState()[0]!;
        const staleHandler = first.response();

        broker.updateSession(second.session);
        expect(second.state().cursorStructuredRequests?.[request.requestKey]).toBeDefined();
        await expect(staleHandler({ requestKey: request.requestKey, submissionId: 'stale', action: 'cancel' })).resolves.toEqual({ status: 'already-resolved' });
        await expect(second.response()({ requestKey: request.requestKey, submissionId: 'fresh', action: 'cancel' })).resolves.toEqual({ status: 'submitted' });
        await expect(native).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    });

    it('replays a settled native outcome without publishing a duplicate form', async () => {
        const fixture = createSession();
        const broker = new CursorStructuredInputBroker(fixture.session);
        const context = {
            method: 'cursor/ask_question' as const,
            params: questionParams,
            nativeSessionId: 'native-1',
            turnGeneration: 1,
        };
        const first = broker.handleRequest(context);
        const request = Object.values(fixture.state().cursorStructuredRequests ?? {})[0]!;

        await fixture.response()({
            requestKey: request.requestKey,
            submissionId: 'submission-1',
            action: 'submit',
            answers: { scope: ['web'], checks: ['tests'] },
        });
        const firstOutcome = await first;

        await expect(broker.handleRequest(context)).resolves.toEqual(firstOutcome);
        expect(fixture.state().cursorStructuredRequests).toBeUndefined();
    });
});
