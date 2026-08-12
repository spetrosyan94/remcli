/**
 * TTS (Text-to-Speech) Service
 *
 * Provides voice synthesis with pluggable providers:
 * - edge-tts (default): Microsoft Edge TTS via node-edge-tts, MP3 -> ffmpeg -> OGG Opus
 * - qwen3-tts: Local Apple Silicon model via Python worker, voice cloning support
 */

import { readSetupConfig } from '@/persistence';
import { logger } from '@/ui/logger';
import { EdgeTtsProvider, listEdgeDefaultVoices } from './edgeTtsProvider';
import { QwenTtsProvider } from './qwenTtsProvider';

// ─── Types ──────────────────────────────────────────────────────

export interface TtsOptions {
    voice?: string;
    lang?: string;  // 'ru', 'en'
}

export interface TtsProvider {
    synthesize(text: string, options: TtsOptions): Promise<Buffer>;  // OGG binary
    isAvailable(): Promise<boolean>;
    start?(): Promise<void>;
    stop?(): Promise<void>;
}

export interface TtsStatus {
    available: boolean;
    provider: string;
    voices: string[];
}

// ─── State ──────────────────────────────────────────────────────

let currentProvider: TtsProvider | null = null;
let currentProviderName: string = 'off';

// ─── Public API ─────────────────────────────────────────────────

export function getConfiguredProviderName(): string {
    const config = readSetupConfig();
    return config.ttsProvider || 'edge';
}

export async function initTtsProvider(): Promise<void> {
    const providerName = getConfiguredProviderName();

    if (providerName === 'off') {
        await stopTts();
        return;
    }

    if (providerName === 'edge') {
        currentProvider = new EdgeTtsProvider();
        currentProviderName = providerName;
    } else if (providerName === 'qwen3') {
        const provider = new QwenTtsProvider();
        try {
            await provider.start();
        } catch (error) {
            await provider.stop();
            throw error;
        }
        currentProvider = provider;
        currentProviderName = providerName;
    }

    logger.debug(`[TTS] Provider initialized: ${providerName}`);
}

export async function synthesize(text: string, options: TtsOptions = {}): Promise<Buffer> {
    if (!currentProvider) {
        throw new Error('TTS provider not initialized or disabled');
    }
    return currentProvider.synthesize(text, options);
}

export async function stopTts(): Promise<void> {
    if (currentProvider?.stop) {
        await currentProvider.stop();
        logger.debug('[TTS] Provider stopped');
    }
    currentProvider = null;
    currentProviderName = 'off';
}

export function getTtsStatus(): TtsStatus {
    const providerName = currentProviderName;

    if (providerName === 'off' || !currentProvider) {
        return { available: false, provider: providerName, voices: [] };
    }

    if (providerName === 'edge') {
        const config = readSetupConfig();
        // Advertise the configured voice (if any) plus the per-language defaults.
        const voices = [config.ttsEdgeVoice, ...listEdgeDefaultVoices()]
            .filter((v): v is string => Boolean(v) && v !== 'auto')
            .filter((v, i, a) => a.indexOf(v) === i);
        // ffmpeg availability is checked lazily on first synth; report as available
        // since ffmpeg is a pre-existing remcli dependency (used by Whisper too)
        return { available: true, provider: 'edge', voices };
    }

    if (providerName === 'qwen3') {
        return {
            available: true,
            provider: 'qwen3',
            voices: ['default'],
        };
    }

    return { available: false, provider: currentProviderName, voices: [] };
}
