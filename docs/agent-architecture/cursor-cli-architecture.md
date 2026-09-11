# Cursor CLI в Remcli

## Источники

- Cursor ACP: https://cursor.com/docs/cli/acp
- Cursor CLI: https://cursor.com/docs/cli/overview
- Cursor models: https://cursor.com/docs/models
- Agent Client Protocol: https://agentclientprotocol.com/protocol/v1/overview
- Локальная приёмка: `agent --help`, `agent acp --help`,
  `agent 2026.09.10-fd3934a`
- Проверено: 2026-09-12.

## Назначение

Remcli управляет Cursor через официальный `agent acp`. Это постоянный
provider-specific transport по stdin/stdout, JSON-RPC 2.0 и NDJSON. Для одного
daemon-owned wrapper создаются один ACP-процесс и одна native Cursor session.
Старый per-turn путь `agent --print --output-format stream-json` удалён.

```text
Web/PWA -> encrypted P2P -> local daemon -> CursorAcpClient -> agent acp -> Cursor
```

Remcli не эмулирует Cursor IDE и не использует MCP как chat transport. MCP
servers могут быть переданы Cursor внутри `session/new` или `session/load`, но
сам обмен Remcli с Cursor идёт по ACP.

## Lifecycle

Порядок запуска соответствует ACP v1:

1. Remcli запускает `agent acp` в выбранной рабочей директории.
2. `initialize` согласует protocol version и capabilities.
3. Если Cursor публикует `cursor_login`, Remcli вызывает `authenticate` и
   использует уже существующую авторизацию локального Cursor CLI.
4. Новая сессия создаётся через `session/new`; resume выполняется только через
   `session/load` с исходным native session ID.
5. Выбранные модель и режим применяются через session methods до prompt.
   Если `session/load` не повторяет optional capability state, daemon-runner
   использует только уже проверенные model/mode, а setter остаётся финальной
   provider-side проверкой. Прямой CLI-resume без явно выбранной модели
   сохраняет модель native-сессии и не блокируется из-за отсутствующего
   optional `SessionModelState`.
6. Каждый телефонный prompt отправляется через `session/prompt` в ту же native
   session. Одновременно выполняется только один prompt.
7. `session/update` транслирует текст и безопасные сведения о tool calls в
   Remcli chat.
8. Stop/abort сначала вызывает `session/cancel`, затем ограниченно завершает
   принадлежащую Remcli process group.

Ошибка `session/load` не создаёт новую сессию. Это защищает пользователя от
тихой потери контекста при неудачном resume: wrapper завершается и не принимает
следующий prompt как новую сессию.

## Идентичность и ownership

| Идентификатор | Владелец | Назначение |
|---|---|---|
| Remcli session ID | P2P daemon | карточка, зашифрованный чат и runner credential |
| Native Cursor session ID | Cursor ACP | Cursor context и `session/load` |

- До ACP startup daemon проверяет одноразовую runner capability, выбранную
  рабочую директорию, provider, executable и fingerprint CLI.
- После `session/new` или `session/load` wrapper атомарно привязывает native ID
  к Remcli session через локальный credential-protected control endpoint.
- Активный native ID не может получить второй daemon wrapper.
- Один native ID имеет ровно одного writer-а. Writer lease сохраняется до
  завершения wrapper; неподтверждённый cleanup остаётся fail-closed.
- Resume разрешён только для исходной рабочей директории. Provisional parent
  lineage публикуется до загрузки чата и подтверждается только после успешного
  `session/load` и bind; при ошибке она удаляется.
- Durable P2P delivery подтверждается после принятия prompt и reconciliation
  native metadata. Повторная доставка одного ACK-pending сообщения не создаёт
  второй native prompt в том же живом runner.

Связь Cursor native ID с предыдущей Remcli session хранится daemon-ом. После
restart daemon внешняя Cursor session может быть выбрана через native history,
но Remcli не читает приватную Cursor DB как transcript и не выдумывает parent
chat relation.

## Модели и режим

Cursor capabilities получаются из реальной авторизованной ACP-сессии. Remcli
использует точные `modelId`, которые вернул `SessionModelState`, и не парсит
человекочитаемый вывод `agent models`.

`get-cursor-capabilities` возвращает:

- exact model ID и display name;
- текущую ACP model как default для нового запуска;
- short-lived `catalogVersion`;
- fingerprint конкретного executable/version.

Web отправляет `{ model, catalogVersion }`. Перед spawn daemon обновляет catalog
и отклоняет stale или отсутствующую модель. CLI aliases, которых нет в ACP
catalog, не принимаются.

