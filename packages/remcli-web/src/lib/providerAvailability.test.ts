import { describe, expect, it } from 'vitest';
import { isProviderAvailable, PROVIDER_AVAILABILITY } from '@/lib/providerAvailability';

describe('shared provider availability', () => {
    it('keeps Codex and Cursor available while Claude and Gemini remain deferred', () => {
        expect(PROVIDER_AVAILABILITY).toEqual({
            claude: { status: 'deferred' },
            codex: { status: 'available' },
            gemini: { status: 'deferred' },
            cursor: { status: 'available' },
        });

        expect(isProviderAvailable('codex')).toBe(true);
        expect(isProviderAvailable('cursor')).toBe(true);
        expect(isProviderAvailable('claude')).toBe(false);
        expect(isProviderAvailable('gemini')).toBe(false);
    });
});
