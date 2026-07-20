/**
 * TypeScript tmux utilities adapted from Python reference
 *
 * Copyright 2025 Andrew Hundt <ATHundt@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Centralized tmux utilities with control sequence support and session management
 * Ensures consistent tmux handling across remcli-cli with proper session naming
 */

import { spawn, SpawnOptions } from 'child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { promisify } from 'util';
import { logger } from '@/ui/logger';

export enum TmuxControlState {
    /** Normal text processing mode */
    NORMAL = "normal",
    /** Escape to tmux control mode */
    ESCAPE = "escape",
    /** Literal character mode */
    LITERAL = "literal"
}

/** Union type of valid tmux control sequences for better type safety */
export type TmuxControlSequence =
    | 'C-m' | 'C-c' | 'C-l' | 'C-u' | 'C-w' | 'C-a' | 'C-b' | 'C-d' | 'C-e' | 'C-f'
    | 'C-g' | 'C-h' | 'C-i' | 'C-j' | 'C-k' | 'C-n' | 'C-o' | 'C-p' | 'C-q' | 'C-r'
    | 'C-s' | 'C-t' | 'C-v' | 'C-x' | 'C-y' | 'C-z' | 'C-\\' | 'C-]' | 'C-[' | 'C-]';

/** Union type of valid tmux window operations for better type safety */
export type TmuxWindowOperation =
    // Navigation and window management
    | 'new-window' | 'new' | 'nw'
    | 'select-window' | 'sw' | 'window' | 'w'
    | 'next-window' | 'n' | 'prev-window' | 'p' | 'pw'
    // Pane management
    | 'split-window' | 'split' | 'sp' | 'vsplit' | 'vsp'
    | 'select-pane' | 'pane'
    | 'next-pane' | 'np' | 'prev-pane' | 'pp'
    // Session management
    | 'new-session' | 'ns' | 'new-sess'
    | 'attach-session' | 'attach' | 'as'
    | 'detach-client' | 'detach' | 'dc'
    // Layout and display
    | 'select-layout' | 'layout' | 'sl'
    | 'clock-mode' | 'clock'
    | 'copy-mode' | 'copy'
    | 'search-forward' | 'search-backward'
    // Misc operations
    | 'list-windows' | 'lw' | 'list-sessions' | 'ls' | 'list-panes' | 'lp'
    | 'rename-window' | 'rename' | 'kill-window' | 'kw'
    | 'kill-pane' | 'kp' | 'kill-session' | 'ks'
    // Display and info
    | 'display-message' | 'display' | 'dm'
    | 'show-options' | 'show' | 'so'
    // Control and scripting
    | 'send-keys' | 'send' | 'sk'
    | 'capture-pane' | 'capture' | 'cp'
    | 'pipe-pane' | 'pipe'
    // Buffer operations
    | 'list-buffers' | 'lb' | 'save-buffer' | 'sb'
    | 'delete-buffer' | 'db'
    // Advanced operations
    | 'resize-pane' | 'resize' | 'rp'
    | 'swap-pane' | 'swap'
    | 'join-pane' | 'join' | 'break-pane' | 'break';

export interface TmuxEnvironment {
    session: string;
    window: string;
    pane: string;
    socket_path?: string;
}

export interface TmuxCommandResult {
    returncode: number;
    stdout: string;
    stderr: string;
    command: string[];
}

export type TmuxSessionStatus = 'exists' | 'missing' | 'unknown';

export interface TmuxWindowInfo {
    windowId: string;
    sessionName: string;
    paneId: string;
    panePid: number;
}

/** Immutable identity of one tmux pane and the process that occupied it at creation. */
export interface TmuxPaneInfo {
    windowId: string;
    sessionName: string;
    paneId: string;
    panePid: number;
    ownerMarker: string;
}

export type TmuxWindowLookupResult =
    | { status: 'exists'; window: TmuxWindowInfo }
    | { status: 'missing' }
    | { status: 'unknown' };

export type TmuxPaneLookupResult =
    | { status: 'exists'; pane: TmuxPaneInfo }
    | { status: 'missing' }
    | { status: 'unknown' };

export type TmuxSpawnResult =
    | { success: true; sessionId: string; ownership: TmuxPaneInfo }
    | { success: false; error: string };

export type TmuxSessionCreateResult =
    | { success: true; sessionId: string; ownership: TmuxPaneInfo }
    | { success: false; error: string };

export type TmuxOwnedPaneReleaseResult = 'released' | 'missing' | 'mismatch' | 'unknown';
export type TmuxOwnedPaneActionResult = 'applied' | 'missing' | 'mismatch' | 'unknown';

export type TmuxOwnedPaneCaptureResult =
    | { status: 'captured'; output: string; truncated: boolean }
    | { status: 'missing' | 'mismatch' | 'unknown' };

const TMUX_WINDOW_ID_PATTERN = /^@\d+$/;
const TMUX_PANE_ID_PATTERN = /^%\d+$/;
const TMUX_OWNER_MARKER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TMUX_OWNER_OPTION = '@remcli_owner';
const TMUX_OWNERSHIP_MISMATCH_OUTPUT = '__remcli_ownership_mismatch__';
const TMUX_OWNED_PANE_CAPTURE_HISTORY_LINES = 200;
const TMUX_OWNED_PANE_CAPTURE_MAX_CHARS = 32_768;
const TMUX_OWNED_PANE_INPUT_MAX_CHARS = 16_384;
const TMUX_OWNED_PANE_FORMAT = '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{@remcli_owner}';
const TMUX_MAX_WINDOW_INDEX = 2_147_483_647;
const TMUX_WINDOW_INDEX_MIN = 1_000_000;
const TMUX_WINDOW_INDEX_MAX_EXCLUSIVE = 2_000_000_000;
const TMUX_WINDOW_INDEX_CREATE_ATTEMPTS = 4;

type TmuxWindowIndexGenerator = () => number;

function isTmuxWindowId(value: string): boolean {
    return TMUX_WINDOW_ID_PATTERN.test(value);
}

function isTmuxPaneId(value: string): boolean {
    return TMUX_PANE_ID_PATTERN.test(value);
}

function isTmuxOwnerMarker(value: string): boolean {
    return TMUX_OWNER_MARKER_PATTERN.test(value);
}

function isTmuxWindowIndex(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && value <= TMUX_MAX_WINDOW_INDEX;
}

function generateTmuxWindowIndex(): number {
    return randomInt(TMUX_WINDOW_INDEX_MIN, TMUX_WINDOW_INDEX_MAX_EXCLUSIVE);
}

function hasValidTmuxPaneOwnership(ownership: TmuxPaneInfo): boolean {
    return isTmuxPaneId(ownership.paneId)
        && isTmuxWindowId(ownership.windowId)
        && /^[a-zA-Z0-9._-]+$/.test(ownership.sessionName)
        && Number.isSafeInteger(ownership.panePid)
        && ownership.panePid > 0
        && isTmuxOwnerMarker(ownership.ownerMarker);
}

function hasMatchingTmuxPaneOwnership(actual: TmuxPaneInfo, expected: TmuxPaneInfo): boolean {
    return actual.sessionName === expected.sessionName
        && actual.windowId === expected.windowId
        && actual.paneId === expected.paneId
        && actual.panePid === expected.panePid
        && actual.ownerMarker === expected.ownerMarker;
}

function buildTmuxPaneCondition(ownership: TmuxPaneInfo, expectedOwnerMarker: string): string {
    const conditions = [
        `#{==:#{${TMUX_OWNER_OPTION}},${expectedOwnerMarker}}`,
        `#{==:#{session_name},${ownership.sessionName}}`,
        `#{==:#{window_id},${ownership.windowId}}`,
        `#{==:#{pane_id},${ownership.paneId}}`,
        `#{==:#{pane_pid},${ownership.panePid}}`,
    ];

    return conditions.reduce((combinedCondition, condition) => `#{&&:${combinedCondition},${condition}}`);
}

