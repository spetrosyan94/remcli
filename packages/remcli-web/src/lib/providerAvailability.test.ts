import { describe, expect, it } from 'vitest';
import { isProviderAvailable, PROVIDER_AVAILABILITY } from '@/lib/providerAvailability';

describe('shared provider availability', () => {
    it('keeps Claude deferred while Antigravity is capability-gated', () => {
        expect(PROVIDER_AVAILABILITY).toEqual({
            claude: { status: 'deferred' },
            codex: { status: 'available' },
            antigravity: { status: 'available' },
            unknown: { status: 'deferred' },
            cursor: { status: 'available' },
        });

        expect(isProviderAvailable('codex')).toBe(true);
        expect(isProviderAvailable('cursor')).toBe(true);
        expect(isProviderAvailable('claude')).toBe(false);
        expect(isProviderAvailable('antigravity')).toBe(true);
    });
});
