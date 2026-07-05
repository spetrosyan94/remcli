import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

import { CodexAppServerClient } from '@/codex/codexAppServerClient';

const runRealAi = process.env.REMCLI_REAL_AI === '1';
const realCodexDescribe = runRealAi ? describe : describe.skip;
const realCodexModel = process.env.REMCLI_REAL_CODEX_MODEL ?? 'gpt-5.3-codex-spark';

let threadIdToDelete: string | null = null;

afterEach(() => {
    if (!threadIdToDelete) return;
    try {
        execFileSync('codex', ['delete', threadIdToDelete, '--force'], { stdio: 'ignore' });
    } catch {
        // Best effort cleanup: the test should report lifecycle failures, not cleanup noise.
    } finally {
        threadIdToDelete = null;
    }
});

realCodexDescribe('Codex real lifecycle smoke', { timeout: 180_000 }, () => {
    it('creates a real Codex thread, resumes it, and preserves context', async () => {
        const token = `REMCLI_SMOKE_${Date.now()}`;
        const firstClient = new CodexAppServerClient();
        const firstMessages: string[] = [];
        firstClient.setHandler((event) => {
            if (event?.type === 'agent_message' && typeof event.message === 'string') {
                firstMessages.push(event.message);
            }
        });

        const threadId = await firstClient.startThread({
            cwd: process.cwd(),
            sandbox: 'read-only',
            approvalPolicy: 'never',
            model: realCodexModel,
        });
        threadIdToDelete = threadId;

        await firstClient.startTurn({
            threadId,
            prompt: `Запомни токен ${token}. Ответь только OK.`,
            sandbox: 'read-only',
            approvalPolicy: 'never',
            model: realCodexModel,
        });
        await firstClient.disconnect();

        expect(firstMessages.join('\n')).not.toContain('Session not found');

        const resumedClient = new CodexAppServerClient();
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
            model: realCodexModel,
        });
        await resumedClient.startTurn({
            threadId,
            prompt: 'Какой токен я попросил запомнить? Ответь только токеном.',
            sandbox: 'read-only',
            approvalPolicy: 'never',
            model: realCodexModel,
        });
        await resumedClient.disconnect();

        const answer = resumedMessages.join('\n');
        expect(answer).not.toContain('Session not found');
        expect(answer).toContain(token);
    });
});
