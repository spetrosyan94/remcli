# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Универсальные стандарты → skill `core-standards`.

## What is Remcli?

Remcli is a mobile and web client for AI coding agents (Claude Code, Codex, Gemini, Cursor) that enables end-to-end encrypted remote control from anywhere. Users run `remcli` instead of `claude` (or `remcli codex`/`remcli cursor`/`remcli gemini`). The CLI wraps AI sessions, a persistent daemon acts as a local P2P server, and mobile/web clients connect directly via WebSocket (LAN or cloudflared tunnel) for real-time control. No cloud server is required — the daemon IS the server.

## Monorepo Structure

npm workspaces with two packages:

- **remcli-app** (`packages/remcli-app`) - React Native + Expo mobile/web client
- **remcli-cli** (`packages/remcli-cli`, published as `remcli`) - CLI wrapper for Claude Code/Codex

Each package has its own `CLAUDE.md` with detailed package-specific guidance. The daemon subsystem has additional docs at `packages/remcli-cli/src/daemon/CLAUDE.md`.

## Commands

### Prerequisites
- **Node.js** (v20+)
- **tmux** — required for daemon session spawning (`brew install tmux` on macOS)

### Install
```bash
npm install
```

### remcli-app
```bash
npm -w remcli-app run start        # Expo dev server
npm -w remcli-app run ios          # iOS simulator
npm -w remcli-app run android      # Android emulator
npm -w remcli-app run web          # Web browser
npm -w remcli-app run typecheck    # TypeScript check (runs in CI)
npm -w remcli-app run test         # Vitest
```

### remcli-cli
```bash
npm -w remcli run build            # TypeScript + pkgroll build
npm -w remcli run test             # Build then Vitest
npm -w remcli run dev              # Run with TSX (no build)
remcli setup                       # Interactive setup wizard (Whisper + TTS + AI agents + cloudflared)
remcli doctor                      # Diagnostics (daemon, agents, Whisper, TTS, logs)
```

## Architecture

### P2P Direct Data Flow
```
Mobile/Web App  <-- WS (LAN / cloudflared tunnel) -->  CLI Daemon (Fastify + Socket.IO + in-memory store)  <->  Claude Code / Codex / Gemini / Cursor
```

The daemon runs a Fastify HTTP server with Socket.IO on `0.0.0.0` — it IS the server. No cloud dependency.

### Authentication (P2P)
QR code-based. The daemon generates a random 32-byte shared secret, displays a QR code in the terminal. The mobile app scans the QR, decodes the shared secret, and derives a Bearer token via `HMAC-SHA256(sharedSecret, "p2p-auth")`. Both sides compute the same token independently.

QR payload format: `{"mode":"p2p","host":"192.168.1.x","port":12345,"key":"<base64>","v":1}`

With `--tunnel` flag, cloudflared provides a public HTTPS URL replacing the LAN IP (port=0 signals tunnel mode).

### End-to-End Encryption
All payloads encrypted client-side. Two schemes:
- **Legacy**: XSalsa20-Poly1305 (TweetNaCl)
- **DataKey**: AES-256-GCM per-session/machine

### Daemon Model
The CLI runs a persistent background daemon (`remcli daemon start`) that:
- Acquires an exclusive lock file to prevent duplicates
- Exposes a local-only HTTP control server on `127.0.0.1` (`/list`, `/stop`, `/spawn-session`)
- Runs a P2P server (Fastify + Socket.IO) on `0.0.0.0` for mobile app connections
- Stores sessions/messages in an in-memory store (no disk persistence; each daemon run starts fresh)
- Optionally starts a cloudflared tunnel (`--tunnel` flag) for remote access
- Auto-updates when it detects a CLI version change (via heartbeat loop)

### P2P Server Protocol
Socket.IO protocol served locally:
- **Update events** (persistent, seq-numbered): `new-session`, `update-session`, `new-message`, `new-machine`, etc.
- **Ephemeral events** (transient): `session-alive`, `machine-alive`
- **REST API**: `/v1/sessions`, `/v1/machines`, `/v2/sessions/active` etc.
- Optimistic concurrency control via `expectedVersion` on state updates
- RPC forwarding for remote session control

