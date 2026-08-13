/**
 * Doctor command implementation
 * 
 * Provides comprehensive diagnostics and troubleshooting information
 * for remcli CLI including configuration, daemon status, logs, and links
 */

import chalk from 'chalk'
import { configuration } from '@/configuration'
import { readSettings, readCredentials } from '@/persistence'
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient'
import { findRunawayRemcliProcesses, findAllRemcliProcesses } from '@/daemon/doctor'
import { readDaemonState } from '@/persistence'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { projectPath } from '@/projectPath'
import packageJson from '../../package.json'
import { execFileSync } from 'node:child_process'
import { getStatus as getWhisperStatus } from '@/daemon/whisper/whisperService'
import { readSetupConfig } from '@/persistence'
import { homedir } from 'node:os'
import { redactDiagnosticData, redactSensitiveCommand } from '@/utils/redaction'

/**
 * Get relevant environment information for debugging
 */
export function getEnvironmentInfo(): Record<string, any> {
    return {
        PWD: process.env.PWD,
        REMCLI_HOME_DIR: process.env.REMCLI_HOME_DIR,
        REMCLI_PROJECT_ROOT: process.env.REMCLI_PROJECT_ROOT,
        NODE_ENV: process.env.NODE_ENV,
        DEBUG: process.env.DEBUG,
        workingDirectory: process.cwd(),
        processArgv: process.argv,
        remcliDir: configuration?.remcliHomeDir,
        logsDir: configuration?.logsDir,
        processPid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        user: process.env.USER,
        home: process.env.HOME,
        shell: process.env.SHELL,
        terminal: process.env.TERM,
    };
}

function getLogFiles(logDir: string): { file: string, path: string, modified: Date }[] {
    if (!existsSync(logDir)) {
        return [];
    }

    try {
        return readdirSync(logDir)
            .filter(file => file.endsWith('.log'))
            .map(file => {
                const path = join(logDir, file);
                const stats = statSync(path);
                return { file, path, modified: stats.mtime };
            })
            .sort((a, b) => b.modified.getTime() - a.modified.getTime());
    } catch {
        return [];
    }
}

/**
 * Run doctor command specifically for daemon diagnostics
 */
export async function runDoctorDaemon(): Promise<void> {
    return runDoctorCommand('daemon');
}

