/**
 * Controlled native Cursor ACP server for product-boundary tests.
 *
 * It is intentionally a local executable rather than a mocked client. The
 * daemon runner still resolves `agent`, owns the child process, and talks to
 * it through the same newline-delimited JSON-RPC transport as Cursor ACP.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ControlledCursorAgentInvocation {
    args: string[];
    mode: string;
    model: string;
    prompt: string;
    resumeSessionId?: string;
    sessionId: string;
}

export interface ControlledCursorAcpOperation {
    method: string;
    model?: string;
    mode?: string;
    sessionId?: string;
}

interface ControlledCursorAgentState {
    invocations: ControlledCursorAgentInvocation[];
    operations: ControlledCursorAcpOperation[];
    protocolViolations: string[];
    runningPids: number[];
}

export interface ControlledCursorAgent {
    binDir: string;
    stateFile: string;
    getInvocations: () => ControlledCursorAgentInvocation[];
    getLiveProcessIds: () => number[];
    getOperations: () => ControlledCursorAcpOperation[];
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
 * Create a disposable `agent acp` executable. The runner resolves it through
 * an isolated PATH supplied by the integration harness.
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
        operations: [],
        protocolViolations: [],
        runningPids: [],
    }), 'utf8');
    writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const options = ${serializedOptions};
const stateFile = process.env.REMCLI_CONTROLLED_CURSOR_STATE_FILE;
const args = process.argv.slice(2);

if (args.includes('--version')) {
    process.stdout.write('controlled-cursor-agent 2.0.0\\n');
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
const mutateState = (mutator) => {
    const state = readState();
    mutator(state);
    writeState(state);
};
const protocolViolation = (message) => mutateState((state) => state.protocolViolations.push(message));
const operation = (entry) => mutateState((state) => state.operations.push(entry));
const invocation = (entry) => mutateState((state) => state.invocations.push(entry));

mutateState((state) => {
    state.runningPids = state.runningPids || [];
    state.runningPids.push(process.pid);
});
let removedRunningPid = false;
const removeRunningPid = () => {
    if (removedRunningPid) return;
    removedRunningPid = true;
    try {
        mutateState((state) => {
            state.runningPids = (state.runningPids || []).filter((pid) => pid !== process.pid);
        });
    } catch {
        // The fixture may already have been removed during forced cleanup.
    }
};
process.once('exit', removeRunningPid);

if (args.length !== 1 || args[0] !== 'acp') {
    protocolViolation('Controlled Cursor Agent expected exactly agent acp.');
    process.stderr.write('Controlled Cursor Agent expected exactly agent acp.\\n');
    process.exit(2);
}

const modes = [
    { id: 'agent', name: 'Agent' },
    { id: 'plan', name: 'Plan' },
    { id: 'ask', name: 'Ask' },
];
const models = [
    { modelId: 'controlled-cursor-model-a', name: 'Controlled Cursor Model A' },
    { modelId: 'controlled-cursor-model-b', name: 'Controlled Cursor Model B' },
];
let mode = 'agent';
let model = models[0].modelId;
let sessionId = null;
let resumedSessionId = undefined;
let pendingPrompt = null;

const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const failure = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32602, message } });
const update = (text) => send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    },
});
const stateForSession = () => ({
    modes: { availableModes: modes, currentModeId: mode },
    models: { availableModels: models, currentModelId: model },
});
const promptText = (params) => {
    if (!params || !Array.isArray(params.prompt)) return null;
    const text = params.prompt.find((item) => item && item.type === 'text' && typeof item.text === 'string');
    return text ? text.text : null;
};
const hasSeedContext = () => readState().invocations.some((entry) => entry.prompt === options.firstContextPrompt);

const handle = (request) => {
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        protocolViolation('Controlled Cursor Agent received malformed JSON-RPC.');
        return;
    }
    const { id, method, params = {} } = request;
    const isRequest = id !== undefined && id !== null;
    const respond = (result) => isRequest && reply(id, result);
    const reject = (message) => isRequest && failure(id, message);

    switch (method) {
        case 'initialize':
            operation({ method });
            respond({
                protocolVersion: 1,
                agentInfo: { name: 'controlled-cursor-agent', version: '2.0.0' },
                authMethods: [{ id: 'cursor_login', name: 'Cursor Login' }],
                agentCapabilities: { loadSession: true },
            });
            return;
        case 'authenticate':
            operation({ method });
            if (params.methodId !== 'cursor_login') return reject('Expected cursor_login authentication.');
            respond({});
            return;
        case 'session/new':
            operation({ method });
            sessionId = options.nativeSessionId;
            resumedSessionId = undefined;
            respond({ sessionId, ...stateForSession() });
            return;
        case 'session/load':
            operation({ method, sessionId: params.sessionId });
            if (params.sessionId !== options.nativeSessionId) return reject('Unexpected native session ID.');
            sessionId = params.sessionId;
            resumedSessionId = params.sessionId;
            respond(stateForSession());
            return;
        case 'session/set_mode':
            operation({ method, sessionId: params.sessionId, mode: params.modeId });
            if (params.sessionId !== sessionId || !modes.some((candidate) => candidate.id === params.modeId)) {
                return reject('Unsupported Cursor mode.');
            }
            mode = params.modeId;
            respond({});
            return;
        case 'session/set_model':
            operation({ method, sessionId: params.sessionId, model: params.modelId });
            if (params.sessionId !== sessionId || !models.some((candidate) => candidate.modelId === params.modelId)) {
                return reject('Unsupported Cursor model.');
            }
            model = params.modelId;
            respond({});
            return;
        case 'session/prompt': {
            const prompt = promptText(params);
            operation({ method, sessionId: params.sessionId, mode, model });
            if (!sessionId || params.sessionId !== sessionId || prompt === null) {
                return reject('Invalid Cursor prompt request.');
            }
            const response = prompt === options.resumeContextPrompt
                ? hasSeedContext()
                    ? 'fixture resume context preserved'
                    : 'fixture resume context missing'
                : 'fixture accepted: ' + prompt;
            invocation({ args, mode, model, prompt, ...(resumedSessionId ? { resumeSessionId: resumedSessionId } : {}), sessionId });
            if (prompt === options.holdPrompt) {
                pendingPrompt = { id, sessionId };
                return;
            }
            update(response);
            respond({ stopReason: 'end_turn' });
            return;
        }
        case 'session/cancel':
            operation({ method, sessionId: params.sessionId });
            if (pendingPrompt && params.sessionId === pendingPrompt.sessionId) {
                reply(pendingPrompt.id, { stopReason: 'cancelled' });
                pendingPrompt = null;
            }
            return;
        default:
            protocolViolation('Controlled Cursor Agent received unsupported ACP method: ' + method + '.');
            reject('Unsupported ACP method.');
    }
};

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
    try {
        handle(JSON.parse(line));
    } catch {
        protocolViolation('Controlled Cursor Agent received invalid JSON.');
    }
});
`, 'utf8');
    chmodSync(executable, 0o755);

    return {
        binDir,
        stateFile,
        getInvocations: () => readState(stateFile).invocations,
        getLiveProcessIds: () => [...new Set(readState(stateFile).runningPids ?? [])]
            .filter((pid) => Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)),
        getOperations: () => readState(stateFile).operations,
        getProtocolViolations: () => readState(stateFile).protocolViolations,
        close: async () => {
            await stopFixtureProcesses(stateFile);
            rmSync(root, { recursive: true, force: true });
        },
    };
}
