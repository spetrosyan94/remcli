# Remcli Docs

Internal documentation for Remcli — protocol, encryption, and CLI architecture.

## Index

| Document | Description |
|----------|-------------|
| [protocol.md](protocol.md) | Wire protocol (WebSocket/HTTP), payload formats, sequencing, concurrency |
| [encryption.md](encryption.md) | Encryption schemes, binary layouts, key wrapping, on-wire encoding |
| [cli-architecture.md](cli-architecture.md) | CLI entry flow, daemon lifecycle, session management, RPC |

## Conventions

- Paths and field names reflect the current implementation in `packages/remcli-cli`.
- The daemon runs a built-in P2P server (Fastify + Socket.IO) — no separate server package.
- The daemon also serves the web app build (`packages/remcli-app/dist/`) as static files via `@fastify/static`, with SPA fallback for client-side routing.
- Examples are illustrative; the canonical source is the code.