### Session Lifecycle
Sessions can be started from terminal (`remcli`) or spawned remotely by the daemon via mobile RPC. The device-switching model: when the user takes control from mobile, the session restarts in remote mode; pressing any key on the keyboard switches back.

### TTS (Text-to-Speech)
Voice synthesis of agent responses. Two providers:
- **edge-tts** (default): Microsoft Edge TTS via `node-edge-tts` npm package. Generates MP3, then ffmpeg converts to OGG Opus. Free, no setup, works everywhere. Requires ffmpeg. Voice priority: per-request voice → `ttsEdgeVoice` from setup.json (unless 'auto', the default) → per-language default voice (fallback en-US).
- **qwen3-tts**: Local Apple Silicon only. Uses `mlx-audio` in a Python worker process (`qwenTtsWorker.py`). Supports voice cloning via reference audio profiles. Worker stays resident in memory (~1.7GB RAM) for fast synthesis.

**Audio format:** OGG Opus, 48kbps mono, 24kHz, `-application voip` (optimized for speech). ~6 KB/sec → 10 sec phrase ≈ 60 KB.

**Data flow:**
```
App: [Listen] → POST /v1/voice/synthesize {text} → Daemon TTS → Provider → OGG Opus → App playback
     [Stop]  → AbortController.abort() → HTTP request cancelled → daemon stops generating
```

**Cancellation:** Each synthesis creates an `AbortController`. Stop or switching to another message aborts the HTTP request. Generation counter prevents race conditions when switching messages quickly (stale callbacks from cancelled requests cannot overwrite state of newer ones).

**REST endpoints:**
- `GET /v1/tts/status` → `{ available, provider, voices[] }`
- `POST /v1/voice/synthesize` → `{ text, voice?, lang? }` → `audio/ogg` binary

**App-side:**
- `useTts` hook: state machine (idle → synthesizing → playing) with generation counter, AbortController, in-memory LRU cache (20 entries)
- `useTtsAvailability` hook: checks daemon TTS status on mount (P2P mode only)
- "Listen" pill button on each agent message, shows synthesis/playback state

**Voice profiles (qwen3-tts):**
- Default profile bundled at `src/daemon/tts/voices/default/` (used as fallback)
- Custom profiles at `~/.remcli/voices/<name>/` (checked first)
- Each profile: `profile.json` (`name`, `ref_text`, `ref_audio`, `ref_duration_sec`, `model`) + ref audio file (3-10 sec OGG/WAV)

**Config** (`~/.remcli/setup.json`): `ttsProvider` (off/edge/qwen3), `ttsEdgeVoice`, `ttsQwenVoiceProfile`

## Code Style (All Packages)

- **4-space indentation** everywhere
- **Strict TypeScript** — no `any`, no untyped code
- **Functional over OOP** — avoid classes where possible
- **Absolute imports** with `@/` alias (maps to `./sources/` in app, `./src/` in CLI)
- **npm** for package management (never yarn)
- **All imports at the top of the file** — never import mid-code
- Prefer `interface` over `type`, avoid enums (use maps)
- Descriptive names with auxiliary verbs: `isLoading`, `hasError`
- No backward compatibility hacks unless explicitly requested
- **Always respond in Russian** — all communication with the user must be in Russian

## Testing

- **Vitest** for all packages
- CLI tests: colocated `.test.ts` files, no mocking, real API calls
- App tests: Vitest

## CI

- **typecheck.yml** — Runs `npm -w remcli-app run typecheck` on PRs/pushes to main
- **cli-smoke-test.yml** — Builds CLI, installs globally, runs `remcli --help/--version/doctor/daemon status` on Linux and Windows (Node 20 & 24)

---

## Базовые принципы

- **Простота**: каждое изменение максимально простое, минимум затронутого кода
- **Без лени**: ищи корневые причины, никаких временных заплаток
- **Минимальное воздействие**: не вноси новых багов, изменяй только необходимое

---

## Workflow оркестрация

### Plan mode по умолчанию
- Входить в plan mode для ЛЮБОЙ нетривиальной задачи (3+ шагов или архитектурные решения)
- Если что-то идёт не так — СТОП и перепланировать, не продолжать вслепую
- Plan mode также для этапов верификации, не только для реализации
- Писать детальные спецификации заранее для снижения неоднозначности

