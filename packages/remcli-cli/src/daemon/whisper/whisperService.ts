/**
 * Whisper STT Service
 *
 * Provides local speech-to-text transcription using smart-whisper (native N-API bindings for whisper.cpp).
 * Model (ggml-base.bin) is auto-downloaded on first use to ~/.remcli/models/.
 */

import { execFile, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Whisper } from 'smart-whisper';
import { decode } from 'node-wav';
import { configuration } from '@/configuration';
import { readSetupConfig } from '@/persistence';
import { logger } from '@/ui/logger';

// ─── Constants ──────────────────────────────────────────────────

const HUGGINGFACE_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

export const WHISPER_MODELS: Record<string, { filename: string; sizeMB: number }> = {
    tiny:   { filename: 'ggml-tiny.bin',     sizeMB: 75 },
    base:   { filename: 'ggml-base.bin',     sizeMB: 140 },
    small:  { filename: 'ggml-small.bin',    sizeMB: 460 },
    medium: { filename: 'ggml-medium.bin',   sizeMB: 1500 },
    large:  { filename: 'ggml-large-v3.bin', sizeMB: 3000 },
};

function getSelectedModel(): string {
    const config = readSetupConfig();
    return config.whisperModel || 'base';
}

function getModelInfo(modelName?: string): { filename: string; sizeMB: number } {
    const name = modelName ?? getSelectedModel();
    return WHISPER_MODELS[name] ?? WHISPER_MODELS['base'];
}

function getModelFilename(modelName?: string): string {
    return getModelInfo(modelName).filename;
}

function getModelUrl(modelName?: string): string {
    return `${HUGGINGFACE_BASE_URL}/${getModelFilename(modelName)}`;
}

// ─── State ──────────────────────────────────────────────────────

let whisperInstance: Whisper | null = null;

// ─── Public API ─────────────────────────────────────────────────

export interface TranscriptionResult {
    text: string;
    language: string;
    duration: number;
}

export interface WhisperStatus {
    available: boolean;
    nativeBindings: boolean;
    modelDownloaded: boolean;
    modelPath: string;
    ffmpegAvailable: boolean;
    selectedModel: string;
}

export function getModelsDir(): string {
    return join(configuration.remcliHomeDir, 'models');
}

export function getModelPath(modelName?: string): string {
    return join(getModelsDir(), getModelFilename(modelName));
}

export function isModelDownloaded(modelName?: string): boolean {
    const name = modelName ?? getSelectedModel();
    const modelPath = getModelPath(name);
    if (!existsSync(modelPath)) return false;
    const info = getModelInfo(name);
    const stat = statSync(modelPath);
    return stat.size > info.sizeMB * 1_000_000 * 0.9;
}

export function isFfmpegAvailable(): boolean {
    try {
        const cmd = process.platform === 'win32' ? 'where' : 'which';
        execFileSync(cmd, ['ffmpeg'], { encoding: 'utf8', timeout: 5000 });
        return true;
    } catch {
        return false;
    }
}

export function isAvailable(): boolean {
    try {
        require('smart-whisper');
        return true;
    } catch {
        return false;
    }
}

export function getStatus(): WhisperStatus {
    const selectedModel = getSelectedModel();
    return {
        available: true,
        nativeBindings: true,
        modelDownloaded: isModelDownloaded(),
        modelPath: getModelPath(),
        ffmpegAvailable: isFfmpegAvailable(),
        selectedModel,
    };
}

export async function ensureModel(modelName?: string): Promise<string> {
    const name = modelName ?? getSelectedModel();
    const modelPath = getModelPath(name);

    if (isModelDownloaded(name)) {
        return modelPath;
    }

    const modelsDir = getModelsDir();
    if (!existsSync(modelsDir)) {
        mkdirSync(modelsDir, { recursive: true });
    }

    logger.debug(`[WHISPER] Downloading model ${name} to ${modelPath}...`);

    const url = getModelUrl(name);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
        throw new Error(`Failed to download Whisper model: ${response.status} ${response.statusText}`);
    }

    const tempPath = `${modelPath}.downloading`;
    try {
        const fileStream = createWriteStream(tempPath);
        const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
        await pipeline(nodeStream, fileStream);

        renameSync(tempPath, modelPath);
        logger.debug(`[WHISPER] Model downloaded successfully (${statSync(modelPath).size} bytes)`);
    } catch (error) {
        // Clean up partial download
        if (existsSync(tempPath)) unlinkSync(tempPath);
        throw error;
    }

    return modelPath;
}

