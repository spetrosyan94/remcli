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
            console.log(chalk.gray(JSON.stringify(settings, null, 2)));
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

        if (isRunning && state) {
            console.log(chalk.green('✓ Daemon is running'));
            console.log(`  PID: ${state.pid}`);
            console.log(`  Started: ${new Date(state.startTime).toLocaleString()}`);
            console.log(`  CLI Version: ${state.startedWithCliVersion}`);
            if (state.httpPort) {
                console.log(`  HTTP Port: ${state.httpPort}`);
            }
        } else if (state && !isRunning) {
            console.log(chalk.yellow('⚠️  Daemon state exists but process not running (stale)'));
        } else {
            console.log(chalk.red('❌ Daemon is not running'));
        }

        // Show daemon state file
        if (state) {
            console.log(chalk.bold('\n📄 Daemon State:'));
            console.log(chalk.blue(`Location: ${configuration.daemonStateFile}`));
            console.log(chalk.gray(JSON.stringify(state, null, 2)));
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
                    console.log(`  ${color(`PID ${pid}`)}: ${chalk.gray(command)}`);
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

    // AI Agents status
    console.log(chalk.bold('\n🤖 AI Agents'));
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const agents = [
        { name: 'Claude Code', binary: 'claude' },
        { name: 'Gemini CLI',  binary: 'gemini' },
        { name: 'Codex CLI',   binary: 'codex' },
        { name: 'Cursor CLI',  binary: 'cursor' },
    ];

    for (const agent of agents) {
        let installed = false;
        try {
            execFileSync(whichCmd, [agent.binary], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
            installed = true;
        } catch {
            // not installed
        }

        if (installed) {
            let version: string | null = null;
            try {
                const output = execFileSync(agent.binary, ['--version'], {
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