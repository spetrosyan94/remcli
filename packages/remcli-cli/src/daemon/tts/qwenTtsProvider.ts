/**
 * Qwen3-TTS Provider
 *
 * Manages a persistent Python worker process running mlx-audio on Apple Silicon.
 * Communicates via JSON lines on stdin/stdout.
 * Supports voice cloning via reference audio profiles in ~/.remcli/voices/.
 */

import { ChildProcess, spawn, execFile } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface, Interface as ReadlineInterface } from 'node:readline';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { tmpNameSync } from 'tmp';
import { readSetupConfig } from '@/persistence';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';
import { TtsProvider, TtsOptions } from './ttsService';

const execFileAsync = promisify(execFile);

// ─── Constants ──────────────────────────────────────────────────

const WORKER_READY_TIMEOUT_MS = 120_000;
const SYNTHESIS_TIMEOUT_MS = 90_000;
const SHUTDOWN_GRACE_MS = 2_000;

// ─── Provider ───────────────────────────────────────────────────

export class QwenTtsProvider implements TtsProvider {
    private workerProcess: ChildProcess | null = null;
    private stdoutReader: ReadlineInterface | null = null;
    private pendingRequestId: string | null = null;
    private pendingResolve: ((value: WorkerResponse) => void) | null = null;
    private pendingReject: ((reason: Error) => void) | null = null;
    private initializing = false;
    private readyResolve: (() => void) | null = null;
    private readyReject: ((reason: Error) => void) | null = null;
    private requestQueue: Array<{ resolve: (buf: Buffer) => void; reject: (err: Error) => void; run: () => Promise<Buffer> }> = [];
    private processing = false;

    async start(): Promise<void> {
        const pythonPath = join(homedir(), '.remcli', 'tts-venv', 'bin', 'python');
        const workerScript = this.resolveWorkerScript();

        if (!existsSync(pythonPath)) {
            throw new Error(`Python venv not found at ${pythonPath}. Run 'remcli setup' first.`);
        }

        if (!existsSync(workerScript)) {
            throw new Error(`Worker script not found at ${workerScript}`);
        }

        logger.debug(`[TTS:qwen3] Starting worker: ${pythonPath} ${workerScript}`);

        this.workerProcess = spawn(pythonPath, [workerScript], {
            stdio: ['pipe', 'pipe', 'pipe'],
            detached: false,
        });

        this.workerProcess.on('error', (error) => {
            logger.debug('[TTS:qwen3] Worker process error:', error);
            this.workerProcess = null;
            // If this fires while we're still waiting for the ready signal, reject
            // startup immediately instead of hanging for WORKER_READY_TIMEOUT_MS.
            if (this.readyReject) {
                this.readyReject(new Error(`Qwen3-TTS worker process error during startup: ${error.message}`));
            }
        });

        this.workerProcess.on('exit', (code, signal) => {
            logger.debug(`[TTS:qwen3] Worker exited: code=${code}, signal=${signal}`);
            this.workerProcess = null;
            this.stdoutReader = null;
            // If the worker dies before signalling readiness, reject startup
            // immediately instead of hanging for WORKER_READY_TIMEOUT_MS.
            if (this.readyReject) {
                this.readyReject(new Error(`Qwen3-TTS worker exited during startup: code=${code}, signal=${signal}`));
            }
            // Reject pending request immediately instead of waiting for 60s timeout
            if (this.pendingReject) {
                this.pendingReject(new Error(`Qwen3-TTS worker exited unexpectedly: code=${code}, signal=${signal}`));
                this.pendingResolve = null;
                this.pendingReject = null;
                this.pendingRequestId = null;
            }
        });

        // Pipe stderr to debug log
        if (this.workerProcess.stderr) {
            this.workerProcess.stderr.on('data', (chunk: Buffer) => {
                logger.debug(`[TTS:qwen3:stderr] ${chunk.toString().trim()}`);
            });
        }

        // Set up stdout JSON line reader
        if (this.workerProcess.stdout) {
            this.stdoutReader = createInterface({ input: this.workerProcess.stdout });
            this.stdoutReader.on('line', (line: string) => {
                this.handleWorkerLine(line);
            });
        }

        // Wait for ready signal
        await this.waitForReady();
        logger.debug('[TTS:qwen3] Worker ready');
    }

