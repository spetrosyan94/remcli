import { afterEach, describe, expect, it, vi } from 'vitest';

type TtsServiceModule = typeof import('./ttsService');

let configuredProvider: 'edge' | 'off' | 'qwen3' = 'edge';

async function importTtsService(): Promise<TtsServiceModule> {
    vi.resetModules();
    vi.doMock('@/persistence', () => ({
        readSetupConfig: () => ({
            ttsProvider: configuredProvider,
            ttsEdgeVoice: 'auto',
        }),
    }));

    return await import('./ttsService');
}

afterEach(() => {
    configuredProvider = 'edge';
    vi.doUnmock('@/persistence');
    vi.resetModules();
});

describe('getTtsStatus', () => {
    it('reports the initialized runtime provider after setup config changes', async () => {
        const ttsService = await importTtsService();
        await ttsService.initTtsProvider();

        configuredProvider = 'off';
        expect(ttsService.getTtsStatus()).toMatchObject({
            available: true,
            provider: 'edge',
        });

        configuredProvider = 'qwen3';
        expect(ttsService.getTtsStatus()).toMatchObject({
            available: true,
            provider: 'edge',
        });

        await ttsService.stopTts();
    });
});
