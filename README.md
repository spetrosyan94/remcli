# Remcli

> Remote Mobile CLI for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://github.com/openai/codex) & [Gemini CLI](https://github.com/google-gemini/gemini-cli)

Управляйте AI-сессиями с телефона. Сквозное шифрование, без облака.

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
- **Claude Code** (`npm install -g @anthropic-ai/claude-code`) и/или [Codex](https://github.com/openai/codex) / [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- **macOS** или **Linux** (Windows через WSL)

### 1. Установка

```bash
git clone https://github.com/spetrosyan94/remcli.git
cd remcli
npm install
```

### 2. Сборка

Соберите CLI и веб-приложение (однократно):

```bash
npm run build:all
```

### 3. Запуск

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

В новом терминале:

```bash
# Claude Code (по умолчанию)
remcli

# Codex
remcli codex

# Gemini CLI
remcli gemini
```

> Если `remcli` не установлен глобально, используйте `node packages/remcli-cli/bin/remcli.mjs` вместо `remcli`.

Сессия появится на телефоне в реальном времени. Можно:

- Читать сообщения и результаты инструментов
- Отправлять промпты
- Одобрять / отклонять запросы на использование инструментов
- Переключаться между сессиями
- Запускать новые сессии удалённо

---

## Доступ через интернет

Для подключения за пределами локальной сети (через ngrok-туннель):

```bash
npm run start:tunnel
```

---

## Команды

### Из корня репозитория

| Команда | Описание |
|---------|----------|
| `npm run build:all` | Сборка CLI + веб-приложения |
| `npm run build` | Только сборка CLI |
| `npm run build:web` | Только сборка веб-приложения |
| `npm start` | Сборка CLI + запуск демона |
| `npm run start:tunnel` | Сборка CLI + запуск с ngrok-туннелем |
| `npm run stop` | Остановить демон |
| `npm run status` | Статус демона |
| `npm run qr` | Показать QR-код повторно |
| `npm run app` | Expo dev server (мобильное приложение) |
| `npm run app:web` | Expo dev server (веб-версия) |
| `npm run typecheck` | Проверка типов приложения |

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

### CLI

```bash
npm run build                              # Сборка
npm run dev --workspace=remcli             # Dev-режим (TSX, без сборки)
npm run test --workspace=remcli            # Тесты
npm run typecheck --workspace=remcli       # Проверка типов
```

### Приложение

```bash
npm run app                                # Expo dev server
npm run app:web                            # Веб-версия (dev)
npm run build:web                          # Продакшн веб-билд
npm run ios --workspace=remcli-app         # iOS симулятор
npm run android --workspace=remcli-app     # Android эмулятор
npm run typecheck                          # Проверка типов
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
