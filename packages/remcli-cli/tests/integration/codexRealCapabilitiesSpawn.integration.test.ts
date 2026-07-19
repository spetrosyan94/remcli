import { execFileSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import {
    fetchCodexCapabilities,
    getDefaultCodexExecution,
    validateCodexExecution,
    type CodexCapabilitiesSnapshot,
    type CodexExecutionConfig,
} from '@/codex/codexCapabilities';
import { resolveCodexPermissionConfig } from '@/codex/runCodex';
import type { CodexSandbox } from '@/codex/types';
import { expectTurnSucceeded } from './codexRealTestUtils';

const runRealAi = process.env.REMCLI_REAL_AI === '1';

interface LiveCapabilitySelection {
    execution: CodexExecutionConfig;
    permissionMode: CodexSandbox;
}

function selectLiveCapabilitySelection(snapshot: CodexCapabilitiesSnapshot): LiveCapabilitySelection | null {
    const execution = getDefaultCodexExecution(snapshot);
    const permissionMode = snapshot.permissionModes[0];
    if (!execution || !permissionMode) {
        return null;
    }

    return {
        execution,
        permissionMode,
    };
}

function formatCleanupFailure(error: unknown): string {
    if (error && typeof error === 'object') {
        const failure = error as NodeJS.ErrnoException & { status?: unknown };
        if (typeof failure.status === 'number') {
            return `exit status ${failure.status}`;
        }
        if (typeof failure.code === 'string') {
            return `error code ${failure.code}`;
        }
    }
    return error instanceof Error ? error.name : 'unknown failure';
}

async function hasRunnableLiveCapabilitySelection(): Promise<boolean> {
    const client = new CodexAppServerClient();
    try {
        const snapshot = await fetchCodexCapabilities(client);
        return selectLiveCapabilitySelection(snapshot) !== null;
    } catch {
        return false;
    } finally {
        await client.disconnect().catch(() => undefined);
    }
}

const realCodexDescribe = runRealAi && await hasRunnableLiveCapabilitySelection()
    ? describe
    : describe.skip;

realCodexDescribe('Codex real capabilities spawn contract', { timeout: 180_000 }, () => {
    it('uses live provider defaults for the first native thread and turn through the narrow app-server boundary (no daemon P2P/UI spawn)', async (context) => {
        const client = new CodexAppServerClient();
        const startThread = vi.spyOn(client, 'startThread');
        const startTurn = vi.spyOn(client, 'startTurn');
        let nativeThreadId: string | null = null;
        let lifecycleFailed = false;

        try {
            const snapshot = await fetchCodexCapabilities(client);
            const selection = selectLiveCapabilitySelection(snapshot);
            if (!selection) {
                context.skip('Live Codex capabilities no longer expose an executable selection after the opt-in preflight.');
            }

            validateCodexExecution(snapshot, selection.execution, selection.permissionMode);
            const permission = resolveCodexPermissionConfig(selection.permissionMode);

            nativeThreadId = await client.startThread({
                cwd: process.cwd(),
                sandbox: permission.sandbox,
                approvalPolicy: permission.approvalPolicy,
                model: selection.execution.model,
            });
            const turn = await client.startTurn({
                threadId: nativeThreadId,
                prompt: 'Reply exactly OK. Do not use tools.',
                sandbox: permission.sandbox,
                approvalPolicy: permission.approvalPolicy,
                model: selection.execution.model,
                ...(selection.execution.reasoningEffort !== undefined
                    ? { effort: selection.execution.reasoningEffort }
                    : {}),
            });

            expect(startThread).toHaveBeenCalledTimes(1);
            expect(startThread).toHaveBeenCalledWith(expect.objectContaining({
                model: selection.execution.model,
            }));
            expect(startTurn).toHaveBeenCalledTimes(1);
            expect(startTurn).toHaveBeenCalledWith(expect.objectContaining({
                model: selection.execution.model,
            }));
            const firstTurnOptions = startTurn.mock.calls[0]?.[0];
            if (selection.execution.reasoningEffort !== undefined) {
                expect(firstTurnOptions).toEqual(expect.objectContaining({
                    effort: selection.execution.reasoningEffort,
                }));
            } else {
                expect(firstTurnOptions).not.toHaveProperty('effort');
            }
            expectTurnSucceeded(turn, 'capability-selected first turn', selection.execution.model);
        } catch (error) {
            lifecycleFailed = true;
            throw error;
        } finally {
            startThread.mockRestore();
            startTurn.mockRestore();
            await client.disconnect().catch(() => undefined);
            if (nativeThreadId) {
                try {
                    execFileSync('codex', ['delete', nativeThreadId, '--force'], { stdio: 'ignore' });
                } catch (error) {
                    const message = `Failed to delete the created real Codex thread during cleanup (${formatCleanupFailure(error)}).`;
                    if (lifecycleFailed) {
                        console.warn(`[Codex real capabilities spawn] ${message}`);
                    } else {
                        throw new Error(message);
                    }
                }
            }
        }
    });
});