    async synthesize(text: string, options: TtsOptions): Promise<Buffer> {
        // Queue requests to prevent race conditions on the single stdin/stdout channel
        return new Promise<Buffer>((resolve, reject) => {
            this.requestQueue.push({
                resolve,
                reject,
                run: () => this.synthesizeInternal(text, options),
            });
            this.processQueue();
        });
    }

    private async processQueue(): Promise<void> {
        if (this.processing) return;
        const next = this.requestQueue.shift();
        if (!next) return;

        this.processing = true;
        try {
            const result = await next.run();
            next.resolve(result);
        } catch (error) {
            next.reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
            this.processing = false;
            this.processQueue();
        }
    }

    private async synthesizeInternal(text: string, options: TtsOptions): Promise<Buffer> {
        if (!this.workerProcess || !this.workerProcess.stdin) {
            throw new Error('Qwen3-TTS worker is not running');
        }

        const config = readSetupConfig();
        const profileName = config.ttsQwenVoiceProfile || 'default';
        const lang = options.lang || 'ru';
        // Worker outputs OGG Vorbis, we convert to OGG Opus via ffmpeg for iOS compatibility
        const vorbisPath = tmpNameSync({ postfix: '.vorbis.ogg' });
        const opusPath = tmpNameSync({ postfix: '.opus.ogg' });

        // Build request
        const request: WorkerRequest = {
            text,
            lang,
            output: vorbisPath,
        };

        // Load voice profile: check user dir first, then bundled fallback
        let profileDir = join(homedir(), '.remcli', 'voices', profileName);
        let profileJsonPath = join(profileDir, 'profile.json');

        if (!existsSync(profileJsonPath)) {
            // Fallback to bundled voice profile shipped with CLI
            const bundledDir = join(projectPath(), 'src', 'daemon', 'tts', 'voices', profileName);
            const bundledPath = join(bundledDir, 'profile.json');
            if (existsSync(bundledPath)) {
                profileDir = bundledDir;
                profileJsonPath = bundledPath;
                logger.debug(`[TTS:qwen3] Using bundled voice profile: ${profileName}`);
            }
        }

        if (existsSync(profileJsonPath)) {
            try {
                const profile = JSON.parse(readFileSync(profileJsonPath, 'utf-8')) as VoiceProfile;
                if (profile.ref_audio) {
                    request.ref_audio = join(profileDir, profile.ref_audio);
                }
                if (profile.ref_text) {
                    request.ref_text = profile.ref_text;
                }
            } catch (error) {
                logger.debug(`[TTS:qwen3] Failed to load voice profile: ${error}`);
            }
        }

        try {
            // Send request and wait for response
            const response = await this.sendRequest(request);

            if (!response.ok) {
                throw new Error(response.error || 'Synthesis failed');
            }

            if (!existsSync(vorbisPath)) {
                throw new Error(`Output file not found: ${vorbisPath}`);
            }

            // Convert OGG Vorbis → OGG Opus for iOS/Safari compatibility
            // 96kbps mono Opus at 24kHz — good quality speech (~12 KB/sec)
            await execFileAsync('ffmpeg', [
                '-i', vorbisPath,
                '-c:a', 'libopus',
                '-b:a', '96k',
                '-ar', '24000',
                '-ac', '1',
                '-application', 'voip',
                '-loglevel', 'error',
                '-y',
                opusPath,
            ]);
            logger.debug(`[TTS:qwen3] Converted Vorbis→Opus: ${opusPath}`);

            return readFileSync(opusPath);
        } finally {
            for (const path of [vorbisPath, opusPath]) {
                if (existsSync(path)) {
                    try { unlinkSync(path); } catch { /* ignore */ }
                }
            }
        }
    }

    async isAvailable(): Promise<boolean> {
        return this.workerProcess !== null && !this.workerProcess.killed;
    }

