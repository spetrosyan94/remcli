/**
 * Tests for Whisper STT Service
 *
 * Covers public API: getModelsDir, getModelPath, isModelDownloaded,
 * isAvailable, getStatus, transcribe, freeWhisper.
 * Native bindings (smart-whisper) and node-wav are mocked since they
 * require N-API binaries unavailable in the test environment.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ─── Mocks (vi.hoisted to avoid TDZ issues) ────────────────────

const { testHomeDir, mockFree, mockTranscribeResult } = vi.hoisted(() => {
    const path = require('node:path');
    const os = require('node:os');
    const crypto = require('node:crypto');
    const testHomeDir = path.join(os.tmpdir(), `remcli-test-${crypto.randomBytes(4).toString('hex')}`);
    const mockFree = vi.fn().mockResolvedValue(undefined);
    const mockTranscribeResult = vi.fn().mockResolvedValue([
        { text: 'Hello world' },
        { text: 'this is a test' },
    ]);
    return { testHomeDir, mockFree, mockTranscribeResult };
});

vi.mock('smart-whisper', () => ({
    Whisper: vi.fn().mockImplementation(() => ({
        transcribe: vi.fn().mockResolvedValue({
            result: mockTranscribeResult(),
        }),
        free: mockFree,
    })),
}));

vi.mock('node-wav', () => ({
    decode: vi.fn().mockReturnValue({
        sampleRate: 16000,
        channelData: [new Float32Array([0.1, 0.2, 0.3])],
    }),
}));

vi.mock('@/configuration', () => ({
    configuration: {
        remcliHomeDir: testHomeDir,
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
    },
}));

// ─── Import after mocks ─────────────────────────────────────────

import {
    getModelsDir,
    getModelPath,
    isModelDownloaded,
    isAvailable,
    getStatus,
    transcribe,
    freeWhisper,
} from './whisperService';

// ─── Tests ──────────────────────────────────────────────────────

describe('whisperService', () => {
    beforeEach(() => {
        mkdirSync(testHomeDir, { recursive: true });
    });

    afterEach(() => {
        if (existsSync(testHomeDir)) {
            rmSync(testHomeDir, { recursive: true, force: true });
        }
    });

    // ─── getModelsDir / getModelPath ────────────────────────────

    describe('getModelsDir', () => {
        it('should return path inside remcliHomeDir', () => {
            const result = getModelsDir();
            expect(result).toBe(join(testHomeDir, 'models'));
        });
    });

    describe('getModelPath', () => {
        it('should return path to ggml-base.bin inside models dir', () => {
            const result = getModelPath();
            expect(result).toBe(join(testHomeDir, 'models', 'ggml-base.bin'));
        });
    });

    // ─── isModelDownloaded ──────────────────────────────────────

    describe('isModelDownloaded', () => {
        it('should return false when model file does not exist', () => {
            expect(isModelDownloaded()).toBe(false);
        });

        it('should return false when model file is too small (partial download)', () => {
            const modelsDir = getModelsDir();
            mkdirSync(modelsDir, { recursive: true });
            // Write a tiny file (100 bytes, way below 140MB * 0.9)
            writeFileSync(getModelPath(), Buffer.alloc(100));
            expect(isModelDownloaded()).toBe(false);
        });

        it('should return true when model file is large enough', () => {
            const modelsDir = getModelsDir();
            mkdirSync(modelsDir, { recursive: true });
            // Threshold: 140 * 1_000_000 * 0.9 = 126_000_000 bytes
            // We create a sparse file by writing just enough to pass the stat check
            const modelPath = getModelPath();
            // Use a file large enough: 127MB
            const fd = openSync(modelPath, 'w');
            ftruncateSync(fd, 127_000_000);
            closeSync(fd);
            expect(isModelDownloaded()).toBe(true);
        });
    });

    // ─── isAvailable ────────────────────────────────────────────

    describe('isAvailable', () => {
        it('should return true when smart-whisper is loadable', () => {
            expect(isAvailable()).toBe(true);
        });
    });

    // ─── getStatus ──────────────────────────────────────────────

    describe('getStatus', () => {
        it('should return status object with correct structure', () => {
            const status = getStatus();

            expect(status.available).toBe(true);
            expect(status.nativeBindings).toBe(true);
            expect(typeof status.modelDownloaded).toBe('boolean');
            expect(status.modelPath).toBe(join(testHomeDir, 'models', 'ggml-base.bin'));
            expect(typeof status.ffmpegAvailable).toBe('boolean');
        });

        it('should report modelDownloaded as false when no model exists', () => {
            const status = getStatus();
            expect(status.modelDownloaded).toBe(false);
        });
    });

    // ─── transcribe ─────────────────────────────────────────────

    describe('transcribe', () => {
        it('should transcribe a WAV file and return text, language, duration', async () => {
            // Create a fake WAV file so readFileSync works
            const modelsDir = getModelsDir();
            mkdirSync(modelsDir, { recursive: true });

            // Create a large enough model file for ensureModel to skip download
            const modelPath = getModelPath();
            const fd = openSync(modelPath, 'w');
            ftruncateSync(fd, 127_000_000);
            closeSync(fd);

            // Create a dummy WAV file
            const wavPath = join(testHomeDir, 'test-audio.wav');
            writeFileSync(wavPath, Buffer.alloc(1024));

            const result = await transcribe(wavPath);

            expect(result).toEqual({
                text: 'Hello world this is a test',
                language: 'auto',
                duration: 0,
            });
        });

        it('should not delete the original WAV file after transcription', async () => {
            const modelsDir = getModelsDir();
            mkdirSync(modelsDir, { recursive: true });

            const modelPath = getModelPath();
            const fd = openSync(modelPath, 'w');
            ftruncateSync(fd, 127_000_000);
            closeSync(fd);

            const wavPath = join(testHomeDir, 'keep-this.wav');
            writeFileSync(wavPath, Buffer.alloc(512));

            await transcribe(wavPath);

            expect(existsSync(wavPath)).toBe(true);
        });
    });

    // ─── freeWhisper ────────────────────────────────────────────

    describe('freeWhisper', () => {
        it('should not throw when no instance exists', async () => {
            await expect(freeWhisper()).resolves.toBeUndefined();
        });

        it('should call free on the whisper instance after transcribe', async () => {
            // First, create a transcription to initialize the instance
            const modelsDir = getModelsDir();
            mkdirSync(modelsDir, { recursive: true });

            const modelPath = getModelPath();
            const fd = openSync(modelPath, 'w');
            ftruncateSync(fd, 127_000_000);
            closeSync(fd);

            const wavPath = join(testHomeDir, 'free-test.wav');
            writeFileSync(wavPath, Buffer.alloc(512));

            await transcribe(wavPath);

            // Now free should call whisper.free()
            await freeWhisper();
            expect(mockFree).toHaveBeenCalled();
        });
    });
});
