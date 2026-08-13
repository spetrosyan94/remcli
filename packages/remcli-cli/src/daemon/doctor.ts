/**
 * Daemon doctor utilities
 * 
 * Process discovery and cleanup functions for the daemon
 * Helps diagnose and fix issues with hung or orphaned processes
 */

import psList from 'ps-list';
import spawn from 'cross-spawn';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, win32 } from 'node:path';
import { redactSensitiveCommand } from '@/utils/redaction';

type RemcliRuntimeKind = 'production' | 'development';

type RemcliProcessType =
  | 'current'
  | 'daemon-version-check'
  | 'dev-daemon-version-check'
  | 'daemon'
  | 'dev-daemon'
  | 'unverified-daemon'
  | 'daemon-spawned-session'
  | 'dev-daemon-spawned'
  | 'doctor'
  | 'dev-doctor'
  | 'dev-related'
  | 'user-session'
  | 'unknown';

interface RemcliProcess {
  pid: number;
  command: string;
  type: RemcliProcessType;
}

const DAEMON_START_SYNC_PATTERN = /(?:^|\s)["']?daemon["']?\s+["']?start-sync["']?(?=\s|$)/;
const COMMAND_TOKEN_PATTERN = /"([^"]+)"|'([^']+)'|(\S+)/g;
const RUNTIME_PROCESS_NAMES = new Set(['node', 'node.exe', 'bun', 'bun.exe']);

interface RemcliEntrypoint {
  path: string;
  kind: RemcliRuntimeKind;
}

interface RemcliRuntime {
  kind: RemcliRuntimeKind;
  isVerifiedPackage: boolean;
}

interface RemcliPackageManifest {
  name?: unknown;
}

function getCommandTokens(command: string): string[] {
  return Array.from(command.matchAll(COMMAND_TOKEN_PATTERN), (match) =>
    match[1] ?? match[2] ?? match[3],
  );
}

function getEntrypoint(command: string): RemcliEntrypoint | null {
  const normalizedTokens = getCommandTokens(command).map((token) => token.replaceAll('\\', '/'));
  const productionEntrypoint = normalizedTokens.find((token) => token.endsWith('/dist/index.mjs'));
  if (productionEntrypoint) {
    return { path: productionEntrypoint, kind: 'production' };
  }

  const developmentEntrypoint = normalizedTokens.find((token) => token.endsWith('/src/index.ts'));
  if (developmentEntrypoint) {
    return { path: developmentEntrypoint, kind: 'development' };
  }

  return null;
}

async function isRemcliPackageEntrypoint(entrypoint: RemcliEntrypoint): Promise<boolean> {
  const pathApi = /^[A-Za-z]:\//.test(entrypoint.path) || entrypoint.path.startsWith('//')
    ? win32
    : { dirname, resolve, isAbsolute };
  if (!pathApi.isAbsolute(entrypoint.path)) {
    return false;
  }

  const packageRoot = pathApi.dirname(pathApi.dirname(pathApi.resolve(entrypoint.path)));
  try {
    const manifest = JSON.parse(
      await readFile(pathApi.resolve(packageRoot, 'package.json'), 'utf8'),
    ) as RemcliPackageManifest;
    return manifest.name === 'remcli';
  } catch {
    return false;
  }
}

async function getRemcliRuntime(name: string, command: string): Promise<RemcliRuntime | null> {
  if (!RUNTIME_PROCESS_NAMES.has(name.toLowerCase())) {
    return null;
  }

  const entrypoint = getEntrypoint(command);
  if (!entrypoint || (entrypoint.kind === 'development' && !command.includes('tsx'))) {
    return null;
  }

  return {
    kind: entrypoint.kind,
    isVerifiedPackage: await isRemcliPackageEntrypoint(entrypoint),
  };
}

function isRemcliProcess(name: string, command: string, runtime: RemcliRuntime | null): boolean {
  return name.toLowerCase().includes('remcli')
    || command.includes('remcli')
    || runtime?.isVerifiedPackage === true;
}

