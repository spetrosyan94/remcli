/**
 * Setup Wizard for remcli
 *
 * Interactive setup command that configures:
 * 1. Whisper STT model selection and download
 * 2. AI agent installation (Claude Code, Gemini CLI, Codex CLI, Cursor CLI)
 * 3. Saves configuration to ~/.remcli/setup.json
 */

import { select, checkbox, confirm, input } from '@inquirer/prompts';
import chalk from 'chalk';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { readSetupConfig, writeSetupConfig } from '@/persistence';
import { WHISPER_MODELS, downloadModelWithProgress, isModelDownloaded } from '@/daemon/whisper/whisperService';
import { resolveCloudflaredBinary } from '@/daemon/p2p/tunnel';

// ─── Types ──────────────────────────────────────────────────────

interface AgentDefinition {
    name: string;
    binary: string;
    /** Alternative binary names to accept if the primary one is not on PATH */
    fallbackBinaries?: string[];
    install: {
        unix: string;      // macOS/Linux/WSL
        windows: string;   // Windows PowerShell
    };
}

// ─── Constants ──────────────────────────────────────────────────

const AGENTS: AgentDefinition[] = [
    {
        name: 'Claude Code',
        binary: 'claude',
        install: {
            unix: 'curl -fsSL https://claude.ai/install.sh | bash',
            windows: 'powershell -Command "irm https://claude.ai/install.ps1 | iex"',
        },
    },
    {
        name: 'Gemini CLI',
        binary: 'gemini',
        install: {
            unix: 'npm install -g @google/gemini-cli',
            windows: 'npm install -g @google/gemini-cli',
        },
    },
    {
        name: 'Codex CLI',
        binary: 'codex',
        install: {
            unix: 'npm install -g @openai/codex',
            windows: 'npm install -g @openai/codex',
        },
    },
    {
        name: 'Cursor CLI',
        // The Cursor Agent CLI installs as `agent` (older builds: `cursor-agent`).
        // Note: a `cursor` binary is the IDE launcher shim, NOT the agent CLI.
        binary: 'agent',
        fallbackBinaries: ['cursor-agent'],
        install: {
            unix: 'curl https://cursor.com/install -fsS | bash',
            // The ?win32=true query returns the native PowerShell installer
            // (the plain URL serves a bash script that iex cannot execute).
            windows: 'powershell -Command "irm \'https://cursor.com/install?win32=true\' | iex"',
        },
    },
];

const IS_WINDOWS = process.platform === 'win32';

const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which';

// ─── Helpers ────────────────────────────────────────────────────

