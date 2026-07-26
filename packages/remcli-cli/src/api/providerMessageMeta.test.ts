import { describe, expect, it } from 'vitest';

import { parseProviderUserMessage } from './providerMessageMeta';

function createUserMessage(meta?: Record<string, unknown>): Record<string, unknown> {
    return {
        role: 'user',
        content: {
            type: 'text',
            text: 'Continue with the task.',
        },
        ...(meta ? { meta } : {}),
    };
}

describe('parseProviderUserMessage', () => {
    it.each(['codex', 'cursor'] as const)('rejects forged per-turn controls for %s', (flavor) => {
        expect(parseProviderUserMessage(flavor, createUserMessage({
            sentFrom: 'web',
            model: 'forged-model',
            permissionMode: 'danger-full-access',
        })).success).toBe(false);

        expect(parseProviderUserMessage(flavor, {
            ...createUserMessage({ sentFrom: 'web' }),
            provider: 'claude',
        }).success).toBe(false);
    });

    it.each(['codex', 'cursor'] as const)('rejects internal sentFrom values for %s', (flavor) => {
        for (const sentFrom of ['history', 'native-app-server', 'cli']) {
            expect(parseProviderUserMessage(flavor, createUserMessage({ sentFrom })).success).toBe(false);
        }
    });

    it('accepts only text, localKey, and a safe sentFrom for Codex live ingress', () => {
        expect(parseProviderUserMessage('codex', {
            ...createUserMessage({ sentFrom: 'phone' }),
            localKey: 'local-key',
        })).toEqual({
            success: true,
            data: {
                role: 'user',
                content: {
                    type: 'text',
                    text: 'Continue with the task.',
                },
                localKey: 'local-key',
                meta: {
                    sentFrom: 'phone',
                },
            },
        });
    });

    it('keeps display text as harmless legacy metadata for Codex live ingress', () => {
        expect(parseProviderUserMessage('codex', createUserMessage({
            sentFrom: 'web',
            displayText: 'Visible user prompt',
        }))).toMatchObject({
            success: true,
            data: {
                meta: {
                    sentFrom: 'web',
                    displayText: 'Visible user prompt',
                },
            },
        });
    });

    it('accepts Claude legacy per-turn controls only through the Claude schema', () => {
        expect(parseProviderUserMessage('claude', createUserMessage({
            sentFrom: 'web',
            permissionMode: 'acceptEdits',
            model: 'claude-model',
            fallbackModel: 'claude-fallback',
            customSystemPrompt: 'custom instructions',
            appendSystemPrompt: 'extra instructions',
            allowedTools: ['Read'],
            disallowedTools: ['Bash'],
        })).success).toBe(true);

        expect(parseProviderUserMessage('claude', createUserMessage({
            permissionMode: 'workspace-write',
        })).success).toBe(false);

        expect(parseProviderUserMessage('claude', createUserMessage({
            sentFrom: 'web',
            provider: 'codex',
        })).success).toBe(false);
    });

    it('accepts Gemini legacy per-turn controls only through the Gemini schema', () => {
        expect(parseProviderUserMessage('gemini', createUserMessage({
            sentFrom: 'phone',
            permissionMode: 'auto_edit',
            model: 'gemini-model',
            appendSystemPrompt: 'extra instructions',
        })).success).toBe(true);

        expect(parseProviderUserMessage('gemini', createUserMessage({
            permissionMode: 'bypassPermissions',
        })).success).toBe(false);

        expect(parseProviderUserMessage('gemini', createUserMessage({
            fallbackModel: 'foreign-control',
        })).success).toBe(false);
    });

    it.each([undefined, 'unknown-provider'])('allows only safe prompts when flavor is %s', (flavor) => {
        expect(parseProviderUserMessage(flavor, createUserMessage({
            sentFrom: 'phone',
            displayText: 'Continue from my phone.',
        })).success).toBe(true);

        expect(parseProviderUserMessage(flavor, createUserMessage({
            permissionMode: 'manual',
        })).success).toBe(false);
        expect(parseProviderUserMessage(flavor, createUserMessage({
            model: 'forged-model',
        })).success).toBe(false);
        expect(parseProviderUserMessage(flavor, createUserMessage({
            allowedTools: ['Bash'],
        })).success).toBe(false);
        expect(parseProviderUserMessage(flavor, createUserMessage({
            sentFrom: 'native-app-server',
        })).success).toBe(false);
    });

    it.each(['__proto__', 'constructor', 'toString'])('treats prototype property %s as an unknown flavor', (flavor) => {
        expect(() => parseProviderUserMessage(flavor, createUserMessage({
            sentFrom: 'phone',
        }))).not.toThrow();
        expect(parseProviderUserMessage(flavor, createUserMessage({
            sentFrom: 'phone',
        })).success).toBe(true);
        expect(parseProviderUserMessage(flavor, createUserMessage({
            model: 'forged-model',
        })).success).toBe(false);
    });
});
