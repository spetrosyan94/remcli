# Protocol

This document describes the Remcli wire protocol as implemented in the P2P server (`packages/remcli-cli/src/daemon/p2p/`). The protocol is intentionally small: JSON over HTTP for reads/actions and Socket.IO for real-time sync. Most payloads are end-to-end encrypted client-side; see `encryption.md` for the encryption boundaries and encoding details.

## Transport and versioning
- HTTP API: JSON requests/responses on `/v1` and `/v2` routes.
- WebSocket: Socket.IO server at path `/v1/updates` (transports: websocket, polling).
- CORS: `*` (server-side).

## Protocol design motivations
The protocol is designed to stay minimal, explicit, and resilient under intermittent connectivity. A few guiding principles shape naming, payloads, and versioning:

- **Small surface area over completeness.** Routes and events exist only when they provide a clear sync primitive (e.g., sessions, machines, KV). If a capability can be expressed as data within an existing primitive, it should be.
- **Explicit event types and short keys.** Update payloads use `t` for the event type and concise field names (`sid`, `id`, `seq`) to keep message size down without hiding meaning. These names are stable because they are used across clients.
- **Separation of persistent vs. ephemeral.** Anything that must be recoverable after reconnect is an `update` event with a sequence number. Presence and usage are `ephemeral` to avoid state confusion and minimize storage.
- **Monotonic ordering at the user level.** `UpdatePayload.seq` is a single per-user counter. This makes client reconciliation simple: apply updates in order and you are consistent for that user.
- **Optimistic concurrency by default.** Versioned fields (metadata, agent state, daemon state, KV) require `expectedVersion`. This prevents silent overwrites and keeps conflict resolution client-driven.
- **Client-side encryption boundaries.** The server never needs to understand plaintext. The protocol therefore treats most payloads as opaque strings or base64 blobs, which keeps server logic simple and privacy guarantees strong.
- **Backward compatibility over breaking changes.** New routes/events are added rather than mutating existing shapes in incompatible ways.
- **Avoid full REST verbs.** Reads are primarily `GET`, while writes/actions are primarily `POST`, with `DELETE` used when the intent is unambiguous. We avoid the full REST palette because many mutations are not cleanly tied to a single entity or involve more than CRUD logic. Keeping to `GET` + `POST` (plus occasional `DELETE`) makes the client simpler and the protocol clearer.

If a new protocol field or event is proposed, it should answer: does this create a durable sync primitive, or can it be encoded inside existing encrypted payloads without expanding the API surface?

## Authentication
API endpoints (`/v1/*`, `/v2/*`) require `Authorization: Bearer <token>`. The same token is also used in the Socket.IO handshake. Static file routes (web app assets) and `/health` do not require authentication.

## QR code and web app serving
The daemon displays a QR code in the terminal that encodes a URL:
```
http://<LAN_IP>:<PORT>/terminal/connect#<base64(JSON)>                  (LAN)
https://<subdomain>.trycloudflare.com/terminal/connect#<base64(JSON)>   (tunnel)
```
The hash fragment is a base64-encoded compact JSON `{k: <shared secret>, v: <version>}` — host/port are derived from the URL itself, keeping the QR ~30-40% smaller. Any phone camera can scan this QR — it opens the browser, which loads the web app from the daemon itself (served via `@fastify/static`). The web app reads the hash, derives the bearer token, and connects.

## WebSocket connection
### Handshake
Connect with Socket.IO using:

```
path: "/v1/updates"
auth: {
  token: "<bearer token>",
  clientType: "user-scoped" | "session-scoped" | "machine-scoped",
  sessionId?: "<session id>",
  machineId?: "<machine id>"
}
```

Rules enforced server-side:
- `token` is required.
- `session-scoped` requires `sessionId`.
- `machine-scoped` requires `machineId`.

### Connection types
- `user-scoped`: receives account-wide updates.
- `session-scoped`: receives updates for a specific session only.
- `machine-scoped`: used by daemons; receives machine updates and emits machine state.

### Server -> client events
The server emits two event types:

#### `update`
Persistent sync events. Payload shape:
```
{
  id: string,
  seq: number,
  body: { t: string, ... },
  createdAt: number
}
```

#### `ephemeral`
Transient presence/usage events. Payload shape:
```
{
  type: string,
  ...
}
```

### Update event types
Field names below match on-wire payloads.

- `new-session`
  - `body`: `{ t: "new-session", id, seq, metadata, metadataVersion, agentState, agentStateVersion, dataEncryptionKey, active, activeAt, createdAt, updatedAt }`

- `update-session`
  - `body`: `{ t: "update-session", id, metadata?, agentState? }`
  - `metadata`: `{ value, version }` or null
  - `agentState`: `{ value, version }` or null

