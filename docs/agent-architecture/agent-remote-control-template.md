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

- Unit tests:
- Integration tests:
- Real AI opt-in tests:
- Browser/UI gate:
- Manual smoke:

## Open Risks

- Что ещё не эквивалентно нативному CLI/TUI.
- Какие provider docs или CLI flags надо перепроверить перед следующей волной.
