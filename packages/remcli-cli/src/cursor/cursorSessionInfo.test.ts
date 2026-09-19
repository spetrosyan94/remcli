import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';
import { applyCursorSessionInfoUpdate, hasCursorNativeTitleDirective } from './cursorSessionInfo';

const BASE_METADATA: Metadata = {
    path: '/repo',
    host: 'mac',
    homeDir: '/home/user',
    remcliHomeDir: '/home/user/.remcli',
    remcliLibDir: '/app',
    remcliToolsDir: '/app/tools',
};

describe('Cursor session info projection', () => {
    it('normalizes and bounds a native title while preserving its timestamp', () => {
        const metadata = applyCursorSessionInfoUpdate(BASE_METADATA, {
            title: `  Native\n${'title '.repeat(20)}  `,
            updatedAt: '2026-09-20T02:00:00.000Z',
        });

        expect(metadata.summary).toEqual({
            text: expect.stringMatching(/^Native title .+\.\.\.$/),
            updatedAt: Date.parse('2026-09-20T02:00:00.000Z'),
        });
        expect(metadata.summary?.text).toHaveLength(60);
    });

    it('updates the timestamp without replacing an existing title', () => {
        const metadata = applyCursorSessionInfoUpdate({
            ...BASE_METADATA,
            summary: { text: 'Existing title', updatedAt: 1 },
        }, { updatedAt: '2026-09-20T03:00:00.000Z' });

        expect(metadata.summary).toEqual({
            text: 'Existing title',
            updatedAt: Date.parse('2026-09-20T03:00:00.000Z'),
        });
    });

    it('clears the native title only for an explicit null directive', () => {
        const source = {
            ...BASE_METADATA,
            summary: { text: 'Native title', updatedAt: 1 },
        };

        expect(applyCursorSessionInfoUpdate(source, { title: null })).not.toHaveProperty('summary');
        expect(applyCursorSessionInfoUpdate(source, { title: '  ', updatedAt: 'invalid' })).toBe(source);
        expect(hasCursorNativeTitleDirective({ title: null })).toBe(true);
        expect(hasCursorNativeTitleDirective({ title: '  ' })).toBe(false);
    });

    it('lets the first native title replace a newer local fallback timestamp', () => {
        const source = {
            ...BASE_METADATA,
            summary: {
                text: 'Local fallback title',
                updatedAt: Date.parse('2026-09-20T04:00:00.000Z'),
            },
        };

        expect(applyCursorSessionInfoUpdate(source, {
            title: 'Native title',
            updatedAt: '2026-09-20T03:00:00.000Z',
        }).summary).toEqual({
            text: 'Native title',
            updatedAt: Date.parse('2026-09-20T03:00:00.000Z'),
        });
    });

    it('maps nullable ACP timestamps without inventing a nullable Remcli summary', () => {
        const source = {
            ...BASE_METADATA,
            summary: { text: 'Native title', updatedAt: 100 },
        };

        expect(applyCursorSessionInfoUpdate(source, {
            title: 'Native title',
            updatedAt: null,
        })).toBe(source);
        expect(applyCursorSessionInfoUpdate(source, {
            title: 'New native title',
            updatedAt: null,
        }, () => 200).summary).toEqual({
            text: 'New native title',
            updatedAt: 200,
        });
        expect(applyCursorSessionInfoUpdate(source, {
            title: null,
            updatedAt: '2026-09-20T05:00:00.000Z',
        })).not.toHaveProperty('summary');
    });
});
