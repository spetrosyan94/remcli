import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AgentState } from '@/api/types';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import {
    CodexStructuredInputBroker,
    type CodexStructuredInputResponse,
    type CodexStructuredInputResponseResult,
    type CodexStructuredInputSession,
} from '@/codex/codexStructuredInputBroker';
import {
    expectTurnSucceeded,
    getRealCodexModel,
    getRealCodexReasoningEffort,
} from './codexRealTestUtils';

type RpcHandler = (request: unknown) => Promise<unknown>;

class RealAiStructuredInputSession implements CodexStructuredInputSession {
    state: AgentState = {};
    readonly handlers = new Map<string, RpcHandler>();

    readonly rpcHandlerManager = {
        registerHandler: <TRequest, TResponse>(
            method: string,
            handler: (request: TRequest) => Promise<TResponse>,
        ): void => {
            this.handlers.set(method, handler as unknown as RpcHandler);
        },
    };

    updateAgentState(handler: (state: AgentState) => AgentState): void {
        this.state = handler(this.state);
    }

    async respond(response: CodexStructuredInputResponse): Promise<CodexStructuredInputResponseResult> {
        const handler = this.handlers.get('codex-structured-input-response');
        if (!handler) throw new Error('structured response handler was not registered');
        return handler(response) as Promise<CodexStructuredInputResponseResult>;
    }
}

const runRealAi = process.env.REMCLI_REAL_AI === '1'
    && process.env.REMCLI_REAL_CODEX_STRUCTURED === '1';
const realAiDescribe = runRealAi ? describe : describe.skip;
const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixtureServer = join(packageRoot, 'tests/integration/fixtures/codexStructuredInputMcpServer.ts');
const threadIdsToDelete: string[] = [];

afterEach(() => {
    while (threadIdsToDelete.length > 0) {
        const threadId = threadIdsToDelete.pop();
        if (!threadId) continue;
        try {
            execFileSync('codex', ['delete', threadId, '--force'], { stdio: 'ignore' });
        } catch {
            // Cleanup must not hide the provider result.
        }
    }
});

type StructuredRequest = NonNullable<AgentState['codexStructuredRequests']>[string];

async function waitForRequest(
    session: RealAiStructuredInputSession,
    ignoredRequestKeys: ReadonlySet<string> = new Set(),
): Promise<StructuredRequest> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        const request = Object.values(session.state.codexStructuredRequests ?? {})
            .find((candidate) => !ignoredRequestKeys.has(candidate.requestKey));
        if (request) return request;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for Codex to call the structured-input MCP tool.');
}

function acceptedContent(request: StructuredRequest): Record<string, unknown> {
    return Object.fromEntries(request.fields.map((field) => {
        if (field.defaultValue !== undefined) return [field.id, field.defaultValue];
        if (field.type === 'boolean') return [field.id, true];
        if (field.type === 'select') return [field.id, field.options?.[0]?.value ?? 'approved'];
        if (field.type === 'multiselect') return [field.id, field.options?.[0] ? [field.options[0].value] : []];
        if (field.type === 'integer' || field.type === 'number') return [field.id, field.minimum ?? 0];
        return [field.id, 'approved'];
    }));
}

function acceptedApprovalResponse(request: StructuredRequest):
    | { answers: Record<string, string[]> }
    | { content: Record<string, unknown> } {
    if (request.kind === 'tool-input') {
        return {
            answers: Object.fromEntries(request.fields.map((field) => [
                field.id,
                [field.options?.[0]?.value ?? 'approved'],
            ])),
        };
    }
    if (request.kind === 'mcp-form') {
        return { content: acceptedContent(request) };
    }
    throw new Error(`Unexpected provider approval request kind: ${request.kind}`);
}

realAiDescribe('Codex real AI structured input', { timeout: 180_000 }, () => {
    it.each([
        ['request_standard_form', 'Choose standard release settings'],
        ['request_openai_form', 'Choose OpenAI release settings'],
    ] as const)('completes a real model turn through %s', async (tool, message) => {
        const session = new RealAiStructuredInputSession();
        const broker = new CodexStructuredInputBroker(session);
        const client = new CodexAppServerClient({
            appServerArgs: [
                '-c',
                `mcp_servers.remcli_structured_test.command=${JSON.stringify(process.execPath)}`,
                '-c',
                `mcp_servers.remcli_structured_test.args=${JSON.stringify(['--import', 'tsx', fixtureServer])}`,
                '-c',
                'mcp_servers.remcli_structured_test.startup_timeout_sec=20',
                '-c',
                'mcp_servers.remcli_structured_test.tool_timeout_sec=120',
            ],
        });
        client.setStructuredInputBroker(broker);
        const model = getRealCodexModel();
        let turn: Promise<Awaited<ReturnType<CodexAppServerClient['startTurn']>>> | null = null;

        try {
            const threadId = await client.startThread({
                cwd: packageRoot,
                sandbox: 'read-only',
                approvalPolicy: 'on-request',
                model,
            });
            threadIdsToDelete.push(threadId);
            turn = client.startTurn({
                threadId,
                prompt: `Call the MCP tool mcp__remcli_structured_test__${tool} exactly once. Do not answer the form yourself. After the tool returns, reply exactly FORM_OK.`,
                sandbox: 'read-only',
                approvalPolicy: 'on-request',
                model,
                effort: getRealCodexReasoningEffort(),
            });
            const handledRequestKeys = new Set<string>();
            let request = await waitForRequest(session, handledRequestKeys);
            while (request.message !== message) {
                handledRequestKeys.add(request.requestKey);
                await expect(session.respond({
                    requestKey: request.requestKey,
                    submissionId: `${tool}-approval-${handledRequestKeys.size}`,
                    action: 'submit',
                    ...acceptedApprovalResponse(request),
                })).resolves.toEqual({ status: 'submitted' });
                request = await waitForRequest(session, handledRequestKeys);
            }
            expect(request).toMatchObject({ kind: 'mcp-form', message });
            await expect(session.respond({
                requestKey: request.requestKey,
                submissionId: `${tool}-real-ai`,
                action: 'submit',
                content: { channel: 'stable', retries: 2 },
            })).resolves.toEqual({ status: 'submitted' });
            const result = await turn;
            expectTurnSucceeded(result, `structured input ${tool}`, model);
            turn = null;
        } finally {
            await turn?.catch(() => undefined);
            await client.disconnect().catch(() => undefined);
        }
    });
});
