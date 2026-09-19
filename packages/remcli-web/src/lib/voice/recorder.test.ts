import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeAnalyserLevel, startRecording, stopRecording, cancelRecording } from '@/lib/voice/recorder';

class FakeSource {
    disconnect = vi.fn();
    connect = vi.fn();
}

class FakeAnalyser {
    fftSize = 256;
    disconnect = vi.fn();
    getByteTimeDomainData = vi.fn((samples: Uint8Array) => samples.fill(128));
}

class FakeAudioContext {
    close = vi.fn(async () => undefined);
    analyser = new FakeAnalyser();
    source = new FakeSource();
    createAnalyser = vi.fn(() => this.analyser);
    createMediaStreamSource = vi.fn(() => this.source);
}

class FakeMediaRecorder {
    static isTypeSupported = vi.fn(() => false);
    state = 'inactive';
    mimeType = 'audio/webm';
    stream: MediaStream;
    ondataavailable: ((event: BlobEvent) => void) | null = null;
    onstop: (() => void) | null = null;

    constructor(stream: MediaStream) {
        this.stream = stream;
    }

    start = vi.fn(() => {
        this.state = 'recording';
    });

    stop = vi.fn(() => {
        this.state = 'inactive';
        this.onstop?.();
    });
}

describe('voice recorder level and audio graph cleanup', () => {
    afterEach(() => {
        cancelRecording();
        vi.unstubAllGlobals();
    });

    it('normalizes analyser samples to a bounded RMS level', () => {
        expect(normalizeAnalyserLevel(new Uint8Array([128, 128, 128]))).toBe(0);
        expect(normalizeAnalyserLevel(new Uint8Array([0, 255]))).toBeCloseTo(1, 2);
        expect(normalizeAnalyserLevel(new Uint8Array())).toBe(0);
    });

    it('disconnects and closes the analyser graph when stopped', async () => {
        const trackStop = vi.fn();
        const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
        const context = new FakeAudioContext();
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
        vi.stubGlobal('window', { AudioContext: class { constructor() { return context; } } });

        expect(await startRecording()).toBe(true);
        expect(await stopRecording()).toBeInstanceOf(Blob);
        expect(trackStop).toHaveBeenCalledOnce();
        expect(context.source.disconnect).toHaveBeenCalledOnce();
        expect(context.analyser.disconnect).toHaveBeenCalledOnce();
        expect(context.close).toHaveBeenCalledOnce();
    });

    it('uses the same cleanup path when cancelled', async () => {
        const trackStop = vi.fn();
        const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
        const context = new FakeAudioContext();
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
        vi.stubGlobal('window', { AudioContext: class { constructor() { return context; } } });

        expect(await startRecording()).toBe(true);
        cancelRecording();
        expect(trackStop).toHaveBeenCalledOnce();
        expect(context.source.disconnect).toHaveBeenCalledOnce();
        expect(context.analyser.disconnect).toHaveBeenCalledOnce();
        expect(context.close).toHaveBeenCalledOnce();
    });

    it('stops a late microphone stream after cancellation while permission is pending', async () => {
        const trackStop = vi.fn();
        const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
        let resolveStream: ((stream: MediaStream) => void) | undefined;
        const getUserMedia = vi.fn(() => new Promise<MediaStream>((resolve) => {
            resolveStream = resolve;
        }));
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
        vi.stubGlobal('window', { AudioContext: FakeAudioContext });

        const pendingStart = startRecording();
        expect(await startRecording()).toBe(false);
        cancelRecording();
        resolveStream?.(stream);

        await expect(pendingStart).resolves.toBe(false);
        expect(getUserMedia).toHaveBeenCalledOnce();
        expect(trackStop).toHaveBeenCalledOnce();
    });

    it('stops the acquired stream when MediaRecorder construction fails', async () => {
        const trackStop = vi.fn();
        const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream) } });
        vi.stubGlobal('MediaRecorder', class {
            static isTypeSupported = vi.fn(() => false);
            constructor() {
                throw new Error('constructor failed');
            }
        });
        vi.stubGlobal('window', { AudioContext: FakeAudioContext });

        await expect(startRecording()).resolves.toBe(false);
        expect(trackStop).toHaveBeenCalledOnce();
    });

    it('does not let a stale rejected permission request stop a newer recording', async () => {
        const currentTrackStop = vi.fn();
        const currentStream = { getTracks: () => [{ stop: currentTrackStop }] } as unknown as MediaStream;
        let rejectStale: ((error: Error) => void) | undefined;
        const staleRequest = new Promise<MediaStream>((_resolve, reject) => {
            rejectStale = reject;
        });
        const getUserMedia = vi.fn()
            .mockReturnValueOnce(staleRequest)
            .mockResolvedValueOnce(currentStream);
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
        vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
        vi.stubGlobal('window', { AudioContext: FakeAudioContext });

        const staleStart = startRecording();
        cancelRecording();
        await expect(startRecording()).resolves.toBe(true);
        rejectStale?.(new Error('permission denied'));

        await expect(staleStart).resolves.toBe(false);
        expect(currentTrackStop).not.toHaveBeenCalled();
        cancelRecording();
        expect(currentTrackStop).toHaveBeenCalledOnce();
    });
});
