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
  [--mode plan|ask] [--force] [--auto-review] \
  [--sandbox enabled|disabled] [--approve-mcps] <prompt>
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
9. Кнопка Resume из Cursor Chat не запускает native CLI напрямую. Она передаёт
   закрытый navigation preset в New Session; тот заново читает capability catalog
   выбранной машины, показывает свежие model/launch controls и только затем
   отправляет typed `cursorExecution` + `cursorLaunchControls` + native resume ID.
   URL не содержит native ID или выбор controls.

### Корректное завершение daemon runner

Когда пользователь завершает daemon-owned Cursor wrapper через `Ctrl+C`, runner
сначала с credential-подтверждением сообщает локальному control server, что
закрывается. Пока этот переход не завершён, новый `agent --resume` с тем же
native ID не запускается. После archive, `session-end`, flush и закрытия P2P
сессии runner отдельно подтверждает completion; только тогда daemon освобождает
свой immutable tmux pane.

Если `tmux` не может подтвердить конкретный pane, cleanup по-прежнему
fail-closed. Исключение возможно только для уже credential-подтверждённого
graceful shutdown, когда `tmux` отдельно подтвердил отсутствие именно
daemon-owned session. Это не даёт удалить чужой pane и не превращает PID в proof
of ownership. Если runner уже умер до final callback, daemon также может
reconcile tracking только по этому независимому immutable tmux proof: мёртвый
процесс не способен отправить completion. Повторный Stop отклоняется, а shutdown
daemon ждёт normal completion ограниченное время и при таймауте завершается
ошибкой вместо преждевременного уничтожения живого pane.

## Execution и controls

| Поверхность | Нативное соответствие |
|---|---|
| Execution mode `Agent` | Не передавать `--mode` |
| Execution mode `Plan` | `--mode plan` |
| Execution mode `Ask` | `--mode ask` |
| Launch control `Force` | Независимый `--force` |
| Launch control `Auto-review` | Независимый `--auto-review` |
| Sandbox override | `--sandbox enabled|disabled`; без override host-controlled |
| MCP approval | Opt-in `--approve-mcps`; default не одобряет все MCP |
| Workspace trust | Daemon-owned headless runner всегда передаёт `--trust` |

`plan` и `ask` локальный CLI описывает как read-only. `--force`,
`--auto-review`, sandbox и MCP approval - отдельные provider-native controls,
которые Remcli не сжимает в общий `PermissionMode` и не делает искусственно
взаимоисключающими. Локальные Cursor allow/deny rules остаются источником
истины: Remcli их не читает, не меняет и не сериализует. Нативный event может
содержать vendor value `permissionMode: "default"`; Remcli не экспортирует его
как пользовательский режим.

В интерфейсе первичный selector всех provider называется «Уровень доступа».
Для Cursor он выбирает только execution mode (`Agent`/`Plan`/`Ask`); это единая
терминология UI, а не попытка выдать mode за Codex permission profile. Launch
controls остаются отдельным sheet.

Перед созданием Cursor child command `SessionSpawner` очищает унаследованный
legacy `REMCLI_CURSOR_PERMISSION_MODE` через `/usr/bin/env -u ...` на границе
tmux. Этот ключ не читается как input и не может изменить argv нового runner.

### Визуальный contract selector-ов

Выбранные rows модели, execution mode, sandbox и reasoning используют
`aria-pressed="true"`, accent surface и check-indicator. Длинный label в такой
row переносится, а не скрывается ellipsis. Resume/history rows не являются
toggle-selector-ами и не получают этот признак. Локальный `design/` служит
визуальным reference; versioned contract и Browser/E2E проверка находятся в
этом документе и `design-smoke.spec.ts`.

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
4. Cursor CLI допускает parameterized `--model` overrides, включая effort, но
   не публикует безопасный machine-readable catalog допустимых efforts для
   конкретной account-visible модели. Это current product limitation Remcli:
   пока он показывает informational status «reasoning не настраивается
   отдельно» и не выводит effort из suffix model id.
5. Web передаёт отдельно `cursorExecution` и полный `cursorLaunchControls`;
   `Agent` означает отсутствие `--mode`, а native flags не являются generic
   permission aliases. Workspace trust и local allow/deny rules отображаются
   как факты, не как телефонные selectors.
6. Только daemon-owned runner может получить injected `REMCLI_CURSOR_*` model
   selection. Обычный terminal `remcli cursor` игнорирует эти переменные.
   Fresh validation также связывает executable и version fingerprint; runner
   перепроверяет его перед созданием P2P metadata. Concierge получает тот же
   daemon-owned selection или не запускает Cursor вовсе.

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

Daemon-owned tmux pane для Cursor сейчас является lifecycle host для
`agent --print`, а не интерактивным native TUI. После `Ctrl+C` он должен
безопасно завершить wrapper; параллельный `agent --resume` не запускается.
Полноценный terminal/phone mirror возможен только после отдельного решения для
PTY streaming, изоляции сессии и host-side confirmation.
