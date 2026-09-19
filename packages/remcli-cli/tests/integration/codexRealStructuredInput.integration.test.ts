import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

type RpcHandler = (request: unknown) => Promise<unknown>;

class RealStructuredInputSession implements CodexStructuredInputSession {
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

const runRealMcp = process.env.REMCLI_REAL_CODEX_MCP === '1';
const realMcpDescribe = runRealMcp ? describe : describe.skip;
const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const fixtureServer = join(packageRoot, 'tests/integration/fixtures/codexStructuredInputMcpServer.ts');

let codexHome: string;

beforeEach(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'remcli-codex-structured-'));
    writeFileSync(join(codexHome, 'config.toml'), [
        '[mcp_servers.remcli_structured_test]',
        `command = ${JSON.stringify(process.execPath)}`,
        `args = [${JSON.stringify('--import')}, ${JSON.stringify('tsx')}, ${JSON.stringify(fixtureServer)}]`,
        'startup_timeout_sec = 20',
        'tool_timeout_sec = 120',
        '',
    ].join('\n'), { mode: 0o600 });
});

afterEach(() => {
    rmSync(codexHome, { recursive: true, force: true });
});

async function waitForRequest(session: RealStructuredInputSession): Promise<NonNullable<AgentState['codexStructuredRequests']>[string]> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const request = Object.values(session.state.codexStructuredRequests ?? {})[0];
        if (request) return request;
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for a real Codex MCP elicitation request.');
}

realMcpDescribe('Codex real MCP structured input', { timeout: 60_000 }, () => {
    it.each([
        ['request_standard_form', 'Choose standard release settings'],
        ['request_openai_form', 'Choose OpenAI release settings'],
    ] as const)('round-trips %s through app-server and the real MCP process', async (tool, message) => {
        const session = new RealStructuredInputSession();
        const broker = new CodexStructuredInputBroker(session);
        const client = new CodexAppServerClient({
            appServerEnv: { ...process.env, CODEX_HOME: codexHome },
        });
        client.setStructuredInputBroker(broker);

        try {
            const threadId = await client.startThread({
                cwd: packageRoot,
                sandbox: 'read-only',
                approvalPolicy: 'on-request',
                ephemeral: true,
            });
            const toolCall = client.callMcpServerTool({
                threadId,
                server: 'remcli_structured_test',
                tool,
                arguments: {},
            });
            const request = await Promise.race([
                waitForRequest(session),
                toolCall.then((result) => {
                    throw new Error(`Codex MCP tool completed before elicitation: ${JSON.stringify(result)}`);
                }),
            ]);

            expect(request).toMatchObject({
                kind: 'mcp-form',
                message,
                serverName: 'remcli_structured_test',
            });
            await expect(session.respond({
                requestKey: request.requestKey,
                submissionId: `${tool}-submission`,
                action: 'submit',
                content: { channel: 'stable', retries: 2 },
            })).resolves.toEqual({ status: 'submitted' });

            const result = await toolCall as { structuredContent?: unknown; isError?: boolean };
            expect(result.isError).not.toBe(true);
            expect(result.structuredContent).toEqual({
                action: 'accept',
                content: { channel: 'stable', retries: 2 },
            });
        } finally {
            await client.disconnect().catch(() => undefined);
        }
    });
});
