# Архитектура Codex / ChatGPT

## Источники

- Codex app-server: https://developers.openai.com/codex/app-server
- Codex CLI features: https://developers.openai.com/codex/cli/features
- Codex CLI reference: https://developers.openai.com/codex/cli/reference
- Codex SDK resume/thread model: https://developers.openai.com/codex/sdk
- Codex remote connections: https://developers.openai.com/codex/remote-connections
- Codex MCP: https://developers.openai.com/codex/mcp

Проверено 2026-07-13 через official OpenAI docs, локальный `codex --help` и `codex app-server` 0.144.1 `model/list`.

## Цель

Remcli управляет настоящим Codex thread, а не отдельной MCP-сессией. Телефон,
Codex TUI и daemon используют один native `threadId`, который продолжается через
официальный app-server.

## Runtime

```text
Web/PWA phone
    -> Remcli P2P encrypted channel
        -> local daemon
            -> shared Codex app-server on 127.0.0.1
                -> Codex thread / turns / approvals
```

Daemon запускает:

```text
codex app-server --listen ws://127.0.0.1:<port>
```

В `daemon.state.json` сохраняются `codexAppServerEndpoint` и
`codexAppServerPid`. Endpoint доступен только через loopback: телефон не
подключается к app-server напрямую, а использует Remcli P2P и daemon.

## Идентичность сессии

- Remcli session id — wrapper-сессия в Remcli/P2P.
- Native Codex id — официальный `threadId`.
- Metadata keys — `agentSessionId` и `codexSessionId`.
- Дубликаты wrapper-сессий нужно определять по native Codex `threadId`.

## Поток сообщений

Создание:

```text
runCodex -> app-server initialize -> thread/start -> turn/start(prompt)
```

Resume:

```text
runCodex --resume <threadId> -> app-server initialize -> thread/resume -> turn/start(prompt)
```

Продолжение:

```text
existing threadId -> turn/start(prompt)
```

Ввод из native terminal не превращается в дополнительный `turn/start`. Shared
app-server публикует его как `userMessage`; `CodexAppServerClient` связывает
сообщения Remcli по `clientUserMessageId` и один раз публикует внешние сообщения
в зашифрованную P2P-историю. Поэтому телефон, `codex --remote` TUI и тот же
native thread видят одну последовательность сообщений.

Для активного turn:

```text
in-flight turnId + same mode/model hash -> turn/steer(expectedTurnId, prompt)
```

Изменение mode/model не создаёт новый Codex thread. Sandbox и model передаются
как параметры конкретного turn. Если настройки изменились во время активного
turn, новый prompt ждёт следующего `turn/start`.

## Transport contract

Используются официальные JSON-RPC методы app-server:

- `initialize`, затем `initialized`;
- `thread/start`;
- `thread/resume`;
- `turn/start`;
- `turn/steer`;
- `turn/interrupt`.

Уведомления преобразуются в события Remcli:

- `turn/started` -> task started;
- `item/completed` с `agentMessage` -> chat message;
- `item/completed` с `reasoning` -> reasoning summary;
- `item/completed` с `commandExecution` -> command result;
- `turn/diff/updated` -> diff event;
- `turn/completed` -> task complete;
- `error` -> видимая ошибка чата.

`codex-reply` для chat/resume transport не используется. `remcli-mcp` остаётся
отдельным bridge для инструментов Remcli.

## Устойчивость runtime

Нельзя без проверки доверять endpoint из `daemon.state.json`.

- Shared WebSocket app-server используется только если сохранённый PID жив и
  `/readyz` отвечает успешно.
- При stale shared endpoint `runCodex.ts` запускает private local app-server по
  stdio. Это всё ещё app-server transport, не MCP.
- Heartbeat удаляет stale `codexAppServerEndpoint` и `codexAppServerPid` из
  `daemon.state.json`.

## Permissions

Native Codex sandbox values:

- `read-only` -> `readOnly`, без network;
- `workspace-write` -> `workspaceWrite`, без network;
- `danger-full-access` -> `dangerFullAccess`.

Approval policy:

- `read-only`, `workspace-write` -> `on-request`;
- `danger-full-access` -> `never`.

## Terminal / TUI parity

Официальный CLI поддерживает remote TUI:

```text
codex --remote ws://127.0.0.1:<port>
codex resume <threadId> --remote ws://127.0.0.1:<port>
```

### Daemon-owned tmux lifecycle

Daemon-spawned Codex runner остаётся headless в tmux. После успешной привязки
native `threadId` Remcli открывает TUI через
`codex resume <threadId> --remote <endpoint>`.

