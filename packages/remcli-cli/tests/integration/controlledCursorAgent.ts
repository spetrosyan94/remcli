/**
 * Controlled native Cursor Agent executable for product-boundary tests.
 *
 * It is intentionally a local executable rather than a mocked `runCursorTurn`:
 * the real daemon runner still resolves `agent`, constructs argv, parses NDJSON
 * and owns the native session lifecycle.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ControlledCursorAgentInvocation {
    args: string[];
    prompt: string;
    resumeSessionId?: string;
    sessionId: string;
}

interface ControlledCursorAgentState {
    invocations: ControlledCursorAgentInvocation[];
    interruptedPrompts: string[];
    protocolViolations: string[];
    runningPids: number[];
}

export interface ControlledCursorAgent {
    binDir: string;
    stateFile: string;
    getInvocations: () => ControlledCursorAgentInvocation[];
    getInterruptedPrompts: () => string[];
    getLiveProcessIds: () => number[];
    getProtocolViolations: () => string[];
    close: () => Promise<void>;
}

export interface ControlledCursorAgentOptions {
    firstContextPrompt: string;
    holdPrompt: string;
    nativeSessionId: string;
    resumeContextPrompt: string;
}

function readState(stateFile: string): ControlledCursorAgentState {
    return JSON.parse(readFileSync(stateFile, 'utf8')) as ControlledCursorAgentState;
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

async function stopFixtureProcesses(stateFile: string): Promise<void> {
    const getLiveProcessIds = (): number[] => {
        try {
            return [...new Set(readState(stateFile).runningPids ?? [])]
                .filter((pid) => Number.isInteger(pid) && pid > 0 && isProcessAlive(pid));
        } catch {
            return [];
        }
    };

    const terminate = (signal: NodeJS.Signals): void => {
        for (const pid of getLiveProcessIds()) {
            try {
                process.kill(pid, signal);
            } catch {
                // A fixture process may exit between the liveness check and signal.
            }
        }
    };

    terminate('SIGTERM');
    const deadline = Date.now() + 1_000;
    while (getLiveProcessIds().length > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    terminate('SIGKILL');
}

/**
 * Create a disposable `agent` executable. The runner resolves it through an
 * isolated PATH supplied by the integration harness.
 */
export function createControlledCursorAgent(options: ControlledCursorAgentOptions): ControlledCursorAgent {
    const root = mkdtempSync(join(tmpdir(), 'remcli-controlled-cursor-agent-'));
    const binDir = join(root, 'bin');
    const stateFile = join(root, 'state.json');
    const executable = join(binDir, 'agent');
    const serializedOptions = JSON.stringify(options);

    mkdirSync(binDir, { recursive: true });
    writeFileSync(stateFile, JSON.stringify({
        invocations: [],
        interruptedPrompts: [],
        protocolViolations: [],
        runningPids: [],
    }), 'utf8');
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const options = ${serializedOptions};
const stateFile = process.env.REMCLI_CONTROLLED_CURSOR_STATE_FILE;
const args = process.argv.slice(2);

if (args.includes('--version')) {
    process.stdout.write('controlled-cursor-agent 1.0.0\\n');
    process.exit(0);
}

if (!stateFile) {
    process.stderr.write('Controlled Cursor state file is missing.\\n');
    process.exit(2);
}

const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const writeState = (state) => {
    const temporaryStateFile = stateFile + '.' + process.pid + '.tmp';
    fs.writeFileSync(temporaryStateFile, JSON.stringify(state), 'utf8');
    fs.renameSync(temporaryStateFile, stateFile);
};
const state = readState();
state.runningPids = state.runningPids || [];
state.runningPids.push(process.pid);
writeState(state);
let removedRunningPid = false;
const removeRunningPid = () => {
    if (removedRunningPid) return;
    removedRunningPid = true;
    try {
        const currentState = readState();
        currentState.runningPids = (currentState.runningPids || []).filter((pid) => pid !== process.pid);
        writeState(currentState);
    } catch {
        // The test fixture may already have been removed during forced cleanup.
    }
};
process.once('exit', removeRunningPid);
const outputFormatIndex = args.indexOf('--output-format');
const resumeIndex = args.indexOf('--resume');
const resumeSessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
const prompt = args.at(-1) || '';
const fail = (message) => {
    state.protocolViolations.push(message);
    writeState(state);
    process.stderr.write(message + '\\n');
    process.exit(2);
};

if (!args.includes('--print') || outputFormatIndex < 0 || args[outputFormatIndex + 1] !== 'stream-json') {
    fail('Controlled Cursor Agent expected --print --output-format stream-json.');
}
if (!args.includes('--trust')) {
    fail('Controlled Cursor Agent expected --trust for the daemon-owned non-interactive turn.');
}
const modeIndex = args.indexOf('--mode');
if (modeIndex >= 0 && !['plan', 'ask'].includes(args[modeIndex + 1] || '')) {
    fail('Controlled Cursor Agent received an unsupported --mode value.');
}
if (args.filter((arg) => arg === '--mode').length > 1) {
    fail('Controlled Cursor Agent received duplicate --mode flags.');
}
const sandboxIndex = args.indexOf('--sandbox');
if (sandboxIndex >= 0 && !['enabled', 'disabled'].includes(args[sandboxIndex + 1] || '')) {
    fail('Controlled Cursor Agent received an unsupported --sandbox value.');
}
if (args.filter((arg) => arg === '--sandbox').length > 1) {
    fail('Controlled Cursor Agent received duplicate --sandbox flags.');
}
if (resumeIndex >= 0 && (!resumeSessionId || resumeSessionId !== options.nativeSessionId)) {
    fail('Controlled Cursor Agent received an unexpected native resume ID.');
}

const sessionId = resumeSessionId || options.nativeSessionId;
const hadSeedContext = state.invocations.some((entry) => entry.prompt === options.firstContextPrompt);
const response = prompt === options.resumeContextPrompt
    ? resumeSessionId && hadSeedContext
        ? 'fixture resume context preserved'
        : 'fixture resume context missing'
    : 'fixture accepted: ' + prompt;

state.invocations.push({ args, prompt, resumeSessionId, sessionId });
writeState(state);
process.stdout.write(JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'controlled-cursor-model',
    permissionMode: 'default',
}) + '\\n');

if (prompt === options.holdPrompt) {
    const recordInterrupt = () => {
        const currentState = readState();
        currentState.interruptedPrompts = currentState.interruptedPrompts || [];
        currentState.interruptedPrompts.push(prompt);
        writeState(currentState);
        process.exit(0);
    };
    process.once('SIGTERM', recordInterrupt);
    process.once('SIGINT', recordInterrupt);
    process.once('SIGHUP', recordInterrupt);
    setInterval(() => undefined, 1_000);
} else {
    process.stdout.write(JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: response }] },
        session_id: sessionId,
    }) + '\\n');
    process.stdout.write(JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: response,
        session_id: sessionId,
    }) + '\\n');
}
`, 'utf8');
    chmodSync(executable, 0o755);

    return {
        binDir,
        stateFile,
        getInvocations: () => readState(stateFile).invocations,
        getInterruptedPrompts: () => readState(stateFile).interruptedPrompts,
        getLiveProcessIds: () => [...new Set(readState(stateFile).runningPids ?? [])]
            .filter((pid) => Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)),
        getProtocolViolations: () => readState(stateFile).protocolViolations,
        close: async () => {
            await stopFixtureProcesses(stateFile);
            rmSync(root, { recursive: true, force: true });
        },
    };
}
