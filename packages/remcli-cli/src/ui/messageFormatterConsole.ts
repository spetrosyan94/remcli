/**
 * Formats Claude SDK messages for console display.
 * Clean chat-like output: "User:" / "Claude:" prefixes, no tool details, parsed options.
 */

import type { SDKMessage, SDKAssistantMessage, SDKResultMessage, SDKSystemMessage, SDKUserMessage } from '@/claude/sdk';
import type { ConsoleRemoteDisplay } from '@/ui/ink/ConsoleRemoteDisplay';
import { logger } from './logger';

/** Extract <options> tags and format as "Варианты: a | b | c". Strip all other XML tags. */
function cleanAssistantText(text: string): string {
    // Replace <options>...</options> with formatted vertical list
    let result = text.replace(/<options>([\s\S]*?)<\/options>/g, (_, inner: string) => {
        const options = [...inner.matchAll(/<option>(.*?)<\/option>/g)].map(m => m[1].trim());
        if (options.length > 0) {
            const lines = options.map((opt, i) => `  ${i + 1}. ${opt}`);
            return `Варианты:\n${lines.join('\n')}`;
        }
        return '';
    });

    // Strip any remaining XML-like tags
    result = result.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').trim();

    return result;
}

/** Derive agent label from model name */
function deriveAgentLabel(model: string): string {
    const m = model.toLowerCase();
    if (m.includes('claude') || m.includes('opus') || m.includes('sonnet') || m.includes('haiku')) {
        return 'Claude';
    }
    if (m.includes('codex')) {
        return 'Codex';
    }
    if (m.includes('gemini')) {
        return 'Gemini';
    }
    return 'Assistant';
}

export function formatClaudeMessageForConsole(
    message: SDKMessage,
    display: ConsoleRemoteDisplay,
): void {
    logger.debugLargeJson('[CLAUDE CONSOLE] Message from remote mode:', message);

    switch (message.type) {
        case 'system': {
            const sysMsg = message as SDKSystemMessage;
            if (sysMsg.subtype === 'init') {
                const model = sysMsg.model || 'unknown';
                display.agentLabel = deriveAgentLabel(model);
                display.writeMessage(`${display.agentLabel} | ${model}`, 'system');
            }
            break;
        }

        case 'user': {
            const userMsg = message as SDKUserMessage;
            if (userMsg.message && typeof userMsg.message === 'object' && 'content' in userMsg.message) {
                const content = userMsg.message.content;

                if (typeof content === 'string') {
                    display.writeMessage(`User: ${content}`, 'user');
                }
                else if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === 'text' && block.text) {
                            display.writeMessage(`User: ${block.text}`, 'user');
                        }
                        // tool_result — skip (verbose, not useful for chat display)
                    }
                }
            }
            break;
        }

        case 'assistant': {
            const assistantMsg = message as SDKAssistantMessage;
            if (assistantMsg.message && assistantMsg.message.content) {
                for (const block of assistantMsg.message.content) {
                    if (block.type === 'text') {
                        const cleaned = cleanAssistantText(block.text || '');
                        if (cleaned) {
                            display.writeMessage(`${display.agentLabel}: ${cleaned}`, 'assistant');
                        }
                    }
                    // tool_use — skip entirely (user doesn't need to see tool names)
                }
            }
            break;
        }

        case 'result': {
            const resultMsg = message as SDKResultMessage;
            if (resultMsg.subtype === 'success') {
                // Skip result.result text — it duplicates the last assistant message
                if (resultMsg.usage) {
                    const cost = `$${resultMsg.total_cost_usd.toFixed(4)}`;
                    const duration = resultMsg.duration_ms < 1000
                        ? `${resultMsg.duration_ms}ms`
                        : `${(resultMsg.duration_ms / 1000).toFixed(1)}s`;
                    display.writeMessage(
                        `Turns: ${resultMsg.num_turns} | Cost: ${cost} | Duration: ${duration}`,
                        'status'
                    );
                }
            } else if (resultMsg.subtype === 'error_max_turns') {
                display.writeMessage(`Error: Max turns reached (${resultMsg.num_turns})`, 'result');
            } else if (resultMsg.subtype === 'error_during_execution') {
                display.writeMessage(`Error during execution (${resultMsg.num_turns} turns)`, 'result');
                logger.debugLargeJson('[RESULT] Error during execution', resultMsg);
            }
            break;
        }

        default: {
            if (process.env.DEBUG) {
                display.writeMessage(`[Unknown: ${message.type}]`, 'status');
            }
        }
    }
}
