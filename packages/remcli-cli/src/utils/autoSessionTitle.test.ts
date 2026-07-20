import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';

const loggerMocks = vi.hoisted(() => ({ debug: vi.fn() }));

vi.mock('@/ui/logger', () => ({
    logger: loggerMocks,
}));

import { createAutoTitleSetter } from './autoSessionTitle';

describe('createAutoTitleSetter', () => {
    it('stores one summary without logging the user prompt', () => {
        const updateMetadata = vi.fn((update: (metadata: Record<string, unknown>) => Record<string, unknown>) => {
            update({});
            return Promise.resolve();
        });
        const session = { updateMetadata } as unknown as ApiSessionClient;
        const setter = createAutoTitleSetter(session);
        const prompt = 'Inspect the payment retry path before the next release.';

        setter(prompt);
        setter('This must not replace the original summary.');

        expect(updateMetadata).toHaveBeenCalledOnce();
        const metadata = updateMetadata.mock.calls[0]?.[0]({});
        expect(metadata?.summary).toEqual(expect.objectContaining({ text: prompt }));
        expect(loggerMocks.debug).not.toHaveBeenCalled();
    });
});