export async function downloadModelWithProgress(
    modelName: string,
    onProgress: (downloadedBytes: number, totalBytes: number | null) => void
): Promise<string> {
    const modelPath = getModelPath(modelName);

    if (isModelDownloaded(modelName)) {
        const info = getModelInfo(modelName);
        const totalBytes = info.sizeMB * 1_000_000;
        onProgress(totalBytes, totalBytes);
        return modelPath;
    }

    const modelsDir = getModelsDir();
    if (!existsSync(modelsDir)) {
        mkdirSync(modelsDir, { recursive: true });
    }

    const url = getModelUrl(modelName);
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
        throw new Error(`Failed to download Whisper model: ${response.status} ${response.statusText}`);
    }

    const contentLength = response.headers.get('content-length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : null;
    let downloadedBytes = 0;

    const tempPath = `${modelPath}.downloading`;
    try {
        const fileStream = createWriteStream(tempPath);
        const reader = response.body.getReader();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fileStream.write(Buffer.from(value));
            downloadedBytes += value.byteLength;
            onProgress(downloadedBytes, totalBytes);
        }

        await new Promise<void>((resolve, reject) => {
            fileStream.end(() => resolve());
            fileStream.on('error', reject);
        });

        renameSync(tempPath, modelPath);
    } catch (error) {
        if (existsSync(tempPath)) unlinkSync(tempPath);
        throw error;
    }

    return modelPath;
}

export async function transcribe(audioPath: string): Promise<TranscriptionResult> {
    const wavPath = await ensureWav(audioPath);
    const shouldCleanup = wavPath !== audioPath;

    try {
        const whisper = await getWhisperInstance();
        const pcm = readWavAsPcm(wavPath);
        const task = await whisper.transcribe(pcm, { language: 'auto' });
        const result = await task.result;

        // result is an array of segments [{text, from, to, ...}]
        const text = result.map(seg => seg.text).join(' ').trim();
        const lastSegment = result[result.length - 1];
        const duration = lastSegment?.to ? lastSegment.to / 1000 : 0;

        return { text, language: 'auto', duration };
    } finally {
        if (shouldCleanup && existsSync(wavPath)) {
            unlinkSync(wavPath);
        }
    }
}

export async function freeWhisper(): Promise<void> {
    if (whisperInstance) {
        await whisperInstance.free();
        whisperInstance = null;
        logger.debug('[WHISPER] Native resources freed');
    }
}

// ─── Internal ───────────────────────────────────────────────────

async function getWhisperInstance(): Promise<Whisper> {
    if (!whisperInstance) {
        const modelPath = await ensureModel();
        whisperInstance = new Whisper(modelPath, { gpu: true });
        logger.debug('[WHISPER] Initialized native bindings with GPU support');
    }
    return whisperInstance;
}

function readWavAsPcm(wavPath: string): Float32Array {
    const buffer = readFileSync(wavPath);
    const { sampleRate, channelData } = decode(buffer);
    if (sampleRate !== 16000) {
        throw new Error(`Invalid sample rate: ${sampleRate}. Expected 16000 Hz.`);
    }
    if (!channelData.length) {
        throw new Error('WAV file contains no audio channels');
    }
    return channelData[0];
}

async function ensureWav(audioPath: string): Promise<string> {
    const ext = audioPath.toLowerCase().split('.').pop();
    if (ext === 'wav') return audioPath;

    if (!isFfmpegAvailable()) {
        throw new Error('ffmpeg is required for non-WAV audio files. Install via: brew install ffmpeg');
    }

    const wavPath = audioPath.replace(/\.[^.]+$/, '.wav');

    await execFilePromise('ffmpeg', [
        '-i', audioPath,
        '-ar', '16000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        '-y',
        wavPath,
    ], 30_000);

    return wavPath;
}

function execFilePromise(cmd: string, args: string[], timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                logger.debug(`[WHISPER] exec error: ${error.message}, stderr: ${stderr}`);
                reject(new Error(`ffmpeg conversion failed: ${error.message}`));
                return;
            }
            resolve(stdout);
        });
    });
}
