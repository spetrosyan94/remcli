# Remcli Codebase Overview

## Project Overview

Remcli (`remcli`) is a command-line tool that wraps Claude Code to enable remote control and session sharing. It's part of a two-component system:

1. **remcli** (this project) - CLI wrapper for Claude Code with built-in P2P server
2. **remcli-app** - React Native + Expo mobile/web client

The CLI daemon acts as a direct P2P server (Fastify + Socket.IO on `0.0.0.0`). Mobile apps connect directly — no cloud server needed.

## Code Style Preferences

### TypeScript Conventions
- **Strict typing**: No untyped code ("I despise untyped code")
- **Clean function signatures**: Explicit parameter and return types
- **As little as possible classes**
- **Comprehensive JSDoc comments**: Each file includes header comments explaining responsibilities.
- **Import style**: Uses `@/` alias for src imports, e.g., `import { logger } from '@/ui/logger'`
- **File extensions**: Uses `.ts` for TypeScript files
- **Export style**: Named exports preferred, with occasional default exports for main functions

### DO NOT

- Create stupid small functions / getters / setters
- Excessive use of `if` statements - especially if you can avoid control flow changes with a better design
- **NEVER import modules mid-code** - ALL imports must be at the top of the file

### Error Handling
- Graceful error handling with proper error messages
- Use of `try-catch` blocks with specific error logging
- Abort controllers for cancellable operations
- Careful handling of process lifecycle and cleanup

### Testing
- Unit tests using Vitest
- No mocking - tests make real API calls
- Test files colocated with source files (`.test.ts`)
- Descriptive test names and proper async handling

### Logging
- All debugging through file logs to avoid disturbing Claude sessions
- Console output only for user-facing messages
- Special handling for large JSON objects with truncation

## Architecture & Key Components

### 1. API Module (`/src/api/`)
Handles communication with the local P2P server and encryption.

- **`api.ts`**: Main API client class for session management (connects to local P2P server)
- **`apiSession.ts`**: WebSocket-based real-time session client with RPC support
- **`encryption.ts`**: End-to-end encryption utilities using TweetNaCl
- **`types.ts`**: Zod schemas for type-safe API communication

**Key Features:**
- End-to-end encryption for all communications
- Socket.IO for real-time messaging with local P2P server
- Optimistic concurrency control for state updates
- RPC handler registration for remote procedure calls
- `getEffectiveServerUrl()` returns P2P URL when configured

### 1b. P2P Module (`/src/daemon/p2p/`)
The built-in P2P server that replaces the cloud backend:

- **`p2pServer.ts`**: Main Fastify + Socket.IO server on `0.0.0.0`
- **`p2pStore.ts`**: In-memory data store (sessions, messages, machines, artifacts)
- **`p2pAuth.ts`**: Shared-secret authentication (HMAC-SHA256 token derivation)
- **`p2pSocketHandlers.ts`**: Socket.IO event handlers (mirrors server protocol)
- **`p2pRestRoutes.ts`**: REST API routes (mirrors server endpoints)
- **`p2pEventRouter.ts`**: Event routing to connected clients
- **`p2pQRCode.ts`**: QR code generation with connection info
- **`p2pSession.ts`**: P2P session setup for CLI processes
- **`networkUtils.ts`**: LAN IP detection
- **`tunnel.ts`**: ngrok tunnel support for remote access

### 2. Claude Integration (`/src/claude/`)
Core Claude Code integration layer.

- **`loop.ts`**: Main control loop managing interactive/remote modes
- **`types.ts`**: Claude message type definitions with parsers

- **`claudeSdk.ts`**: Direct SDK integration using `@anthropic-ai/claude-code`
- **`interactive.ts`**: **LIKELY WILL BE DEPRECATED in favor of running through SDK** PTY-based interactive Claude sessions
- **`watcher.ts`**: File system watcher for Claude session files (for interactive mode snooping)

- **`mcp/startPermissionServer.ts`**: MCP (Model Context Protocol) permission server

**Key Features:**
- Dual mode operation: interactive (terminal) and remote (mobile control)
- Session persistence and resumption
- Real-time message streaming
- Permission intercepting via MCP [Permission checking not implemented yet]

### 3. UI Module (`/src/ui/`)
User interface components.

- **`logger.ts`**: Centralized logging system with file output
- **`qrcode.ts`**: QR code generation for mobile authentication
- **`start.ts`**: Main application startup and orchestration

**Key Features:**
- Clean console UI with chalk styling
- QR code display for easy mobile connection
- Graceful mode switching between interactive and remote

### 4. Core Files

- **`index.ts`**: CLI entry point with argument parsing
- **`persistence.ts`**: Local storage for settings and keys
- **`utils/time.ts`**: Exponential backoff utilities

## Data Flow

1. **P2P Authentication**:
   - Daemon generates 32-byte shared secret → Displays QR code in terminal
   - Mobile scans QR → Both derive Bearer token via HMAC-SHA256

