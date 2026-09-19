import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new McpServer({
    name: 'remcli-structured-input-test',
    version: '1.0.0',
});

const requestedSchema = {
    type: 'object' as const,
    properties: {
        channel: {
            type: 'string' as const,
            title: 'Release channel',
            enum: ['stable', 'preview'],
        },
        retries: {
            type: 'integer' as const,
            title: 'Retries',
            minimum: 0,
            maximum: 3,
            default: 1,
        },
    },
    required: ['channel'],
};

function toolResult(result: unknown) {
    return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        structuredContent: result,
    };
}

server.registerTool('request_standard_form', {
    description: 'Request a standard MCP form for Remcli integration testing.',
    inputSchema: {},
}, async () => toolResult(await server.server.elicitInput({
    mode: 'form',
    message: 'Choose standard release settings',
    requestedSchema,
})));

server.registerTool('request_openai_form', {
    description: 'Request an OpenAI form extension for Remcli integration testing.',
    inputSchema: {},
}, async () => {
    const result = await (server.server.request as unknown as (
        request: unknown,
        schema: typeof ElicitResultSchema,
    ) => Promise<unknown>)(
        {
            method: 'elicitation/create',
            params: {
                mode: 'openai/form',
                message: 'Choose OpenAI release settings',
                requestedSchema,
            },
        },
        ElicitResultSchema,
    );
    return toolResult(result);
});

await server.connect(new StdioServerTransport());
