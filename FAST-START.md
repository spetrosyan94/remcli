# remcli — быстрый старт

Все команды выполняются из корня репозитория (`/remcli`).

## Первый запуск

```bash
npm run setup        # зависимости + сборка + мастер настройки (Whisper, TTS, агенты, cloudflared)
```

## Запуск

```bash
npm start            # собрать всё и запустить демон — QR появится в терминале (Ctrl+C — остановить)
npm run start:tunnel # то же + публичный HTTPS-туннель (доступ не из домашней сети)
```

**С телефона:** сканируешь QR камерой → открывается веб-клиент → на iPhone: Поделиться → «На экран "Домой"» — работает как приложение.

## Управление демоном

```bash
npm run stop         # остановить
npm run status       # статус
npm run qr           # показать QR ещё раз
npm run doctor       # диагностика (демон, агенты, голос, логи)
```

## AI-агенты в терминале

```bash
npm run claude       # Claude Code
npm run codex        # Codex
npm run gemini       # Gemini
npm run cursor       # Cursor
```

## Разработка

```bash
npm run dev:web      # веб-клиент с hot reload (Vite)
npm run build        # прод-сборка: веб-клиент + CLI
npm run typecheck    # проверка типов (web + cli)
npm run test         # тесты (web + cli)
```

## Консьерж «Джарвис» (LM Studio)

1. Загрузить модель и запустить сервер: `lms load qwen/qwen3-4b && lms server start`
2. В `~/.remcli/setup.json`: `"conciergeEnabled": true`
3. Переключение модели — поле `"conciergeModel"`: `"qwen/qwen3-4b"` или `"llama-3.2-3b-instruct"` (применяется сразу, без перезапуска)

**Промт и правила**: `packages/remcli-cli/src/daemon/concierge/conciergeService.ts` — `CONCIERGE_SYSTEM_PROMPT` (персона и мягкие правила) + жёсткие ограничения в коде (белый список инструментов, валидация директории, лимиты вызовов — промтом не обходятся).
**Свой характер без правки кода**: `"conciergeExtraPrompt": "..."` в `~/.remcli/setup.json` — добавка к промту, базовые правила отменить не может.