function buildTmuxSessionOwnerCondition(sessionName: string, ownerMarker: string): string {
    return '#{&&:#{==:#{session_name},' + sessionName + '},#{==:#{@remcli_owner},' + ownerMarker + '}}';
}

function buildExactTmuxWindowIndexTarget(sessionName: string, windowIndex: number): string {
    return `=${sessionName}:${windowIndex}`;
}

function isTmuxWindowIndexInUse(result: TmuxCommandResult | null, windowIndex: number): boolean {
    if (!result || result.returncode === 0) {
        return false;
    }

    return `${result.stderr}\n${result.stdout}`.includes(`index ${windowIndex} in use`);
}

function quoteTmuxCommandArgument(value: string): string {
    return `"${value.replace(/([\\"])/g, '\\$1')}"`;
}

function createOwnedPaneOutcomeMarker(kind: 'capture' | 'input'): string {
    return `__remcli_owned_pane_${kind}_${randomUUID()}__`;
}

function buildOwnedTmuxPaneCreationCommand(
    createWindowArgs: string[],
    sessionWindowTarget: string,
    ownershipMarker: string,
): string {
    const quoteCommand = (args: string[]): string => args.map(quoteTmuxCommandArgument).join(' ');

    return [
        quoteCommand(createWindowArgs),
        quoteCommand(['set-option', '-p', '-t', sessionWindowTarget, TMUX_OWNER_OPTION, ownershipMarker]),
        quoteCommand(['display-message', '-p', '-t', sessionWindowTarget, TMUX_OWNED_PANE_FORMAT]),
    ].join(' ; ');
}

export interface TmuxSessionInfo {
    target_session: string;
    session: string;
    window: string;
    pane: string;
    socket_path?: string;
    tmux_active: boolean;
    current_session?: string;
    env_session?: string;
    env_window?: string;
    env_pane?: string;
    available_sessions: string[];
}

// Strongly typed tmux session identifier with validation
export interface TmuxSessionIdentifier {
    session: string;
    window?: string;
    pane?: string;
}

/** Validation error for tmux session identifiers */
export class TmuxSessionIdentifierError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TmuxSessionIdentifierError';
    }
}

// Helper to parse tmux session identifier from string with validation
export function parseTmuxSessionIdentifier(identifier: string): TmuxSessionIdentifier {
    if (!identifier || typeof identifier !== 'string') {
        throw new TmuxSessionIdentifierError('Session identifier must be a non-empty string');
    }

    // Format: session:window or session:window.pane or just session
    const parts = identifier.split(':');
    if (parts.length === 0 || !parts[0]) {
        throw new TmuxSessionIdentifierError('Invalid session identifier: missing session name');
    }

    const result: TmuxSessionIdentifier = {
        session: parts[0].trim()
    };

    // Validate session name (tmux has restrictions on session names)
    if (!/^[a-zA-Z0-9._-]+$/.test(result.session)) {
        throw new TmuxSessionIdentifierError(`Invalid session name: "${result.session}". Only alphanumeric characters, dots, hyphens, and underscores are allowed.`);
    }

    if (parts.length > 1) {
        const windowAndPane = parts[1].split('.');
        result.window = windowAndPane[0]?.trim();

        if (result.window && !/^[a-zA-Z0-9._-]+$/.test(result.window)) {
            throw new TmuxSessionIdentifierError(`Invalid window name: "${result.window}". Only alphanumeric characters, dots, hyphens, and underscores are allowed.`);
        }

        if (windowAndPane.length > 1) {
            result.pane = windowAndPane[1]?.trim();
            if (result.pane && !/^[0-9]+$/.test(result.pane)) {
                throw new TmuxSessionIdentifierError(`Invalid pane identifier: "${result.pane}". Only numeric values are allowed.`);
            }
        }
    }

    return result;
}

// Helper to format tmux session identifier to string
export function formatTmuxSessionIdentifier(identifier: TmuxSessionIdentifier): string {
    if (!identifier.session) {
        throw new TmuxSessionIdentifierError('Session identifier must have a session name');
    }

    let result = identifier.session;
    if (identifier.window) {
        result += `:${identifier.window}`;
        if (identifier.pane) {
            result += `.${identifier.pane}`;
        }
    }
    return result;
}

// Helper to extract session and window from tmux output with improved validation
export function extractSessionAndWindow(tmuxOutput: string): { session: string; window: string } | null {
    if (!tmuxOutput || typeof tmuxOutput !== 'string') {
        return null;
    }

    // Look for session:window patterns in tmux output
    const lines = tmuxOutput.split('\n');

    for (const line of lines) {
        const match = line.match(/^([a-zA-Z0-9._-]+):([a-zA-Z0-9._-]+)(?:\.([0-9]+))?/);
        if (match) {
            return {
                session: match[1],
                window: match[2]
            };
        }
    }

    return null;
}

export interface TmuxSpawnOptions extends Omit<SpawnOptions, 'env'> {
    /** Target tmux session name */
    sessionName?: string;
    /** UUID capability written to the pane before it is returned to a caller. */
    ownershipMarker: string;
    /** Custom tmux socket path */
    socketPath?: string;
    /** Create new window in existing session */
    createWindow?: boolean;
    /** Window name for new windows */
    windowName?: string;
    // Note: env is intentionally excluded from this interface.
    // It's passed as a separate parameter to spawnInTmux() for clarity
    // and efficiency - only variables that differ from the tmux server
    // environment need to be passed via -e flags.
}

/**
 * Options for creating a child window only when one daemon-owned host pane
 * still has its original immutable ownership tuple.
 */
export interface TmuxOwnedWindowSpawnOptions extends Omit<TmuxSpawnOptions, 'sessionName'> {
    hostOwnership: TmuxPaneInfo;
}

/**
 * Complete WIN_OPS dispatch dictionary for tmux operations
 * Maps operation names to tmux commands with proper typing
 */
