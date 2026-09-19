# Общий live chat для AI-агентов без multi-client API

> Статус: целевая архитектура. Cursor и Antigravity ещё не имеют такого local
> terminal frontend в runtime Remcli; этапы реализации находятся в плане.

Этот контракт применяется, когда provider умеет вести долгоживущую headless
сессию, но не позволяет подключить Remcli к уже открытому штатному TUI.

## Схема

```text
Phone/Web ───────┐
                 ├─ Remcli daemon ─ provider adapter ─ одна native session
Local terminal ──┘
```

- daemon является единственным writer к provider;
- phone/web и локальный terminal UI Remcli работают с одной Remcli-сессией;
- сообщения, streaming, tools, lifecycle и только поддержанные provider events
  публикуются обоим клиентам через общий ordered event stream; недоступные
  approvals/questions получают явный unsupported outcome;
- resume восстанавливает exact native session ID, а не создаёт новый context;
- terminal UI Remcli не является ANSI-копией штатного provider TUI.

## Terminal frontend

Общий terminal frontend Cursor и Antigravity строится на
`@earendil-works/pi-tui`. Remcli использует библиотеку только для rendering и
input: Markdown, multiline editor, focus, keyboard navigation, dialogs, resize
и корректную ширину Unicode. Pi agent runtime, Pi sessions, Pi tools и Pi как
provider в Remcli не подключаются.

Terminal frontend является обычным клиентом Remcli session broker и не владеет
provider process. Версия `pi-tui` фиксируется в lockfile; до product rollout
отдельно проверяются license/dependency boundary, macOS/Linux/Windows, tmux,
resize, длинный streaming chat и limited-color terminal.

Codex не переводится на этот frontend. Его официальный live path остаётся
`codex --remote` + shared Codex app-server и native thread: общий broker может
нормализовать события для web, но не заменяет Codex transport или TUI.

## Общий и provider-specific слои

Общий слой Remcli отвечает за client identity, ordering, ACK/reconnect,
encrypted transcript, duplicate guard, stop/resume и синхронизацию двух UI.

Provider adapter отвечает за native session ID, transport, model/mode catalog,
prompt, streaming events, tools, approvals и cancel. Нативные slash-команды
добавляются только при наличии документированного provider mapping.

## Условия поддержки

Live chat можно включить только если provider позволяет:

1. держать один headless runtime между несколькими turns;
2. отправлять prompts в ту же native session;
3. получать структурированные ответы и lifecycle events;
4. безопасно остановить и возобновить exact session.

Если approvals, questions или tool events недоступны в structured transport,
Remcli явно показывает ограничение и не имитирует поддержку через screen
scraping, общий PTY или второй конкурентный writer.

## Cursor

Cursor будет использовать существующий daemon-owned `agent acp`. Локальный
terminal UI Remcli и phone/web будут подключаться к одной wrapper session; оба
prompt источника пойдут через один ACP writer. Resume выполняется через
`session/load`.

Штатный Cursor TUI к этой active session не подключается: Cursor ACP SDK `1.4.0`
и установленный CLI не публикуют multi-client attach/fanout contract.

## Antigravity

Официальный Remote Control синхронизирует CLI с Google UI, поэтому не входит в
пользовательский flow Remcli. Используется один daemon-owned `agy stream-json`,
а phone/web и local terminal UI Remcli работают поверх него. Resume обязан
сохранять exact `conversationId` и workspace.

До появления structured approvals/questions Antigravity не получает ложную
полную parity: поддержанные события показываются live, неподдержанные состояния
остаются явным ограничением adapter.

## Приёмка каждого provider

- terminal prompt появляется на телефоне один раз;
- phone prompt появляется в local terminal UI один раз;
- два клиента видят одинаковый ordered stream и конечный outcome;
- reconnect не повторяет turn и не теряет подтверждённые события;
- stop/resume сохраняет exact native context; известные durable сообщения
  воспроизводятся отдельно, а отсутствующий или повреждённый transcript не
  блокирует resume;
- каждый prompt имеет client origin и idempotency key, daemon назначает общий
  sequence, а reconnect продолжает поток после последнего подтверждённого ACK;
- при одновременном вводе daemon обрабатывает prompts строго по sequence;
- concurrent input сериализуется одним daemon writer;
- deterministic, integration, real provider и Browser mobile/desktop gates
  проходят отдельно для каждого adapter.
