# Архитектура Codex / ChatGPT

## Источники

- Codex app-server: https://developers.openai.com/codex/app-server
- Codex CLI features: https://developers.openai.com/codex/cli/features
- Codex CLI reference: https://developers.openai.com/codex/cli/reference
- Codex SDK resume/thread model: https://developers.openai.com/codex/sdk
- Codex remote connections: https://developers.openai.com/codex/remote-connections
- Codex MCP: https://developers.openai.com/codex/mcp

Проверено 2026-07-17 через official OpenAI docs, локальные `codex --help`,
`codex app-server --help` и `codex-cli 0.144.5`.

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

Attach существующей сессии:

```text
runCodex --resume <threadId> -> app-server initialize -> thread/resume -> shared remote TUI
```

Для daemon-owned resume это attach-only путь: `thread/resume` восстанавливает
тот же native thread и открывает один managed TUI, но не создаёт `turn/start` и
не добавляет фиктивный prompt. Первый реальный prompt с телефона или терминала
создаёт следующий turn.

Продолжение после attach:

```text
idle threadId -> turn/start(prompt)
active threadId -> turn/steer(expectedTurnId, prompt)
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
как параметры конкретного turn. Выбранная до первого открытия TUI model также
передаётся в команду managed remote TUI. Уже открытый TUI не перезапускается при
поздней смене model. Если настройки изменились во время активного turn, новый
prompt ждёт следующего `turn/start`.

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
- `turn/completed(completed)` текущего active turn -> task complete;
- `turn/completed(interrupted)` текущего active turn -> turn aborted;
- `turn/completed(failed)` текущего active turn -> видимая ошибка;
- stale completion не меняет состояние чата;
- `error` -> видимая ошибка чата.

Ошибки Codex app-server проходят через redaction boundary до публикации в
зашифрованную историю: `runCodex` записывает в chat error event только
redacted text. `metadata.executionOutcome` при этом содержит только
`{ kind: "error" | "success", occurredAt }`, без текста ошибки, stack trace или
provider payload. Непустой live `agent_message` может записать `success`
watermark; summary, history replay, reasoning и status events его не записывают.
Полные правила watermark и UI-приоритета описаны в [протоколе](../protocol.md).

`codex mcp-server` и `codex-reply` для chat/resume transport не используются.
`remcli-mcp` остаётся отдельным bridge для инструментов Remcli.

### Доставка и восстановление

- `thread/start` неидемпотентен: Remcli принимает native id только из JSON-RPC
  response. `thread/started` не содержит correlation id и не используется как
  receipt. Потерянный или неполный response становится
  `CODEX_THREAD_START_AMBIGUOUS`: runner не делает retry/reattach и не
  привязывается к потенциально чужому thread.
- Каждый phone prompt получает стабильный `clientUserMessageId` из P2P delivery
  id. Перед повторной отправкой Remcli читает thread и, если Codex уже принял
  этот id, продолжает существующий turn вместо создания второго prompt.
- P2P ACK/high-water продвигается только после принятия prompt app-server. Для
  recoverable `-32001` или transport отказа runner повторяет ту же delivery
  ограниченное число раз с тем же `clientUserMessageId`; окончательный отказ
  остаётся видимой ошибкой чата.
- При потере WebSocket во время active turn клиент reconnect-ится, читает
  thread, выполняет `thread/resume` для running turn и сохраняет исходный
  completion waiter. Исторические non-user items публикуются с bounded dedupe
  по native `item.id`.
- Если terminal успел завершить T1 и открыть T2 до `turn/steer`, Remcli
  reattach-ится к T2 до ожидания idle. Abort ожидания не прерывает external
  successor turn.
- Успешный ответ на `turn/interrupt` только подтверждает принятие запроса.
  Phone delivery ждёт точный `threadId + turnId + turn/completed(interrupted)`
  до `turn/start` или `turn/steer`; delivery не ACK-ится в отменяемый turn.
  Foreign, stale, `completed` и `failed` barrier не открывают. Rejected request
  или settle-timeout остаётся видимой fail-closed ошибкой до точного позднего
  `interrupted` либо reconnect. Recovery snapshot открывает barrier только для
  того же текущего `threadId + turnId + interrupted`; stale predecessor остаётся
  заблокированным. Interrupted turn публикуется как
  `turn_aborted`, не как успешный `task_complete`.
- Диагностика app-server проходит redaction до логов и chat event: в том числе
  enumerable поля `Error` и ключи заголовков/JSON с `_`.

## Устойчивость runtime

Нельзя без проверки доверять endpoint из `daemon.state.json`.

- Shared WebSocket app-server используется только если сохранённый PID жив и
  `/readyz` отвечает успешно.
- При stale shared endpoint `runCodex.ts` запускает private local app-server по
  stdio. Это всё ещё app-server transport, не MCP.
- При transient ошибке первоначального подключения или attach `thread/resume`
  к уже проверенному shared endpoint `runCodex.ts` отключает этот client и один
  раз переключается на private app-server по stdio. Private fallback сохраняет
  native context, но remote TUI не открывается, потому что WebSocket endpoint
  отсутствует. Если private attach тоже не проходит, P2P-чат получает typed
  session error; silent fresh thread не создаётся.
- Heartbeat удаляет stale `codexAppServerEndpoint` и `codexAppServerPid` из
  `daemon.state.json`.

## Resume picker

`list-agent-sessions` читает bounded prefix существующей Codex JSONL history
только во время RPC, чтобы извлечь first user message для picker-а. Remcli не
создаёт второй persistent title/preview cache и не меняет provider-native
activity. Web использует такой текст только если это не opaque UUID; иначе
показывает нейтральный `Codex session · project · activity`, а короткий native
thread ID оставляет вторичным. Child threads продолжают исключаться по native
metadata до выдачи списка.

## Permissions

Native Codex sandbox values:

- `read-only` -> `readOnly`, без network;
- `workspace-write` -> `workspaceWrite`, без network;
- `danger-full-access` -> `dangerFullAccess`.

Approval policy:

- `read-only`, `workspace-write` -> `on-request`;
- `danger-full-access` -> `never`.

## Provider capability catalog

New Session не содержит локального allowlist моделей или reasoning Codex.
Daemon читает account-visible picker catalog из shared app-server через
пагинированный `model/list` и ограничения sandbox через
`configRequirements/read`. В web передаётся только typed snapshot:

- models: `id`, display name, provider default и supported reasoning efforts;
- допустимые native sandbox values;
- `catalogVersion`, timestamps freshness и безопасный state `unavailable`.

Сохраняется каждое provider-advertised значение модели и reasoning, включая
`max` и `ultra`, если их вернул provider. Модель без
`supportedReasoningEfforts` остаётся selectable: UI отключает только её control
reasoning, а native turn/TUI не передаёт effort override.

Web отправляет `codexExecution { model, reasoningEffort?, catalogVersion }`
вместе с выбранным `permissionMode` в `spawn-remcli-session`. Daemon валидирует
эту атомарную пару по текущему snapshot до spawn runner. Runner повторно читает
и валидирует тот же selection на app-server transport, который примет первый
native turn, включая shared-to-private fallback. Stale catalog, unsupported
model/effort или permission отклоняются до `thread/start`, `thread/resume` и
`turn/start`.

RPC принимает только own plain object с `model`, `catalogVersion` и необязательным
`reasoningEffort`; extra fields, accessors, массивы и prototype-pollution payload
отклоняются до capability validator и spawn. При typed rejection `expired`,
`unsupported_selection` или `policy_denied` web сохраняет видимую ошибку,
очищает selection и принудительно обновляет catalog; до новой валидной пары
Start и Resume заблокированы.

Проверки разделены по уровню: deterministic capability tests и encrypted
machine-RPC integration используют fake app-server client и mocked spawn
boundary; это не real-provider gate. Реальный `thread/start + turn/start` gate
запускается только opt-in с действующими credentials, не в обычном CI.

Переключения model, reasoning и permission внутри открытого чата пока нет.
Raw per-message metadata намеренно игнорируется daemon-created Codex session и
не может обойти этот contract.

## Terminal / TUI parity

Официальный CLI поддерживает remote TUI:

```text
codex -c 'model_reasoning_effort="xhigh"' [--model <selected-model>] --remote ws://127.0.0.1:<port>
codex -c 'model_reasoning_effort="xhigh"' [--model <selected-model>] resume <threadId> --remote ws://127.0.0.1:<port>
```

### Daemon-owned tmux lifecycle

Daemon-spawned Codex runner остаётся headless в tmux. После успешной привязки
native `threadId` Remcli открывает TUI через
`codex -c 'model_reasoning_effort="<effective-effort>"' --model <selected-model> resume <threadId> --remote <endpoint>`.
Выбранные provider model и effort идут одинаково в phone turn и TUI command.
Если model не выбрана явно, `--model` не передаётся; если provider не выдал
reasoning choices для выбранной модели, `-c model_reasoning_effort=...` также
не передаётся. Это не изменяет `~/.codex/config.toml`.

Если daemon получает resume без первого P2P prompt, он сначала делает
attach-only `thread/resume`, а затем открывает этот TUI. Это устраняет ожидание
первого сообщения с телефона и не создаёт лишний turn.

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
- Unit: `turn/interrupt` не разблокирует delivery до точного matching
  `turn/completed(interrupted)`; rejected request и settle-timeout fail closed.
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
- Unit: active WebSocket loss reattach-ит turn без повторной публикации item;
  T1→T2 steer race подключает successor; transient overload повторяет одну P2P
  delivery без нового native prompt.
- Unit: daemon запускает `codex app-server --listen ws://127.0.0.1:<port>` и ждёт
  `/readyz`.
- Unit: paginated `model/list` сохраняет все provider values, модель без
  reasoning selector не скрывается, stale/forged selection и raw per-message
  override fail closed.
- Unit/integration: spawn передаёт atomic `codexExecution` через daemon и
  повторно валидируется runner до первого native turn.
- CLI: `npm -w remcli run typecheck`, `npm -w remcli run build`,
  `npm -w remcli run test`.
- Real AI opt-in: create -> prompt -> stop -> reopen/resume -> context check.
  Default Remcli-created Codex gate — `GPT-5.6-Luna` (`gpt-5.6-luna`) с
  reasoning `xhigh`; override только через `REMCLI_REAL_CODEX_MODEL` и
  `REMCLI_REAL_CODEX_REASONING_EFFORT`.
