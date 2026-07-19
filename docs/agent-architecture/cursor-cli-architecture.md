# Cursor CLI в Remcli

## Источники

- Official docs: https://cursor.com/docs/cli/headless и https://cursor.com/docs/cli/reference/parameters
- Local CLI: `agent --help`, `agent models`, `agent 2026.07.16-899851b`
- Context7: anonymous quota исчерпана; не заменять official docs устаревшими заметками.
- Проверено: 2026-07-19.

## Назначение

Remcli удалённо запускает и возобновляет Cursor Agent CLI в выбранной рабочей
директории. Телефон отправляет prompt в daemon; daemon-owned wrapper исполняет
один headless Cursor turn и возвращает канонический terminal result в P2P-чат.
Это не MCP transport и не эмуляция Cursor IDE.

## Владение runtime

```text
Web/PWA -> P2P daemon -> daemon-owned tmux wrapper -> agent --print -> Cursor
                              ^                         |
                              +------- stream-json ------+
```

- Daemon создаёт wrapper в принадлежащем ему tmux pane.
- Wrapper (`runCursor.ts`) владеет очередью remote prompts и дочерним
  `agent --print --output-format stream-json` процессом каждого turn.
- Нативный Cursor CLI не получает API key через argv: daemon передаёт
  `CURSOR_API_KEY` только в environment, если пользователь выбрал token auth.
- Cursor может самостоятельно discover `.cursor/mcp.json`; Remcli MCP не
  является chat/resume fallback.

## Команда turn

```text
agent --print --output-format stream-json --trust \
  [--model <model>] [--resume <native-session-id>] \
  [--mode plan|ask] [--force|--auto-review] <prompt>
```

- `agent` - текущий бинарник; `cursor-agent` используется только как fallback
  для старой установки.
- Обычный режим Agent не передаёт `--mode agent`: такого значения у текущего
  Cursor CLI нет.
- `--trust` убирает интерактивный workspace prompt, который иначе блокировал бы
  headless runner. Рабочую директорию пользователь выбирает до spawn.
- Успех принимается только после `system/init` с native ID, terminal
  `result.success` без `is_error` и exit code `0`.
- В телефонный чат сначала передаётся непустой terminal `result`. Если текущий
  Cursor CLI подтвердил успех без этого поля, Remcli использует только text
  chunks из `assistant` events после `system/init` того же native session;
  reasoning/tool events, pre-init и foreign-session payloads игнорируются.
  `message.content` обрабатывается как incremental stream, а одинаковый
  `content`/`text_delta` внутри одного события не дублируется.

## Идентичность и resume

| Идентификатор | Владелец | Назначение |
|---|---|---|
| Remcli session ID | P2P daemon | карточка/чат Remcli и runner credential |
| Native Cursor session ID | Cursor CLI | `agent --resume <id>` и context history |

1. При create Remcli ID существует раньше native Cursor ID.
2. После `system/init` daemon-owned wrapper сначала вызывает защищённый
   loopback `POST /cursor-session-bound`. Endpoint требует runner credential и
   атомарно закрепляет `{nativeSessionId -> daemon wrapper}`.
3. Только успешный ответ `bound` или `already-bound` разрешает записать native
   ID в P2P metadata. `reuse-active-wrapper`, отсутствующий wrapper или
   несовпадение агента прерывают turn до `task_complete`, поэтому второй tmux
   pane не может начать работу с тем же native ID.
4. После такого bind `SessionManager` хранит только в памяти daemon
   `{native Cursor ID -> parent Remcli session ID, directory}`. Когда active
   wrapper уже освобождён, тот же daemon создаёт новый wrapper с отдельной
   runner capability.
5. До создания любой P2P metadata daemon-owned Cursor runner вызывает loopback
   `POST /cursor-runner-preflight` с capability, PID, агентом и native resume
   ID. Daemon проверяет точный tmux wrapper, capability, `cursor` и ожидаемый
   resume ID. Ручной `--started-by daemon` без этой capability не создаёт P2P
   session и не публикует daemon provenance.
6. Для same-daemon/same-workspace resume preflight возвращает parent Remcli ID,
   и runner кладёт `resumedFromRemcliSessionId` в initial metadata, поэтому Web
   сразу показывает существующую зашифрованную P2P-ленту родителя перед child
   сообщениями. Эта связь provisional до matching `system/init` и успешного
   native bind; mismatch, binding failure, CLI error, abort, stop или смена mode
   до подтверждения удаляют её до archive. Перед idle reset `AbortController`
   wrapper ждёт bounded metadata rollback; его отказ fail-closed завершает wrapper,
   а archive повторно удаляет relation. После подтверждения связь сохраняется.
   Дубликаты сообщений подавляются. Нативное Cursor-хранилище, внешние
   Cursor-сессии и связь после restart daemon не читаются и не копируются.