export async function runDoctorCommand(filter?: 'all' | 'daemon'): Promise<void> {
    // Default to 'all' if no filter specified
    if (!filter) {
        filter = 'all';
    }
    
    console.log(chalk.bold.cyan('\n🩺 Remcli Doctor\n'));

    // For 'all' filter, show everything. For 'daemon', only show daemon-related info
    if (filter === 'all') {
        // Version and basic info
        console.log(chalk.bold('📋 Basic Information'));
        console.log(`Remcli Version: ${chalk.green(packageJson.version)}`);
        console.log(`Platform: ${chalk.green(process.platform)} ${process.arch}`);
        console.log(`Node.js Version: ${chalk.green(process.version)}`);
        console.log('');

        // Daemon spawn diagnostics
        console.log(chalk.bold('🔧 Daemon Spawn Diagnostics'));
        const projectRoot = projectPath();
        const wrapperPath = join(projectRoot, 'bin', 'remcli.mjs');
        const cliEntrypoint = join(projectRoot, 'dist', 'index.mjs');
        
        console.log(`Project Root: ${chalk.blue(projectRoot)}`);
        console.log(`Wrapper Script: ${chalk.blue(wrapperPath)}`);
        console.log(`CLI Entrypoint: ${chalk.blue(cliEntrypoint)}`);
        console.log(`Wrapper Exists: ${existsSync(wrapperPath) ? chalk.green('✓ Yes') : chalk.red('❌ No')}`);
        console.log(`CLI Exists: ${existsSync(cliEntrypoint) ? chalk.green('✓ Yes') : chalk.red('❌ No')}`);
        console.log('');

        // Configuration
        console.log(chalk.bold('⚙️  Configuration'));
        console.log(`Remcli Home: ${chalk.blue(configuration.remcliHomeDir)}`);
        console.log(`P2P Server URL: ${chalk.blue(configuration.p2pServerUrl || 'not configured (daemon sets this)')}`);
        console.log(`Logs Dir: ${chalk.blue(configuration.logsDir)}`);

        // Environment
        console.log(chalk.bold('\n🌍 Environment Variables'));
        const env = getEnvironmentInfo();
        console.log(`REMCLI_HOME_DIR: ${env.REMCLI_HOME_DIR ? chalk.green(env.REMCLI_HOME_DIR) : chalk.gray('not set')}`);
        console.log(`DEBUG: ${env.DEBUG ? chalk.green(env.DEBUG) : chalk.gray('not set')}`);
        console.log(`NODE_ENV: ${env.NODE_ENV ? chalk.green(env.NODE_ENV) : chalk.gray('not set')}`);

        // Settings
        try {
            const settings = await readSettings();
            console.log(chalk.bold('\n📄 Settings (settings.json):'));
            console.log(chalk.gray(JSON.stringify(redactDiagnosticData(settings), null, 2)));
        } catch (error) {
            console.log(chalk.bold('\n📄 Settings:'));
            console.log(chalk.red('❌ Failed to read settings'));
        }

        // Authentication status
        console.log(chalk.bold('\n🔐 Authentication'));
        try {
            const credentials = await readCredentials();
            if (credentials) {
                console.log(chalk.green('✓ Authenticated (credentials found)'));
            } else {
                console.log(chalk.yellow('⚠️  Not authenticated (no credentials)'));
            }
        } catch (error) {
            console.log(chalk.red('❌ Error reading credentials'));
        }
    }

    // Daemon status - shown for both 'all' and 'daemon' filters
    console.log(chalk.bold('\n🤖 Daemon Status'));
    try {
        const isRunning = await checkIfDaemonRunningAndCleanupStaleState();
        const state = await readDaemonState();

        if (isRunning && state?.state === 'running') {
            console.log(chalk.green('✓ Daemon is running'));
            console.log(`  PID: ${state.pid}`);
            console.log(`  Started: ${new Date(state.startedAtMs).toLocaleString()}`);
            console.log(`  CLI Version: ${state.startedWithCliVersion}`);
            if (state.httpPort) {
                console.log(`  HTTP Port: ${state.httpPort}`);
            }
        } else if (isRunning && state?.state === 'stopping') {
            console.log(chalk.yellow('⚠️  Daemon is finishing a shutdown'));
        } else if (state) {
            console.log(chalk.yellow(`⚠️  Daemon is not running (last state: ${state.state}/${state.stateReason})`));
        } else {
            console.log(chalk.red('❌ Daemon is not running'));
        }

        // Show daemon state file
        if (state) {
            console.log(chalk.bold('\n📄 Daemon State:'));
            console.log(chalk.blue(`Location: ${configuration.daemonStateFile}`));
            console.log(chalk.gray(JSON.stringify(redactDiagnosticData(state), null, 2)));
        }

        // All Remcli processes
        const allProcesses = await findAllRemcliProcesses();
        if (allProcesses.length > 0) {
            console.log(chalk.bold('\n🔍 All Remcli Processes'));

            // Group by type
            const grouped = allProcesses.reduce((groups, process) => {
                if (!groups[process.type]) groups[process.type] = [];
                groups[process.type].push(process);
                return groups;
            }, {} as Record<string, typeof allProcesses>);

            // Display each group
            Object.entries(grouped).forEach(([type, processes]) => {
                const typeLabels: Record<string, string> = {
                    'current': '📍 Current Process',
                    'daemon': '🤖 Daemon',
                    'unverified-daemon': '⚠️  Unverified Daemon',
                    'daemon-version-check': '🔍 Daemon Version Check (stuck)',
                    'daemon-spawned-session': '🔗 Daemon-Spawned Sessions',
                    'user-session': '👤 User Sessions',
                    'dev-daemon': '🛠️  Dev Daemon',
                    'dev-daemon-version-check': '🛠️  Dev Daemon Version Check (stuck)',
                    'dev-session': '🛠️  Dev Sessions',
                    'dev-doctor': '🛠️  Dev Doctor',
                    'dev-related': '🛠️  Dev Related',
                    'doctor': '🩺 Doctor',
                    'unknown': '❓ Unknown'
                };

                console.log(chalk.blue(`\n${typeLabels[type] || type}:`));
                processes.forEach(({ pid, command }) => {
                    const color = type === 'current' ? chalk.green :
                        type.startsWith('dev') ? chalk.cyan :
                            type.includes('daemon') ? chalk.blue : chalk.gray;
                    console.log(`  ${color(`PID ${pid}`)}: ${chalk.gray(redactSensitiveCommand(command))}`);
                });
            });
        } else {
            console.log(chalk.red('❌ No remcli processes found'));
        }

        if (filter === 'all' && allProcesses.length > 1) { // More than just current process
            console.log(chalk.bold('\n💡 Process Management'));
            console.log(chalk.gray('To clean up runaway processes: remcli doctor clean'));
        }
    } catch (error) {
        console.log(chalk.red('❌ Error checking daemon status'));
    }

    // Log files - only show for 'all' filter
    if (filter === 'all') {
        console.log(chalk.bold('\n📝 Log Files'));

        // Get ALL log files
        const allLogs = getLogFiles(configuration.logsDir);
        
        if (allLogs.length > 0) {
            // Separate daemon and regular logs
            const daemonLogs = allLogs.filter(({ file }) => file.includes('daemon'));
            const regularLogs = allLogs.filter(({ file }) => !file.includes('daemon'));

            // Show regular logs (max 10)
            if (regularLogs.length > 0) {
                console.log(chalk.blue('\nRecent Logs:'));
                const logsToShow = regularLogs.slice(0, 10);
                logsToShow.forEach(({ file, path, modified }) => {
                    console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
                    console.log(chalk.gray(`    ${path}`));
                });
                if (regularLogs.length > 10) {
                    console.log(chalk.gray(`  ... and ${regularLogs.length - 10} more log files`));
                }
            }

            // Show daemon logs (max 5)
            if (daemonLogs.length > 0) {
                console.log(chalk.blue('\nDaemon Logs:'));
                const daemonLogsToShow = daemonLogs.slice(0, 5);
                daemonLogsToShow.forEach(({ file, path, modified }) => {
                    console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
                    console.log(chalk.gray(`    ${path}`));
                });
                if (daemonLogs.length > 5) {
                    console.log(chalk.gray(`  ... and ${daemonLogs.length - 5} more daemon log files`));
                }
            } else {
                console.log(chalk.yellow('\nNo daemon log files found'));
            }
        } else {
            console.log(chalk.yellow('No log files found'));
        }

        // Support and bug reports
        console.log(chalk.bold('\n🐛 Support & Bug Reports'));
        console.log(`Report issues: ${chalk.blue('https://github.com/spetrosyan94/remcli/issues')}`);
        console.log(`Documentation: ${chalk.blue('https://remcli.dev/')}`);
    }

    // Whisper STT status
    console.log(chalk.bold('\n🎤 Whisper STT'));
    const whisper = getWhisperStatus();
    if (whisper.nativeBindings) {
        console.log(chalk.green('✓ Whisper: native bindings (smart-whisper)'));
    }
    console.log(`  Selected model: ${chalk.cyan(whisper.selectedModel)}`);
    if (whisper.modelDownloaded) {
        console.log(chalk.green(`✓ Model downloaded: ${whisper.modelPath}`));
    } else {
        console.log(chalk.yellow(`⚠️  Model not downloaded (will auto-download on first use)`));
        console.log(chalk.gray(`   Path: ${whisper.modelPath}`));
    }
    if (whisper.ffmpegAvailable) {
        console.log(chalk.green('✓ ffmpeg available (for audio conversion)'));
    } else {
        console.log(chalk.yellow('⚠️  ffmpeg not found. Install: brew install ffmpeg'));
        console.log(chalk.gray('   Required for non-WAV audio files (m4a, webm, etc.)'));
    }

    // TTS status
    console.log(chalk.bold('\n🔊 Text-to-Speech'));
    const setupConfig2 = readSetupConfig();
    const ttsProvider = setupConfig2.ttsProvider || 'edge';
    console.log(`  Provider: ${chalk.cyan(ttsProvider)}`);

    if (ttsProvider === 'off') {
        console.log(chalk.gray('  TTS disabled'));
    } else if (ttsProvider === 'edge') {
        console.log(chalk.green('✓ edge-tts (always available via npm)'));
        console.log(`  Voice: ${chalk.cyan(setupConfig2.ttsEdgeVoice || 'ru-RU-DmitryNeural')}`);
        if (whisper.ffmpegAvailable) {
            console.log(chalk.green('✓ ffmpeg available (required for MP3→OGG conversion)'));
        } else {
            console.log(chalk.red('❌ ffmpeg not found — edge-tts requires ffmpeg for OGG conversion'));
        }
    } else if (ttsProvider === 'qwen3') {
        const venvPath = join(homedir(), '.remcli', 'tts-venv');
        const venvExists = existsSync(venvPath);
        const voicesDir = join(homedir(), '.remcli', 'voices');
        const voicesDirExists = existsSync(voicesDir);

        if (venvExists) {
            console.log(chalk.green('✓ Python venv exists'));
        } else {
            console.log(chalk.red('❌ Python venv not found at ~/.remcli/tts-venv/'));
        }

        if (voicesDirExists) {
            const profiles = readdirSync(voicesDir).filter((f: string) => {
                return statSync(join(voicesDir, f)).isDirectory();
            });
            console.log(chalk.green(`✓ Voices directory: ${profiles.length} profile(s)`));
        } else {
            console.log(chalk.yellow('⚠️  No voices directory (~/.remcli/voices/)'));
        }
    }

    // AI Agents status
    console.log(chalk.bold('\n🤖 AI Agents'));
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const agents: { name: string; binaries: string[] }[] = [
        { name: 'Claude Code', binaries: ['claude'] },
        { name: 'Gemini CLI',  binaries: ['gemini'] },
        { name: 'Codex CLI',   binaries: ['codex'] },
        // Cursor Agent CLI installs as `agent` (older builds: `cursor-agent`).
        // A `cursor` binary is the IDE launcher shim, not the agent CLI.
        { name: 'Cursor CLI',  binaries: ['agent', 'cursor-agent'] },
    ];

    for (const agent of agents) {
        const resolvedBinary = agent.binaries.find((binary) => {
            try {
                execFileSync(whichCmd, [binary], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
                return true;
            } catch {
                return false;
            }
        }) ?? null;

        if (resolvedBinary) {
            let version: string | null = null;
            try {
                const output = execFileSync(resolvedBinary, ['--version'], {
                    encoding: 'utf8',
                    timeout: 10000,
                    stdio: 'pipe',
                });
                version = output.trim().split('\n')[0] || null;
            } catch {
                // version unavailable
            }
            console.log(chalk.green(`✓ ${agent.name}${version ? ` (${version})` : ''}`));
        } else {
            console.log(chalk.red(`❌ ${agent.name} - not installed`));
        }
    }

    const setupConfig = readSetupConfig();
    if (setupConfig.setupCompletedAt) {
        console.log(chalk.gray(`\n  Setup completed: ${new Date(setupConfig.setupCompletedAt).toLocaleString()}`));
    } else {
        console.log(chalk.gray('\n  Run `remcli setup` to configure agents and Whisper model.'));
    }

    console.log(chalk.green('\n✅ Doctor diagnosis complete!\n'));
}
