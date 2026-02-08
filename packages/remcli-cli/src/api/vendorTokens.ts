/**
 * Local storage for vendor API tokens
 *
 * Stores tokens in ~/.remcli/vendor-tokens.json instead of cloud endpoints.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';

type VendorName = 'openai' | 'anthropic' | 'gemini';

interface VendorTokenStore {
    [vendor: string]: unknown;
}

function getStorePath(): string {
    return join(configuration.remcliHomeDir, 'vendor-tokens.json');
}

function readStore(): VendorTokenStore {
    const path = getStorePath();
    if (!existsSync(path)) {
        return {};
    }
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
        logger.debug('[VENDOR-TOKENS] Failed to parse vendor-tokens.json, returning empty');
        return {};
    }
}

function writeStore(store: VendorTokenStore): void {
    writeFileSync(getStorePath(), JSON.stringify(store, null, 2), 'utf-8');
}

export function registerVendorToken(vendor: VendorName, tokenData: unknown): void {
    const store = readStore();
    store[vendor] = tokenData;
    writeStore(store);
    logger.debug(`[VENDOR-TOKENS] Token for ${vendor} saved locally`);
}

export function getVendorToken(vendor: VendorName): unknown | null {
    const store = readStore();
    return store[vendor] ?? null;
}
