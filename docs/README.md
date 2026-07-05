# Документация Remcli

Внутренняя документация Remcli — протокол, шифрование, архитектура CLI и
provider-specific архитектура AI-агентов.

Основной индекс: [index.md](index.md).

## Оглавление

| Документ | Описание |
|----------|----------|
| [protocol.md](protocol.md) | Сетевой протокол (WebSocket/HTTP), форматы payload, секвенирование, конкурентность |
| [encryption.md](encryption.md) | Схемы шифрования, бинарные форматы, обёртывание ключей, кодирование на проводе |
| [cli-architecture.md](cli-architecture.md) | Поток запуска CLI, жизненный цикл демона, управление сессиями, RPC |
| [agent-architecture/codex-chatgpt-architecture.md](agent-architecture/codex-chatgpt-architecture.md) | Архитектура Codex/ChatGPT через официальный Codex app-server |
| [agent-architecture/agent-remote-control-template.md](agent-architecture/agent-remote-control-template.md) | Шаблон документации для следующих AI-агентов |

## Соглашения

- Пути и имена полей соответствуют текущей реализации в `packages/remcli-cli`.
- Демон запускает встроенный P2P-сервер (Fastify + Socket.IO) — отдельного серверного пакета нет.
- Демон также раздаёт сборку веб-приложения (`packages/remcli-web/dist/` или bundled `web-dist/`) как статические файлы через `@fastify/static`, с SPA-fallback для клиентского роутинга.
- Клиентская часть живёт в web-only пакете `remcli-web` (Vite + React + PWA).
- Примеры иллюстративны; канонический источник — код.
