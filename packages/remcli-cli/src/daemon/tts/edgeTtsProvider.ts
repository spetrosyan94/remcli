/**
 * Edge-TTS Provider
 *
 * Uses node-edge-tts (Microsoft Edge TTS) to generate MP3 audio,
 * then converts to OGG Opus via ffmpeg for efficient mobile playback.
 */

import { execFile } from 'node:child_process';
import { readFileSync, unlinkSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { tmpNameSync } from 'tmp';
import { EdgeTTS } from 'node-edge-tts';
import { readSetupConfig } from '@/persistence';
import { logger } from '@/ui/logger';
import { TtsProvider, TtsOptions } from './ttsService';

const execFileAsync = promisify(execFile);

// ─── Voice selection ────────────────────────────────────────────

/**
 * Default Microsoft Edge neural voice per app language.
 * Covers all 10 languages supported by the app; anything else falls back to en-US.
 */
const EDGE_VOICE_BY_LANG: Record<string, string> = {
    en: 'en-US-GuyNeural',
    ru: 'ru-RU-DmitryNeural',
    pl: 'pl-PL-MarekNeural',
    es: 'es-ES-AlvaroNeural',
    ca: 'ca-ES-EnricNeural',
    it: 'it-IT-DiegoNeural',
    pt: 'pt-BR-AntonioNeural',
    ja: 'ja-JP-KeitaNeural',
    'zh-Hans': 'zh-CN-YunxiNeural',
    'zh-Hant': 'zh-TW-YunJheNeural',
};

const EDGE_FALLBACK_VOICE = 'en-US-GuyNeural';

/** Pick a default Edge neural voice for the requested app language (fallback en-US). */
export function getEdgeVoiceForLang(lang?: string): string {
    return (lang && EDGE_VOICE_BY_LANG[lang]) || EDGE_FALLBACK_VOICE;
}

/** All default per-language voices, used to advertise available voices in TTS status. */
export function listEdgeDefaultVoices(): string[] {
    return Object.values(EDGE_VOICE_BY_LANG);
}

/**
 * Resolve the voice to synthesize with. Priority:
 *   1. Explicit per-request voice (options.voice)
 *   2. User-configured voice from setup.json (unless 'auto')
 *   3. Language default for options.lang (fallback en-US)
 */
function resolveEdgeVoice(options: TtsOptions, configuredVoice?: string): string {
    if (options.voice) return options.voice;
    if (configuredVoice && configuredVoice !== 'auto') return configuredVoice;
    return getEdgeVoiceForLang(options.lang);
}

// ─── Provider ───────────────────────────────────────────────────

export class EdgeTtsProvider implements TtsProvider {
    async synthesize(text: string, options: TtsOptions): Promise<Buffer> {
        const config = readSetupConfig();
        const voice = resolveEdgeVoice(options, config.ttsEdgeVoice);

        const mp3Path = tmpNameSync({ postfix: '.mp3' });
        const oggPath = tmpNameSync({ postfix: '.ogg' });

        try {
            // Generate MP3 via Edge TTS
            const tts = new EdgeTTS({ voice });
            await tts.ttsPromise(text, mp3Path);
            logger.debug(`[TTS:edge] MP3 generated: ${mp3Path}`);

            // Convert MP3 -> OGG Opus via ffmpeg
            // 48kbps mono Opus at 24kHz is very good for speech (~6 KB/sec)
            await execFileAsync('ffmpeg', [
                '-i', mp3Path,
                '-c:a', 'libopus',
                '-b:a', '48k',
                '-ar', '24000',
                '-ac', '1',
                '-application', 'voip',
                '-loglevel', 'error',
                '-y',
                oggPath,
            ]);
            logger.debug(`[TTS:edge] OGG converted: ${oggPath}`);

            // Read OGG buffer
            const audioBuffer = readFileSync(oggPath);
            return audioBuffer;
        } finally {
            // Clean up temp files
            for (const path of [mp3Path, oggPath]) {
                if (existsSync(path)) {
                    try { unlinkSync(path); } catch { /* ignore cleanup errors */ }
                }
            }
        }
    }

    async isAvailable(): Promise<boolean> {
        // edge-tts generates MP3, ffmpeg is required for OGG Opus conversion
        try {
            await execFileAsync('ffmpeg', ['-version']);
            return true;
        } catch {
            return false;
        }
    }
}