- `delete-session`
  - `body`: `{ t: "delete-session", sid }`

- `new-message`
  - `body`: `{ t: "new-message", sid, message: { id, seq, content, localId, createdAt, updatedAt } }`

- `new-machine`
  - `body`: `{ t: "new-machine", machineId, seq, metadata, metadataVersion, daemonState, daemonStateVersion, dataEncryptionKey, active, activeAt, createdAt, updatedAt }`

- `update-machine`
  - `body`: `{ t: "update-machine", machineId, metadata?, daemonState?, activeAt? }`

### Ephemeral event types
- `activity`: `{ type: "activity", id: sessionId, active, activeAt, thinking }`
- `machine-activity`: `{ type: "machine-activity", id: machineId, active, activeAt }`
- `usage`: `{ type: "usage", id: sessionId, key, tokens, cost, timestamp }`

### Client -> server WebSocket events
- `ping` -> callback `{}`

- `update-metadata`
  - `{ sid, metadata, expectedVersion }`
  - Response: `{ result: "success", version, metadata }` or `{ result: "version-mismatch", version, metadata }`

- `update-state`
  - `{ sid, agentState, expectedVersion }`
  - Response: `{ result: "success", version, agentState }` or `{ result: "version-mismatch", version, agentState }`

- `message`
  - `{ sid, message, localId? }`
  - Creates a new session message (encrypted payload) and emits `new-message` update to other connections.

- `session-alive`
  - `{ sid, time, thinking?, mode? }`
  - Emits `ephemeral` activity to user-scoped connections.

- `session-end`
  - `{ sid, time }`
  - Marks session inactive and emits `ephemeral` activity.

- `usage-report`
  - `{ key, sessionId?, tokens, cost }`
  - Stores usage report and optionally emits `ephemeral` usage for the session.

- `machine-alive`
  - `{ machineId, time }`
  - Emits `ephemeral` machine-activity.

- `machine-update-metadata`
  - `{ machineId, metadata, expectedVersion }`
  - Response: `{ result: "success", version, metadata }` or `{ result: "version-mismatch", version, metadata }`

- `machine-update-state`
  - `{ machineId, daemonState, expectedVersion }`
  - Response: `{ result: "success", version, daemonState }` or `{ result: "version-mismatch", version, daemonState }`

- `rpc-register`
  - `{ method }` -> server emits `rpc-registered`

- `rpc-unregister`
  - `{ method }` -> server emits `rpc-unregistered`

- `rpc-call`
  - `{ method, params }` -> callback `{ ok, result? | error? }`
  - Server forwards to the registered socket via `rpc-request` (ack-based).

## HTTP endpoints by area

| Area | Endpoint | Description |
|------|----------|-------------|
| Health | `GET /health` | Liveness probe (no auth) |
| Account | `GET /v1/account/settings`, `GET /v1/account/profile`, `POST /v1/account/settings` | Account stubs for client compatibility |
| KV | `GET /v1/kv`, `GET /v1/kv/:key`, `POST /v1/kv/bulk`, `POST /v1/kv` | Encrypted key-value store (mutate with `version` for optimistic concurrency) |
| Voice (STT) | `GET /v1/whisper/status`, `POST /v1/voice/transcribe` | Local Whisper transcription |
| Voice (TTS) | `GET /v1/tts/status`, `POST /v1/voice/synthesize` | TTS status + synthesis: `{ text, voice?, lang? }` → `audio/ogg` (OGG Opus) |
| Concierge | `GET /v1/concierge/status`, `POST /v1/concierge/chat` | Optional local LLM assistant (LM Studio); chat body: `{ messages: [{ role, content }] }` → `{ reply, actions }` |
| Sessions | `GET /v1/sessions`, `GET /v2/sessions`, `GET /v2/sessions/active`, `POST /v1/sessions`, `GET /v1/sessions/:sessionId/messages`, `DELETE /v1/sessions/:sessionId` | Session CRUD + message history |
| Machines | `POST /v1/machines`, `GET /v1/machines`, `GET /v1/machines/:id` | Machine registration and listing |

## Sequencing and concurrency
- `UpdatePayload.seq` is the per-user update sequence (monotonic) used for sync ordering.
- Sessions and machines have their own `seq` fields used by clients for ordering.
- Versioned fields (metadata, agentState, daemonState, KV) use optimistic concurrency with `expectedVersion` and return a version-mismatch response containing the current version/data.

## Implementation references
- API routes: `packages/remcli-cli/src/daemon/p2p/p2pRestRoutes.ts`
- Socket handlers: `packages/remcli-cli/src/daemon/p2p/p2pSocketHandlers.ts`
- Event routing: `packages/remcli-cli/src/daemon/p2p/p2pEventRouter.ts`
