---
name: logging-standards
description: |
  Стандарты структурированного логирования для бэкенд-сервисов.
  Применяй при ЛЮБОЙ работе с логированием — даже если пользователь просто добавляет
  console.log, этот skill объяснит почему нужен structured logging.
  USE THIS SKILL WHEN:
  - Настройке логирования: pino, zerolog, winston, bunyan
  - Добавлении request/response logging middleware
  - Проектировании error logging стратегии
  - Настройке traceId/correlationId для distributed tracing
  - Выборе что логировать (уровни info/warn/error, PII, секреты, sanitization)
  - Отладке проблем в production по логам
  - Настройке log rotation, транспортов, форматов (JSON vs text)
  Ключевые слова: логирование, logging, logger, pino, winston, zerolog, traceId,
  structured logging, request logging, error logging, log levels, middleware, лог.
globs:
  - "**/*logger*"
  - "**/*logging*"
  - "**/*middleware*"
  - "**/error-handler*"
---

# Стандарты логирования

## Как использовать этот skill

При настройке логирования всегда объясняй пользователю **почему** выбран именно такой подход. Не просто показывай код — расскажи зачем структурированные логи вместо console.log, почему traceId критичен для production debugging, почему sanitizeBody обязателен. Пользователь должен понимать принципы, а не просто копировать конфиг.

## Зачем структурированное логирование

**Поиск в production.** JSON-логи индексируются системами (ELK, Loki, CloudWatch). Поиск по
`traceId`, `statusCode`, `path` — секунды вместо часов grep по plaintext.

**Корреляция через traceId.** Один запрос пользователя проходит через API gateway, бэкенд,
БД, внешние сервисы. `traceId` связывает все логи в единую цепочку — критично для
распределённых систем.

**Тело ответа в логах.** Без него для воспроизведения бага нужно повторить запрос в тех же
условиях. С ним — видишь точный ответ сервера в момент ошибки. Экономит часы отладки.

---

## Обязательные поля

| Поле | Тип | Описание |
|------|-----|----------|
| `type` | string | `request`, `response`, `error` |
| `timestamp` | string | ISO 8601 |
| `traceId` | string | UUID для корреляции запросов |
| `method` | string | HTTP метод |
| `path` | string | URL путь |
| `statusCode` | number | HTTP статус (response) |
| `durationMs` | number | Время выполнения в мс |
| `body` | object | Тело ответа (response) — sanitized |
| `error` | object | `name`, `message`, `stack`, `code` |

---

## Уровни логирования

| Уровень | Когда |
|---------|-------|
| `debug` | Детали выполнения (только dev, выключено в prod) |
| `info` | Request/response, бизнес-события, успешные операции |
| `warn` | Потенциальные проблемы, деградация, retries |
| `error` | ВСЕ ошибки — 4xx/5xx, исключения, таймауты, отказы внешних сервисов |

Уровень задаётся через `LOG_LEVEL` env variable. Default: `info` (prod), `debug` (dev).

---

## Правила log.error

ОБЯЗАТЕЛЬНО `log.error` для:
- HTTP статусы 4xx и 5xx (включая валидационные ошибки)
- Все исключения и необработанные ошибки
- Ошибки подключения к БД, Redis, внешним API
- Таймауты и circuit breaker срабатывания
- Невалидные данные от внешних источников

ВСЕГДА включать в error лог:
- `traceId` — для корреляции
- `error.stack` — для локализации
- `error.code` — для классификации
- Контекст: `method`, `path`, `service`

---

## Что НЕ логировать

| Запрещено | Почему |
|-----------|--------|
| Пароли, токены, API ключи | Утечка credentials |
| Номера карт (полные) | PCI DSS |
| PII без маскирования | GDPR/152-ФЗ |
| Секреты из env | Компрометация инфраструктуры |

Используй `sanitizeBody()` — редактирование sensitive полей перед логированием.
Список полей для редактирования: `password`, `token`, `secret`, `apiKey`, `authorization`.

---

## Обязательные требования к сервису

1. **Request logging middleware** — логирует каждый входящий запрос и исходящий ответ
2. **Централизованный error handler** — единая точка логирования ошибок
3. **traceId propagation** — берётся из `X-Trace-Id` header или генерируется
4. **Response body capture** — тело ответа сохраняется и логируется (sanitized)
5. **Sensitive data sanitization** — ДО записи в лог

---

## Реализация по стеку

| Стек | Библиотека | Пример |
|------|-----------|--------|
| Node.js | pino | `references/nodejs.md` |
| Golang | zerolog | `references/golang.md` |

---

## Связи

- **backend-standards** — структура проекта, слои, middleware placement
- **core-standards** — env variables (`LOG_LEVEL`), общие принципы
