import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { expectTurnSucceeded, getRealCodexModel, responseText } from './codexRealTestUtils';

const runRealAi = process.env.REMCLI_REAL_AI === '1';
const realCodexDescribe = runRealAi ? describe : describe.skip;

const threadIdsToDelete: string[] = [];

afterEach(() => {
    while (threadIdsToDelete.length > 0) {
        const threadId = threadIdsToDelete.pop();
        if (!threadId) continue;
        try {
            execFileSync('codex', ['delete', threadId, '--force'], { stdio: 'ignore' });
        } catch {
            // Best effort cleanup: the test should report lifecycle failures, not cleanup noise.
        }
    }
});

realCodexDescribe('Codex real lifecycle smoke', { timeout: 180_000 }, () => {
    it('creates a real Codex thread, resumes it, and preserves context', async () => {
        await runLifecycleSmoke(getRealCodexModel());
    });
});

async function runLifecycleSmoke(model: string): Promise<void> {
    const token = `REMCLI_SMOKE_${Date.now()}_${model.replace(/[^a-z0-9]+/gi, '_')}`;
    const firstClient = new CodexAppServerClient();
    const resumedClient = new CodexAppServerClient();
    const firstMessages: string[] = [];
    firstClient.setHandler((event) => {
        if (event?.type === 'agent_message' && typeof event.message === 'string') {
            firstMessages.push(event.message);
        }
    });

    try {
        const threadId = await firstClient.startThread({
            cwd: process.cwd(),
            sandbox: 'read-only',
            approvalPolicy: 'never',
            model,
        });
        threadIdsToDelete.push(threadId);

        const firstTurn = await firstClient.startTurn({
            threadId,
            prompt: `Контекст для проверки: session_token=${token}. Не используй инструменты. Ответь ровно OK.`,
            sandbox: 'read-only',
            approvalPolicy: 'on-request',
            model,
        });
        expectTurnSucceeded(firstTurn, 'seed turn', model);
        await firstClient.disconnect();

        expect(firstMessages.join('\n')).not.toContain('Session not found');

        const resumedMessages: string[] = [];
        resumedClient.setHandler((event) => {
            if (event?.type === 'agent_message' && typeof event.message === 'string') {
                resumedMessages.push(event.message);
            }
        });

        await resumedClient.resumeThread({
            threadId,
            cwd: process.cwd(),
            sandbox: 'read-only',
            approvalPolicy: 'never',
            model,
        });
        const resumedTurn = await resumedClient.startTurn({
            threadId,
            prompt: 'Какое значение session_token было в предыдущем сообщении? Не используй инструменты. Ответь только значением.',
            sandbox: 'read-only',
            approvalPolicy: 'on-request',
            model,
        });
        expectTurnSucceeded(resumedTurn, 'resume turn', model);
        await resumedClient.disconnect();

        const answer = [resumedMessages.join('\n'), responseText(resumedTurn)].filter(Boolean).join('\n');
        expect(answer).not.toContain('Session not found');
        expect(answer, 'Codex resume turn did not emit an agent_message response').not.toBe('');
        expect(answer).toContain(token);
    } finally {
        await firstClient.disconnect().catch(() => undefined);
        await resumedClient.disconnect().catch(() => undefined);
    }
}