7. Cursor history и resume ограничены MD5 raw absolute path выбранной
   директории (`~/.cursor/chats/<workspace-hash>`). Resume из другой директории
   отклоняется до spawn.
8. До подтверждения `system/init` pending resume дедуплицируется по запрошенному
   native ID, но этот ID не считается подтверждённым и не публикуется в metadata.

## Permissions

| UI mode | Нативное соответствие |
|---|---|
| `agent` | Без `--mode`, `--force` и `--auto-review` |
| `plan` | `--mode plan` |
| `ask` | `--mode ask` |
| `force` | `--force` |
| `auto-review` | `--auto-review` |

`plan` и `ask` локальный CLI описывает как read-only. `force` и
`auto-review` - отдельные provider flags; они не являются общими Remcli aliases
и не смешиваются друг с другом. Нативный event может содержать vendor value
`permissionMode: "default"`; Remcli не экспортирует его как режим разрешений.

## Account-visible model catalog

1. Daemon запускает только `agent models` (fallback binary: `cursor-agent`) с
   ограниченными timeout и output buffer. Он строго принимает header
   `Available models`, нормальные model rows, ровно один provider default
   (`(default)` либо текущий CLI marker `(current, default)`) и
   recognized footer; raw stdout/stderr, account/quota/auth data не выходят в
   protocol и логи.
2. `get-cursor-capabilities` возвращает нормализованный snapshot: exact model
   id, display name, provider default, source freshness и opaque
   `catalogVersion`. Web не содержит fallback catalog и блокирует Start/Resume,
   пока нет этой пары.
3. New Session передаёт `cursorExecution = { model, catalogVersion }` атомарно
   со стартом. Daemon принудительно refresh-валидирует пару перед spawn; stale
   или чужая model отклоняется typed ошибкой, после которой Web очищает выбор и
   повторно запрашивает catalog.
4. Cursor CLI не публикует отдельный machine-readable reasoning selector.
   Remcli показывает явный informational status «reasoning не настраивается
   отдельно», не выводя effort из suffix model id.
5. `agent`, `plan`, `ask`, `force` и `auto-review` пока отображаются как
   native launch controls. Отдельная future work должна развести execution mode,
   sandbox, MCP approval, workspace trust и реальные permission allow/deny
   semantics вместо одного UI поля.
6. Только daemon-owned runner может получить injected `REMCLI_CURSOR_*` model
   selection. Обычный terminal `remcli cursor` игнорирует эти переменные.
   Concierge получает fresh provider default или не запускает Cursor вовсе.

## Ошибки и остановка

- Missing executable, auth, invalid NDJSON, native failure, resume identity
  mismatch, binding rejection и abort имеют typed error boundary. Pending parent
  lineage не остаётся в metadata после неуспешного первого native resume.
- Prompt, raw stderr, tool result payloads и credentials не попадают в public
  error или debug log; tool completion log содержит только non-sensitive
  metadata.
- Abort завершает process group: SIGTERM с bounded SIGKILL fallback.
- Остановка daemon wrapper и OS signals архивируют Remcli session, отправляют
  session death, flush и close идемпотентно.

## Проверки

- Unit/native fixture: success, no init/result, result error, malformed NDJSON,
  auth redaction, missing binary, resume mismatch, abort process tree.
- `D`: native fixture покрывает success, no init/result, result error,
  malformed NDJSON, auth redaction, missing binary, resume mismatch и abort
  process tree.
- `I`: encrypted machine-RPC проходит real SessionManager/tmux/compiled runner
  до controlled native `agent`; проверяются exact argv, ACK no-replay, active
  native stop с SIGTERM, same-native resume и cleanup.
- `UI-F`: Cursor-labelled Browser fixture проверяет model catalog, native
  controls, unsupported reasoning, unavailable/retry и bind/resume error в том
  же drawer на `390x844` и `1280x800`.
- `L`: opt-in `REMCLI_REAL_CURSOR=1` прошёл create -> prompt -> stop -> same
  native `--resume` -> context marker -> cleanup. Deterministic I tests отдельно
  покрывают disconnect-before-ACK, concurrent/pre-init duplicate, workspace
  mismatch и exact owned tmux pane cleanup.

## Явная граница

Cursor CLI integration пока не объявляет full live mirror нативного Cursor TUI:
Remcli передаёт в phone chat подтверждённый terminal result или строго
привязанный assistant fallback, но не создаёт отдельную live-ленту
tool/approval events. Добавление такого mirror требует отдельного
provider-specific дизайна, контракта и real gate.
