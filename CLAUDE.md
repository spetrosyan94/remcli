# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Remcli?

Remcli is a mobile and web client for Claude Code & Codex that enables end-to-end encrypted remote control from anywhere. Users run `remcli` instead of `claude` (or `remcli codex` instead of `codex`). The CLI wraps AI sessions, a persistent daemon acts as a local P2P server, and mobile/web clients connect directly via WebSocket (LAN or ngrok tunnel) for real-time control. No cloud server is required — the daemon IS the server.

## Monorepo Structure

npm workspaces with two packages:

- **remcli-app** (`packages/remcli-app`) - React Native + Expo mobile/web client
- **remcli-cli** (`packages/remcli-cli`, published as `remcli`) - CLI wrapper for Claude Code/Codex

Each package has its own `CLAUDE.md` with detailed package-specific guidance. The daemon subsystem has additional docs at `packages/remcli-cli/src/daemon/CLAUDE.md`.

## Commands

### Prerequisites
- **Node.js** (v20+)
- **tmux** — required for daemon session spawning (`brew install tmux` on macOS)

### Install
```bash
npm install
```

### remcli-app
```bash
npm -w remcli-app run start        # Expo dev server
npm -w remcli-app run ios          # iOS simulator
npm -w remcli-app run android      # Android emulator
npm -w remcli-app run web          # Web browser
npm -w remcli-app run typecheck    # TypeScript check (runs in CI)
npm -w remcli-app run test         # Vitest
```

### remcli-cli
```bash
npm -w remcli run build            # TypeScript + pkgroll build
npm -w remcli run test             # Build then Vitest
npm -w remcli run dev              # Run with TSX (no build)
```

## Architecture

### P2P Direct Data Flow
```
Mobile/Web App  <-- WS (LAN / ngrok tunnel) -->  CLI Daemon (Fastify + Socket.IO + in-memory store)  <->  Claude Code/Codex SDK
```

The daemon runs a Fastify HTTP server with Socket.IO on `0.0.0.0` — it IS the server. No cloud dependency.

### Authentication (P2P)
QR code-based. The daemon generates a random 32-byte shared secret, displays a QR code in the terminal. The mobile app scans the QR, decodes the shared secret, and derives a Bearer token via `HMAC-SHA256(sharedSecret, "p2p-auth")`. Both sides compute the same token independently.

QR payload format: `{"mode":"p2p","host":"192.168.1.x","port":12345,"key":"<base64>","v":1}`

With `--tunnel` flag, ngrok provides a public URL replacing the LAN IP (port=0 signals tunnel mode).

### End-to-End Encryption
All payloads encrypted client-side. Two schemes:
- **Legacy**: XSalsa20-Poly1305 (TweetNaCl)
- **DataKey**: AES-256-GCM per-session/machine

### Daemon Model
The CLI runs a persistent background daemon (`remcli daemon start`) that:
- Acquires an exclusive lock file to prevent duplicates
- Exposes a local-only HTTP control server on `127.0.0.1` (`/list`, `/stop`, `/spawn-session`)
- Runs a P2P server (Fastify + Socket.IO) on `0.0.0.0` for mobile app connections
- Stores sessions/messages in `~/.remcli/p2p-store.json` (in-memory with JSON persistence)
- Optionally starts an ngrok tunnel (`--tunnel` flag) for remote access
- Auto-updates when it detects a CLI version change (via heartbeat loop)

### P2P Server Protocol
Socket.IO protocol served locally:
- **Update events** (persistent, seq-numbered): `new-session`, `update-session`, `new-message`, `new-machine`, etc.
- **Ephemeral events** (transient): `session-alive`, `machine-alive`
- **REST API**: `/v1/sessions`, `/v1/machines`, `/v2/sessions/active` etc.
- Optimistic concurrency control via `expectedVersion` on state updates
- RPC forwarding for remote session control

### Session Lifecycle
Sessions can be started from terminal (`remcli`) or spawned remotely by the daemon via mobile RPC. The device-switching model: when the user takes control from mobile, the session restarts in remote mode; pressing any key on the keyboard switches back.

## Code Style (All Packages)

- **4-space indentation** everywhere
- **Strict TypeScript** — no `any`, no untyped code
- **Functional over OOP** — avoid classes where possible
- **Absolute imports** with `@/` alias (maps to `./sources/` in app, `./src/` in CLI)
- **npm** for package management (never yarn)
- **All imports at the top of the file** — never import mid-code
- Prefer `interface` over `type`, avoid enums (use maps)
- Descriptive names with auxiliary verbs: `isLoading`, `hasError`
- No backward compatibility hacks unless explicitly requested
- **Always respond in Russian** — all communication with the user must be in Russian

## Testing

- **Vitest** for all packages
- CLI tests: colocated `.test.ts` files, no mocking, real API calls
- App tests: Vitest

## CI

- **typecheck.yml** — Runs `npm -w remcli-app run typecheck` on PRs/pushes to main
- **cli-smoke-test.yml** — Builds CLI, installs globally, runs `remcli --help/--version/doctor/daemon status` on Linux and Windows (Node 20 & 24)
