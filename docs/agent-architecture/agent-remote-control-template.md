# Шаблон архитектуры AI-агента

Использовать для каждой новой или существенно изменённой интеграции:
Claude Code, Codex, Gemini, Cursor и будущие агенты.

## Official Sources

- Official docs:
- Local CLI check:
- Context7/OpenAI docs skill:
- Проверено: YYYY-MM-DD

## Product Goal

- Как пользователь должен работать с агентом с телефона.
- Как этот поток соотносится с нативным CLI/TUI агента.
- Что считается сохранением контекста и resume.

## Runtime Ownership

- Кто владеет процессом агента: daemon, session process, external app-server,
  terminal/TUI или provider SDK.
- Какие локальные endpoint/IPC используются.
- Что доступно телефону напрямую, а что только через Remcli daemon.

## Session Identity

- Remcli wrapper session id:
- Native provider session/thread id:
- Где id хранится:
- Как работает duplicate guard:
- Как работает stop/reopen/resume:

## Message Flow

```text
Phone/Web -> Remcli P2P -> daemon/session -> provider runtime -> session -> Remcli P2P -> Phone/Web
```

- Create:
- Resume:
- User prompt:
- Streaming:
- Tool/approval request:
- Interrupt/stop:

## Permissions

- Native permission modes:
- UI labels:
- Boundary mapping:
- Unsupported/invalid modes:

## Errors

- Какие ошибки показываем пользователю.
- Какие ошибки не маскируем.
- Что считается retryable.

## Verification

Каждую ячейку заполнять отдельно для **этого** provider. Общий Remcli harness
проверяет transport/lifecycle, но не доказывает native contract другого CLI.

| Уровень | Что доказывает | Не засчитывается как доказательство |
|---|---|---|
| `D` — deterministic | argv/env, parser/event order, native id, resume, permission/model/reasoning mapping и provider errors с контролируемым executable/transport | Generic daemon или UI test без provider protocol |
| `I` — product boundary | encrypted machine-RPC/P2P, spawn/resume и typed handoff до provider boundary | Unit mock `spawnSession` или fake WebSocket без daemon boundary |
| `L` — opt-in real | Реальный установленный CLI/API: create -> prompt -> stop -> resume и проверка контекста | Skipped gate, fixture executable или только `--help` |
| `UI-F` — Browser fixture | Provider-labelled create/resume/error/recovery states на mobile и desktop | Generic fixture другого provider; не заменяет `L` |

- `D` tests and files:
- `I` tests and files:
- `L` opt-in command, required credential and last actual result:
- `UI-F` Browser routes/viewports/states:
- Manual smoke and remaining limitations:

## Open Risks

- Что ещё не эквивалентно нативному CLI/TUI.
- Какие provider docs или CLI flags надо перепроверить перед следующей волной.
