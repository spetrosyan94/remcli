import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { P2PStore } from './p2pStore';
import { getWebStaticCacheControl, isWebStaticAssetRequest, startP2PServer } from './p2pServer';

describe('web static asset policy', () => {
    it('revalidates the Vite entry chunk but keeps route chunks immutable', () => {
        expect(getWebStaticCacheControl('/tmp/web-dist/assets/index-abc123.js')).toBe('no-cache');
        expect(getWebStaticCacheControl('/tmp/web-dist/assets/TerminalPage-abc123.js')).toBe(
            'public, max-age=31536000, immutable',
        );
        expect(getWebStaticCacheControl('/tmp/web-dist/index.html')).toBe('no-cache');
    });

    it('does not turn missing static assets into SPA documents', () => {
        expect(isWebStaticAssetRequest('/assets/TerminalPage-missing.js')).toBe(true);
        expect(isWebStaticAssetRequest('/favicon.ico')).toBe(true);
        expect(isWebStaticAssetRequest('/session/remcli-session/terminal')).toBe(false);
        expect(isWebStaticAssetRequest('/session/remcli-session?fixtures=1')).toBe(false);
    });

    it('serves a newly added lazy chunk without restarting the static route registry', async () => {
        const webAppDir = mkdtempSync(join(tmpdir(), 'remcli-web-static-'));
        const assetsDir = join(webAppDir, 'assets');
        mkdirSync(assetsDir);
        writeFileSync(join(webAppDir, 'index.html'), '<!doctype html><title>remcli</title>');

        const server = await startP2PServer({
            port: 0,
            host: '127.0.0.1',
            sharedSecret: new Uint8Array(32),
            store: new P2PStore({ kvFilePath: null }),
            webAppDir,
        });
        try {
            writeFileSync(join(assetsDir, 'TerminalPage-new.js'), 'export default null;');

            const response = await fetch(`http://127.0.0.1:${server.port}/assets/TerminalPage-new.js`);

            expect(response.status).toBe(200);
            expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
            await expect(response.text()).resolves.toContain('export default null');
        } finally {
            await server.stop();
            rmSync(webAppDir, { recursive: true, force: true });
        }
    });
});
