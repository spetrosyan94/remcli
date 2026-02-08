/**
 * Console log buffer for developer settings UI.
 * Remote server logging has been removed (P2P-only architecture).
 */

let logBuffer: any[] = []
const MAX_BUFFER_SIZE = 1000

export function monkeyPatchConsoleForRemoteLoggingForFasterAiAutoDebuggingOnlyInLocalBuilds() {
  // Remote logging has been removed. This function now only buffers console
  // output for the developer settings UI.
  if (!process.env.DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING) {
    return
  }

  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }

  // Patch console methods to buffer logs for dev UI
  ;(['log', 'info', 'warn', 'error', 'debug'] as const).forEach(level => {
    console[level] = (...args: any[]) => {
      // Always call original
      originalConsole[level](...args)

      // Buffer for developer settings
      const entry = {
        timestamp: new Date().toISOString(),
        level,
        message: args
      }
      logBuffer.push(entry)
      if (logBuffer.length > MAX_BUFFER_SIZE) {
        logBuffer.shift()
      }
    }
  })

  console.log('[ConsoleBuffer] Initialized for dev UI')
}

// For developer settings UI
export function getLogBuffer() {
  return [...logBuffer]
}

export function clearLogBuffer() {
  logBuffer = []
}
