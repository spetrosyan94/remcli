import chalk from 'chalk';
import { readCredentials } from '@/persistence';
import { registerVendorToken, getVendorToken } from '@/api/vendorTokens';
import { authenticateCodex } from './connect/authenticateCodex';
import { authenticateClaude } from './connect/authenticateClaude';
import { decodeJwtPayload } from './connect/utils';

/**
 * Handle connect subcommand
 * 
 * Implements connect subcommands for storing AI vendor API keys:
 * - connect codex: Store OpenAI API key in Remcli cloud
 * - connect claude: Store Anthropic API key in Remcli cloud
 * - connect help: Show help for connect command
 */
export async function handleConnectCommand(args: string[]): Promise<void> {
    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showConnectHelp();
        return;
    }

    switch (subcommand.toLowerCase()) {
        case 'codex':
            await handleConnectVendor('codex', 'OpenAI');
            break;
        case 'claude':
            await handleConnectVendor('claude', 'Anthropic');
            break;
        case 'status':
            await handleConnectStatus();
            break;
        default:
            console.error(chalk.red(`Unknown connect target: ${subcommand}`));
            showConnectHelp();
            process.exit(1);
    }
}

function showConnectHelp(): void {
    console.log(`
${chalk.bold('remcli connect')} - Store AI vendor API keys locally

${chalk.bold('Usage:')}
  remcli connect codex        Store your Codex API key
  remcli connect claude       Store your Anthropic API key
  remcli connect status       Show connection status for all vendors
  remcli connect help         Show this help message

${chalk.bold('Description:')}
  The connect command allows you to store your AI vendor API keys
  locally in ~/.remcli/vendor-tokens.json. This enables you to use
  these services through Remcli.

${chalk.bold('Examples:')}
  remcli connect codex
  remcli connect claude
  remcli connect status

${chalk.bold('Notes:')}
  • You must be authenticated with Remcli first (run 'remcli auth login')
  • API keys are stored locally on this machine
`);
}

async function handleConnectVendor(vendor: 'codex' | 'claude', displayName: string): Promise<void> {
    console.log(chalk.bold(`\n🔌 Connecting ${displayName}\n`));

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(chalk.yellow('⚠️  Not authenticated with Remcli'));
        console.log(chalk.gray('  Please run "remcli auth login" first'));
        process.exit(1);
    }

    // Handle vendor authentication
    if (vendor === 'codex') {
        console.log('🚀 Registering Codex token');
        const codexAuthTokens = await authenticateCodex();
        registerVendorToken('openai', { oauth: codexAuthTokens });
        console.log('✅ Codex token saved');
        process.exit(0);
    } else if (vendor === 'claude') {
        console.log('🚀 Registering Anthropic token');
        const anthropicAuthTokens = await authenticateClaude();
        registerVendorToken('anthropic', { oauth: anthropicAuthTokens });
        console.log('✅ Anthropic token saved');
        process.exit(0);
    } else {
        throw new Error(`Unsupported vendor: ${vendor}`);
    }
}

/**
 * Show connection status for all vendors
 */
async function handleConnectStatus(): Promise<void> {
    console.log(chalk.bold('\n🔌 Connection Status\n'));

    // Check each vendor
    const vendors: Array<{ key: 'openai' | 'anthropic'; name: string; display: string }> = [
        { key: 'openai', name: 'Codex', display: 'OpenAI Codex' },
        { key: 'anthropic', name: 'Claude', display: 'Anthropic Claude' },
    ];

    for (const vendor of vendors) {
        try {
            const token = getVendorToken(vendor.key) as any;

            if (token?.oauth) {
                // Try to extract user info from id_token (JWT)
                let userInfo = '';

                if (token.oauth.id_token) {
                    const payload = decodeJwtPayload(token.oauth.id_token);
                    if (payload?.email) {
                        userInfo = chalk.gray(` (${payload.email})`);
                    }
                }

                // Check if token might be expired
                const expiresAt = token.oauth.expires_at || (token.oauth.expires_in ? Date.now() + token.oauth.expires_in * 1000 : null);
                const isExpired = expiresAt && expiresAt < Date.now();

                if (isExpired) {
                    console.log(`  ${chalk.yellow('⚠️')}  ${vendor.display}: ${chalk.yellow('expired')}${userInfo}`);
                } else {
                    console.log(`  ${chalk.green('✓')}  ${vendor.display}: ${chalk.green('connected')}${userInfo}`);
                }
            } else {
                console.log(`  ${chalk.gray('○')}  ${vendor.display}: ${chalk.gray('not connected')}`);
            }
        } catch {
            console.log(`  ${chalk.gray('○')}  ${vendor.display}: ${chalk.gray('not connected')}`);
        }
    }

    console.log('');
    console.log(chalk.gray('To connect a vendor, run: remcli connect <vendor>'));
    console.log(chalk.gray('Example: remcli connect codex'));
    console.log('');
}
