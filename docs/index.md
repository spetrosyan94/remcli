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
| [cli-architecture.md](cli-architecture.md) | CLI/daemon lifecycle, session spawning, machine RPC |

## AI-агенты

| Документ | Что описывает |
|----------|---------------|
| [agent-architecture/codex-chatgpt-architecture.md](agent-architecture/codex-chatgpt-architecture.md) | Codex app-server, native resume/TUI и capability-driven model/reasoning contract |
| [agent-architecture/cursor-cli-architecture.md](agent-architecture/cursor-cli-architecture.md) | Native Cursor Agent CLI: turn boundary, resume identity, уровень доступа и lifecycle |
| [agent-architecture/agent-remote-control-template.md](agent-architecture/agent-remote-control-template.md) | Шаблон для следующих provider-specific архитектур |