### Стратегия агентов
- Agent Teams — основной механизм для больших задач (лид координирует команду)
- Субагенты (Task tool) — для быстрых исследований, проверок, параллельного анализа
- Одна задача — один агент для фокусной работы
- Для сложных проблем — больше агентов параллельно
- Агент не имеет права списывать найденные ошибки как «не мои» и молча завершаться
- Если ошибка в зоне компетенции/пакете агента — агент обязан исправить её
- Если ошибка вне текущего ownership агента — агент обязан явно сообщить лиду; лид делегирует отдельному агенту
- После любого фикса адверсиальный критик повторно проверяет результат

### Цикл самоулучшения
- После ЛЮБОЙ коррекции от пользователя → обновить .claude/LESSONS.md с паттерном ошибки
- Если сам обнаружил свою ошибку → записать в .claude/LESSONS.md до того как продолжить. Только значимые: архитектурные просчёты, неверные технические решения, сломанная логика, проблемы совместимости. НЕ записывать: опечатки, синтаксис, забытый импорт, мелкие правки
- Писать правила, предотвращающие повторение ошибки
- Проверять .claude/LESSONS.md в начале каждой сессии
- Итерировать до снижения процента ошибок

### Верификация перед завершением
- НИКОГДА не отмечать задачу завершённой без доказательства работоспособности
- Сравнивать поведение до и после изменений (diff)
- Спросить себя: "Одобрит ли это senior инженер?"
- Запустить тесты, проверить логи, продемонстрировать корректность

### Элегантность (сбалансированно)
- Для нетривиальных изменений: "Есть ли более элегантный способ?"
- Если фикс кажется хакерским — переделать элегантно
- Для простых фиксов — не переусложнять

### Автономный баг-фикс
- При баг-репорте — просто чини, не проси за руку
- Указывай на логи, ошибки, падающие тесты — затем исправляй
- Ноль переключений контекста от пользователя
- Чини падающие CI тесты без указаний как именно

### Управление задачами
1. План → plans/PLAN.md с чекбоксами (БЕЗ КОДА!)
2. Проверить план перед реализацией → одобрение пользователя
3. Отмечать выполненное по ходу работы
4. Объяснять изменения на каждом шаге (высокоуровневое резюме)
5. Фиксировать результаты
6. Обновлять .claude/LESSONS.md после коррекций

---

## Оркестрация: Agent Teams

### Включение

settings.json: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1"`

### Архитектура

| Компонент | Роль |
|-----------|------|
| Лидер | Основной сеанс — координирует, синтезирует, НЕ пишет код |
| Тиммейты | Отдельные экземпляры Claude Code, работают независимо |
| Список задач | Общий — тиммейты берут и завершают задачи |
| Почтовый ящик | Обмен сообщениями между агентами |

### Роль: Техлид

- Координирует — НЕ пишет код сам
- Shift+Tab для режима делегирования
- Shift+Up/Down для общения с тиммейтами
- Сравнивает результаты тиммейтов перед принятием

### Agent Teams vs Субагенты

| Когда | Механизм |
|-------|---------|
| Большая задача, нужна координация команды | Agent Teams |
| Быстрое исследование, проверка, параллельный анализ | Субагенты (Task tool) |
| Тиммейту нужно исследование внутри своей задачи | Субагент из тиммейта — НЕЛЬЗЯ (ограничение) |

### Workflow задачи (9 фаз)

**Фаза 1: Анализ** → code-architect
- Анализ ТЗ на ошибки и неоднозначности

**Фаза 2: Исследование** → code-explorer (2-3 параллельно)
- Каждый исследует свою область кодабейса
- Результат: список файлов + резюме архитектуры

**Фаза 3: Уточнение** → Лид → пользователь
- Уточняющие вопросы на основе анализа

**Фаза 4: Планирование** → Лид
- plans/PLAN.md (БЕЗ КОДА!) → **одобрение пользователя**
- Лид говорит: кто что будет делать

**Фаза 5: Реализация** → backend-dev + frontend-dev **ПАРАЛЛЕЛЬНО**
- Каждый читает PLAN.md и реализует свою часть
- backend-dev: API, БД, миграции, бизнес-логика
- frontend-dev: UI, компоненты, страницы, стили

