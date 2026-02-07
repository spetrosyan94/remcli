/**
 * Cross-platform Remcli spawning utility
 * 
 * ## Background
 * 
 * We built a command-line JavaScript program with the entrypoint at `dist/index.mjs`.
 * This needs to be run with `node`, but we want to hide deprecation warnings and other 
 * noise from end users by passing specific flags: `--no-warnings --no-deprecation`.
 * 
 * Users don't care about these technical details - they just want a clean experience
 * with no warning output when using Remcli.
 * 
 * ## The Wrapper Strategy
 * 
 * We created a wrapper script `bin/remcli.mjs` with a shebang `#!/usr/bin/env node`.
 * This allows direct execution on Unix systems and NPM automatically generates 
 * Windows-specific wrapper scripts (`remcli.cmd` and `remcli.ps1`) when it sees 
 * the `bin` field in package.json pointing to a JavaScript file with a shebang.
 * 
 * The wrapper script either directly execs `dist/index.mjs` with the flags we want,
 * or imports it directly if Node.js already has the right flags.
 * 
 * ## Execution Chains
 * 
 * **Unix/Linux/macOS:**
 * 1. User runs `remcli` command
 * 2. Shell directly executes `bin/remcli.mjs` (shebang: `#!/usr/bin/env node`)
 * 3. `bin/remcli.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * **Windows:**
 * 1. User runs `remcli` command  
 * 2. NPM wrapper (`remcli.cmd`) calls `node bin/remcli.mjs`
 * 3. `bin/remcli.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * ## The Spawning Problem
 * 
 * When our code needs to spawn Remcli CLI as a subprocess (for daemon processes), 
 * we were trying to execute `bin/remcli.mjs` directly. This fails on Windows 
 * because Windows doesn't understand shebangs - you get an `EFTYPE` error.
 * 
 * ## The Solution
 * 
 * Since we know exactly what needs to happen (run `dist/index.mjs` with specific 
 * Node.js flags), we can bypass all the wrapper layers and do it directly:
 * 
 * `spawn('node', ['--no-warnings', '--no-deprecation', 'dist/index.mjs', ...args])`
 * 
 * This works on all platforms and achieves the same result without any of the 
 * middleman steps that were providing workarounds for Windows vs Linux differences.
 */

import { spawn, SpawnOptions, type ChildProcess } from 'child_process';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';
import { isBun } from './runtime';

/**
 * Spawn the Remcli with the given arguments in a cross-platform way.
 * 
 * This function bypasses the wrapper script (bin/remcli.mjs) and spawns the 
 * actual CLI entrypoint (dist/index.mjs) directly with Node.js, ensuring
 * compatibility across all platforms including Windows.
 * 
 * @param args - Arguments to pass to the Remcli
 * @param options - Spawn options (same as child_process.spawn)
 * @returns ChildProcess instance
 */
export function spawnRemcliCLI(args: string[], options: SpawnOptions = {}): ChildProcess {
  const projectRoot = projectPath();
  const entrypoint = join(projectRoot, 'dist', 'index.mjs');

  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  // Note: We're actually executing 'node' with the calculated entrypoint path below,
  // bypassing the 'remcli' wrapper that would normally be found in the shell's PATH.
  // However, we log it as 'remcli' here because other engineers are typically looking
  // for when "remcli" was started and don't care about the underlying node process
  // details and flags we use to achieve the same result.
  const fullCommand = `remcli ${args.join(' ')}`;
  logger.debug(`[SPAWN REMCLI CLI] Spawning: ${fullCommand} in ${directory}`);
  
  // Use the same Node.js flags that the wrapper script uses
  const nodeArgs = [
    '--no-warnings',
    '--no-deprecation',
    entrypoint,
    ...args
  ];

  // Sanity check of the entrypoint path exists
  if (!existsSync(entrypoint)) {
    const errorMessage = `Entrypoint ${entrypoint} does not exist`;
    logger.debug(`[SPAWN REMCLI CLI] ${errorMessage}`);
    throw new Error(errorMessage);
  }
  
  const runtime = isBun() ? 'bun' : 'node';
  return spawn(runtime, nodeArgs, options);
}