ACP публикует три режима сессии:

- `Agent`
- `Plan`
- `Ask`

В интерфейсе selector называется «Уровень доступа», но значение остаётся
provider-native Cursor mode. Root CLI flags `--force`, `--auto-review`,
`--sandbox` и `--approve-mcps` не являются ACP session controls и поэтому не
показываются и не передаются Remcli. Отдельного reasoning selector для Cursor
нет: текущий ACP contract не публикует настраиваемый effort по моделям.

Смена модели в открытом чате использует свежий catalog и применяется через
ACP session method только перед следующим prompt. Native session и её контекст
при этом сохраняются.

## Streaming, tools и permissions

Remcli обрабатывает только типизированные ACP updates:

- `agent_message_chunk` дополняет ответ;
- `tool_call` создаёт tool card с названием, kind и locations;
- `tool_call_update` завершает карточку статусом `completed` или `failed`;
- provider reasoning и raw tool result не копируются в публичный чат;
- update другой native session игнорируется.

Текстовые chunks отправляются в web-клиент сразу с одним logical message ID.
Клиент собирает их в один ответ, а после завершения turn получает полную
durable final-версию. При загрузке внешней native session без известного
Remcli-parent `user_message_chunk` и `agent_message_chunk` воспроизводятся в
новом чате; для известного parent используется уже сохранённый transcript,
чтобы не дублировать сообщения.

`session/request_permission` отображается существующей мобильной карточкой
разрешения. Решение переводится только в один из option kinds, которые Cursor
явно прислал в запросе:

| Remcli | Cursor ACP |
|---|---|
| Разрешить один раз | `allow_once` |
| Разрешить для сессии | `allow_always` |
| Отклонить / прервать | `reject_once` |

Remcli не генерирует option ID и не одобряет запрос автоматически. При stop,
reconnect reset или отсутствующей поддерживаемой опции request завершается как
`cancelled`.

Cursor extensions `cursor/ask_question` и `cursor/create_plan` требуют
отдельного structured UI/P2P contract. Пока Remcli возвращает официальный
fail-closed outcome и показывает пользователю видимое предупреждение; запрос
не зависает и не скрывается.

## Ошибки и данные

- Ошибки spawn, protocol, auth, load, bind и prompt проходят через безопасную
  provider boundary; credentials, prompt, raw stderr/stdout и tool payload не
  попадают в публичные ошибки или debug log.
- Provider stderr фиксируется только как факт события.
- Неизвестные permission и extension requests не одобряются.
- Abort и crash закрывают pending permissions, P2P state, writer lease и owned
  process в определённом порядке.
- `initialize`, auth, load/new, mode/model и cancel имеют bounded deadline;
  зависший Cursor CLI не оставляет запуск или capability picker в вечном loading.

## Terminal

Команда `remcli cursor` сохраняет отдельный native interactive Cursor TUI для
локальной работы. Daemon-owned телефонная сессия использует ACP и не является
ANSI screen mirror.

Одновременный ввод из штатного Cursor TUI и телефона в одну native session не
объявляется поддержанным: Cursor не публикует attach/fanout contract для двух
конкурентных клиентов. Remcli не подменяет его screen scraping или общим PTY.

## Проверки

- `D`: deterministic ACP protocol tests для initialize/auth, new/load,
  mode/model validation, streaming, permission options, extensions, cancel,
  crash, shutdown и redaction.
- `I`: encrypted machine RPC, real SessionManager/tmux и controlled `agent acp`;
  проверяются create, same-ID resume, active duplicate guard, ACK replay,
  workspace mismatch, stop и cleanup.
- `L`: opt-in `REMCLI_REAL_CURSOR=1` использует установленный авторизованный
  Cursor CLI: create -> prompt -> external SIGINT -> same-ID resume -> context
  proof -> stop.
- `UI-F`: встроенный Browser проверяет New Session и lifecycle state на
  `390x844` и `1280x800`: real ACP models, `Agent / Plan / Ask`, отсутствие
  неисполняемых controls, start, chat, stop и resume.

Команды:

```bash
npm -w remcli run typecheck
npm -w remcli run build
npm -w remcli run test
REMCLI_REAL_CURSOR=1 npx vitest run tests/integration/cursorRealLifecycle.integration.test.ts --no-file-parallelism
npm -w remcli run doctor
node packages/remcli-cli/bin/remcli.mjs daemon status
```
