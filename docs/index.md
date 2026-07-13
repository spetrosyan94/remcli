# Индекс документации Remcli

Короткая карта документов. Если меняется архитектура агента, протокол, daemon
state или UX-контракт, обновлять соответствующий документ в этом разделе.

## Core

| Документ | Что описывает |
|----------|---------------|
| [protocol.md](protocol.md) | P2P WebSocket/HTTP protocol, payloads, sequencing, concurrency |
| [encryption.md](encryption.md) | Wire encryption, keys, binary formats |
| [cli-architecture.md](cli-architecture.md) | CLI/daemon lifecycle, session spawning, machine RPC |

## AI Agents

| Документ | Что описывает |
|----------|---------------|
| [agent-architecture/codex-chatgpt-architecture.md](agent-architecture/codex-chatgpt-architecture.md) | Удалённое управление Codex/ChatGPT через официальный Codex app-server |
| [agent-architecture/agent-remote-control-template.md](agent-architecture/agent-remote-control-template.md) | Шаблон для следующих provider-specific архитектур |

## Local Rules

| Документ | Что описывает |
|----------|---------------|
| [../CLAUDE.md](../CLAUDE.md) | Основные проектные правила, агентская оркестрация, docs routing |
| [../AGENTS.md](../AGENTS.md) | Codex-адаптация правил проекта |
| [../.claude/LESSONS.md](../.claude/LESSONS.md) | Накопленные ошибки и обязательные уроки |
