import { describe, expect, it } from 'vitest';
import { MetadataSchema } from '@/lib/protocol/types';

describe('MetadataSchema execution outcome', () => {
    it('accepts typed error and success outcomes', () => {
        expect(MetadataSchema.safeParse({
            path: '/tmp/project',
            host: 'test-host',
            executionOutcome: { kind: 'error', occurredAt: 100 },
        }).success).toBe(true);
        expect(MetadataSchema.safeParse({
            path: '/tmp/project',
            host: 'test-host',
            executionOutcome: { kind: 'success', occurredAt: 101 },
        }).success).toBe(true);
    });

    it('accepts a trusted Cursor lineage parent reference and rejects empty ids', () => {
        expect(MetadataSchema.safeParse({
            path: '/tmp/project',
            host: 'test-host',
            resumedFromRemcliSessionId: 'parent-session',
        }).success).toBe(true);
        expect(MetadataSchema.safeParse({
            path: '/tmp/project',
            host: 'test-host',
            resumedFromRemcliSessionId: '',
        }).success).toBe(false);
    });

    it('rejects malformed execution outcomes instead of rendering an unknown status', () => {
        expect(MetadataSchema.safeParse({
            path: '/tmp/project',
            host: 'test-host',
            executionOutcome: { kind: 'error', occurredAt: 'now' },
        }).success).toBe(false);
    });

    it('accepts only a complete persisted Codex execution tuple', () => {
        expect(MetadataSchema.safeParse({
            path: '/tmp/project',
            host: 'test-host',
            codexExecution: {
                model: 'gpt-5.6-luna',
                reasoningEffort: 'xhigh',
                permissionMode: 'workspace-write',
            },
        }).success).toBe(true);
        expect(MetadataSchema.safeParse({
            path: '/tmp/project',
            host: 'test-host',
            codexExecution: {
                model: 'gpt-5.6-luna',
                permissionMode: 'default',
            },
        }).success).toBe(false);
        expect(MetadataSchema.safeParse({
            path: '/tmp/project',
            host: 'test-host',
            codexExecution: {
                model: '',
                permissionMode: 'workspace-write',
            },
        }).success).toBe(false);
    });
});
