# Индекс документации Remcli

Короткая карта документов. Если меняется архитектура агента, протокол, daemon
state или UX-контракт, обновлять соответствующий документ в этом разделе.

## Начать отсюда

| Документ | Что содержит |
|----------|--------------|
| [README](../README.md) | Назначение Remcli, поддерживаемые providers, быстрый старт и команды |
| [PROMO](../PROMO.md) | Короткий текст для анонса проекта |

## Основное

| Документ | Что описывает |
|----------|---------------|
| [protocol.md](protocol.md) | P2P WebSocket/HTTP protocol, payloads, sequencing, concurrency |
| [encryption.md](encryption.md) | Wire encryption, keys, binary formats |
| [p2p-security.md](p2p-security.md) | Модель угроз P2P, request integrity и границы direct LAN |
| [cli-architecture.md](cli-architecture.md) | CLI/daemon lifecycle, session spawning, machine RPC |

## AI-агенты

| Документ | Что описывает |
|----------|---------------|
| [provider-capabilities.md](provider-capabilities.md) | Сводный статус provider integrations: lifecycle, resume, terminal/phone continuity, models, approvals, forms и acceptance gates |
| [agent-architecture/codex-chatgpt-architecture.md](agent-architecture/codex-chatgpt-architecture.md) | Codex app-server, native resume/TUI и capability-driven model/reasoning contract |
| [agent-architecture/cursor-cli-architecture.md](agent-architecture/cursor-cli-architecture.md) | Cursor ACP: session lifecycle, exact models, resume, permissions и ownership |
| [agent-architecture/antigravity-cli-architecture.md](agent-architecture/antigravity-cli-architecture.md) | Antigravity `agy`: stream-json, dynamic account catalog, exact conversation resume и controls |
| [agent-architecture/agent-remote-control-template.md](agent-architecture/agent-remote-control-template.md) | Шаблон для следующих provider-specific архитектур |
