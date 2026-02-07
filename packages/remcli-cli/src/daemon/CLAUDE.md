# Remcli Daemon: Control Flow and Lifecycle

The daemon is a persistent background process that manages Remcli sessions, runs a built-in P2P server for direct mobile app connections, and handles auto-updates when the CLI version changes. No cloud server is needed.

## 1. Daemon Lifecycle

### Starting the Daemon

Command: `remcli daemon start` (optionally with `--tunnel` for ngrok)

Control Flow:
1. `src/index.ts` receives `daemon start` command
2. Spawns detached process via `spawnRemcliCLI(['daemon', 'start-sync'], { detached: true })`
3. New process calls `startDaemon()` from `src/daemon/run.ts`
4. `startDaemon()` performs startup:
   - Sets up shutdown promise and handlers (SIGINT, SIGTERM, uncaughtException, unhandledRejection)
   - Version check: `isDaemonRunningSameVersion()` reads daemon.state.json, compares `startedWithCliVersion` with `configuration.currentCliVersion`
   - If version mismatch: calls `stopDaemon()` to kill old daemon before proceeding
   - If same version running: exits with "Daemon already running"
   - Lock acquisition: `acquireDaemonLock()` creates exclusive lock file to prevent multiple daemons
   - State persistence: writes PID, version, HTTP port to daemon.state.json
   - HTTP control server: starts on random port on `127.0.0.1` for local CLI control
   - P2P Store: loads `~/.remcli/p2p-store.json` from disk
   - P2P Server: starts Fastify + Socket.IO on `0.0.0.0:PORT` for mobile app connections
   - Shared secret: generates 32-byte secret, derives bearer token
   - QR code: displays connection info (host, port, key) in terminal
   - (Optional) ngrok tunnel: if `--tunnel` flag, starts ngrok and re-displays QR with tunnel URL
   - Machine registration: registers machine in P2PStore (locally, not in cloud)
   - RPC registration: exposes `spawn-remcli-session`, `stop-session`, `requestShutdown` handlers
   - Heartbeat loop: every 60s checks for version updates and prunes dead sessions
5. Awaits shutdown promise which resolves when:
   - OS signal received (SIGINT/SIGTERM)
   - HTTP `/stop` endpoint called
   - RPC `requestShutdown` invoked
   - Uncaught exception occurs
6. On shutdown, `cleanupAndShutdown()` performs:
   - Clears heartbeat interval
   - Saves P2PStore to disk
   - Stops ngrok tunnel (if running)
   - Stops P2P server
   - Stops HTTP control server
   - Deletes daemon.state.json
   - Releases lock file
   - Exits process

### Version Mismatch Auto-Update

The daemon detects when `npm upgrade remcli` occurs:
1. Heartbeat reads package.json from disk
2. Compares `JSON.parse(package.json).version` with compiled `configuration.currentCliVersion`
3. If mismatch detected:
   - Spawns new daemon via `spawnRemcliCLI(['daemon', 'start'])`
   - Hangs and waits to be killed
4. New daemon starts, sees old daemon.state.json version != its compiled version
5. New daemon calls `stopDaemon()` which tries HTTP `/stop`, falls back to SIGKILL
6. New daemon takes over

### Stopping the Daemon

Command: `remcli daemon stop`

Control Flow:
1. `stopDaemon()` in `controlClient.ts` reads daemon.state.json
2. Attempts graceful shutdown via HTTP POST to `/stop`
3. Daemon receives request, calls `cleanupAndShutdown()`:
   - Updates backend status to "shutting-down"
   - Closes WebSocket connection
   - Stops HTTP server
   - Deletes daemon.state.json
   - Releases lock file
4. If HTTP fails, falls back to `process.kill(pid, 'SIGKILL')`

## 2. Session Management

### Daemon-Spawned Sessions (Remote)

Initiated by mobile app via P2P RPC:
1. Mobile app sends RPC `spawn-remcli-session` via Socket.IO to P2P server
2. P2P server invokes `spawnSession()` handler
3. `spawnSession()`:
   - Creates directory if needed
   - Spawns detached Remcli process with `--remcli-starting-mode remote --started-by daemon`
   - Adds to `pidToTrackedSession` map
   - Sets up 10-second awaiter for session webhook
4. New Remcli process:
   - Calls `setupP2PForSession()` — reads daemon state, derives bearer token
   - Creates session on local P2P server, receives `remcliSessionId`
   - Calls `notifyDaemonSessionStarted()` to POST to daemon's `/session-started`
5. Daemon updates tracking with `remcliSessionId`, resolves awaiter
6. RPC returns session info to mobile app

### Terminal-Spawned Sessions

User runs `remcli` directly:
1. CLI auto-starts daemon if configured
2. `setupP2PForSession()` reads daemon state, connects to local P2P server
3. Remcli process calls `notifyDaemonSessionStarted()`
4. Daemon receives webhook, creates `TrackedSession` with `startedBy: 'remcli directly...'`
5. Session tracked for health monitoring

### Session Termination

Via RPC `stop-session` or health check:
1. `stopSession()` finds session by `remcliSessionId`
2. Sends SIGTERM to process
3. `on('exit')` handler removes from tracking map

## 3. HTTP Control Server

Local HTTP server (127.0.0.1 only) provides:
- `/session-started` - webhook for sessions to report themselves
- `/list` - returns tracked sessions
- `/stop-session` - terminates specific session
- `/spawn-session` - creates new session (used by integration tests)
- `/stop` - graceful daemon shutdown

