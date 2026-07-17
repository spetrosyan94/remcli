# Remcli

> Remote CLI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex) & [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Cursor](https://cursor.com/cli)

Open-source Remote CLI для удалённого управления AI агентами. Управляйте сессиями Claude Code, Cursor, Codex и Gemini CLI прямо с телефона — со сквозным шифрованием и без облачных серверов.

Проект вдохновлён [Happy](https://github.com/slopus/happy) — open-source решением той же задачи, но реализует другой подход: вместо облачной архитектуры Remcli использует прямое P2P-соединение, где демон на вашей машине выступает сервером.

```
Телефон  ←── WebSocket (LAN / cloudflared) ──→  CLI Daemon  ←──→  Claude Code / Cursor / Codex / Gemini CLI
```

---

## Как это работает

1. На Mac (или Linux) запускается демон — локальный P2P-сервер
2. В терминале появляется QR-код (это URL)
3. Сканируете QR камерой телефона — открывается браузер
4. Нажимаете **Accept** — подключено! Все данные зашифрованы end-to-end
5. Видите и управляете AI-сессиями прямо с телефона

Демон работает на вашей машине. Никаких облачных серверов.

---

## Быстрый старт

### Требования

- **Node.js** 20+
- **tmux** (`brew install tmux` на macOS, `apt install tmux` на Linux)
- **Claude Code** (`npm install -g @anthropic-ai/claude-code`) и/или [Cursor CLI](https://cursor.com/cli) / [Codex](https://github.com/openai/codex) / [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- **macOS** или **Linux** (Windows через WSL)

> Docker и Linux Playwright image не нужны пользователю Remcli: они применяются
> только разработчиками и GitHub CI для детерминированной визуальной проверки.
> Установка, daemon, web/PWA-клиент и обычный запуск Remcli их не скачивают.

### 1. Установка и сборка

```bash
git clone https://github.com/spetrosyan94/remcli.git
cd remcli
npm run setup
```

### 2. Запуск

```bash
npm start
```

В терминале появится QR-код. Не закрывайте этот терминал — демон работает в нём.

### 3. Подключение с телефона

1. Телефон должен быть в **той же Wi-Fi сети**
2. Откройте камеру и наведите на QR-код
3. Нажмите на ссылку — откроется браузер с веб-приложением
4. Нажмите **Accept** — подключено!

> Демон сам раздаёт веб-приложение. Никакой отдельный сервер не нужен.

### 4. Запуск AI-сессии

Можно запускать сессии с телефона (через веб-интерфейс) — терминал с tmux откроется автоматически. Каждая новая сессия появится как отдельное окно в tmux (переключение: `Ctrl-B n` / `Ctrl-B p`).

Или запустите сессию из терминала вручную:

```bash
npm run claude              # Claude Code
npm run cursor              # Cursor
npm run codex               # Codex
npm run gemini              # Gemini CLI
```

Сессия появится и в терминале Mac, и на телефоне. Управлять можно с обоих устройств.

### Возобновление сессий (Resume)

| Агент | Resume |
|-------|--------|
| Claude Code | Полный — `--resume` с восстановлением истории |
| Cursor | Полный — `agent --resume` |
| Gemini | Полный — через ACP `session/load` (с фолбэком на новую сессию) |
| Codex | Поддерживается — Remcli использует официальный Codex app-server: shared daemon WebSocket endpoint предпочтителен; при stale state или initial transient WebSocket connect failure используется typed private stdio fallback. `thread/start`/`thread/resume`, `turn/start` и `turn/steer` работают с тем же `threadId`. `codex mcp-server` и `codex-reply` не используются для chat/resume transport; `remcli-mcp` остаётся отдельным tool bridge |

---

## Доступ через интернет

Для подключения за пределами локальной сети (через cloudflared-туннель):

```bash
npm run start:tunnel
```

---

## Команды

| Команда | Описание |
|---------|----------|
| `npm run setup` | Первоначальная установка (install + сборка) |
| `npm run build:web` | Пересборка CLI + веб-приложения |
| `npm start` | Запуск демона (LAN) |
| `npm run start:tunnel` | Запуск демона через интернет (cloudflared) |
| `npm run claude` | Сессия Claude Code (видна на Mac и телефоне) |
| `npm run cursor` | Сессия Cursor |
| `npm run codex` | Сессия Codex |
| `npm run gemini` | Сессия Gemini CLI |
| `npm run stop` | Остановить демон |
| `npm run status` | Статус демона |
| `npm run qr` | Показать QR-код повторно |

### CLI (после глобальной установки)

```bash
remcli setup                  # Мастер настройки (Whisper, TTS, агенты, cloudflared)
remcli                        # Сессия Claude Code
remcli cursor                 # Сессия Cursor
remcli codex                  # Сессия Codex
remcli gemini                 # Сессия Gemini CLI
remcli daemon start           # Запустить демон
remcli daemon start --tunnel  # Запустить с cloudflared
remcli daemon stop            # Остановить демон
remcli daemon status          # Статус
remcli daemon qr              # Показать QR повторно
remcli doctor                 # Диагностика
remcli doctor clean           # Убить зависшие процессы
```

---

## Глобальная установка (опционально)

Чтобы команда `remcli` работала из любой директории:

```bash
npm run build
cd packages/remcli-cli && npm link
```

---

## Структура проекта

```
packages/
  remcli-cli/     CLI + демон (публикуется как remcli в npm)
  remcli-web/     Web-клиент — Vite + React + shadcn/ui, PWA
docs/             Документация (протокол, шифрование, архитектура)
```

> **Направление:** клиентская часть теперь web-only: активный UI живёт в `packages/remcli-web`.

---

## Разработка

| Команда | Описание |
|---------|----------|
| `npm run dev:web` | Vite dev server для web-клиента |
| `npm run build` | Сборка web-клиента и CLI |
| `npm run typecheck` | Проверка типов web-клиента и CLI |
| `npm run test` | Тесты web-клиента и CLI |

### Пакетные команды

```bash
npm run dev --workspace=remcli             # CLI dev-режим (TSX, без сборки)
npm run test --workspace=remcli            # CLI тесты
npm -w remcli-web run dev                  # Web UI
npm -w remcli-web run test                 # Web тесты
```

### Структура CLI-тестов

- Unit-тесты остаются рядом с исходным кодом: `packages/remcli-cli/src/**/*.test.ts`
- Integration-тесты находятся отдельно: `packages/remcli-cli/tests/integration/**/*.test.ts`
- E2E-тесты добавляются в `packages/remcli-cli/tests/e2e/**/*.test.ts`

## Голосовой ввод (Whisper STT)

Remcli поддерживает голосовой ввод — нажмите кнопку микрофона в сессии, произнесите команду, и транскрибированный текст отправится AI-агенту.

- **Полностью локальная** транскрипция — данные не покидают вашу машину
- **whisper.cpp** через native N-API bindings (`smart-whisper`) — скорость ~1-3 сек на модели `base`
- Модель `ggml-base.bin` (~142MB) скачивается автоматически при первом использовании в `~/.remcli/models/`
- **ffmpeg** необходим для конвертации аудио (`brew install ffmpeg`)

Голосовые сообщения отмечаются в чате иконкой 🎤 и фиолетовым пузырём.

---

## Озвучка ответов (TTS)

Кнопка **Listen** на сообщении агента синтезирует речь на стороне демона (формат OGG Opus):

- **edge-tts** (по умолчанию) — Microsoft Edge TTS, бесплатно, без настройки. Голос выбирается автоматически по языку ответа (`ttsEdgeVoice: 'auto'`), нужен ffmpeg
- **qwen3-tts** — локальный синтез с клонированием голоса (только Apple Silicon, ~1.7GB RAM)

Провайдер выбирается в `remcli setup`.

---

## Локальный консьерж (LM Studio)

Опциональный LLM-ассистент «Джарвис» внутри демона (выключен по умолчанию: `conciergeEnabled` в `~/.remcli/setup.json`). Подключается к LM Studio (или любому OpenAI-совместимому API, по умолчанию `http://127.0.0.1:1234/v1`) и через function calling умеет:

- показать статус сессий и демона
- запустить агент-сессию — только по явной просьбе пользователя

**Промт, правила и ограничения** — `packages/remcli-cli/src/daemon/concierge/conciergeService.ts`:

- `CONCIERGE_SYSTEM_PROMPT` — персона (Джарвис) и мягкие правила: отвечать на языке пользователя, не выдумывать данные, только статус/запуск/помощь
- Жёсткие ограничения зашиты в код и промтом не обходятся: белый список из 3 инструментов (`CONCIERGE_TOOLS`), валидация агента и директории до запуска, максимум 4 LLM-раунда × 5 tool-вызовов, один запуск сессии на диалог
- Своя добавка к промту без правки кода: `"conciergeExtraPrompt"` в `~/.remcli/setup.json` — добавляется после базовых правил и не может их отменить

Детали API — в `docs/protocol.md`.

---

## Безопасность

- **QR-код** — демон создаёт или переиспользует persistent pairing: 32-байтный секрет и preferred port в `~/.remcli/p2p-pairing.json` с правами 0600. QR нужен для первого сопряжения или после `remcli daemon rekey`
- **Аутентификация** — обе стороны вычисляют Bearer-токен через `HMAC-SHA512(secret, "p2p-auth").digest("hex")`. Секрет никогда не передаётся по сети; `daemon.state.json` тоже пишется с правами 0600, потому что содержит активный `p2pSharedSecret` для локальных CLI-сессий
- **Шифрование** — все данные сессий зашифрованы AES-256-GCM (ключи на сессию) или XSalsa20-Poly1305
- **Локальность** — P2P-сервер работает на вашей машине. Данные не покидают локальную сеть (кроме режима `--tunnel`)

Подробнее: [docs/encryption.md](docs/encryption.md)

---

## Документация

- [Протокол](docs/protocol.md) — WebSocket/HTTP API, формат сообщений, sequencing
- [Шифрование](docs/encryption.md) — схемы шифрования, binary layouts, key wrapping
- [Архитектура CLI](docs/cli-architecture.md) — устройство демона, сессий, RPC

---

## Лицензия

MIT