2. **Session Creation**:
   - CLI calls `setupP2PForSession()` → Reads daemon state → Connects to local P2P server
   - Creates encrypted session on local P2P server → Establishes Socket.IO connection

3. **Message Flow**:
   - Interactive mode: User input → PTY → Claude → File watcher → P2P Server → Mobile
   - Remote mode: Mobile app → P2P Server → Claude SDK → P2P Server → Mobile app

4. **Permission Handling**:
   - Claude requests permission → MCP server intercepts → Sends to mobile → Mobile responds → MCP approves/denies

## Key Design Decisions

1. **File-based logging**: Prevents interference with Claude's terminal UI
2. **Dual Claude integration**: Process spawning for interactive, SDK for remote
3. **P2P direct connection**: No cloud dependency — daemon IS the server
4. **In-memory store**: Sessions/messages live in daemon memory only (no disk persistence)
5. **Shared secret auth**: QR code scan proves physical proximity
6. **ngrok tunnel support**: `--tunnel` flag for remote access beyond LAN

## Security Considerations

- Shared secret generated per daemon session, displayed only in terminal QR code
- Bearer token derived via HMAC-SHA256 (timing-safe comparison)
- All communications encrypted using TweetNaCl / AES-256-GCM
- Session isolation through unique session IDs

## Dependencies

- Core: Node.js, TypeScript
- Claude: `@anthropic-ai/claude-code` SDK
- Networking: Socket.IO (server + client), Fastify, @fastify/cors, Axios
- Crypto: TweetNaCl, Node.js crypto (HMAC)
- Terminal: node-pty, chalk, qrcode-terminal
- Validation: Zod
- Testing: Vitest


# Running the Daemon

## Starting the Daemon
```bash
# From the remcli-cli directory:
./bin/remcli.mjs daemon start

# With ngrok tunnel for remote access:
./bin/remcli.mjs daemon start --tunnel

# Stop the daemon:
./bin/remcli.mjs daemon stop

# Check daemon status:
./bin/remcli.mjs daemon status

# Re-display QR code for mobile connection:
./bin/remcli.mjs daemon qr
```

The daemon starts a P2P server on `0.0.0.0` and displays a QR code containing the LAN IP, port, and shared secret. Mobile app scans this QR to connect directly.

## Daemon Logs
- Daemon logs are stored in `~/.remcli-dev/logs/` (or `$REMCLI_HOME_DIR/logs/`)
- Named with format: `YYYY-MM-DD-HH-MM-SS-daemon.log`

# Session Forking `claude` and sdk behavior

## Commands Run

### Initial Session
```bash
claude --print --output-format stream-json --verbose 'list files in this directory'
```
- Original Session ID: `aada10c6-9299-4c45-abc4-91db9c0f935d`
- Created file: `~/.claude/projects/.../aada10c6-9299-4c45-abc4-91db9c0f935d.jsonl`

### Resume with --resume flag
```bash
claude --print --output-format stream-json --verbose --resume aada10c6-9299-4c45-abc4-91db9c0f935d 'what file did we just see?'
```
- New Session ID: `1433467f-ff14-4292-b5b2-2aac77a808f0`
- Created file: `~/.claude/projects/.../1433467f-ff14-4292-b5b2-2aac77a808f0.jsonl`

## Key Findings for --resume

### 1. Session File Behavior
- Creates a NEW session file with NEW session ID
- Original session file remains unchanged
- Two separate files exist after resumption

### 2. History Preservation
- The new session file contains the COMPLETE history from the original session
- History is prefixed at the beginning of the new file
- Includes a summary line at the very top

### 3. Session ID Rewriting
- **CRITICAL FINDING**: All historical messages have their sessionId field UPDATED to the new session ID
- Original messages from session `aada10c6-9299-4c45-abc4-91db9c0f935d` now show `sessionId: "1433467f-ff14-4292-b5b2-2aac77a808f0"`
- This creates a unified session history under the new ID

### 4. Message Structure in New File
```
Line 1: Summary of previous conversation
Lines 2-6: Complete history from original session (with updated session IDs)
Lines 7-8: New messages from current interaction
```

### 5. Context Preservation
- Claude successfully maintains full context
- Can answer questions about previous interactions
- Behaves as if it's a continuous conversation

## Technical Details

### Original Session File Structure
- Contains only messages from the original session
- All messages have original session ID
- Remains untouched after resume

### New Session File Structure After Resume
```json
{"type":"summary","summary":"Listing directory files in current location","leafUuid":"..."}
{"parentUuid":null,"sessionId":"1433467f-ff14-4292-b5b2-2aac77a808f0","message":{"role":"user","content":[{"type":"text","text":"list files in this directory"}]},...}
// ... all historical messages with NEW session ID ...
{"parentUuid":"...","sessionId":"1433467f-ff14-4292-b5b2-2aac77a808f0","message":{"role":"user","content":"what file did we just see?"},...}
```

## Implications for remcli

When using --resume:
1. Must handle new session ID in responses
2. Original session remains as historical record
3. All context preserved but under new session identity
4. Session ID in stream-json output will be the new one, not the resumed one