const WIN_OPS: Record<TmuxWindowOperation, string> = {
    // Navigation and window management
    'new-window': 'new-window',
    'new': 'new-window',
    'nw': 'new-window',

    'select-window': 'select-window -t',
    'sw': 'select-window -t',
    'window': 'select-window -t',
    'w': 'select-window -t',

    'next-window': 'next-window',
    'n': 'next-window',
    'prev-window': 'previous-window',
    'p': 'previous-window',
    'pw': 'previous-window',

    // Pane management
    'split-window': 'split-window',
    'split': 'split-window',
    'sp': 'split-window',
    'vsplit': 'split-window -h',
    'vsp': 'split-window -h',

    'select-pane': 'select-pane -t',
    'pane': 'select-pane -t',

    'next-pane': 'select-pane -t :.+',
    'np': 'select-pane -t :.+',
    'prev-pane': 'select-pane -t :.-',
    'pp': 'select-pane -t :.-',

    // Session management
    'new-session': 'new-session',
    'ns': 'new-session',
    'new-sess': 'new-session',

    'attach-session': 'attach-session -t',
    'attach': 'attach-session -t',
    'as': 'attach-session -t',

    'detach-client': 'detach-client',
    'detach': 'detach-client',
    'dc': 'detach-client',

    // Layout and display
    'select-layout': 'select-layout',
    'layout': 'select-layout',
    'sl': 'select-layout',

    'clock-mode': 'clock-mode',
    'clock': 'clock-mode',

    // Copy mode
    'copy-mode': 'copy-mode',
    'copy': 'copy-mode',

    // Search and navigation in copy mode
    'search-forward': 'search-forward',
    'search-backward': 'search-backward',

    // Misc operations
    'list-windows': 'list-windows',
    'lw': 'list-windows',
    'list-sessions': 'list-sessions',
    'ls': 'list-sessions',
    'list-panes': 'list-panes',
    'lp': 'list-panes',

    'rename-window': 'rename-window',
    'rename': 'rename-window',

    'kill-window': 'kill-window',
    'kw': 'kill-window',
    'kill-pane': 'kill-pane',
    'kp': 'kill-pane',
    'kill-session': 'kill-session',
    'ks': 'kill-session',

    // Display and info
    'display-message': 'display-message',
    'display': 'display-message',
    'dm': 'display-message',

    'show-options': 'show-options',
    'show': 'show-options',
    'so': 'show-options',

    // Control and scripting
    'send-keys': 'send-keys',
    'send': 'send-keys',
    'sk': 'send-keys',

    'capture-pane': 'capture-pane',
    'capture': 'capture-pane',
    'cp': 'capture-pane',

    'pipe-pane': 'pipe-pane',
    'pipe': 'pipe-pane',

    // Buffer operations
    'list-buffers': 'list-buffers',
    'lb': 'list-buffers',
    'save-buffer': 'save-buffer',
    'sb': 'save-buffer',
    'delete-buffer': 'delete-buffer',
    'db': 'delete-buffer',

    // Advanced operations
    'resize-pane': 'resize-pane',
    'resize': 'resize-pane',
    'rp': 'resize-pane',

    'swap-pane': 'swap-pane',
    'swap': 'swap-pane',

    'join-pane': 'join-pane',
    'join': 'join-pane',
    'break-pane': 'break-pane',
    'break': 'break-pane',
};

// Commands that support session targeting
const COMMANDS_SUPPORTING_TARGET = new Set([
    'send-keys', 'capture-pane', 'new-window', 'kill-window',
    'select-window', 'split-window', 'select-pane', 'kill-pane',
    'select-layout', 'display-message', 'attach-session', 'detach-client',
    'new-session', 'kill-session', 'list-windows', 'list-panes'
]);

// Control sequences that must be separate arguments with proper typing
const CONTROL_SEQUENCES: Set<TmuxControlSequence> = new Set([
    'C-m', 'C-c', 'C-l', 'C-u', 'C-w', 'C-a', 'C-b', 'C-d', 'C-e', 'C-f',
    'C-g', 'C-h', 'C-i', 'C-j', 'C-k', 'C-n', 'C-o', 'C-p', 'C-q', 'C-r',
    'C-s', 'C-t', 'C-v', 'C-x', 'C-y', 'C-z', 'C-\\', 'C-]', 'C-[', 'C-]'
]);

const TMUX_COMMAND_TIMEOUT_MS = 5_000;

export class TmuxUtilities {
    /** Default session name to prevent interference */
    public static readonly DEFAULT_SESSION_NAME = "remcli";

    private controlState: TmuxControlState = TmuxControlState.NORMAL;
    public readonly sessionName: string;
    private readonly socketPath?: string;
    private readonly windowIndexGenerator: TmuxWindowIndexGenerator;

    constructor(
        sessionName?: string,
        socketPath?: string,
        windowIndexGenerator: TmuxWindowIndexGenerator = generateTmuxWindowIndex,
    ) {
        this.sessionName = sessionName || TmuxUtilities.DEFAULT_SESSION_NAME;
        this.socketPath = socketPath;
        this.windowIndexGenerator = windowIndexGenerator;
    }

    /**
     * Detect tmux environment from TMUX environment variable
     */
    detectTmuxEnvironment(): TmuxEnvironment | null {
        const tmuxEnv = process.env.TMUX;
        if (!tmuxEnv) {
            return null;
        }

        // Parse TMUX environment: /tmp/tmux-1000/default,4219,0
        try {
            const parts = tmuxEnv.split(',');
            if (parts.length >= 3) {
                const socketPath = parts[0];
                // Extract last component from path (JavaScript doesn't support negative array indexing)
                const pathParts = parts[1].split('/');
                const sessionAndWindow = pathParts[pathParts.length - 1] || parts[1];
                const pane = parts[2];

                // Extract session name from session.window format
                let session: string;
                let window: string;
                if (sessionAndWindow.includes('.')) {
                    const parts = sessionAndWindow.split('.', 2);
                    session = parts[0];
                    window = parts[1] || "0";
                } else {
                    session = sessionAndWindow;
                    window = "0";
                }

                return {
                    session,
                    window,
                    pane,
                    socket_path: socketPath
                };
            }
        } catch (error) {
            logger.debug('[TMUX] Failed to parse TMUX environment variable:', error);
        }

        return null;
    }

    /**
     * Execute tmux command with proper session targeting and socket handling
     */
    async executeTmuxCommand(
        cmd: string[],
        session?: string,
        window?: string,
        pane?: string,
        socketPath?: string
    ): Promise<TmuxCommandResult | null> {
        const targetSession = session || this.sessionName;

        // Build command array
        let baseCmd = ['tmux'];

        // Add socket specification if provided
        const targetSocketPath = socketPath ?? this.socketPath;
        if (targetSocketPath) {
            baseCmd = ['tmux', '-S', targetSocketPath];
        }

        // Handle send-keys with proper target specification
        if (cmd.length > 0 && cmd[0] === 'send-keys') {
            const fullCmd = [...baseCmd, cmd[0]];

            // Add target specification immediately after send-keys
            let target = targetSession;
            if (window) target += `:${window}`;
            if (pane) target += `.${pane}`;
            fullCmd.push('-t', target);

            // Add keys and control sequences
            fullCmd.push(...cmd.slice(1));

            return this.executeCommand(fullCmd);
        } else {
            // Non-send-keys commands
            const fullCmd = [...baseCmd, ...cmd];

            // Add target specification for commands that support it
            if (cmd.length > 0 && COMMANDS_SUPPORTING_TARGET.has(cmd[0])) {
                let target = targetSession;
                if (window) target += `:${window}`;
                if (pane) target += `.${pane}`;
                fullCmd.push('-t', target);
            }

            return this.executeCommand(fullCmd);
        }
    }

    /**
     * Execute command with subprocess and return result
     */
    private async executeCommand(cmd: string[]): Promise<TmuxCommandResult | null> {
        try {
            const command = this.socketPath && cmd[0] === 'tmux' && !cmd.slice(1).includes('-S')
                ? ['tmux', '-S', this.socketPath, ...cmd.slice(1)]
                : cmd;
            const result = await this.runCommand(command);
            return {
                returncode: result.exitCode,
                stdout: result.stdout || '',
                stderr: result.stderr || '',
                command,
            };
        } catch (error) {
            logger.debug('[TMUX] Command execution failed:', error);
            return null;
        }
    }

