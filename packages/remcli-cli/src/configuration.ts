/**
 * Global configuration for remcli CLI
 * 
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json'

class Configuration {
  public readonly serverUrl: string
  public readonly webappUrl: string
  public readonly isDaemonProcess: boolean
  public p2pServerUrl: string | null = null

  // Directories and paths (from persistence)
  public readonly remcliHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean

  constructor() {
    // Server configuration - priority: parameter > environment > default
    this.serverUrl = process.env.REMCLI_SERVER_URL || ''
    this.webappUrl = process.env.REMCLI_WEBAPP_URL || ''

    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start-sync')

    // Directory configuration - Priority: REMCLI_HOME_DIR env > default home dir
    if (process.env.REMCLI_HOME_DIR) {
      // Expand ~ to home directory if present
      const expandedPath = process.env.REMCLI_HOME_DIR.replace(/^~/, homedir())
      this.remcliHomeDir = expandedPath
    } else {
      this.remcliHomeDir = join(homedir(), '.remcli')
    }

    this.logsDir = join(this.remcliHomeDir, 'logs')
    this.settingsFile = join(this.remcliHomeDir, 'settings.json')
    this.privateKeyFile = join(this.remcliHomeDir, 'access.key')
    this.daemonStateFile = join(this.remcliHomeDir, 'daemon.state.json')
    this.daemonLockFile = join(this.remcliHomeDir, 'daemon.state.json.lock')

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.REMCLI_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.REMCLI_DISABLE_CAFFEINATE?.toLowerCase() || '');

    this.currentCliVersion = packageJson.version

    // Validate variant configuration
    const variant = process.env.REMCLI_VARIANT || 'stable'
    if (variant === 'dev' && !this.remcliHomeDir.includes('dev')) {
      console.warn('⚠️  WARNING: REMCLI_VARIANT=dev but REMCLI_HOME_DIR does not contain "dev"')
      console.warn(`   Current: ${this.remcliHomeDir}`)
      console.warn(`   Expected: Should contain "dev" (e.g., ~/.remcli-dev)`)
    }

    // Visual indicator on CLI startup (only if not daemon process to avoid log clutter)
    if (!this.isDaemonProcess && variant === 'dev') {
      console.log('\x1b[33m🔧 DEV MODE\x1b[0m - Data: ' + this.remcliHomeDir)
    }

    if (!existsSync(this.remcliHomeDir)) {
      mkdirSync(this.remcliHomeDir, { recursive: true })
    }
    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
  }
}

export const configuration: Configuration = new Configuration()