function isBinaryInstalled(binary: string): boolean {
    try {
        execFileSync(WHICH_CMD, [binary], { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
        return true;
    } catch {
        return false;
    }
}

/**
 * Resolve the first installed binary for an agent, checking the primary name
 * and any declared fallbacks. Returns the resolved binary name or null.
 */
function resolveInstalledBinary(agent: AgentDefinition): string | null {
    const candidates = [agent.binary, ...(agent.fallbackBinaries ?? [])];
    return candidates.find(isBinaryInstalled) ?? null;
}

function getBinaryVersion(binary: string): string | null {
    try {
        const output = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000, stdio: 'pipe' });
        const firstLine = output.trim().split('\n')[0];
        return firstLine || null;
    } catch {
        return null;
    }
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatProgressBar(downloaded: number, total: number | null, width: number = 30): string {
    if (!total) {
        return `${formatBytes(downloaded)} downloaded`;
    }
    const percent = Math.min(100, Math.round((downloaded / total) * 100));
    const filled = Math.round((percent / 100) * width);
    const empty = width - filled;
    const bar = chalk.green('\u2588'.repeat(filled)) + chalk.gray('\u2591'.repeat(empty));
    return `${bar} ${percent}% (${formatBytes(downloaded)} / ${formatBytes(total)})`;
}

// ─── Steps ──────────────────────────────────────────────────────

async function stepWhisperModel(): Promise<string> {
    console.log(chalk.bold('\n\u{1F3A4} Step 1: Whisper STT Model\n'));
    console.log(chalk.gray('  Whisper provides local speech-to-text for voice messages.'));
    console.log(chalk.gray('  Larger models are more accurate but use more disk space.\n'));

    // Show currently downloaded models
    const downloadedModels = Object.keys(WHISPER_MODELS).filter(key => isModelDownloaded(key));
    if (downloadedModels.length > 0) {
        console.log(chalk.gray(`  Currently downloaded: ${downloadedModels.join(', ')}\n`));
    }

    const existingConfig = readSetupConfig();

    const modelChoices = [
        // Skip option at the top
        { name: chalk.gray('Skip (keep current settings)'), value: '__skip__' },
        ...Object.entries(WHISPER_MODELS).map(([key, info]) => {
            const downloaded = isModelDownloaded(key);
            const recommended = key === 'small';
            const isActive = existingConfig.whisperModel === key;
            const sizeLabel = info.sizeMB >= 1000
                ? `~${(info.sizeMB / 1000).toFixed(1)}GB`
                : `~${info.sizeMB}MB`;

            let label = `${key} (${sizeLabel})`;
            if (recommended) label += chalk.cyan(' -- RECOMMENDED');
            if (downloaded && isActive) label += chalk.green(' [active]');
            else if (downloaded) label += chalk.green(' [downloaded]');

            return { name: label, value: key };
        }),
    ];

    const selectedModel = await select({
        message: 'Select Whisper model:',
        choices: modelChoices,
        default: existingConfig.whisperModel || 'small',
    });

    if (selectedModel === '__skip__') {
        const current = existingConfig.whisperModel || 'base';
        console.log(chalk.gray(`\n  Keeping current model: ${current}`));
        return current;
    }

    if (isModelDownloaded(selectedModel)) {
        console.log(chalk.green(`\n  Model "${selectedModel}" is already downloaded.`));
    } else {
        const info = WHISPER_MODELS[selectedModel];
        const sizeLabel = info.sizeMB >= 1000
            ? `~${(info.sizeMB / 1000).toFixed(1)}GB`
            : `~${info.sizeMB}MB`;
        console.log(chalk.yellow(`\n  Downloading model "${selectedModel}" (${sizeLabel})...`));

        let lastLineLength = 0;
        await downloadModelWithProgress(selectedModel, (downloaded, total) => {
            const line = `  ${formatProgressBar(downloaded, total)}`;
            process.stdout.write(`\r${' '.repeat(lastLineLength)}\r${line}`);
            lastLineLength = line.length;
        });
        console.log('');
        console.log(chalk.green(`  Model "${selectedModel}" downloaded successfully.`));
    }

    return selectedModel;
}

async function stepTTS(): Promise<{ provider: string; voice: string; voiceProfile: string }> {
    console.log(chalk.bold('\n\u{1F50A} Step 2: Text-to-Speech (TTS)\n'));
    console.log(chalk.gray('  TTS enables voice playback of agent responses on your mobile/web client.\n'));

    const existingConfig = readSetupConfig();
    const currentProvider = existingConfig.ttsProvider || 'edge';

    // Check qwen3 installation status
    const qwenVenvPath = join(homedir(), '.remcli', 'tts-venv');
    const qwenInstalled = existsSync(qwenVenvPath);
    const isAppleSilicon = process.arch === 'arm64' && process.platform === 'darwin';

    // Build labels with status info
    const edgeLabel = `edge-tts (Microsoft, free, no setup needed)${currentProvider === 'edge' ? chalk.green(' [active]') : chalk.green(' [ready]')}`;

    let qwenLabel = 'qwen3-tts (local, voice cloning, Apple Silicon only)';
    if (!isAppleSilicon) {
        qwenLabel += chalk.gray(' [unavailable on this platform]');
    } else if (qwenInstalled) {
        qwenLabel += currentProvider === 'qwen3' ? chalk.green(' [active]') : chalk.green(' [installed]');
    } else {
        qwenLabel += chalk.yellow(' [needs setup ~5 min]');
    }

    const provider = await select({
        message: 'Select TTS provider:',
        choices: [
            { name: edgeLabel, value: 'edge' },
            { name: qwenLabel, value: 'qwen3' },
            { name: chalk.gray('Skip (keep current settings)'), value: '__skip__' },
            { name: 'Off', value: 'off' },
        ],
        default: currentProvider,
    });

    if (provider === '__skip__') {
        console.log(chalk.gray(`\n  Keeping current provider: ${currentProvider}`));
        return {
            provider: currentProvider,
            voice: existingConfig.ttsEdgeVoice || 'ru-RU-DmitryNeural',
            voiceProfile: existingConfig.ttsQwenVoiceProfile || 'default',
        };
    }

    if (provider === 'off') {
        console.log(chalk.gray('\n  TTS disabled.'));
        return { provider: 'off', voice: 'auto', voiceProfile: 'default' };
    }

    let voice = 'auto';
    let voiceProfile = 'default';

    if (provider === 'edge') {
        voice = await select({
            message: 'Select voice:',
            choices: [
                { name: 'Auto — pick voice by response language (recommended)', value: 'auto' },
                { name: 'ru-RU-DmitryNeural (male, Russian)', value: 'ru-RU-DmitryNeural' },
                { name: 'ru-RU-SvetlanaNeural (female, Russian)', value: 'ru-RU-SvetlanaNeural' },
                { name: 'Custom (enter voice name)', value: '__custom__' },
            ],
            default: 'auto',
        });

        if (voice === '__custom__') {
            voice = await input({
                message: 'Enter voice name (e.g., en-US-AriaNeural):',
                default: 'en-US-AriaNeural',
            });
        }

        console.log(chalk.green(`\n  Edge-TTS configured with voice: ${voice}`));
    }

    if (provider === 'qwen3') {
        // Check Apple Silicon
        if (process.arch !== 'arm64' || process.platform !== 'darwin') {
            console.log(chalk.red('\n  Qwen3-TTS requires Apple Silicon (M1+). Falling back to edge-tts.'));
            return { provider: 'edge', voice: 'ru-RU-DmitryNeural', voiceProfile };
        }

        const remcliHome = join(homedir(), '.remcli');
        const venvPath = join(remcliHome, 'tts-venv');

        // Create venv
        if (!existsSync(venvPath)) {
            console.log(chalk.yellow('\n  Creating Python virtual environment...'));
            try {
                execSync(`python3 -m venv "${venvPath}"`, { stdio: 'inherit', timeout: 60_000 });
                console.log(chalk.green('  Virtual environment created.'));
            } catch {
                console.log(chalk.red('  Failed to create venv. Falling back to edge-tts.'));
                return { provider: 'edge', voice: 'ru-RU-DmitryNeural', voiceProfile };
            }
        } else {
            console.log(chalk.green('  Virtual environment already exists.'));
        }

        // Install mlx-audio
        console.log(chalk.yellow('  Installing mlx-audio (this may take a few minutes)...'));
        try {
            execSync(`"${join(venvPath, 'bin', 'pip')}" install mlx-audio`, { stdio: 'inherit', timeout: 600_000 });
            console.log(chalk.green('  mlx-audio installed successfully.'));
        } catch {
            console.log(chalk.red('  Failed to install mlx-audio. Falling back to edge-tts.'));
            return { provider: 'edge', voice: 'ru-RU-DmitryNeural', voiceProfile };
        }

        // Default voice profile is bundled with the CLI and used automatically.
        // Users can add custom profiles to ~/.remcli/voices/<name>/
        console.log(chalk.green('\n  Default voice profile is bundled with remcli (no extra setup needed).'));
        console.log(chalk.cyan('  Custom voice profiles: ~/.remcli/voices/<name>/'));
        console.log(chalk.gray('     Each profile needs: profile.json + ref_audio (3-10 sec)'));
        console.log(chalk.gray('     Model (~1.7GB) will download automatically on first synthesis.\n'));
    }

    return { provider, voice, voiceProfile };
}

async function stepAIAgents(): Promise<string[]> {
    console.log(chalk.bold('\n\u{1F916} Step 3: AI Agents\n'));
    console.log(chalk.gray('  Select AI agents to install.\n'));

    const agentChoices = AGENTS.map(agent => {
        const resolvedBinary = resolveInstalledBinary(agent);
        const installed = resolvedBinary !== null;
        const version = resolvedBinary ? getBinaryVersion(resolvedBinary) : null;
        const statusLabel = installed
            ? chalk.green(`[installed${version ? `: ${version}` : ''}]`)
            : chalk.red('[not installed]');

        return {
            name: `${agent.name} ${statusLabel}`,
            value: agent.binary,
            checked: !installed,
        };
    });

    const selectedBinaries = await checkbox({
        message: 'Select agents to install:',
        choices: agentChoices,
    });

    if (selectedBinaries.length === 0) {
        console.log(chalk.gray('\n  No agents selected for installation.'));
        return [];
    }

    const installedAgents: string[] = [];

    for (const binary of selectedBinaries) {
        const agent = AGENTS.find(a => a.binary === binary);
        if (!agent) continue;

        const resolvedBinary = resolveInstalledBinary(agent);
        if (resolvedBinary) {
            const version = getBinaryVersion(resolvedBinary);
            console.log(chalk.green(`\n  ${agent.name} is already installed${version ? ` (${version})` : ''}, skipping.`));
            continue;
        }

        const installCmd = IS_WINDOWS ? agent.install.windows : agent.install.unix;
        console.log(chalk.yellow(`\n  Installing ${agent.name}...`));
        console.log(chalk.gray(`  $ ${installCmd}`));
        try {
            execSync(installCmd, { stdio: 'inherit', timeout: 300_000 });
            console.log(chalk.green(`  ${agent.name} installed successfully.`));
            installedAgents.push(agent.name);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            console.log(chalk.red(`  Failed to install ${agent.name}: ${message}`));
        }
    }

    return installedAgents;
}

async function stepCloudflared(): Promise<boolean> {
    console.log(chalk.bold('\n\u{1F310} Step 4: cloudflared (HTTPS tunnel)\n'));

    const installed = resolveCloudflaredBinary() !== null;

    if (installed) {
        console.log(chalk.green('  cloudflared is already installed.'));
        console.log(chalk.gray('  Use --tunnel flag to enable remote access with voice input.\n'));
        return true;
    }

    console.log(chalk.gray('  cloudflared provides free HTTPS tunnel for remote access beyond your local network.'));
    console.log(chalk.gray('  No account required. No interstitial pages.\n'));

    const shouldInstall = await confirm({
        message: 'Install cloudflared?',
        default: true,
    });

    if (!shouldInstall) {
        console.log(chalk.gray('\n  Skipped. Install later: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'));
        return false;
    }

    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';

    if (isMac) {
        console.log(chalk.yellow('\n  Installing cloudflared via Homebrew...'));
        console.log(chalk.gray('  $ brew install cloudflared'));
        try {
            execSync('brew install cloudflared', { stdio: 'inherit', timeout: 300_000 });
            console.log(chalk.green('  cloudflared installed successfully.'));
        } catch {
            console.log(chalk.red('  Failed to install via Homebrew.'));
            console.log(chalk.gray('  Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'));
            return false;
        }
    } else if (isLinux) {
        console.log(chalk.yellow('\n  Installing cloudflared...'));
        try {
            // Try dpkg approach (works on Debian/Ubuntu)
            const arch = execSync('dpkg --print-architecture', { encoding: 'utf-8', stdio: 'pipe' }).trim();
            const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}.deb`;
            console.log(chalk.gray(`  $ curl -L ${url} -o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb`));
            execSync(`curl -L ${url} -o /tmp/cloudflared.deb && sudo dpkg -i /tmp/cloudflared.deb`, {
                stdio: 'inherit', timeout: 300_000,
            });
            console.log(chalk.green('  cloudflared installed successfully.'));
        } catch {
            console.log(chalk.red('  Failed to install cloudflared.'));
            console.log(chalk.gray('  Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'));
            return false;
        }
    } else if (IS_WINDOWS) {
        console.log(chalk.yellow('\n  Installing cloudflared via winget...'));
        console.log(chalk.gray('  $ winget install Cloudflare.cloudflared'));
        try {
            execSync('winget install Cloudflare.cloudflared', { stdio: 'inherit', timeout: 300_000 });
            console.log(chalk.green('  cloudflared installed successfully.'));
        } catch {
            console.log(chalk.red('  Failed to install via winget.'));
            console.log(chalk.gray('  Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'));
            return false;
        }
    } else {
        console.log(chalk.gray('  Install from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'));
        return false;
    }

    return true;
}

function stepSummary(whisperModel: string, installedAgents: string[], cloudflaredInstalled: boolean, ttsConfig?: { provider: string; voice: string }): void {
    console.log(chalk.bold('\n\u{2728} Setup Summary\n'));

    // Whisper
    console.log(chalk.bold('  Whisper STT'));
    const modelInfo = WHISPER_MODELS[whisperModel];
    const sizeLabel = modelInfo.sizeMB >= 1000
        ? `~${(modelInfo.sizeMB / 1000).toFixed(1)}GB`
        : `~${modelInfo.sizeMB}MB`;
    console.log(chalk.green(`  \u2713 Model: ${whisperModel} (${sizeLabel})`));

    // TTS
    if (ttsConfig) {
        console.log(chalk.bold('\n  Text-to-Speech'));
        if (ttsConfig.provider === 'off') {
            console.log(chalk.gray('  \u2717 Disabled'));
        } else if (ttsConfig.provider === 'edge') {
            console.log(chalk.green(`  \u2713 edge-tts (voice: ${ttsConfig.voice})`));
        } else if (ttsConfig.provider === 'qwen3') {
            console.log(chalk.green('  \u2713 qwen3-tts (local, voice cloning)'));
        }
    }

    // AI Agents
    console.log(chalk.bold('\n  AI Agents'));
    for (const agent of AGENTS) {
        const resolvedBinary = resolveInstalledBinary(agent);
        const installed = resolvedBinary !== null;
        const version = resolvedBinary ? getBinaryVersion(resolvedBinary) : null;
        if (installed) {
            console.log(chalk.green(`  \u2713 ${agent.name}${version ? ` (${version})` : ''}`));
        } else {
            console.log(chalk.red(`  \u2717 ${agent.name} - not installed`));
        }
    }

    if (installedAgents.length > 0) {
        console.log(chalk.gray(`\n  Newly installed: ${installedAgents.join(', ')}`));
    }

    // cloudflared
    console.log(chalk.bold('\n  HTTPS Tunnel (cloudflared)'));
    if (cloudflaredInstalled) {
        console.log(chalk.green('  \u2713 cloudflared installed'));
    } else {
        console.log(chalk.red('  \u2717 cloudflared not installed — voice input on web requires HTTPS'));
    }

    console.log('');
}

// ─── Main ───────────────────────────────────────────────────────

export async function handleSetupCommand(): Promise<void> {
    console.log(chalk.bold.cyan('\n\u{1F680} Remcli Setup Wizard\n'));
    console.log(chalk.gray('  This wizard will help you configure Whisper STT, TTS, AI agents, and cloudflared.\n'));

    // Step 1: Whisper model
    const whisperModel = await stepWhisperModel();

    // Step 2: TTS
    const ttsConfig = await stepTTS();

    // Step 3: AI agents
    const installedAgents = await stepAIAgents();

    // Step 4: cloudflared
    const cloudflaredInstalled = await stepCloudflared();

    // Save config
    const existingConfig = readSetupConfig();
    writeSetupConfig({
        ...existingConfig,
        whisperModel,
        ttsProvider: ttsConfig.provider as 'off' | 'edge' | 'qwen3',
        ttsEdgeVoice: ttsConfig.voice,
        ttsQwenVoiceProfile: ttsConfig.voiceProfile,
        installedAgents: [
            ...new Set([...existingConfig.installedAgents, ...installedAgents]),
        ],
        setupCompletedAt: new Date().toISOString(),
    });

    // Summary
    stepSummary(whisperModel, installedAgents, cloudflaredInstalled, ttsConfig);

    console.log(chalk.green('  Setup complete! Run `remcli doctor` to verify.\n'));
}
