# Codex / ChatGPT Architecture

## Official Sources

- Codex app-server: https://developers.openai.com/codex/app-server
- Codex CLI features: https://developers.openai.com/codex/cli/features
- Codex CLI reference: https://developers.openai.com/codex/cli/reference
- Codex SDK resume/thread model: https://developers.openai.com/codex/sdk
- Codex remote connections: https://developers.openai.com/codex/remote-connections
- Codex MCP: https://developers.openai.com/codex/mcp

Проверено: 2026-07-06 через `openai-docs`, official OpenAI docs и локальный
`codex --help`.

## Goal

Remcli должен работать как remote control для настоящего Codex thread, а не как
отдельный MCP-wrapper с потерей контекста. Телефон отправляет сообщения в тот же
Codex thread id, который можно продолжать официальным Codex app-server/CLI
механизмом.

## Runtime

```text
Web/PWA phone
    -> Remcli P2P encrypted channel
        -> local daemon
            -> shared Codex app-server on 127.0.0.1
                -> Codex thread / turns / approvals
```

Daemon стартует shared host:

```text
codex app-server --listen ws://127.0.0.1:<port>
```

Endpoint хранится в `daemon.state.json` как:

- `codexAppServerEndpoint`
- `codexAppServerPid`

Endpoint loopback-only. Телефон не подключается к Codex app-server напрямую; он
всегда ходит через Remcli P2P и daemon/session process.

## Session Identity

- Remcli session id: wrapper-сессия в Remcli/P2P.
- Native Codex id: official Codex `threadId`.
- Metadata keys: `agentSessionId` и `codexSessionId`.
- Duplicate guard должен дедуплицировать wrapper-сессии по native Codex thread id.

## Message Flow

Create:

```text
runCodex -> app-server initialize -> thread/start -> turn/start(prompt)
```

Resume:

```text
runCodex --resume <threadId> -> app-server initialize -> thread/resume -> turn/start(prompt)
```

Continue:

```text
existing threadId -> turn/start(prompt)
```

Steer active turn:

```text
in-flight turnId + same mode/model hash -> turn/steer(expectedTurnId, prompt)
```

Mode/model changes не создают новый Codex thread. Sandbox/model передаются как
per-turn параметры app-server. Если новый prompt пришёл во время активного turn,
но пользователь сменил model или sandbox mode, Remcli ждёт завершения текущего
turn и отправляет prompt следующим `turn/start`, чтобы не смешивать per-turn
настройки.

## Transport Contract

Remcli uses official app-server JSON-RPC methods:

- `initialize`, then `initialized`
- `thread/start`
- `thread/resume`
- `turn/start`
- `turn/steer`
- `turn/interrupt`

Notifications mapped into Remcli session events:

- `turn/started` -> task started
- `item/completed` with `agentMessage` -> chat message
- `item/completed` with `reasoning` -> reasoning summary
- `item/completed` with `commandExecution` -> command result
- `turn/diff/updated` -> diff event
- `turn/completed` -> task complete
- `error` -> visible chat error

Codex MCP `codex-reply` is not used for chat/resume transport.

## Runtime Resilience

Remcli must not trust a stale `daemon.state.json` endpoint blindly.

- `runCodex.ts` uses shared WebSocket app-server only when the saved PID is live
  and `/readyz` succeeds.
- If the shared endpoint is stale, `runCodex.ts` starts a private local
  `codex app-server` over stdio. This is still app-server transport, not MCP.
- The daemon heartbeat removes stale `codexAppServerEndpoint` and
  `codexAppServerPid` from `daemon.state.json`.

## Permissions

Codex exposes native sandbox values:

- `read-only`
- `workspace-write`
- `danger-full-access`

Remcli maps these to app-server sandbox policies:

- `read-only` -> `readOnly`, no network
- `workspace-write` -> `workspaceWrite`, no network
- `danger-full-access` -> `dangerFullAccess`

Approval policy:

- `read-only`, `workspace-write` -> `on-request`
- `danger-full-access` -> `never`

## Terminal / TUI Parity

Official CLI supports remote TUI connection:

```text
codex --remote ws://127.0.0.1:<port>
codex resume <threadId> --remote ws://127.0.0.1:<port>
```

This makes the target architecture possible: phone and desktop terminal can use
one app-server-owned Codex thread model.

For daemon-started Codex sessions, Remcli runs its P2P wrapper process headless
inside tmux and opens a real Codex TUI separately through the shared app-server:

- saved/resumed thread: opens immediately with
  `codex resume <threadId> --remote <endpoint>`;
- new thread: opens after the first phone prompt creates a native Codex
  `threadId`, then uses the same `codex resume <threadId> --remote <endpoint>`;
- terminal-started `remcli codex` does not open another Terminal.app window.

If the shared daemon endpoint is stale and `runCodex.ts` falls back to a private
stdio app-server, remote TUI attach is skipped because there is no WebSocket
endpoint for `codex --remote`.

## Not Implemented Yet

- Full terminal/TUI mirroring inside web.
- Cross-process locking around two simultaneous writers to the same Codex
  thread beyond current Remcli duplicate guard.

## Verification

Required gates for this architecture:

- Unit: app-server WebSocket client sends JSON-RPC over shared endpoint.
- Unit: `turn/steer` sends `threadId`, `expectedTurnId` and text input to the
  active turn.
- Unit: daemon-spawned Codex no longer opens a tmux attach terminal; `runCodex`
  opens a real Codex TUI through `codex resume <threadId> --remote <endpoint>`
  only for daemon-started shared app-server sessions.
- Unit: daemon host starts `codex app-server --listen ws://127.0.0.1:<port>` and
  waits for `/readyz`.
- CLI: `npm -w remcli run typecheck`, `npm -w remcli run build`,
  `npm -w remcli run test`.
- Real AI opt-in: create -> prompt -> stop -> reopen/resume -> context check.
  The default Remcli-created Codex model is `gpt-5.4-mini`. Override with
  `REMCLI_REAL_CODEX_MODEL` when a specific Remcli session model must be tested.
