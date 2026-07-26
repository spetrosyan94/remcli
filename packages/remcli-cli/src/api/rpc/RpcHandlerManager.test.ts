import { describe, expect, it, vi } from 'vitest';

import { decodeBase64, decrypt, encodeBase64 } from '@/api/encryption';
import { RpcHandlerManager } from './RpcHandlerManager';

describe('RpcHandlerManager', () => {
    it('does not invoke a handler when request params fail authenticated decryption', async () => {
        const encryptionKey = new Uint8Array(32).fill(3);
        const handler = vi.fn(() => ({ ok: true }));
        const manager = new RpcHandlerManager({
            scopePrefix: 'machine',
            encryptionKey,
            encryptionVariant: 'legacy',
        });
        manager.registerHandler('mutate', handler);

        const response = await manager.handleRequest({
            method: 'machine:mutate',
            params: encodeBase64(new Uint8Array([1, 2, 3])),
        });
        const decryptedResponse = decrypt(encryptionKey, 'legacy', decodeBase64(response));

        expect(handler).not.toHaveBeenCalled();
        expect(decryptedResponse).toEqual({ error: 'Invalid RPC params' });
    });
});