**Фаза 6: Тестирование** → tester
- Лид назначает тестировщика
- **Критерий успеха: тесты проходят, coverage не упал**
- Только после этого задача может быть завершена

**Фаза 7: DevOps** (если нужен деплой) → devops-automation
- Настройка инфраструктуры, CI/CD

**Фаза 8: Code Review** (опционально) → code-reviewer
- Ревью реализации, confidence ≥80%

**Фаза 9: Итоги** → Лид
- Обновление PLAN.md с результатами
- Обновление .claude/LESSONS.md с паттернами

### Артефакты задачи

```
.claude/
└── LESSONS.md          # Уроки и паттерны ошибок (постоянный)

plans/
└── PLAN.md             # План реализации (БЕЗ КОДА!)
```

### Правила PLAN.md

- ЗАПРЕЩЕНО писать код проекта в PLAN.md
- Только описания задач, чеклисты, назначения, зависимости

### Best practices

- Давай тиммейтам полный контекст (они НЕ наследуют историю лида, но читают CLAUDE.md и skills)
- 5-6 задач на тиммейта — оптимально
- Избегай конфликтов файлов — каждый тиммейт владеет своим набором
- Ждать завершения тиммейтов, не реализовывать самому
- Начинай с исследования, потом реализация

### Когда НЕ использовать Agent Teams

| Задача | Подход |
|--------|--------|
| Большая фича с нуля | Agent Teams |
| Параллельная работа (backend + frontend) | Agent Teams |
| Простой баг-фикс / мелкая правка | Одиночный режим |

---

## Документация AI-агентов (ОБЯЗАТЕЛЬНО)

При работе с интеграцией AI-агентов, новом функционале или вопросах — **сначала проверяй актуальную документацию**:

| Агент | Документация | Когда смотреть |
|-------|-------------|----------------|
| Claude Code | https://code.claude.com/docs/en/ | SDK, CLI flags, --resume, remote-control, sessions, hooks |
| Cursor | https://cursor.com/en/docs/ | agent CLI, --resume, cloud mode, sandbox |
| Gemini CLI | https://geminicli.com/docs/ | --resume, --list-sessions, checkpointing, extensions |
| Codex CLI | https://developers.openai.com/codex/cli | resume, sessions, MCP, policies |

Также используй `context7` MCP для получения актуальной документации по любой библиотеке.

## MCP серверы (ОБЯЗАТЕЛЬНО)

| MCP | Когда |
|-----|-------|
| `context7` | ПЕРЕД работой с любой библиотекой или AI-агентом |
| `pg-aiguide` | Table design, pgvector, hybrid search, TimescaleDB, документация PG |
| `postgres-best-practices` (skill) | Query perf, connections, RLS, locking, monitoring — читай references/ |
| `MCP Docker` | Логи, состояние контейнеров |

---

## Агенты и Skills

### Тиммейты (`.claude/agents/`)

| Агент | Описание |
|-------|----------|
| **backend-dev** | Бэкенд, API, БД, миграции |
| **frontend-dev** | UI/UX, React, Tailwind, shadcn |
| **devops-automation** | Cloud, Docker, K8s, CI/CD |
| **code-explorer** | Трассировка кода, архитектура |
| **code-architect** | Проектирование (2-3 подхода) |
| **code-reviewer** | Code review (confidence ≥80%) |
| **tester** | Тесты, QA, coverage |

### Skills (`.claude/skills/`)

| Skill | Описание |
|-------|----------|
| **core-standards** | Нейминг, SOLID, дизайн, env, MCP, агенты |
| **backend-standards** | Структура бэкенда, слои, валидация, JWT |
| **frontend-standards** | Структура фронтенда, эстетика |
| **devops-standards** | Terraform, Docker, K8s, CI/CD |
| **react-best-practices** | 45 правил оптимизации React/Next.js |
| **postgres-best-practices** | 30 правил PostgreSQL от Supabase (query, conn, RLS, locking) |
| **logging-standards** | Стандарты логирования |
| **testing-patterns** | Паттерны тестирования |
| **documentation-sync** | Синхронизация документации |
