---
name: logging-standards
description: |
  Стандарты логирования для бэкенд-сервисов.
  Применяется автоматически при: логирование, logging, логи, logs, трейсинг, tracing,
  мониторинг, monitoring, отладка, debug, запросы, requests, ответы, responses, error.
---

# Стандарты логирования

## Обязательные требования

Каждый бэкенд-сервис ДОЛЖЕН логировать:
1. **Входящие запросы** — метод, путь, traceId, тело запроса
2. **Исходящие ответы** — статус код, traceId, время выполнения, **тело ответа**
3. **Ошибки** — log.error для всех исключений с полным стеком

## Структура логов

### Обязательные поля

| Поле | Тип | Описание |
|------|-----|----------|
| `type` | string | `request`, `response`, `error` |
| `timestamp` | string | ISO 8601 формат |
| `traceId` | string | ID для корреляции |
| `method` | string | HTTP метод |
| `path` | string | URL путь |
| `statusCode` | number | HTTP статус (response) |
| `durationMs` | number | Время выполнения |
| `body` | object | Тело ответа (response) |
| `error` | object | Детали ошибки (error) |

---

## Node.js (pino) — Полный пример

```typescript
import pino from 'pino';
import { randomUUID } from 'crypto';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
});

// Утилита для безопасного логирования body
function sanitizeBody(body: any): any {
  if (!body) return undefined;
  const sanitized = { ...body };
  const sensitiveFields = ['password', 'token', 'secret', 'apiKey', 'authorization'];
  for (const field of sensitiveFields) {
    if (sanitized[field]) sanitized[field] = '[REDACTED]';
  }
  return sanitized;
}

// Middleware для логирования
export function requestLogger(req, res, next) {
  const traceId = req.headers['x-trace-id'] || randomUUID();
  const startTime = Date.now();

  req.traceId = traceId;
  res.setHeader('x-trace-id', traceId);

  // Сохраняем оригинальный метод для перехвата body
  const originalJson = res.json.bind(res);
  let responseBody: any;

  res.json = (body: any) => {
    responseBody = body;
    return originalJson(body);
  };

  // Лог входящего запроса
  logger.info({
    type: 'request',
    method: req.method,
    path: req.url,
    traceId,
    body: sanitizeBody(req.body),
    query: req.query,
    timestamp: new Date().toISOString(),
  });

  // Лог исходящего ответа
  res.on('finish', () => {
    const logData = {
      type: 'response',
      method: req.method,
      path: req.url,
      statusCode: res.statusCode,
      traceId,
      durationMs: Date.now() - startTime,
      body: sanitizeBody(responseBody), // ТЕЛО ОТВЕТА
      timestamp: new Date().toISOString(),
    };

    if (res.statusCode >= 400) {
      logger.error(logData); // ERROR для ошибочных статусов
    } else {
      logger.info(logData);
    }
  });

  next();
}

// Централизованный error handler
export function errorHandler(err, req, res, next) {
  logger.error({
    type: 'error',
    traceId: req.traceId,
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack,
      code: err.code,
    },
    method: req.method,
    path: req.url,
    timestamp: new Date().toISOString(),
  });

  res.status(err.statusCode || 500).json({
    error: {
      message: err.message || 'Internal Server Error',
      code: err.code,
    },
  });
}
```

---

## Golang (zerolog) — Полный пример

```go
package middleware

import (
    "bytes"
    "encoding/json"
    "io"
    "net/http"
    "time"

    "github.com/google/uuid"
    "github.com/rs/zerolog/log"
)

type responseWriter struct {
    http.ResponseWriter
    statusCode int
    body       bytes.Buffer
}

func (rw *responseWriter) WriteHeader(code int) {
    rw.statusCode = code
    rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
    rw.body.Write(b) // Сохраняем тело ответа
    return rw.ResponseWriter.Write(b)
}

func RequestLogger(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        traceId := r.Header.Get("X-Trace-Id")
        if traceId == "" {
            traceId = uuid.New().String()
        }

        startTime := time.Now()

        // Читаем и восстанавливаем body запроса
        var requestBody map[string]interface{}
        if r.Body != nil {
            bodyBytes, _ := io.ReadAll(r.Body)
            r.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
            json.Unmarshal(bodyBytes, &requestBody)
        }

        // Лог входящего запроса
        log.Info().
            Str("type", "request").
            Str("method", r.Method).
            Str("path", r.URL.Path).
            Str("traceId", traceId).
            Interface("body", requestBody).
            Msg("incoming request")

        rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}
        w.Header().Set("X-Trace-Id", traceId)

        next.ServeHTTP(rw, r)

        // Парсим тело ответа
        var responseBody map[string]interface{}
        json.Unmarshal(rw.body.Bytes(), &responseBody)

        duration := time.Since(startTime).Milliseconds()

        // Лог ответа (error для 4xx/5xx)
        logEvent := log.Info()
        if rw.statusCode >= 400 {
            logEvent = log.Error()
        }

        logEvent.
            Str("type", "response").
            Str("method", r.Method).
            Str("path", r.URL.Path).
            Int("statusCode", rw.statusCode).
            Str("traceId", traceId).
            Int64("durationMs", duration).
            Interface("body", responseBody). // ТЕЛО ОТВЕТА
            Msg("outgoing response")
    })
}

// Error handler
func ErrorHandler(err error, traceId string, w http.ResponseWriter) {
    log.Error().
        Str("type", "error").
        Str("traceId", traceId).
        Err(err).
        Stack().
        Msg("error occurred")

    w.WriteHeader(http.StatusInternalServerError)
    json.NewEncoder(w).Encode(map[string]string{
        "error": err.Error(),
    })
}
```

---

## Уровни логирования

| Уровень | Когда использовать |
|---------|-------------------|
| `debug` | Детальная информация (только dev) |
| `info` | Request/response, бизнес-события |
| `warn` | Потенциальные проблемы |
| `error` | **ВСЕ ошибки** — 4xx/5xx статусы, исключения |

## Правила log.error

**ОБЯЗАТЕЛЬНО** использовать `log.error` для:
- HTTP статусы 4xx и 5xx
- Все исключения и необработанные ошибки
- Ошибки подключения к БД/внешним сервисам
- Таймауты
- Невалидные данные от внешних API

```typescript
// Пример: ошибка внешнего сервиса
try {
  const result = await externalApi.call();
} catch (err) {
  logger.error({
    type: 'error',
    traceId,
    service: 'external-api',
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack,
    },
  });
  throw err;
}
```

## Что НЕ логировать

- Пароли, токены, API ключи
- Полные номера карт
- PII без маскирования
- Секретные данные