    async stop(): Promise<void> {
        if (!this.workerProcess || this.workerProcess.killed) {
            return;
        }

        logger.debug('[TTS:qwen3] Stopping worker...');
        this.workerProcess.kill('SIGTERM');

        await new Promise<void>(resolve => setTimeout(resolve, SHUTDOWN_GRACE_MS));

        if (this.workerProcess && !this.workerProcess.killed) {
            logger.debug('[TTS:qwen3] Force killing worker');
            this.workerProcess.kill('SIGKILL');
        }

        this.workerProcess = null;
        this.stdoutReader = null;
    }

    // ─── Private ────────────────────────────────────────────────

    private resolveWorkerScript(): string {
        // Worker script lives in src/ and is not bundled by pkgroll.
        // Use projectPath() to find the package root reliably.
        const root = projectPath();
        const srcPath = join(root, 'src', 'daemon', 'tts', 'qwenTtsWorker.py');
        if (existsSync(srcPath)) {
            return srcPath;
        }

        throw new Error(`qwenTtsWorker.py not found at ${srcPath}`);
    }

    private waitForReady(): Promise<void> {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeout);
                this.initializing = false;
                this.readyResolve = null;
                this.readyReject = null;
            };

            const timeout = setTimeout(() => {
                cleanup();
                reject(new Error(`Qwen3-TTS worker failed to become ready within ${WORKER_READY_TIMEOUT_MS}ms`));
            }, WORKER_READY_TIMEOUT_MS);

            // Enter the initialization phase: handleWorkerLine watches for the
            // ready signal until one of these callbacks fires.
            this.initializing = true;
            this.readyResolve = () => {
                cleanup();
                resolve();
            };
            // Allow the process 'exit'/'error' handlers to abort startup instantly.
            this.readyReject = (error: Error) => {
                cleanup();
                reject(error);
            };
        });
    }

    private handleWorkerLine(line: string): void {
        if (!line.trim()) return;

        // During startup, watch for the readiness signal. Non-ready lines fall
        // through to normal request/response handling below.
        if (this.initializing) {
            try {
                const parsed = JSON.parse(line) as { ready?: boolean };
                if (parsed.ready) {
                    this.readyResolve?.();
                    return;
                }
            } catch {
                // Not JSON — fall through to normal handling
            }
        }

        try {
            const response = JSON.parse(line) as WorkerResponse;
            // Match response to pending request by ID — discard stale responses
            // from timed-out requests that finished after we moved on
            if (response.id && response.id !== this.pendingRequestId) {
                logger.debug(`[TTS:qwen3] Discarding stale response (id=${response.id}, pending=${this.pendingRequestId})`);
                return;
            }
            if (this.pendingResolve) {
                this.pendingResolve(response);
                this.pendingResolve = null;
                this.pendingReject = null;
                this.pendingRequestId = null;
            }
        } catch {
            logger.debug(`[TTS:qwen3] Non-JSON output: ${line}`);
        }
    }

    private sendRequest(request: WorkerRequest): Promise<WorkerResponse> {
        return new Promise((resolve, reject) => {
            if (!this.workerProcess?.stdin) {
                reject(new Error('Worker stdin not available'));
                return;
            }

            const requestId = randomBytes(8).toString('hex');

            const timeout = setTimeout(() => {
                this.pendingResolve = null;
                this.pendingReject = null;
                this.pendingRequestId = null;
                reject(new Error(`Synthesis timed out after ${SYNTHESIS_TIMEOUT_MS}ms`));
            }, SYNTHESIS_TIMEOUT_MS);

            this.pendingRequestId = requestId;
            this.pendingResolve = (response: WorkerResponse) => {
                clearTimeout(timeout);
                resolve(response);
            };
            this.pendingReject = (error: Error) => {
                clearTimeout(timeout);
                reject(error);
            };

            const jsonLine = JSON.stringify({ ...request, id: requestId }) + '\n';
            this.workerProcess.stdin.write(jsonLine);
        });
    }
}

// ─── Types ──────────────────────────────────────────────────────

interface WorkerRequest {
    text: string;
    lang: string;
    output: string;
    ref_audio?: string;
    ref_text?: string;
}

interface WorkerResponse {
    id?: string;
    ok: boolean;
    path?: string;
    error?: string;
}

interface VoiceProfile {
    ref_audio?: string;
    ref_text?: string;
}
