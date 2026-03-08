/**
 * Setup Wizard for remcli
 *
 * Interactive setup command that configures:
 * 1. Whisper STT model selection and download
 * 2. AI agent installation (Claude Code, Gemini CLI, Codex CLI, Cursor CLI)
 * 3. Saves configuration to ~/.remcli/setup.json
 */

import { select, checkbox } from '@inquirer/prompts';
import chalk from 'chalk';
import { execFileSync, execSync } from 'node:child_process';
import { readSetupConfig, writeSetupConfig } from '@/persistence';
import { WHISPER_MODELS, downloadModelWithProgress, isModelDownloaded } from '@/daemon/whisper/whisperService';

// ─── Types ──────────────────────────────────────────────────────

interface AgentDefinition {
    name: string;
    binary: string;
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
        binary: 'cursor',
        install: {
            unix: 'curl https://cursor.com/install -fsS | bash',
            windows: 'curl https://cursor.com/install -fsS | bash',
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

    const modelChoices = Object.entries(WHISPER_MODELS).map(([key, info]) => {
        const downloaded = isModelDownloaded(key);
        const recommended = key === 'small';
        const sizeLabel = info.sizeMB >= 1000
            ? `~${(info.sizeMB / 1000).toFixed(1)}GB`
            : `~${info.sizeMB}MB`;

        let label = `${key} (${sizeLabel})`;
        if (recommended) label += chalk.cyan(' -- RECOMMENDED');
        if (downloaded) label += chalk.green(' [downloaded]');

        return { name: label, value: key };
    });

    const selectedModel = await select({
        message: 'Select Whisper model:',
        choices: modelChoices,
        default: 'small',
    });

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
            // Clear previous line and write new one
            process.stdout.write(`\r${' '.repeat(lastLineLength)}\r${line}`);
            lastLineLength = line.length;
        });
        console.log(''); // newline after progress
        console.log(chalk.green(`  Model "${selectedModel}" downloaded successfully.`));
    }

    return selectedModel;
}

async function stepAIAgents(): Promise<string[]> {
    console.log(chalk.bold('\n\u{1F916} Step 2: AI Agents\n'));
    console.log(chalk.gray('  Select AI agents to install.\n'));

    const agentChoices = AGENTS.map(agent => {
        const installed = isBinaryInstalled(agent.binary);
        const version = installed ? getBinaryVersion(agent.binary) : null;
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

function stepSummary(whisperModel: string, installedAgents: string[]): void {
    console.log(chalk.bold('\n\u{2728} Setup Summary\n'));

    // Whisper
    console.log(chalk.bold('  Whisper STT'));
    const modelInfo = WHISPER_MODELS[whisperModel];
    const sizeLabel = modelInfo.sizeMB >= 1000
        ? `~${(modelInfo.sizeMB / 1000).toFixed(1)}GB`
        : `~${modelInfo.sizeMB}MB`;
    console.log(chalk.green(`  \u2713 Model: ${whisperModel} (${sizeLabel})`));

    // AI Agents
    console.log(chalk.bold('\n  AI Agents'));
    for (const agent of AGENTS) {
        const installed = isBinaryInstalled(agent.binary);
        const version = installed ? getBinaryVersion(agent.binary) : null;
        if (installed) {
            console.log(chalk.green(`  \u2713 ${agent.name}${version ? ` (${version})` : ''}`));
        } else {
            console.log(chalk.red(`  \u2717 ${agent.name} - not installed`));
        }
    }

    if (installedAgents.length > 0) {
        console.log(chalk.gray(`\n  Newly installed: ${installedAgents.join(', ')}`));
    }

    console.log('');
}

// ─── Main ───────────────────────────────────────────────────────

export async function handleSetupCommand(): Promise<void> {
    console.log(chalk.bold.cyan('\n\u{1F680} Remcli Setup Wizard\n'));
    console.log(chalk.gray('  This wizard will help you configure Whisper STT and AI agents.\n'));

    // Step 1: Whisper model
    const whisperModel = await stepWhisperModel();

    // Step 2: AI agents
    const installedAgents = await stepAIAgents();

    // Step 3: Save config
    const existingConfig = readSetupConfig();
    writeSetupConfig({
        ...existingConfig,
        whisperModel,
        installedAgents: [
            ...new Set([...existingConfig.installedAgents, ...installedAgents]),
        ],
        setupCompletedAt: new Date().toISOString(),
    });

    // Step 4: Summary
    stepSummary(whisperModel, installedAgents);

    console.log(chalk.green('  Setup complete! Run `remcli doctor` to verify.\n'));
}
