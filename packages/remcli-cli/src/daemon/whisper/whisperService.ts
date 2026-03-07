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
import { logger } from '@/ui/logger';

// ─── Constants ──────────────────────────────────────────────────

const MODEL_FILENAME = 'ggml-base.bin';
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin';
const MODEL_EXPECTED_SIZE_MB = 140; // ~142MB, used for sanity check

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
}

export function getModelsDir(): string {
    return join(configuration.remcliHomeDir, 'models');
}

export function getModelPath(): string {
    return join(getModelsDir(), MODEL_FILENAME);
}

export function isModelDownloaded(): boolean {
    const modelPath = getModelPath();
    if (!existsSync(modelPath)) return false;
    const stat = statSync(modelPath);
    return stat.size > MODEL_EXPECTED_SIZE_MB * 1_000_000 * 0.9;
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
    return {
        available: true,
        nativeBindings: true,
        modelDownloaded: isModelDownloaded(),
        modelPath: getModelPath(),
        ffmpegAvailable: isFfmpegAvailable(),
    };
}

export async function ensureModel(): Promise<string> {
    const modelPath = getModelPath();

    if (isModelDownloaded()) {
        return modelPath;
    }

    const modelsDir = getModelsDir();
    if (!existsSync(modelsDir)) {
        mkdirSync(modelsDir, { recursive: true });
    }

    logger.debug(`[WHISPER] Downloading model to ${modelPath}...`);

    const response = await fetch(MODEL_URL, { redirect: 'follow' });
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
