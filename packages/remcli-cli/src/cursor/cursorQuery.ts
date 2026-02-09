/**
 * Cursor CLI Query
 *
 * Spawns the `agent` CLI process with `--output-format stream-json` and parses
 * the NDJSON events. Similar to `claude/sdk/query.ts` but simplified — Cursor
 * does not support bidirectional stdin protocol.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

import { logger } from '@/ui/logger';
import type { CursorStreamEvent } from './types';

export interface CursorQueryOptions {
    /** The user prompt to send */
    prompt: string;
    /** Working directory */
    cwd?: string;
    /** Model override */
    model?: string;
    /** Resume session by ID */
    resumeSessionId?: string;
    /** API key for authentication */
    apiKey?: string;
    /** Abort signal */
    abort?: AbortSignal;
    /** Extra environment variables */
    env?: Record<string, string>;
    /** Path to agent executable (default: "agent") */
    executable?: string;
    /** Cursor agent mode: agent (default), plan (read-only planning), ask (Q&A) */
    mode?: 'agent' | 'plan' | 'ask';
    /** Force allow all commands without prompting (maps to --force / -f) */
    force?: boolean;
}

/**
 * Spawn `agent` CLI and yield NDJSON events.
 *
 * Usage:
 * ```ts
 * for await (const event of cursorQuery({ prompt: 'hello', abort: controller.signal })) {
 *     console.log(event.type, event.subtype);
 * }
 * ```
 */
export async function* cursorQuery(options: CursorQueryOptions): AsyncGenerator<CursorStreamEvent> {
    const {
        prompt,
        cwd = process.cwd(),
        model,
        resumeSessionId,
        apiKey,
        abort,
        env,
        executable = 'agent',
        mode,
        force,
    } = options;

    // Build arguments
    // `-p` = `--print` (headless/non-interactive mode)
    // Prompt is passed as positional argument: `agent -p "prompt" --output-format stream-json`
    // MCP servers are auto-discovered from .cursor/mcp.json — no inline config flag
    const args = ['-p', prompt, '--output-format', 'stream-json'];

    if (model) args.push('--model', model);
    if (resumeSessionId) args.push('--resume', resumeSessionId);
    if (apiKey) args.push('--api-key', apiKey);
    if (mode && mode !== 'agent') args.push('--mode', mode);
    if (force) args.push('--force');

    logger.debug(`[cursor] Spawning: ${executable} ${args.map(a => a.length > 100 ? a.substring(0, 100) + '...' : a).join(' ')}`);

    const spawnEnv = { ...process.env, ...env };
    const child: ChildProcessWithoutNullStreams = spawn(executable, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: spawnEnv,
        shell: process.platform === 'win32',
    });

    // Close stdin — prompt is passed as positional argument
    child.stdin.end();

    // Stderr logging
    child.stderr.on('data', (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
            logger.debug(`[cursor stderr] ${text}`);
        }
    });

    // Abort handling
    const cleanup = () => {
        if (!child.killed) {
            child.kill('SIGTERM');
        }
    };
    abort?.addEventListener('abort', cleanup);
    process.on('exit', cleanup);

    // Parse NDJSON from stdout
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    try {
        for await (const line of rl) {
            if (abort?.aborted) break;

            const trimmed = line.trim();
            if (!trimmed) continue;

            try {
                const event = JSON.parse(trimmed) as CursorStreamEvent;
                yield event;
            } catch (parseError) {
                logger.debug(`[cursor] Failed to parse NDJSON line: ${trimmed.substring(0, 200)}`);
            }
        }
    } finally {
        rl.close();
        abort?.removeEventListener('abort', cleanup);

        // Wait for process to exit
        if (!child.killed) {
            await new Promise<void>((resolve) => {
                child.on('close', () => resolve());
                // Give it a moment to exit naturally
                setTimeout(() => {
                    if (!child.killed) child.kill('SIGTERM');
                    resolve();
                }, 3000);
            });
        }
    }
}
