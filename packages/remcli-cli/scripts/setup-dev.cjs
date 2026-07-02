#!/usr/bin/env node
/**
 * One-command setup for development environment
 * Creates directories, shows next steps
 *
 * Run: npm run setup:dev
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STABLE_DIR = path.join(os.homedir(), '.remcli');
const DEV_DIR = path.join(os.homedir(), '.remcli-dev');

console.log('🔧 Setting up remcli development environment...\n');

// Create directories
[STABLE_DIR, DEV_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ Created: ${dir}`);
  } else {
    console.log(`ℹ️  Already exists: ${dir}`);
  }
});

// Create .envrc for direnv users (optional)
const envrcContent = `# Remcli environment (for direnv users)
# Automatically sets REMCLI_HOME_DIR based on directory
#
# To use: cd to remcli-dev directory, run: direnv allow
export REMCLI_HOME_DIR="$HOME/.remcli-dev"
export REMCLI_VARIANT="dev"
`;

const envrcPath = path.join(__dirname, '..', '.envrc.example');
if (!fs.existsSync(envrcPath)) {
  fs.writeFileSync(envrcPath, envrcContent);
  console.log(`✅ Created: .envrc.example (optional direnv configuration)`);
} else {
  console.log(`ℹ️  Already exists: .envrc.example`);
}

console.log('\n✨ Setup complete!\n');
console.log('📋 Next steps:\n');
console.log('1. Build the CLI:');
console.log('   npm run build\n');
console.log('2. Start the daemon (stable data dir ~/.remcli):');
console.log('   node ./bin/remcli.mjs daemon start\n');
console.log('3. Or use the dev data dir (~/.remcli-dev):');
console.log('   REMCLI_HOME_DIR=~/.remcli-dev REMCLI_VARIANT=dev node ./bin/remcli.mjs daemon start\n');
console.log('4. Check status:');
console.log('   node ./bin/remcli.mjs daemon status\n');
console.log('💡 Use .envrc.example with direnv to switch to the dev variant automatically.');
