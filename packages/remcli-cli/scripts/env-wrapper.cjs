#!/usr/bin/env node
/**
 * Cross-platform environment wrapper for remcli CLI
 * Sets REMCLI_HOME_DIR and provides visual feedback
 *
 * Usage: node scripts/env-wrapper.cjs <variant> <command> [...args]
 *
 * Variants:
 *   - stable: Production-ready version using ~/.remcli/
 *   - dev: Development version using ~/.remcli-dev/
 *
 * Examples:
 *   node scripts/env-wrapper.cjs stable daemon start
 *   node scripts/env-wrapper.cjs dev auth login
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const VARIANTS = {
  stable: {
    homeDir: path.join(os.homedir(), '.remcli'),
    color: '\x1b[32m', // Green
    label: '✅ STABLE',
  },
  dev: {
    homeDir: path.join(os.homedir(), '.remcli-dev'),
    color: '\x1b[33m', // Yellow
    label: '🔧 DEV',
  }
};

const variant = process.argv[2];
const command = process.argv[3];
const args = process.argv.slice(4);

if (!variant || !VARIANTS[variant]) {
  console.error('Usage: node scripts/env-wrapper.cjs <stable|dev> <command> [...args]');
  console.error('');
  console.error('Variants:');
  console.error('  stable - Production-ready version (data: ~/.remcli/)');
  console.error('  dev    - Development version (data: ~/.remcli-dev/)');
  console.error('');
  console.error('Examples:');
  console.error('  node scripts/env-wrapper.cjs stable daemon start');
  console.error('  node scripts/env-wrapper.cjs dev auth login');
  process.exit(1);
}

const config = VARIANTS[variant];

// Create home directory if it doesn't exist
if (!fs.existsSync(config.homeDir)) {
  fs.mkdirSync(config.homeDir, { recursive: true });
}

// Visual feedback
console.log(`${config.color}${config.label}\x1b[0m Remcli (data: ${config.homeDir})`);

// Set environment and execute command
const env = {
  ...process.env,
  REMCLI_HOME_DIR: config.homeDir,
  REMCLI_VARIANT: variant,
};

const binPath = path.join(__dirname, '..', 'bin', 'remcli.mjs');
const proc = spawn('node', [binPath, command, ...args], {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

proc.on('exit', (code) => process.exit(code || 0));
