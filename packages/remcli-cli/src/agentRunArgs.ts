/**
 * Shared parser for remcli-managed agent subcommands.
 *
 * Agent wrappers consume remcli-only flags, while vendor CLI informational flags
 * (`--help`, `--version`) must pass through directly without starting a daemon
 * session. This prevents simple diagnostics from creating tracked sessions or
 * hanging in interactive mode.
 */

export interface AgentRunArgs {
    startedBy?: 'daemon' | 'terminal';
    resumeSessionId?: string;
    passthroughArgs: string[];
    shouldPassthrough: boolean;
}

const AGENT_PASSTHROUGH_FLAGS = new Set(['--help', '-h', '--version', '-v']);

export function parseAgentRunArgs(args: string[]): AgentRunArgs {
    let startedBy: 'daemon' | 'terminal' | undefined = undefined;
    let resumeSessionId: string | undefined = undefined;
    const passthroughArgs: string[] = [];

    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        const nextArg = args[i + 1];
        if (arg === '--started-by') {
            if (nextArg && !nextArg.startsWith('-')) {
                startedBy = nextArg as 'daemon' | 'terminal';
                i += 1;
            }
        } else if (arg === '--resume') {
            if (nextArg && !nextArg.startsWith('-')) {
                resumeSessionId = nextArg;
                i += 1;
            }
        } else if (arg === '--remcli-starting-mode') {
            if (nextArg && !nextArg.startsWith('-')) {
                i += 1;
            }
        } else {
            passthroughArgs.push(arg);
        }
    }

    return {
        startedBy,
        resumeSessionId,
        passthroughArgs,
        shouldPassthrough: passthroughArgs.some((arg) => AGENT_PASSTHROUGH_FLAGS.has(arg))
    };
}
