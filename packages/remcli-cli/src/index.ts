#!/usr/bin/env node

/**
 * CLI entry point for remcli command
 * 
 * Simple argument parsing without any CLI framework dependencies
 */


import chalk from 'chalk'
import { runClaude, StartOptions } from '@/claude/runClaude'
import { logger } from './ui/logger'
import { readCredentials, readSettings } from './persistence'
import { setupP2PForSession } from './daemon/p2p/p2pSession'
import packageJson from '../package.json'
import { z } from 'zod'
import { startDaemon } from './daemon/run'
import { checkIfDaemonRunningAndCleanupStaleState, isDaemonRunningCurrentlyInstalledRemcliVersion, stopDaemon } from './daemon/controlClient'
import { getLatestDaemonLog } from './ui/logger'
import { killRunawayRemcliProcesses } from './daemon/doctor'
import { install } from './daemon/install'
import { uninstall } from './daemon/uninstall'
import { runDoctorCommand } from './ui/doctor'
import { listDaemonSessions, stopDaemonSession } from './daemon/controlClient'
import { handleAuthCommand } from './commands/auth'
import { handleConnectCommand } from './commands/connect'
import { spawnRemcliCLI } from './utils/spawnRemcliCLI'
import { getCleanEnv, getDefaultClaudeCodePath } from './claude/sdk/utils'
import { parseAgentRunArgs } from './agentRunArgs'
import { execFileSync } from 'node:child_process'

/**
 * Print a subcommand error consistently and terminate the process.
 * Full stack is printed only when DEBUG is set.
 */
function exitWithSubcommandError(error: unknown): never {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
    if (process.env.DEBUG) {
        console.error(error)
    }
    process.exit(1)
}

function runPassthroughCommand(binary: string, args: string[]): void {
    execFileSync(binary, args, {
        stdio: 'inherit',
        env: getCleanEnv()
    });
}

function resolveFirstExecutable(candidates: string[]): string {
    for (const candidate of candidates) {
        try {
            execFileSync(candidate, ['--version'], {
                stdio: 'ignore',
                env: getCleanEnv()
            });
            return candidate;
        } catch {
            // Try the next candidate.
        }
    }
    return candidates[0];
}

async function ensureDaemonRunning(): Promise<void> {
    logger.debug('Ensuring Remcli background service is running & matches our version...');
    if (!(await isDaemonRunningCurrentlyInstalledRemcliVersion())) {
        logger.debug('Starting Remcli background service...');
        const daemonProcess = spawnRemcliCLI(['daemon', 'start-sync'], {
            detached: true,
            stdio: 'ignore',
            env: process.env
        });
        daemonProcess.unref();

        // Wait for daemon to write state file (PID, port, shared secret)
        const maxWait = 5000;
        const interval = 200;
        let waited = 0;
        while (waited < maxWait) {
            await new Promise(resolve => setTimeout(resolve, interval));
            waited += interval;
            if (await isDaemonRunningCurrentlyInstalledRemcliVersion()) {
                logger.debug(`Daemon started after ${waited}ms`);
                return;
            }
        }
        logger.debug(`Daemon may not have started within ${maxWait}ms, proceeding anyway`);
    }
}