    /**
     * Run command using Node.js child_process.spawn
     */
    private runCommand(args: string[], options: SpawnOptions = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
        return new Promise((resolve, reject) => {
            let stdout = '';
            let stderr = '';
            let hasSettled = false;
            let timeout: NodeJS.Timeout | undefined;

            const complete = (result: { exitCode: number; stdout: string; stderr: string }) => {
                if (hasSettled) {
                    return;
                }
                hasSettled = true;
                if (timeout) {
                    clearTimeout(timeout);
                }
                resolve(result);
            };

            const fail = (error: Error) => {
                if (hasSettled) {
                    return;
                }
                hasSettled = true;
                if (timeout) {
                    clearTimeout(timeout);
                }
                reject(error);
            };

            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(args[0], args.slice(1), {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    shell: false,
                    ...options
                });
            } catch (error) {
                fail(error instanceof Error ? error : new Error(String(error)));
                return;
            }

            timeout = setTimeout(() => {
                try {
                    child.kill('SIGKILL');
                } catch (error) {
                    stderr += `tmux command timeout cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
                } finally {
                    fail(new Error(`${stderr}tmux command timed out after ${TMUX_COMMAND_TIMEOUT_MS}ms`));
                }
            }, TMUX_COMMAND_TIMEOUT_MS);

            child.stdout?.on('data', (data) => {
                stdout += data.toString();
            });

            child.stderr?.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code, signal) => {
                if (signal) {
                    fail(new Error(`${stderr}tmux command terminated by ${signal}`));
                    return;
                }
                complete({
                    exitCode: code ?? 1,
                    stdout,
                    stderr
                });
            });

            child.on('error', (error) => {
                fail(error);
            });
        });
    }

    /**
     * Parse control sequences in text (^ for escape, ^^ for literal ^)
     */
    parseControlSequences(text: string): [string, TmuxControlState] {
        const result: string[] = [];
        let i = 0;
        let localState = this.controlState;

        while (i < text.length) {
            const char = text[i];

            if (localState === TmuxControlState.NORMAL) {
                if (char === '^') {
                    if (i + 1 < text.length && text[i + 1] === '^') {
                        // Literal ^
                        result.push('^');
                        i += 2;
                    } else {
                        // Escape to normal tmux
                        localState = TmuxControlState.ESCAPE;
                        i += 1;
                    }
                } else {
                    result.push(char);
                    i += 1;
                }
            } else if (localState === TmuxControlState.ESCAPE) {
                // In escape mode - pass through to tmux directly
                result.push(char);
                i += 1;
                localState = TmuxControlState.NORMAL;
            } else {
                result.push(char);
                i += 1;
            }
        }

        this.controlState = localState;
        return [result.join(''), localState];
    }

    /**
     * Execute window operation using WIN_OPS dispatch with type safety
     */
    async executeWinOp(
        operation: TmuxWindowOperation,
        args: string[] = [],
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        const tmuxCmd = WIN_OPS[operation];
        if (!tmuxCmd) {
            logger.debug(`[TMUX] Unknown operation: ${operation}`);
            return false;
        }

        const cmdParts = tmuxCmd.split(' ');
        cmdParts.push(...args);

        const result = await this.executeTmuxCommand(cmdParts, session, window, pane);
        return result !== null && result.returncode === 0;
    }

    /**
     * Ensure session exists, create if needed
     */
    async ensureSessionExists(sessionName?: string): Promise<boolean> {
        const targetSession = sessionName || this.sessionName;

        // Check if session exists
        // Use executeCommand directly because executeTmuxCommand auto-appends -t for has-session,
        // which is fine here but we want consistency with the create path.
        const result = await this.executeCommand(['tmux', 'has-session', '-t', targetSession]);
        if (result && result.returncode === 0) {
            return true;
        }

        // Create session if it doesn't exist
        // IMPORTANT: Use executeCommand directly, NOT executeTmuxCommand!
        // executeTmuxCommand auto-appends "-t sessionName" for new-session,
        // but for new-session, -t means SESSION GROUP (not target), which causes
        // grouped sessions where new-window fails with "index in use".
        const createResult = await this.executeCommand(['tmux', 'new-session', '-d', '-s', targetSession]);
        return createResult !== null && createResult.returncode === 0;
    }

    /**
     * Allocate the numeric target before creating a window, so the create,
     * marker, and ownership response all address the same immutable target.
     * A target collision fails before the command runs; it is safe to retry
     * because no name-based target is ever used to mark a foreign window.
     */
    private async createMarkedTmuxWindow(
        sessionName: string,
        ownershipMarker: string,
        buildCreateCommand: (sessionWindowTarget: string) => string[],
        buildFailureMessage: (result: TmuxCommandResult | null) => string,
    ): Promise<TmuxPaneInfo> {
        for (let attempt = 0; attempt < TMUX_WINDOW_INDEX_CREATE_ATTEMPTS; attempt++) {
            const windowIndex = this.windowIndexGenerator();
            if (!isTmuxWindowIndex(windowIndex)) {
                throw new TmuxSessionIdentifierError('Tmux window index generator returned an invalid index');
            }

            const sessionWindowTarget = buildExactTmuxWindowIndexTarget(sessionName, windowIndex);
            const result = await this.executeCommand(buildCreateCommand(sessionWindowTarget));
            if (isTmuxWindowIndexInUse(result, windowIndex)) {
                logger.debug(`[TMUX] Window index ${windowIndex} is already in use; retrying owned window creation.`);
                continue;
            }

            const ownership = await this.resolveCreatedPaneOwnership(
                result,
                sessionName,
                ownershipMarker,
            );
            if (ownership) {
                return ownership;
            }

            throw new Error(buildFailureMessage(result));
        }

        throw new Error(`Failed to reserve a unique tmux window index after ${TMUX_WINDOW_INDEX_CREATE_ATTEMPTS} attempts.`);
    }

    private parseCreatedPaneOwnership(
        output: string,
        sessionName: string,
        ownerMarker: string,
        includesSessionName: boolean,
        includesOwnerMarker = false,
    ): TmuxPaneInfo | null {
        const values = output.trim().split('\t');
        const expectedValueCount = 3 + Number(includesSessionName) + Number(includesOwnerMarker);
        if (values.length !== expectedValueCount) {
            return null;
        }
        const receivedSessionName = includesSessionName ? values.shift() : sessionName;
        const [windowId, paneId, panePidValue, receivedOwnerMarker] = values;
        const panePid = Number.parseInt(panePidValue ?? '', 10);
        const ownership: TmuxPaneInfo = {
            sessionName: receivedSessionName ?? '',
            windowId: windowId ?? '',
            paneId: paneId ?? '',
            panePid,
            ownerMarker,
        };

        return ownership.sessionName === sessionName
            && (!includesOwnerMarker || receivedOwnerMarker === ownerMarker)
            && hasValidTmuxPaneOwnership(ownership)
            ? ownership
            : null;
    }

    /**
     * Find the one pane a failed create attempt could have made. The tmux
     * server filters by both session name and owner marker, while this client
     * accepts exactly one fully validated tuple. Ambiguity is never cleaned up
     * or adopted.
     */
    async findOwnedPaneBySessionAndMarker(
        sessionName: string,
        ownerMarker: string,
    ): Promise<TmuxPaneInfo | null> {
        try {
            const parsedSession = parseTmuxSessionIdentifier(sessionName);
            if (parsedSession.window || parsedSession.pane || !isTmuxOwnerMarker(ownerMarker)) {
                return null;
            }

            const result = await this.executeCommand([
                'tmux',
                'list-panes',
                '-a',
                '-F',
                TMUX_OWNED_PANE_FORMAT,
                '-f',
                buildTmuxSessionOwnerCondition(parsedSession.session, ownerMarker),
            ]);
            if (!result || result.returncode !== 0) {
                return null;
            }

            const candidateRows = result.stdout.split('\n').filter(Boolean);
            if (candidateRows.length !== 1) {
                return null;
            }

            return this.parseCreatedPaneOwnership(
                candidateRows[0],
                parsedSession.session,
                ownerMarker,
                true,
                true,
            );
        } catch (error) {
            logger.debug('[TMUX] Failed to recover an owned tmux pane:', error);
            return null;
        }
    }

    /**
     * Use the response only when tmux confirmed the full marked tuple. A lost,
     * failed, or malformed response is recoverable solely through the UUID
     * marker that the creation command installed server-side.
     */
    private async resolveCreatedPaneOwnership(
        result: TmuxCommandResult | null,
        sessionName: string,
        ownerMarker: string,
    ): Promise<TmuxPaneInfo | null> {
        if (result?.returncode === 0) {
            const createdOwnership = this.parseCreatedPaneOwnership(
                result.stdout,
                sessionName,
                ownerMarker,
                true,
                true,
            );
            if (createdOwnership) {
                return createdOwnership;
            }
        }

        return this.findOwnedPaneBySessionAndMarker(sessionName, ownerMarker);
    }

    /**
     * Create a tmux host session and return the exact pane identity created by
     * that command. Unlike ensureSessionExists(), this never adopts a
     * same-named session that another process created.
     */
    async createSessionWithPane(
        sessionName: string,
        windowName: string,
        ownershipMarker: string,
    ): Promise<TmuxSessionCreateResult> {
        try {
            const parsedSession = parseTmuxSessionIdentifier(sessionName);
            if (parsedSession.window || parsedSession.pane) {
                throw new TmuxSessionIdentifierError('Session name must not include a window or pane target');
            }
            if (!/^[a-zA-Z0-9._-]+$/.test(windowName)) {
                throw new TmuxSessionIdentifierError(`Invalid window name: "${windowName}". Only alphanumeric characters, dots, hyphens, and underscores are allowed.`);
            }
            if (!isTmuxOwnerMarker(ownershipMarker)) {
                throw new TmuxSessionIdentifierError('Invalid tmux ownership marker');
            }

            const result = await this.executeCommand([
                'tmux',
                'new-session',
                '-d',
                '-s',
                parsedSession.session,
                '-n',
                windowName,
                ';',
                'set-option',
                '-p',
                TMUX_OWNER_OPTION,
                ownershipMarker,
                ';',
                'display-message',
                '-p',
                TMUX_OWNED_PANE_FORMAT,
            ]);
            const ownership = await this.resolveCreatedPaneOwnership(
                result,
                parsedSession.session,
                ownershipMarker,
            );
            if (!ownership) {
                throw new Error(result?.stderr || 'Failed to create or recover the marked tmux session pane.');
            }

            return {
                success: true,
                sessionId: formatTmuxSessionIdentifier({ session: parsedSession.session, window: windowName }),
                ownership,
            };
        } catch (error) {
            logger.debug('[TMUX] Failed to create an owned tmux session:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Capture current input from tmux pane
     */
    async captureCurrentInput(
        session?: string,
        window?: string,
        pane?: string
    ): Promise<string> {
        const result = await this.executeTmuxCommand(['capture-pane', '-p'], session, window, pane);
        if (result && result.returncode === 0) {
            const lines = result.stdout.trim().split('\n');
            return lines[lines.length - 1] || '';
        }
        return '';
    }

    /**
     * Check if user is actively typing
     */
    async isUserTyping(
        checkInterval: number = 500,
        maxChecks: number = 3,
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        const initialInput = await this.captureCurrentInput(session, window, pane);

        for (let i = 0; i < maxChecks - 1; i++) {
            await new Promise(resolve => setTimeout(resolve, checkInterval));
            const currentInput = await this.captureCurrentInput(session, window, pane);
            if (currentInput !== initialInput) {
                return true;
            }
        }

        return false;
    }

    /**
     * Send keys to tmux pane with proper control sequence handling and type safety
     */
    async sendKeys(
        keys: string | TmuxControlSequence,
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        // Validate input
        if (!keys || typeof keys !== 'string') {
            logger.debug('[TMUX] Invalid keys provided to sendKeys');
            return false;
        }

        // Handle control sequences that must be separate arguments
        if (CONTROL_SEQUENCES.has(keys as TmuxControlSequence)) {
            const result = await this.executeTmuxCommand(['send-keys', keys], session, window, pane);
            return result !== null && result.returncode === 0;
        } else {
            // Regular text
            const result = await this.executeTmuxCommand(['send-keys', keys], session, window, pane);
            return result !== null && result.returncode === 0;
        }
    }

    /**
     * Send multiple keys to tmux pane with proper control sequence handling
     */
    async sendMultipleKeys(
        keys: Array<string | TmuxControlSequence>,
        session?: string,
        window?: string,
        pane?: string
    ): Promise<boolean> {
        if (!Array.isArray(keys) || keys.length === 0) {
            logger.debug('[TMUX] Invalid keys array provided to sendMultipleKeys');
            return false;
        }

        for (const key of keys) {
            const success = await this.sendKeys(key, session, window, pane);
            if (!success) {
                return false;
            }
        }

        return true;
    }

    /**
     * Get comprehensive session information
     */
    async getSessionInfo(sessionName?: string): Promise<TmuxSessionInfo> {
        const targetSession = sessionName || this.sessionName;
        const envInfo = this.detectTmuxEnvironment();

        const info: TmuxSessionInfo = {
            target_session: targetSession,
            session: targetSession,
            window: "unknown",
            pane: "unknown",
            socket_path: undefined,
            tmux_active: envInfo !== null,
            current_session: envInfo?.session,
            available_sessions: []
        };

        // Update with environment info if it matches our target session
        if (envInfo && envInfo.session === targetSession) {
            info.window = envInfo.window;
            info.pane = envInfo.pane;
            info.socket_path = envInfo.socket_path;
        } else if (envInfo) {
            // Add environment info as separate fields
            info.env_session = envInfo.session;
            info.env_window = envInfo.window;
            info.env_pane = envInfo.pane;
        }

        // Get available sessions
        const result = await this.executeTmuxCommand(['list-sessions']);
        if (result && result.returncode === 0) {
            info.available_sessions = result.stdout
                .trim()
                .split('\n')
                .filter(line => line.trim())
                .map(line => line.split(':')[0]);
        }

        return info;
    }

    /**
     * Spawn process in tmux session with environment variables.
     *
     * IMPORTANT: Unlike Node.js spawn(), env is a separate parameter.
     * This is intentional because:
     * - Tmux windows inherit environment from the tmux server
     * - Only NEW or DIFFERENT variables need to be set via -e flag
     * - Passing all of process.env would create 50+ unnecessary -e flags
     *
     * @param args - Command and arguments to execute (as array, will be joined)
     * @param options - Spawn options (tmux-specific, excludes env)
     * @param env - Environment variables to set in window (only pass what's different!)
     * @returns Result with success status and session identifier
     */
    async spawnInTmux(
        args: string[],
        options: TmuxSpawnOptions,
        env?: Record<string, string>
    ): Promise<TmuxSpawnResult> {
        try {
            // Check if tmux is available
            const tmuxCheck = await this.executeTmuxCommand(['list-sessions']);
            if (!tmuxCheck) {
                throw new Error('tmux not available');
            }

            // Handle session name resolution
            // - undefined: Use first existing session or create "remcli"
            // - empty string: Use first existing session or create "remcli"
            // - specific name: Use that session (create if doesn't exist)
            let sessionName = options.sessionName !== undefined && options.sessionName !== ''
                ? options.sessionName
                : null;

            // If no specific session name, try to use first existing session
            if (!sessionName) {
                const listResult = await this.executeTmuxCommand(['list-sessions', '-F', '#{session_name}']);
                if (listResult && listResult.returncode === 0 && listResult.stdout.trim()) {
                    // Use first session from list
                    const firstSession = listResult.stdout.trim().split('\n')[0];
                    sessionName = firstSession;
                    logger.debug(`[TMUX] Using first existing session: ${sessionName}`);
                } else {
                    // No sessions exist, create "remcli"
                    sessionName = 'remcli';
                    logger.debug(`[TMUX] No existing sessions, using default: ${sessionName}`);
                }
            }

            const windowName = options.windowName;
            if (!windowName || !/^[a-zA-Z0-9._-]+$/.test(windowName)) {
                throw new TmuxSessionIdentifierError('A valid collision-resistant tmux window name is required');
            }

            if (!isTmuxOwnerMarker(options.ownershipMarker)) {
                throw new TmuxSessionIdentifierError('Invalid tmux ownership marker');
            }

            // Check if session already exists
            const sessionExistsResult = await this.executeCommand(['tmux', 'has-session', '-t', sessionName]);
            const sessionExists = sessionExistsResult !== null && sessionExistsResult.returncode === 0;

            // Build command to execute
            const fullCommand = args.join(' ');

            // Build env flags (shared between new-session and new-window paths)
            const envFlags: string[] = [];
            if (env && Object.keys(env).length > 0) {
                for (const [key, value] of Object.entries(env)) {
                    if (value === undefined || value === null) {
                        logger.warn(`[TMUX] Skipping undefined/null environment variable: ${key}`);
                        continue;
                    }
                    if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
                        logger.warn(`[TMUX] Skipping invalid environment variable name: ${key}`);
                        continue;
                    }
                    envFlags.push('-e', `${key}=${value}`);
                }
                logger.debug(`[TMUX] Setting ${Object.keys(env).length} environment variables in tmux window`);
            }

            let ownership: TmuxPaneInfo;
            if (!sessionExists) {
                // Session doesn't exist — create it WITH the command as first window.
                // This avoids an empty default shell window (window 0).
                // The same tmux command marks and displays the exact new pane.
                const createWindowArgs = ['new-session', '-d', '-s', sessionName, '-n', windowName];

                if (options.cwd) {
                    const cwdPath = typeof options.cwd === 'string' ? options.cwd : options.cwd.pathname;
                    createWindowArgs.push('-c', cwdPath);
                }

                createWindowArgs.push(...envFlags);
                createWindowArgs.push(fullCommand);

                logger.debug(`[TMUX] Creating new session "${sessionName}" with command window "${windowName}"`);
                const fullTmuxCmd = [
                    'tmux',
                    ...createWindowArgs,
                    ';',
                    'set-option',
                    '-p',
                    TMUX_OWNER_OPTION,
                    options.ownershipMarker,
                    ';',
                    'display-message',
                    '-p',
                    TMUX_OWNED_PANE_FORMAT,
                ];
                logger.debug(`[TMUX] Full tmux command (${fullTmuxCmd.length} args): tmux ${createWindowArgs.slice(0, 6).join(' ')} ... [${env ? Object.keys(env).length : 0} env vars] ... ${createWindowArgs.slice(-3).join(' ')}`);
                const createResult = await this.executeCommand(fullTmuxCmd);
                const createdOwnership = await this.resolveCreatedPaneOwnership(
                    createResult,
                    sessionName,
                    options.ownershipMarker,
                );
                if (!createdOwnership) {
                    throw new Error(createResult?.stderr || 'Failed to create or recover the marked tmux session pane.');
                }
                ownership = createdOwnership;
            } else {
                logger.debug(`[TMUX] Adding window "${windowName}" to existing session "${sessionName}"`);
                ownership = await this.createMarkedTmuxWindow(
                    sessionName,
                    options.ownershipMarker,
                    (sessionWindowTarget) => {
                        const createWindowArgs = ['new-window', '-t', sessionWindowTarget, '-n', windowName];
                        if (options.cwd) {
                            const cwdPath = typeof options.cwd === 'string' ? options.cwd : options.cwd.pathname;
                            createWindowArgs.push('-c', cwdPath);
                        }
                        createWindowArgs.push(...envFlags, fullCommand);

                        return [
                            'tmux',
                            ...createWindowArgs,
                            ';',
                            'set-option',
                            '-p',
                            '-t',
                            sessionWindowTarget,
                            TMUX_OWNER_OPTION,
                            options.ownershipMarker,
                            ';',
                            'display-message',
                            '-p',
                            '-t',
                            sessionWindowTarget,
                            TMUX_OWNED_PANE_FORMAT,
                        ];
                    },
                    (result) => result?.stderr || 'Failed to create or recover the marked tmux window pane.',
                );
            }

            logger.debug(`[TMUX] Spawned command in tmux session ${sessionName}, window ${windowName}, target ${ownership.windowId}/${ownership.paneId}, PID ${ownership.panePid}`);

            // Return tmux session info and PID
            const sessionIdentifier: TmuxSessionIdentifier = {
                session: sessionName,
                window: windowName
            };

            return {
                success: true,
                sessionId: formatTmuxSessionIdentifier(sessionIdentifier),
                ownership,
            };
        } catch (error) {
            logger.debug('[TMUX] Failed to spawn in tmux:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Create one child window only if the supplied host pane still belongs to
     * this daemon. The host tuple check and new-window command are one tmux
     * server-side operation, so a pane-id reuse cannot authorize creation.
     */
    async spawnInOwnedTmuxSession(
        args: string[],
        options: TmuxOwnedWindowSpawnOptions,
        env?: Record<string, string>
    ): Promise<TmuxSpawnResult> {
        try {
            const hostOwnership = options.hostOwnership;
            if (!hasValidTmuxPaneOwnership(hostOwnership)) {
                throw new TmuxSessionIdentifierError('Invalid immutable tmux host ownership');
            }
            if (!isTmuxOwnerMarker(options.ownershipMarker)) {
                throw new TmuxSessionIdentifierError('Invalid tmux ownership marker');
            }

            const windowName = options.windowName;
            if (!windowName || !/^[a-zA-Z0-9._-]+$/.test(windowName)) {
                throw new TmuxSessionIdentifierError('A valid collision-resistant tmux window name is required');
            }
            const ownership = await this.createMarkedTmuxWindow(
                hostOwnership.sessionName,
                options.ownershipMarker,
                (sessionWindowTarget) => {
                    const createWindowArgs = ['new-window', '-t', sessionWindowTarget, '-n', windowName];
                    if (options.cwd) {
                        const cwdPath = typeof options.cwd === 'string' ? options.cwd : options.cwd.pathname;
                        createWindowArgs.push('-c', cwdPath);
                    }
                    if (env) {
                        for (const [key, value] of Object.entries(env)) {
                            if (value === undefined || value === null || !/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
                                continue;
                            }
                            createWindowArgs.push('-e', `${key}=${value}`);
                        }
                    }
                    createWindowArgs.push(args.join(' '));

                    return [
                        'tmux',
                        'if-shell',
                        '-t',
                        hostOwnership.paneId,
                        '-F',
                        buildTmuxPaneCondition(hostOwnership, hostOwnership.ownerMarker),
                        buildOwnedTmuxPaneCreationCommand(
                            createWindowArgs,
                            sessionWindowTarget,
                            options.ownershipMarker,
                        ),
                        `display-message -p ${TMUX_OWNERSHIP_MISMATCH_OUTPUT}`,
                    ];
                },
                (result) => result?.stdout.trim() === TMUX_OWNERSHIP_MISMATCH_OUTPUT
                    ? 'Refused to create a tmux window because the host ownership no longer matches.'
                    : result?.stderr || 'Failed to create or recover the marked guarded tmux window pane.',
            );

            logger.debug(`[TMUX] Spawned guarded tmux child window ${ownership.windowId}/${ownership.paneId} in ${hostOwnership.sessionName}`);
            return {
                success: true,
                sessionId: formatTmuxSessionIdentifier({
                    session: hostOwnership.sessionName,
                    window: windowName,
                }),
                ownership,
            };
        } catch (error) {
            logger.debug('[TMUX] Failed to spawn guarded tmux window:', error);
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * Get session info for a given session identifier string
     */
    async getSessionInfoFromString(sessionIdentifier: string): Promise<TmuxSessionInfo | null> {
        try {
            const parsed = parseTmuxSessionIdentifier(sessionIdentifier);
            const info = await this.getSessionInfo(parsed.session);
            return info;
        } catch (error) {
            if (error instanceof TmuxSessionIdentifierError) {
                logger.debug(`[TMUX] Invalid session identifier: ${error.message}`);
            } else {
                logger.debug('[TMUX] Error getting session info:', error);
            }
            return null;
        }
    }

    /**
     * Kill a tmux window safely with proper error handling
     */
    async killWindow(sessionIdentifier: string): Promise<boolean> {
        try {
            const parsed = parseTmuxSessionIdentifier(sessionIdentifier);
            if (!parsed.window) {
                throw new TmuxSessionIdentifierError(`Window identifier required: ${sessionIdentifier}`);
            }

            const result = await this.executeWinOp('kill-window', [], parsed.session, parsed.window, parsed.pane);
            return result;
        } catch (error) {
            if (error instanceof TmuxSessionIdentifierError) {
                logger.debug(`[TMUX] Invalid window identifier: ${error.message}`);
            } else {
                logger.debug('[TMUX] Error killing window:', error);
            }
            return false;
        }
    }

    /**
     * Kill one tmux window by its immutable server-wide id. Callers must verify
     * ownership before invoking this method because @window_id is global to tmux.
     */
    async killWindowById(windowId: string): Promise<boolean> {
        if (!isTmuxWindowId(windowId)) {
            logger.debug(`[TMUX] Invalid immutable window id: ${windowId}`);
            return false;
        }

        const result = await this.executeCommand(['tmux', 'kill-window', '-t', windowId]);
        return result?.returncode === 0;
    }

    /**
     * Look up an immutable window id and return the host session and pane pid
     * needed to prove a daemon still owns the target before cleanup.
     */
    async getWindowInfo(windowId: string): Promise<TmuxWindowLookupResult> {
        if (!isTmuxWindowId(windowId)) {
            return { status: 'unknown' };
        }

        const result = await this.executeCommand([
            'tmux',
            'display-message',
            '-p',
            '-t',
            windowId,
            '#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}',
        ]);
        if (!result) {
            return { status: 'unknown' };
        }
        if (result.returncode === 1) {
            return { status: 'missing' };
        }
        if (result.returncode !== 0) {
            return { status: 'unknown' };
        }

        const [sessionName, receivedWindowId, paneId, panePidValue] = result.stdout.trim().split('\t');
        const panePid = Number.parseInt(panePidValue ?? '', 10);
        if (
            !sessionName
            || !/^[a-zA-Z0-9._-]+$/.test(sessionName)
            || receivedWindowId !== windowId
            || !paneId
            || !isTmuxPaneId(paneId)
            || !Number.isSafeInteger(panePid)
            || panePid <= 0
        ) {
            return { status: 'unknown' };
        }

        return {
            status: 'exists',
            window: {
                windowId,
                sessionName,
                paneId,
                panePid,
            },
        };
    }

    /**
     * Look up exactly one tmux pane by its immutable server-wide id. The
     * returned process id lets callers prove ownership before a destructive
     * action without broadening the target to its window or session.
     */
    async getPaneInfo(paneId: string): Promise<TmuxPaneLookupResult> {
        if (!isTmuxPaneId(paneId)) {
            return { status: 'unknown' };
        }

        const result = await this.executeCommand([
            'tmux',
            'display-message',
            '-p',
            '-t',
            paneId,
            `#{session_name}\t#{window_id}\t#{pane_id}\t#{pane_pid}\t#{${TMUX_OWNER_OPTION}}`,
        ]);
        if (!result) {
            return { status: 'unknown' };
        }
        if (result.returncode === 1) {
            return { status: 'missing' };
        }
        if (result.returncode !== 0) {
            return { status: 'unknown' };
        }

        const [sessionName, windowId, receivedPaneId, panePidValue, ownerMarker] = result.stdout.trim().split('\t');
        const panePid = Number.parseInt(panePidValue ?? '', 10);
        if (
            !sessionName
            || !/^[a-zA-Z0-9._-]+$/.test(sessionName)
            || !windowId
            || !isTmuxWindowId(windowId)
            || receivedPaneId !== paneId
            || !Number.isSafeInteger(panePid)
            || panePid <= 0
            || !ownerMarker
            || !isTmuxOwnerMarker(ownerMarker)
        ) {
            return { status: 'unknown' };
        }

        return {
            status: 'exists',
            pane: {
                sessionName,
                windowId,
                paneId,
                panePid,
                ownerMarker,
            },
        };
    }

    private async getOwnedPaneOperationFailureStatus(
        ownership: TmuxPaneInfo,
    ): Promise<'missing' | 'mismatch' | 'unknown'> {
        const paneLookup = await this.getPaneInfo(ownership.paneId);
        if (paneLookup.status === 'missing') {
            return 'missing';
        }
        if (paneLookup.status !== 'exists') {
            return 'unknown';
        }

        return hasMatchingTmuxPaneOwnership(paneLookup.pane, ownership)
            ? 'unknown'
            : 'mismatch';
    }

    /**
     * Atomically send literal text only after tmux confirms the complete
     * daemon ownership tuple. The caller must decide separately whether a
     * terminal Enter/control sequence is appropriate for its protocol.
     */
    async sendLiteralTextToOwnedPane(
        ownership: TmuxPaneInfo,
        text: string,
    ): Promise<TmuxOwnedPaneActionResult> {
        if (
            !hasValidTmuxPaneOwnership(ownership)
            || typeof text !== 'string'
            || text.length === 0
            || text.length > TMUX_OWNED_PANE_INPUT_MAX_CHARS
        ) {
            return 'unknown';
        }

        const outcomeMarker = createOwnedPaneOutcomeMarker('input');
        const condition = buildTmuxPaneCondition(ownership, ownership.ownerMarker);
        const successCommand = [
            'send-keys',
            '-l',
            '-t',
            ownership.paneId,
            '--',
            quoteTmuxCommandArgument(text),
            ';',
            'display-message',
            '-p',
            outcomeMarker,
        ].join(' ');

        try {
            const result = await this.executeCommand([
                'tmux',
                'if-shell',
                '-t',
                ownership.paneId,
                '-F',
                condition,
                successCommand,
                `display-message -p ${TMUX_OWNERSHIP_MISMATCH_OUTPUT}`,
            ]);
            if (result?.returncode === 0 && result.stdout.trim() === outcomeMarker) {
                return 'applied';
            }
        } catch (error) {
            logger.debug(`[TMUX] Failed to send text to owned pane ${ownership.paneId}:`, error);
        }

        return await this.getOwnedPaneOperationFailureStatus(ownership);
    }

    /**
     * Capture a bounded owned-pane screen snapshot. The random terminal marker
     * is never logged and prevents pane content from forging a success result.
     */
    async captureOwnedPane(ownership: TmuxPaneInfo): Promise<TmuxOwnedPaneCaptureResult> {
        if (!hasValidTmuxPaneOwnership(ownership)) {
            return { status: 'unknown' };
        }

        const outcomeMarker = createOwnedPaneOutcomeMarker('capture');
        const condition = buildTmuxPaneCondition(ownership, ownership.ownerMarker);
        const successCommand = [
            'capture-pane',
            '-p',
            '-S',
            `-${TMUX_OWNED_PANE_CAPTURE_HISTORY_LINES}`,
            '-t',
            ownership.paneId,
            ';',
            'display-message',
            '-p',
            outcomeMarker,
        ].join(' ');

        try {
            const result = await this.executeCommand([
                'tmux',
                'if-shell',
                '-t',
                ownership.paneId,
                '-F',
                condition,
                successCommand,
                `display-message -p ${TMUX_OWNERSHIP_MISMATCH_OUTPUT}`,
            ]);
            const markerIndex = result?.returncode === 0
                ? result.stdout.lastIndexOf(outcomeMarker)
                : -1;
            if (
                result?.returncode === 0
                && markerIndex !== undefined
                && markerIndex >= 0
                && result.stdout.slice(markerIndex + outcomeMarker.length).trim() === ''
            ) {
                const output = result.stdout.slice(0, markerIndex);
                const truncated = output.length > TMUX_OWNED_PANE_CAPTURE_MAX_CHARS;
                return {
                    status: 'captured',
                    output: truncated
                        ? output.slice(-TMUX_OWNED_PANE_CAPTURE_MAX_CHARS)
                        : output,
                    truncated,
                };
            }
        } catch (error) {
            logger.debug(`[TMUX] Failed to capture owned pane ${ownership.paneId}:`, error);
        }

        return { status: await this.getOwnedPaneOperationFailureStatus(ownership) };
    }

    /**
     * Atomically prove a pane still has the daemon's full ownership tuple and
     * destroy it in the same tmux server command. There is deliberately no
     * client-side read-then-kill sequence here: a restarted tmux server may
     * reuse a pane id between two client commands.
     */
    async releaseOwnedPane(ownership: TmuxPaneInfo): Promise<TmuxOwnedPaneReleaseResult> {
        if (!hasValidTmuxPaneOwnership(ownership)) {
            return 'unknown';
        }

        const condition = buildTmuxPaneCondition(ownership, ownership.ownerMarker);

        try {
            const result = await this.executeCommand([
                'tmux',
                'if-shell',
                '-t',
                ownership.paneId,
                '-F',
                condition,
                `kill-pane -t ${ownership.paneId}`,
                `display-message -p ${TMUX_OWNERSHIP_MISMATCH_OUTPUT}`,
            ]);
            if (result?.returncode === 0 && result.stdout.trim() === '') {
                return 'released';
            }

            const paneLookup = await this.getPaneInfo(ownership.paneId);
            if (paneLookup.status === 'missing') {
                return 'missing';
            }
            if (paneLookup.status === 'unknown') {
                return 'unknown';
            }
            return 'mismatch';
        } catch (error) {
            logger.debug(`[TMUX] Failed to atomically release owned pane ${ownership.paneId}:`, error);
            return 'unknown';
        }
    }

    /** Kill only one immutable pane. Callers must prove full ownership first. */
    async killPaneById(paneId: string): Promise<boolean> {
        if (!isTmuxPaneId(paneId)) {
            logger.debug(`[TMUX] Invalid immutable pane id: ${paneId}`);
            return false;
        }

        const result = await this.executeCommand(['tmux', 'kill-pane', '-t', paneId]);
        return result?.returncode === 0;
    }

    /**
     * Kill a tmux session through the bounded non-shell command runner.
     */
    async killSession(sessionIdentifier: string): Promise<boolean> {
        try {
            const parsed = parseTmuxSessionIdentifier(sessionIdentifier);
            return await this.executeWinOp('kill-session', [], parsed.session);
        } catch (error) {
            if (error instanceof TmuxSessionIdentifierError) {
                logger.debug(`[TMUX] Invalid session identifier: ${error.message}`);
            } else {
                logger.debug('[TMUX] Error killing session:', error);
            }
            return false;
        }
    }

    /**
     * Return whether tmux confirmed a session exists, is missing, or could not be queried.
     */
    async getSessionStatus(sessionIdentifier: string): Promise<TmuxSessionStatus> {
        try {
            const parsed = parseTmuxSessionIdentifier(sessionIdentifier);
            const result = await this.executeCommand(['tmux', 'has-session', '-t', parsed.session]);
            if (!result) {
                return 'unknown';
            }
            if (result.returncode === 0) {
                return 'exists';
            }
            return result.returncode === 1 ? 'missing' : 'unknown';
        } catch (error) {
            logger.debug(`[TMUX] Failed to check tmux session ${sessionIdentifier}:`, error);
            return 'unknown';
        }
    }

    /**
     * List windows in a session
     */
    async listWindows(sessionName?: string): Promise<string[]> {
        const targetSession = sessionName || this.sessionName;
        const result = await this.executeTmuxCommand(['list-windows', '-t', targetSession]);

        if (!result || result.returncode !== 0) {
            return [];
        }

        // Parse window names from tmux output
        const windows: string[] = [];
        const lines = result.stdout.trim().split('\n');

        for (const line of lines) {
            const match = line.match(/^\d+:\s+(\w+)/);
            if (match) {
                windows.push(match[1]);
            }
        }

        return windows;
    }
}

// Global instance for consistent usage
let _tmuxUtils: TmuxUtilities | null = null;

export function getTmuxUtilities(sessionName?: string): TmuxUtilities {
    if (!_tmuxUtils || (sessionName && sessionName !== _tmuxUtils.sessionName)) {
        _tmuxUtils = new TmuxUtilities(sessionName);
    }
    return _tmuxUtils;
}

export async function isTmuxAvailable(): Promise<boolean> {
    try {
        const utils = new TmuxUtilities();
        const result = await utils.executeTmuxCommand(['list-sessions']);
        return result !== null;
    } catch {
        return false;
    }
}

/**
 * Create a new tmux session with proper typing and validation
 */
export async function createTmuxSession(
    sessionName: string,
    options?: {
        windowName?: string;
        detached?: boolean;
        attach?: boolean;
    }
): Promise<{ success: boolean; sessionIdentifier?: string; error?: string }> {
    try {
        if (!sessionName || !/^[a-zA-Z0-9._-]+$/.test(sessionName)) {
            throw new TmuxSessionIdentifierError(`Invalid session name: "${sessionName}"`);
        }

        const utils = new TmuxUtilities(sessionName);
        const windowName = options?.windowName || 'main';

        const cmd = ['new-session'];
        if (options?.detached !== false) {
            cmd.push('-d');
        }
        cmd.push('-s', sessionName);
        cmd.push('-n', windowName);

        const result = await utils.executeTmuxCommand(cmd);
        if (result && result.returncode === 0) {
            const sessionIdentifier: TmuxSessionIdentifier = {
                session: sessionName,
                window: windowName
            };
            return {
                success: true,
                sessionIdentifier: formatTmuxSessionIdentifier(sessionIdentifier)
            };
        } else {
            return {
                success: false,
                error: result?.stderr || 'Failed to create tmux session'
            };
        }
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

/**
 * Validate a tmux session identifier without throwing
 */
export function validateTmuxSessionIdentifier(identifier: string): { valid: boolean; error?: string } {
    try {
        parseTmuxSessionIdentifier(identifier);
        return { valid: true };
    } catch (error) {
        return {
            valid: false,
            error: error instanceof Error ? error.message : 'Unknown validation error'
        };
    }
}

/**
 * Build a tmux session identifier with validation
 */
export function buildTmuxSessionIdentifier(params: {
    session: string;
    window?: string;
    pane?: string;
}): { success: boolean; identifier?: string; error?: string } {
    try {
        if (!params.session || !/^[a-zA-Z0-9._-]+$/.test(params.session)) {
            throw new TmuxSessionIdentifierError(`Invalid session name: "${params.session}"`);
        }

        if (params.window && !/^[a-zA-Z0-9._-]+$/.test(params.window)) {
            throw new TmuxSessionIdentifierError(`Invalid window name: "${params.window}"`);
        }

        if (params.pane && !/^[0-9]+$/.test(params.pane)) {
            throw new TmuxSessionIdentifierError(`Invalid pane identifier: "${params.pane}"`);
        }

        const identifier: TmuxSessionIdentifier = params;
        return {
            success: true,
            identifier: formatTmuxSessionIdentifier(identifier)
        };
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}
