import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import type { CodexToolResponse } from '@/codex/types';

const runRealAi = process.env.REMCLI_REAL_AI === '1';
const realCodexDescribe = runRealAi ? describe : describe.skip;
const realCodexModel = process.env.REMCLI_REAL_CODEX_MODEL ?? 'gpt-5.3-codex-spark';

let threadIdToDelete: string | null = null;

function responseText(response: CodexToolResponse): string {
    return response.content
        .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n');
}

function expectTurnSucceeded(response: CodexToolResponse, phase: string): void {
    if (!response.isError) return;
    throw new Error(`Codex ${phase} failed: ${responseText(response) || 'unknown app-server error'}`);
}

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

        const firstTurn = await firstClient.startTurn({
            threadId,
            prompt: `Запомни токен ${token}. Ответь только OK.`,
            sandbox: 'read-only',
            approvalPolicy: 'never',
            model: realCodexModel,
        });
        expectTurnSucceeded(firstTurn, 'seed turn');
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
        const resumedTurn = await resumedClient.startTurn({
            threadId,
            prompt: 'Какой токен я попросил запомнить? Ответь только токеном.',
            sandbox: 'read-only',
            approvalPolicy: 'never',
            model: realCodexModel,
        });
        expectTurnSucceeded(resumedTurn, 'resume turn');
        await resumedClient.disconnect();

        const answer = [resumedMessages.join('\n'), responseText(resumedTurn)].filter(Boolean).join('\n');
        expect(answer).not.toContain('Session not found');
        expect(answer, 'Codex resume turn did not emit an agent_message response').not.toBe('');
        expect(answer).toContain(token);
    });
});