(async () => {
  const args = process.argv.slice(2)

  // If --version is passed - do not log, its likely daemon inquiring about our version
  if (!args.includes('--version')) {
    logger.debug('Starting remcli CLI with args: ', process.argv)
  }

  // Check if first argument is a subcommand
  const subcommand = args[0]
  
  // Log which subcommand was detected (for debugging)
  if (!args.includes('--version')) {
  }

  if (subcommand === 'doctor') {
    // Check for clean subcommand
    if (args[1] === 'clean') {
      const result = await killRunawayRemcliProcesses()
      console.log(`Cleaned up ${result.killed} runaway processes`)
      if (result.errors.length > 0) {
        console.log('Errors:', result.errors)
      }
      process.exit(0)
    }
    await runDoctorCommand();
    return;
  } else if (subcommand === 'auth') {
    // Handle auth subcommands
    try {
      await handleAuthCommand(args.slice(1));
    } catch (error) {
      exitWithSubcommandError(error)
    }
    return;
  } else if (subcommand === 'connect') {
    // Handle connect subcommands
    try {
      await handleConnectCommand(args.slice(1));
    } catch (error) {
      exitWithSubcommandError(error)
    }
    return;
  } else if (subcommand === 'codex') {
    // Handle codex command
    try {
      const { runCodex } = await import('@/codex/runCodex');

      const { startedBy, resumeSessionId, passthroughArgs, shouldPassthrough } = parseAgentRunArgs(args);
      if (shouldPassthrough) {
        runPassthroughCommand('codex', passthroughArgs);
        process.exit(0);
      }

      await ensureDaemonRunning();
      const {
        credentials
      } = await setupP2PForSession();
      await runCodex({credentials, startedBy, resumeSessionId});
      // Do not force exit here; allow instrumentation to show lingering handles
    } catch (error) {
      exitWithSubcommandError(error)
    }
    return;
  } else if (subcommand === 'cursor') {
    // Handle cursor command
    try {
      const { runCursor } = await import('@/cursor/runCursor');

      const { startedBy, resumeSessionId, passthroughArgs, shouldPassthrough } = parseAgentRunArgs(args);
      if (shouldPassthrough) {
        runPassthroughCommand(resolveFirstExecutable(['agent', 'cursor-agent']), passthroughArgs);
        process.exit(0);
      }

      await ensureDaemonRunning();
      const {
        credentials
      } = await setupP2PForSession();

      await runCursor({credentials, startedBy, resumeSessionId});
    } catch (error) {
      exitWithSubcommandError(error)
    }
    return;
  } else if (subcommand === 'gemini') {
    // Handle gemini subcommands
    const geminiSubcommand = args[1];
    
    // Handle "remcli gemini model set <model>" command
    if (geminiSubcommand === 'model' && args[2] === 'set' && args[3]) {
      const modelName = args[3];
      const { VALID_GEMINI_MODELS } = await import('@/gemini/constants');
      const validModels: readonly string[] = VALID_GEMINI_MODELS;

      if (!validModels.includes(modelName)) {
        console.error(`Invalid model: ${modelName}`);
        console.error(`Available models: ${validModels.join(', ')}`);
        process.exit(1);
      }
      
      try {
        const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
        const { join } = require('path');
        const { homedir } = require('os');
        
        const configDir = join(homedir(), '.gemini');
        const configPath = join(configDir, 'config.json');
        
        // Create directory if it doesn't exist
        if (!existsSync(configDir)) {
          mkdirSync(configDir, { recursive: true });
        }
        
        // Read existing config or create new one
        let config: any = {};
        if (existsSync(configPath)) {
          try {
            config = JSON.parse(readFileSync(configPath, 'utf-8'));
          } catch (error) {
            // Ignore parse errors, start fresh
            config = {};
          }
        }
        
        // Update model in config
        config.model = modelName;
        
        // Write config back
        writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        console.log(`✓ Model set to: ${modelName}`);
        console.log(`  Config saved to: ${configPath}`);
        console.log(`  This model will be used in future sessions.`);
        process.exit(0);
      } catch (error) {
        console.error('Failed to save model configuration:', error);
        process.exit(1);
      }
    }
    
    // Handle "remcli gemini model get" command
    if (geminiSubcommand === 'model' && args[2] === 'get') {
      try {
        const { existsSync, readFileSync } = require('fs');
        const { join } = require('path');
        const { homedir } = require('os');
        
        const configPaths = [
          join(homedir(), '.gemini', 'config.json'),
          join(homedir(), '.config', 'gemini', 'config.json'),
        ];
        
        let model: string | null = null;
        for (const configPath of configPaths) {
          if (existsSync(configPath)) {
            try {
              const config = JSON.parse(readFileSync(configPath, 'utf-8'));
              model = config.model || config.GEMINI_MODEL || null;
              if (model) break;
            } catch (error) {
              // Ignore parse errors
            }
          }
        }
        
        if (model) {
          console.log(`Current model: ${model}`);
        } else if (process.env.GEMINI_MODEL) {
          console.log(`Current model: ${process.env.GEMINI_MODEL} (from GEMINI_MODEL env var)`);
        } else {
          console.log('Current model: gemini-2.5-pro (default)');
        }
        process.exit(0);
      } catch (error) {
        console.error('Failed to read model configuration:', error);
        process.exit(1);
      }
    }
    
    // Handle "remcli gemini project set <project-id>" command
    if (geminiSubcommand === 'project' && args[2] === 'set' && args[3]) {
      const projectId = args[3];
      
      try {
        const { saveGoogleCloudProjectToConfig } = await import('@/gemini/utils/config');
        const { getVendorToken } = await import('@/api/vendorTokens');

        // Try to get current user email from local vendor token
        let userEmail: string | undefined = undefined;
        try {
          const vendorToken = getVendorToken('gemini') as any;
          if (vendorToken?.oauth?.id_token) {
            const parts = vendorToken.oauth.id_token.split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
              userEmail = payload.email;
            }
          }
        } catch {
          // If we can't get email, project will be saved globally
        }
        
        saveGoogleCloudProjectToConfig(projectId, userEmail);
        console.log(`✓ Google Cloud Project set to: ${projectId}`);
        if (userEmail) {
          console.log(`  Linked to account: ${userEmail}`);
        }
        console.log(`  This project will be used for Google Workspace accounts.`);
        process.exit(0);
      } catch (error) {
        console.error('Failed to save project configuration:', error);
        process.exit(1);
      }
    }
    
    // Handle "remcli gemini project get" command
    if (geminiSubcommand === 'project' && args[2] === 'get') {
      try {
        const { readGeminiLocalConfig } = await import('@/gemini/utils/config');
        const config = readGeminiLocalConfig();
        
        if (config.googleCloudProject) {
          console.log(`Current Google Cloud Project: ${config.googleCloudProject}`);
          if (config.googleCloudProjectEmail) {
            console.log(`  Linked to account: ${config.googleCloudProjectEmail}`);
          } else {
            console.log(`  Applies to: all accounts (global)`);
          }
        } else if (process.env.GOOGLE_CLOUD_PROJECT) {
          console.log(`Current Google Cloud Project: ${process.env.GOOGLE_CLOUD_PROJECT} (from env var)`);
        } else {
          console.log('No Google Cloud Project configured.');
          console.log('');
          console.log('If you see "Authentication required" error, you may need to set a project:');
          console.log('  remcli gemini project set <your-project-id>');
          console.log('');
          console.log('This is required for Google Workspace accounts.');
          console.log('Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca');
        }
        process.exit(0);
      } catch (error) {
        console.error('Failed to read project configuration:', error);
        process.exit(1);
      }
    }
    
    // Handle "remcli gemini project" (no subcommand) - show help
    if (geminiSubcommand === 'project' && !args[2]) {
      console.log('Usage: remcli gemini project <command>');
      console.log('');
      console.log('Commands:');
      console.log('  set <project-id>   Set Google Cloud Project ID');
      console.log('  get                Show current Google Cloud Project ID');
      console.log('');
      console.log('Google Workspace accounts require a Google Cloud Project.');
      console.log('If you see "Authentication required" error, set your project ID.');
      console.log('');
      console.log('Guide: https://goo.gle/gemini-cli-auth-docs#workspace-gca');
      process.exit(0);
    }
    
    // Handle gemini command (ACP-based agent)
    try {
      const { runGemini } = await import('@/gemini/runGemini');

      const { startedBy, resumeSessionId, passthroughArgs, shouldPassthrough } = parseAgentRunArgs(args);
      if (shouldPassthrough) {
        runPassthroughCommand('gemini', passthroughArgs);
        process.exit(0);
      }

      await ensureDaemonRunning();
      const {
        credentials
      } = await setupP2PForSession();

      await runGemini({credentials, startedBy, resumeSessionId});
    } catch (error) {
      exitWithSubcommandError(error)
    }
    return;
  } else if (subcommand === 'logout') {
    // Keep for backward compatibility - redirect to auth logout
    console.log(chalk.yellow('Note: "remcli logout" is deprecated. Use "remcli auth logout" instead.\n'));
    try {
      await handleAuthCommand(['logout']);
    } catch (error) {
      exitWithSubcommandError(error)
    }
    return;
  } else if (subcommand === 'setup') {
    try {
      const { handleSetupCommand } = await import('@/commands/setup');
      await handleSetupCommand();
    } catch (error) {
      exitWithSubcommandError(error)
    }
    return;
  } else if (subcommand === 'daemon') {
    // Show daemon management help
    const daemonSubcommand = args[1]

    if (daemonSubcommand === 'list') {
      try {
        const sessions = await listDaemonSessions()

        if (sessions.length === 0) {
          console.log('No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)')
        } else {
          console.log('Active sessions:')
          console.log(JSON.stringify(sessions, null, 2))
        }
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'stop-session') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error('Session ID required')
        process.exit(1)
      }

      try {
        const success = await stopDaemonSession(sessionId)
        console.log(success ? 'Session stopped' : 'Failed to stop session')
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'start') {
      // Spawn detached daemon process, passing through --tunnel flag
      const daemonArgs = ['daemon', 'start-sync'];
      if (args.includes('--tunnel')) {
        daemonArgs.push('--tunnel');
      }
      const child = spawnRemcliCLI(daemonArgs, {
        detached: true,
        stdio: 'ignore',
        env: process.env
      });
      child.unref();

      // Wait for daemon to write state file (up to 5 seconds)
      let started = false;
      for (let i = 0; i < 50; i++) {
        if (await checkIfDaemonRunningAndCleanupStaleState()) {
          started = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (started) {
        console.log('Daemon started successfully');
      } else {
        console.error('Failed to start daemon');
        process.exit(1);
      }
      process.exit(0);
    } else if (daemonSubcommand === 'start-sync') {
      await startDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'stop') {
      await stopDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'qr') {
      // Re-display P2P QR code from daemon state
      const { readDaemonState } = await import('./persistence');
      const { buildP2PConnectionInfo, buildP2PQRUrl, displayP2PQRCode, displayP2PConnectionStatus } = await import('./daemon/p2p/p2pQRCode');
      const { decodeSharedSecret } = await import('./daemon/p2p/p2pAuth');

      const state = await readDaemonState();
      if (!state || !state.p2pPort || !state.p2pSharedSecret) {
        console.log('Daemon is not running or P2P is not configured.');
        console.log('Start the daemon first: remcli daemon start');
        process.exit(1);
      }

      const secret = decodeSharedSecret(state.p2pSharedSecret);
      if (state.tunnelUrl) {
        const info = buildP2PConnectionInfo(state.tunnelUrl.replace(/^https?:\/\//, ''), 0, secret);
        const qrUrl = buildP2PQRUrl(info, state.tunnelUrl);
        await displayP2PQRCode(qrUrl);
        displayP2PConnectionStatus(state.p2pHost || '0.0.0.0', state.p2pPort, state.tunnelUrl);
      } else {
        const info = buildP2PConnectionInfo(state.p2pHost || '0.0.0.0', state.p2pPort, secret);
        const qrUrl = buildP2PQRUrl(info);
        await displayP2PQRCode(qrUrl);
        displayP2PConnectionStatus(state.p2pHost || '0.0.0.0', state.p2pPort);
      }
      process.exit(0)
    } else if (daemonSubcommand === 'rekey') {
      // Reset the persistent pairing secret: delete the pairing file and restart the daemon
      const { clearPairing } = await import('./daemon/p2p/p2pPairing');

      const wasRunning = await checkIfDaemonRunningAndCleanupStaleState();
      if (wasRunning) {
        await stopDaemon();
      }

      const removed = clearPairing();
      console.log(removed
        ? 'Pairing secret removed — a fresh secret will be generated.'
        : 'No pairing file found — a fresh secret will be generated on next daemon start.');

      if (wasRunning) {
        const child = spawnRemcliCLI(['daemon', 'start-sync'], {
          detached: true,
          stdio: 'ignore',
          env: process.env
        });
        child.unref();

        // Wait for daemon to write state file (up to 5 seconds)
        let restarted = false;
        for (let i = 0; i < 50; i++) {
          if (await checkIfDaemonRunningAndCleanupStaleState()) {
            restarted = true;
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        console.log(restarted
          ? 'Daemon restarted with a new pairing secret.'
          : 'Daemon did not restart — start it manually: remcli daemon start');
      }

      console.log('All previously paired devices must rescan the QR code: remcli daemon qr');
      process.exit(0)
    } else if (daemonSubcommand === 'status') {
      // Show daemon-specific doctor output
      await runDoctorCommand('daemon')
      process.exit(0)
    } else if (daemonSubcommand === 'logs') {
      // Simply print the path to the latest daemon log file
      const latest = await getLatestDaemonLog()
      if (!latest) {
        console.log('No daemon logs found')
      } else {
        console.log(latest.path)
      }
      process.exit(0)
    } else if (daemonSubcommand === 'install') {
      try {
        await install()
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
    } else if (daemonSubcommand === 'uninstall') {
      try {
        await uninstall()
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
    } else {
      console.log(`
${chalk.bold('remcli daemon')} - Daemon management

${chalk.bold('Usage:')}
  remcli daemon start              Start the daemon (detached)
  remcli daemon start --tunnel     Start with cloudflared tunnel for remote access
  remcli daemon stop               Stop the daemon (sessions stay alive)
  remcli daemon status             Show daemon status
  remcli daemon qr                 Show P2P connection QR code
  remcli daemon rekey              Reset pairing secret (all devices must rescan QR)
  remcli daemon list               List active sessions

  If you want to kill all remcli related processes run 
  ${chalk.cyan('remcli doctor clean')}

${chalk.bold('Note:')} The daemon runs in the background and manages Claude sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('remcli doctor clean')}
`)
    }
    return;
  } else {

    // If the first argument is claude, remove it
    if (args.length > 0 && args[0] === 'claude') {
      args.shift()
    }

    // Parse command line arguments for main command
    const options: StartOptions = {}
    let showHelp = false
    let showVersion = false
    let chromeOverride: boolean | undefined = undefined  // Track explicit --chrome or --no-chrome
    const unknownArgs: string[] = [] // Collect unknown args to pass through to claude

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]

      if (arg === '-h' || arg === '--help') {
        showHelp = true
        // Also pass through to claude
        unknownArgs.push(arg)
      } else if (arg === '-v' || arg === '--version') {
        showVersion = true
        // Also pass through to claude (will show after our version)
        unknownArgs.push(arg)
      } else if (arg === '--remcli-starting-mode') {
        options.startingMode = z.enum(['local', 'remote']).parse(args[++i])
      } else if (arg === '--yolo') {
        // Shortcut for --dangerously-skip-permissions
        unknownArgs.push('--dangerously-skip-permissions')
      } else if (arg === '--started-by') {
        options.startedBy = args[++i] as 'daemon' | 'terminal'
      } else if (arg === '--js-runtime') {
        const runtime = args[++i]
        if (runtime !== 'node' && runtime !== 'bun') {
          console.error(chalk.red(`Invalid --js-runtime value: ${runtime}. Must be 'node' or 'bun'`))
          process.exit(1)
        }
        options.jsRuntime = runtime
      } else if (arg === '--claude-env') {
        // Parse KEY=VALUE environment variable to pass to Claude
        const envArg = args[++i]
        if (envArg && envArg.includes('=')) {
          const eqIndex = envArg.indexOf('=')
          const key = envArg.substring(0, eqIndex)
          const value = envArg.substring(eqIndex + 1)
          options.claudeEnvVars = options.claudeEnvVars || {}
          options.claudeEnvVars[key] = value
        } else {
          console.error(chalk.red(`Invalid --claude-env format: ${envArg}. Expected KEY=VALUE`))
          process.exit(1)
        }
      } else if (arg === '--chrome') {
        chromeOverride = true
        // We'll add --chrome to claudeArgs after resolving settings default
      } else if (arg === '--no-chrome') {
        chromeOverride = false
        // Remcli-specific flag to disable chrome even if default is on
      } else if (arg === '--settings') {
        // Intercept --settings flag - Remcli uses this internally for session hooks
        const settingsValue = args[++i] // consume the value
        console.warn(chalk.yellow(`⚠️  Warning: --settings is used internally by Remcli for session tracking.`))
        console.warn(chalk.yellow(`   Your settings file "${settingsValue}" will be ignored.`))
        console.warn(chalk.yellow(`   To configure Claude, edit ~/.claude/settings.json instead.`))
        // Don't pass through to claudeArgs
      } else {
        // Pass unknown arguments through to claude
        unknownArgs.push(arg)
        // Check if this arg expects a value (simplified check for common patterns)
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          unknownArgs.push(args[++i])
        }
      }
    }

    // Add unknown args to claudeArgs
    if (unknownArgs.length > 0) {
      options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs]
    }

    // Resolve Chrome mode: explicit flag > settings > false
    const settings = await readSettings()
    const chromeEnabled = chromeOverride ?? settings.chromeMode ?? false
    if (chromeEnabled) {
      options.claudeArgs = [...(options.claudeArgs || []), '--chrome']
    }

    // Show help
    if (showHelp) {
      console.log(`
${chalk.bold('remcli')} - Claude Code On the Go

${chalk.bold('Usage:')}
  remcli [options]         Start Claude with mobile control
  remcli auth              Manage authentication
  remcli codex             Start Codex mode
  remcli cursor            Start Cursor mode
  remcli gemini            Start Gemini mode (ACP)
  remcli setup             Setup wizard (Whisper, AI agents)
  remcli connect           Connect AI vendor API keys
  remcli daemon            Manage background service that allows
                            to spawn new sessions away from your computer
  remcli doctor            System diagnostics & troubleshooting

${chalk.bold('Examples:')}
  remcli                    Start session
  remcli --yolo             Start with bypassing permissions
                            remcli sugar for --dangerously-skip-permissions
  remcli --chrome           Enable Chrome browser access for this session
  remcli --no-chrome        Disable Chrome even if default is on
  remcli --js-runtime bun   Use bun instead of node to spawn Claude Code
  remcli --claude-env ANTHROPIC_BASE_URL=http://127.0.0.1:3456
                           Use a custom API endpoint (e.g., claude-code-router)
  remcli auth login --force Authenticate
  remcli doctor             Run diagnostics

${chalk.bold('Remcli supports ALL Claude options!')}
  Use any claude flag with remcli as you would with claude. Our favorite:

  remcli --resume

${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan('Claude Code Options (from `claude --help`):')}
`)
      
      // Run claude --help and display its output without starting a remcli session.
      try {
        const claudeHelp = execFileSync(getDefaultClaudeCodePath(), ['--help'], {
          encoding: 'utf8',
          env: getCleanEnv()
        })
        console.log(claudeHelp)
      } catch (e) {
        console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'))
      }
      
      process.exit(0)
    }

    // Show version without starting a remcli session.
    if (showVersion) {
      console.log(`remcli version: ${packageJson.version}`)
      try {
        runPassthroughCommand(getDefaultClaudeCodePath(), ['--version'])
      } catch {
        console.log(chalk.yellow('Could not retrieve claude version. Make sure claude is installed.'))
      }
      process.exit(0)
    }

    // Normal flow - auto-start daemon then connect
    await ensureDaemonRunning();
    const {
      credentials
    } = await setupP2PForSession();

    // Start the CLI
    try {
      await runClaude(credentials, options);
    } catch (error) {
      exitWithSubcommandError(error)
    }
  }
})();