function classifyRemcliProcess(
  pid: number,
  command: string,
  runtime: RemcliRuntime | null,
): RemcliProcessType {
  if (pid === process.pid) {
    return 'current';
  }

  if (runtime?.isVerifiedPackage && command.includes('--version')) {
    return runtime.kind === 'development' ? 'dev-daemon-version-check' : 'daemon-version-check';
  }

  if (runtime !== null && DAEMON_START_SYNC_PATTERN.test(command)) {
    if (!runtime.isVerifiedPackage) {
      return 'unverified-daemon';
    }
    return runtime.kind === 'development' ? 'dev-daemon' : 'daemon';
  }

  if (runtime?.isVerifiedPackage && command.includes('--started-by daemon')) {
    return runtime.kind === 'development' ? 'dev-daemon-spawned' : 'daemon-spawned-session';
  }

  if (runtime?.isVerifiedPackage && command.includes('doctor')) {
    return runtime.kind === 'development' ? 'dev-doctor' : 'doctor';
  }

  return runtime?.isVerifiedPackage && runtime.kind === 'development' ? 'dev-related' : 'user-session';
}

/**
 * Find all Remcli processes (including current process)
 */
export async function findAllRemcliProcesses(): Promise<RemcliProcess[]> {
  try {
    const processes = await psList();
    const allProcesses: RemcliProcess[] = [];
    
    for (const proc of processes) {
      const cmd = proc.cmd || '';
      const name = proc.name || '';
      const runtime = await getRemcliRuntime(name, cmd);
      
      // Check if it's a Remcli process
      if (!isRemcliProcess(name, cmd, runtime)) continue;

      const type = classifyRemcliProcess(proc.pid, cmd, runtime);

      allProcesses.push({ pid: proc.pid, command: cmd || name, type });
    }

    return allProcesses;
  } catch {
    throw new Error('Failed to discover Remcli processes');
  }
}

/**
 * Find all runaway Remcli processes that should be killed
 */
export async function findRunawayRemcliProcesses(): Promise<Array<{ pid: number, command: string }>> {
  const allProcesses = await findAllRemcliProcesses();
  
  // Filter to just runaway processes (excluding current process)
  return allProcesses
    .filter(p => 
      p.pid !== process.pid && (
        p.type === 'daemon' ||
        p.type === 'dev-daemon' ||
        p.type === 'daemon-spawned-session' ||
        p.type === 'dev-daemon-spawned' ||
        p.type === 'daemon-version-check' ||
        p.type === 'dev-daemon-version-check'
      )
    )
    .map(p => ({ pid: p.pid, command: p.command }));
}

/**
 * Kill all runaway Remcli processes
 */
export async function killRunawayRemcliProcesses(): Promise<{ killed: number, errors: Array<{ pid: number, error: string }> }> {
  const runawayProcesses = await findRunawayRemcliProcesses();
  const errors: Array<{ pid: number, error: string }> = [];
  let killed = 0;
  
  for (const { pid, command } of runawayProcesses) {
    try {
      console.log(`Killing runaway process PID ${pid}: ${redactSensitiveCommand(command)}`);
      
      if (process.platform === 'win32') {
        // Windows: use taskkill
        const result = spawn.sync('taskkill', ['/F', '/PID', pid.toString()], { stdio: 'pipe' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`taskkill exited with code ${result.status}`);
      } else {
        // Unix: try SIGTERM first
        process.kill(pid, 'SIGTERM');
        
        // Wait a moment
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Check if still alive
        const processes = await psList();
        const stillAlive = processes.find(p => p.pid === pid);
        if (stillAlive) {
          console.log(`Process PID ${pid} ignored SIGTERM, using SIGKILL`);
          process.kill(pid, 'SIGKILL');
        }
      }
      
      console.log(`Successfully killed runaway process PID ${pid}`);
      killed++;
    } catch (error) {
      const errorMessage = (error as Error).message;
      errors.push({ pid, error: errorMessage });
      console.log(`Failed to kill process PID ${pid}: ${errorMessage}`);
    }
  }

  return { killed, errors };
}
