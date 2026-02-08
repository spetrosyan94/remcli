# Remcli

> Remote Mobile CLI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex) & [Gemini CLI](https://github.com/google-gemini/gemini-cli)

Open-source мобильный и веб-клиент для удалённого управления AI CLI-инструментами. Управляйте сессиями Claude Code, Codex и Gemini CLI прямо с телефона — со сквозным шифрованием и без облачных серверов.

Проект вдохновлён [Happy](https://github.com/slopus/happy) — open-source решением той же задачи, но реализует другой подход: вместо облачной архитектуры Remcli использует прямое P2P-соединение, где демон на вашей машине выступает сервером.

```
Телефон  ←── WebSocket (LAN / ngrok) ──→  CLI Daemon  ←──→  Claude Code / Codex / Gemini CLI
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
- **Claude Code** (`npm install -g @anthropic-ai/claude-code`) и/или [Codex](https://github.com/openai/codex) / [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- **macOS** или **Linux** (Windows через WSL)

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

### 4. Подключение с телефона

1. Телефон должен быть в **той же Wi-Fi сети**
2. Откройте камеру и наведите на QR-код
3. Нажмите на ссылку — откроется браузер с веб-приложением
4. Нажмите **Accept** — подключено!

> Демон сам раздаёт веб-приложение. Никакой отдельный сервер не нужен.

### 5. Запуск AI-сессии

Можно запускать сессии с телефона (через веб-интерфейс) — терминал с tmux откроется автоматически. Каждая новая сессия появится как отдельное окно в tmux (переключение: `Ctrl-B n` / `Ctrl-B p`).

Или запустите сессию из терминала вручную:

```bash
npm run claude              # Claude Code
npm run codex               # Codex
npm run gemini              # Gemini CLI
```

Сессия появится и в терминале Mac, и на телефоне. Управлять можно с обоих устройств.

---

## Доступ через интернет

Для подключения за пределами локальной сети (через ngrok-туннель):

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
| `npm run start:tunnel` | Запуск демона через интернет (ngrok) |
| `npm run claude` | Сессия Claude Code (видна на Mac и телефоне) |
| `npm run codex` | Сессия Codex |
| `npm run gemini` | Сессия Gemini CLI |
| `npm run stop` | Остановить демон |
| `npm run status` | Статус демона |
| `npm run qr` | Показать QR-код повторно |

### CLI (после глобальной установки)

```bash
remcli                        # Сессия Claude Code
remcli codex                  # Сессия Codex
remcli gemini                 # Сессия Gemini CLI
remcli daemon start           # Запустить демон
remcli daemon start --tunnel  # Запустить с ngrok
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
  remcli-app/     React Native + Expo — мобильное/веб приложение
docs/             Документация (протокол, шифрование, архитектура)
```

---

## Разработка

Все команды для разработки имеют префикс `dev:`:

| Команда | Описание |
|---------|----------|
| `npm run dev:app` | Expo dev server (мобильное приложение, hot reload) |
| `npm run dev:web` | Expo dev server (веб-версия, hot reload) |
| `npm run dev:cli` | Сборка CLI |
| `npm run dev:typecheck` | Проверка типов приложения |

### Пакетные команды

```bash
npm run dev --workspace=remcli             # CLI dev-режим (TSX, без сборки)
npm run test --workspace=remcli            # CLI тесты
npm run ios --workspace=remcli-app         # iOS симулятор
npm run android --workspace=remcli-app     # Android эмулятор
```

### macOS десктоп (Tauri)

```bash
cd packages/remcli-app
npm run tauri:dev                          # Dev с hot reload
npm run tauri:build:production             # Продакшн сборка
```

---

## Безопасность

- **QR-код** — демон генерирует случайный 32-байтный секрет. Он передаётся только через QR-код в вашем терминале
- **Аутентификация** — обе стороны вычисляют Bearer-токен через `HMAC-SHA256(secret, "p2p-auth")`. Секрет никогда не передаётся по сети
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
