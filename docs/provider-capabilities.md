# Возможности AI-провайдеров

Актуально на 2026-09-19. Этот документ фиксирует фактический контракт Remcli,
а не общий список возможностей provider CLI. Возможность считается
поддержанной только после реализации в Remcli и соответствующей проверки.

## Легенда

- ✅ официальный provider-контракт интегрирован и принят в Remcli;
- 🟡 работает частично или требует повторной реальной приёмки;
- 🛠 находится в текущей реализации;
- ⏸ отложено до отдельной provider-specific wave;
- ❌ нет публичного provider-контракта или функция не поддерживается.

## Матрица возможностей

| Возможность Remcli | Codex | Cursor | Antigravity | Claude Code |
|--------------------|-------|--------|-------------|-------------|
| **Provider реализован** | ✅ app-server | ✅ `agent acp` | 🟡 `agy stream-json`; real gate надо повторить | ⏸ UI выключен |
| **Создание сессии** | ✅ | ✅ | ✅ | ⏸ |
| **Resume того же native context** | ✅ `thread/resume` | ✅ `session/load` | 🟡 exact `--conversation`, без свежего real gate | 🟡 только существующие wrapper/SDK paths |
| **История диалога в Remcli** | 🟡 user/assistant text | 🟡 Remcli transcript или ACP chunks | 🟡 encrypted Remcli transcript; официальный hook `transcriptPath` ещё не интегрирован | 🟡 user/assistant text, UI выключен |
| **Stop и cleanup** | ✅ | ✅ | ✅ deterministic/product gates | 🟡 без real provider gate |
| **Один live chat в terminal и Remcli** | ✅ общий daemon-owned thread и remote TUI | ❌ Cursor не публикует attach/fanout API | 🟡 официальный sidecar/hooks bridge возможен, но не реализован | ⏸ |
| **Ввод и с terminal, и с телефона** | ✅ | ❌ нет официального concurrent writer contract | 🟡 `agentapi send-message` существует; ordering/event flow ещё не принят | ⏸ |
| **Актуальные модели** | ✅ dynamic app-server catalog | ✅ dynamic ACP catalog | ✅ account-visible `agy models` | ⏸ нет принятого dynamic catalog |
| **Reasoning выбранной модели** | ✅ provider-advertised efforts | ❌ ACP не публикует selector | ✅ provider-advertised efforts | ⏸ |
| **Уровень доступа** | ✅ native sandbox/approval policy | ✅ `Agent / Plan / Ask` | ✅ native launch modes | 🟡 static modes, UI выключен |
| **Tool approval с телефона** | ✅ | ✅ только options из ACP request | ❌ headless interactive contract не найден | ⏸ |
| **Несколько вопросов, A/B/C, Other** | ✅ `requestUserInput` | ⏸ следующий этап: `cursor/ask_question` | ❌ provider flow не найден | ❌ |
| **Typed forms** | ✅ standard MCP form + URL elicitation | ⏸ следующий этап: Cursor extensions | ❌ provider flow не найден | ❌ |

### Важные границы

- 🟡 История не равна полному снимку native UI: tool calls, reasoning и status
  могут не восстанавливаться.
- Codex `requestUserInput` и standard MCP form реализованы отдельным typed
  flow. MCP URL открывается только явным действием; raw URL не хранится в
  session state. Расширенный `openai/form` не объявляется и fail-closed.
  Cursor forms переиспользуют общий UI/P2P contract, но сохраняют нативный
  ACP-адаптер.
- Terminal/phone continuity добавляется только через официальный structured
  transport. Remcli не использует ANSI scraping или два writer-процесса ради
  формального совпадения функций.
- Antigravity Remote Control синхронизирует native TUI только с web-интерфейсом
  Google. Для Remcli исследуется официальный extension path: sidecar отправляет
  prompt через `agentapi`, а hooks предоставляют `conversationId` и
  `transcriptPath`. Документированного API для streamed deltas и ответов на
  approvals/questions пока нет.

## Проверки

| Gate | Что доказывает |
|------|----------------|
| `D` | Provider argv/IPC, parser, native ID, resume и mapping capabilities |
| `I` | Зашифрованную границу daemon/P2P, lifecycle и typed handoff |
| `L` | Реальный установленный и авторизованный provider CLI: create, prompt, stop, resume |
| `UI-F` | Fixture-состояния и UX во встроенном Browser на mobile и desktop |

`UI-F` не заменяет `L`. Skipped opt-in suite, fixture executable или одна
документация provider не доказывают реальный lifecycle.

Текущий evidence: Codex и Cursor имеют `D/I` и opt-in `L`; Antigravity имеет
`D/I`, но повтор `L` заблокирован внешним eligibility gate; Claude Code не
имеет принятого phone/web gate. Browser-проверки сейчас `UI-F` и не выдаются
за реальные provider-запросы.

## Правило обновления

Матрица обновляется после изменения provider adapter или подтверждённого drift:

1. Проверить официальную документацию и changelog provider.
2. Сверить установленный CLI, `--help` и account-visible capability catalog.
3. Сверить adapter, protocol schema и фактический UI Remcli.
4. Запустить релевантные `D/I/L/UI-F` gates и зафиксировать ограничения.
5. Только после этого повысить статус возможности.

Provider API drift monitor является внутренним процессом разработки. Он не
добавляет настройки, фоновые проверки или уведомления в клиент Remcli.