- Одна native Codex thread имеет одну активную Remcli wrapper-сессию: повторный
  resume возвращает существующую wrapper-сессию.
- Host создаётся в уникальной tmux session с постоянным для lifecycle UUID
  owner marker. Terminal открывает только attach к этому owned pane.
- Runner и child TUI получают полный immutable ownership tuple:
  `sessionName`, `@window`, `%pane`, `panePid`, `ownerMarker`.
- Display name окна не является идентификатором: tmux допускает дубли. Новое
  окно резервирует collision-resistant numeric index и использует
  `=sessionName:<index>` для create, marker и tuple output.
- Child TUI создаётся только в server-side `if-shell -F` ветке, которая
  одновременно проверяет полный tuple и marker host pane. Ложная ветка не
  создаёт окно.
- Marker ставится в той же tmux command chain, что и создание pane. При потере
  или порче ответа daemon ищет ровно один pane по `sessionName + ownerMarker`;
  ноль, несколько или foreign match приводят к fail-closed ошибке без cleanup.
- Stop, prune и shutdown освобождают pane только server-side проверкой marker и
  полного tuple вместе с `kill-pane`. `mismatch` и `unknown` сохраняют tracking
  для повторной попытки и не считаются успешным cleanup.
- Stop ожидает in-flight открытие child TUI; поздно созданный pane либо
  подтверждённо освобождается, либо сохраняется для retry.
- Terminal-started `remcli codex` не получает managed tmux target. При private
  stdio app-server remote TUI не открывается, потому что нет WebSocket endpoint.

Terminal.app tab не является управляемым lease: AppleScript умеет создать tab,
но не предоставляет подтверждённого точечного закрытия tab. Поэтому нельзя
закрывать `front window` или целое пользовательское окно.

### Runner capability

Daemon-spawned runner получает случайный per-process control token через
`REMCLI_DAEMON_RUNNER_TOKEN` и передаёт его в `/session-started`. После успешной
проверки daemon выдаёт per-runner credential; native thread binding и managed TUI
route требуют этот credential. Manual terminal session не получает capability и
не должна перепривязывать daemon-owned wrapper.

Credential привязан к daemon-spawned runner и отзывается до публикации terminal
inactive state. Повторный или чужой exchange не выдаёт capability и не может
привязать native thread или открыть managed TUI.

Общий bootstrap для daemon-runner'ов Claude, Codex, Gemini и Cursor сначала
получает этот credential через `/session-started`, а только затем создаёт
P2P session consumer. Повторный authenticated handoff того же owner возвращает
тот же lease после потери HTTP-ответа; другой owner его не получает. После
активации lease daemon отключает legacy consumer и отклоняет credential-less
подключение к этой session, поэтому первый mobile prompt нельзя подтвердить
или потерять через downgrade.

## Не реализовано

- Полное отображение терминала/TUI внутри web.
- Межпроцессная блокировка двух одновременных writers одного Codex thread сверх
  текущего duplicate guard.
- Полная матрица tmux версий: real ownership regression сейчас выполняется на
  локальном tmux 3.6a.

## Обязательные gates

- Unit: app-server client отправляет JSON-RPC через shared endpoint.
- Unit: `turn/steer` отправляет `threadId`, `expectedTurnId` и текст активному
  turn.
- Unit: daemon-spawned runner не открывает attach-terminal; TUI использует
  `codex resume <threadId> --remote <endpoint>` только для shared endpoint.
- Security: неизвестный runner token, повторный token exchange, отсутствующий
  или чужой runner credential не могут менять tracking, bind native thread или
  создавать TUI.
- Integration: daemon-owned Codex resume получает credential через тот же
  `/session-started` contract до создания session consumer и сохраняет native
  thread context; failed handoff не превращается в legacy consumer.
- Unit/integration: native thread dedupe, runner capability, stale/response-loss
  recovery, duplicate display names, occupied numeric index, exact cleanup при
  stop, prune и shutdown. Real tmux regression использует isolated socket.
- Unit: daemon запускает `codex app-server --listen ws://127.0.0.1:<port>` и ждёт
  `/readyz`.
- CLI: `npm -w remcli run typecheck`, `npm -w remcli run build`,
  `npm -w remcli run test`.
- Real AI opt-in: create -> prompt -> stop -> reopen/resume -> context check.
  Default Remcli-created Codex gate — `GPT-5.6-Luna` (`gpt-5.6-luna`) с
  reasoning `xhigh`; override только через `REMCLI_REAL_CODEX_MODEL` и
  `REMCLI_REAL_CODEX_REASONING_EFFORT`.