## 4. Process Discovery and Cleanup

### Doctor Command

`remcli doctor` uses `ps aux | grep` to find all Remcli processes:
- Production: matches `remcli.mjs`, `remcli`, `dist/index.mjs`
- Development: matches `tsx.*src/index.ts`
- Categorizes by command args: daemon, daemon-spawned, user-session, doctor

### Clean Runaway Processes

`remcli doctor clean`:
1. `findRunawayRemcliProcesses()` filters for likely orphans
2. `killRunawayRemcliProcesses()`:
   - Sends SIGTERM
   - Waits 1 second
   - Sends SIGKILL if still alive

## 5. State Persistence

### daemon.state.json
```json
{
  "pid": 12345,
  "httpPort": 50097,
  "p2pPort": 12345,
  "p2pHost": "192.168.1.100",
  "p2pSharedSecret": "<base64>",
  "tunnelUrl": "https://abc123.ngrok-free.app",
  "startTime": "8/24/2025, 6:46:22 PM",
  "startedWithCliVersion": "0.9.0-6",
  "lastHeartbeat": "8/24/2025, 6:47:22 PM",
  "daemonLogPath": "/path/to/daemon.log"
}
```

### P2P Store (`~/.remcli/p2p-store.json`)
In-memory maps with debounced JSON persistence:
- Sessions: id, tag, seq, metadata, agentState, dataEncryptionKey, active
- Messages: id, sessionId, seq, content, localId
- Machines: id, seq, metadata, daemonState, dataEncryptionKey
- Sequences: userSeq, per-session seq counters

### Lock File
- Created with O_EXCL flag for atomic acquisition
- Contains PID for debugging
- Prevents multiple daemon instances
- Cleaned up on graceful shutdown

## 6. P2P Server Communication

The daemon runs its own Socket.IO server (replaces cloud WebSocket):
- Mobile app connects directly to daemon's P2P server
- Bearer token auth derived from shared secret (HMAC-SHA256)
- Same Socket.IO event protocol as legacy server
- RPC handlers: `spawn-remcli-session`, `stop-session`, `requestShutdown`
- REST API: `/v1/sessions`, `/v1/machines`, `/v2/sessions/active`, etc.
- Event routing: user-scoped, session-scoped, machine-scoped connections

## 7. Integration Testing Challenges

Version mismatch test simulates npm upgrade:
- Test modifies package.json, rebuilds with new version
- Daemon's compiled version != package.json on disk
- Critical timing: heartbeat interval must exceed rebuild time
- pkgroll doesn't update compiled imports, must use full npm run build

# Improvements

I do not like how

- daemon.state.json file is getting hard removed when daemon exits or is stopped. We should keep it around and have 'state' field and 'stateReason' field that will explain why the daemon is in that state
- If the file is not found - we assume the daemon was never started or was cleaned out by the user or doctor
- If the file is found and corrupted - we should try to upgrade it to the latest version? or simply remove it if we have write access

- posts helpers for daemon do not return typed results
- I don't like that daemonPost returns either response from daemon or { error: ... }. We should have consistent envelope type

- we loose track of children processes when daemon exits / restarts - we should write them to the same state file? At least the pids should be there for doctor & cleanup

- caffeinate process is not tracked in state at all & might become runaway
- caffeinate is also started by individual sesions - we should not do that for simpler cleanup 

- the port is not protected - lets encrypt something with a public portion of the secret key & send it as a signature along the rest of the unencrypted payload to the daemon - will make testing harder :/


# Machine & P2P Architecture

## P2P Data Flow

In P2P mode, the daemon IS the server. Machine data is stored locally in P2PStore:

```
Mobile App  ──Socket.IO──>  Daemon P2P Server  ──>  P2PStore (in-memory + JSON)
                                    │
                                    └──>  Claude SDK (via RPC)
```

## Machine Data Structure

```typescript
interface P2PMachine {
  id: string;
  seq: number;
  metadata: string;              // encrypted machine info
  metadataVersion: number;
  daemonState: string;           // encrypted daemon state
  daemonStateVersion: number;
  dataEncryptionKey: string;
  active: boolean;
  activeAt: number;
  createdAt: number;
  updatedAt: number;
}
```

## P2P Server Events (same protocol as legacy cloud server)

### Connection Handshake:
```javascript
io('http://192.168.1.x:PORT', {
  path: '/v1/updates',
  auth: {
    token: '<hmac-derived-bearer-token>',
    clientType: 'user-scoped'
  }
})
```

### Session events:
- `message` → store in P2PStore, broadcast `new-message`
- `update-metadata` → OCC check, update store, broadcast `update-session`
- `update-state` → OCC check, update store, broadcast `update-session`
- `session-alive` → broadcast ephemeral `activity`

### Machine events:
- `machine-alive` → broadcast ephemeral `machine-activity`
- `machine-update-metadata` → OCC check, update store, broadcast `update-machine`
- `machine-update-state` → OCC check, update store, broadcast `update-machine`

### RPC events:
- `rpc-register` → register socket→method binding
- `rpc-call` → forward to registered handler (30s timeout)

### REST API (same as legacy server):
- `GET /v1/sessions`, `POST /v1/sessions`, `DELETE /v1/sessions/:id`
- `GET /v1/sessions/:id/messages`
- `GET /v2/sessions/active`, `GET /v2/sessions` (cursor pagination)
- `POST /v1/machines`, `GET /v1/machines`, `GET /v1/machines/:id`




