---
name: backend-standards
description: |
  Стандарты разработки бэкенда на Node.js: слоёная архитектура (routes->controllers->services->repositories),
  структура проекта, валидация, JWT аутентификация, обработка ошибок, инициализация Fastify.
  Применяй этот skill при ЛЮБОЙ работе с бэкендом — даже если пользователь просто говорит
  "создай API" или "добавь эндпоинт", этот skill содержит архитектурные стандарты проекта.
  USE THIS SKILL WHEN:
  - Создании/модификации бэкенд-сервиса, API, REST endpoints, GraphQL
  - Работе с Fastify, NestJS, Express — роуты, контроллеры, сервисы, репозитории
  - Настройке JWT (access 15min + refresh 7d), auth middleware, httpOnly cookies
  - Валидации через zod, обработке request/response
  - Работе с Prisma, Drizzle, миграциями, seed данными, PostgreSQL, Redis
  - Настройке docker-compose для бэкенда, Dockerfile, env config
  - Проектировании кастомных ошибок (NotFoundError, ValidationError), error handler middleware
  - Настройке CORS, rate limiting, graceful shutdown
  Связанные skills: postgres-best-practices (SQL, индексы), logging-standards (pino, traceId).
  Ключевые слова: backend, бэкенд, api, server, сервер, fastify, nestjs, express,
  controller, service, repository, jwt, auth, validation, zod, prisma, drizzle,
  middleware, migration, seed, docker, postgresql, redis, error handling, endpoint, route.
user-invocable: false
---

# Стандарты Backend разработки

## Как использовать этот skill

При генерации бэкенд-кода всегда объясняй пользователю **почему** выбрана такая архитектура, паттерн или подход. Не просто показывай код — расскажи зачем слои разделены именно так, почему валидация именно на границах, почему dual-token для JWT. Пользователь должен понимать принципы, а не просто копировать boilerplate.

## Связанные skills

- **PostgreSQL**: запросы, схемы, индексы, RLS → skill `postgres-best-practices` / MCP `pg-aiguide`
- **Логирование**: форматы, уровни, трейсинг → skill `logging-standards`
- **Базовые принципы**: SOLID, нейминг, env → skill `core-standards`
- **Тестирование**: unit/integration → skill `testing-patterns`

---

## Структура проекта (Node.js)

```
backend/
├── src/
│   ├── api/                    # API слой
│   │   ├── routes/             # Роуты (endpoints)
│   │   ├── controllers/        # Контроллеры (обработка запросов)
│   │   └── middleware/         # Middleware (auth, validation, logging)
│   ├── services/               # Бизнес-логика
│   ├── repositories/           # Работа с БД
│   ├── db/                     # Конфигурация БД (client, migrations, seed)
│   ├── lib/                    # Утилиты (logger, errors, jwt)
│   ├── config/                 # Environment, константы
│   ├── types/                  # TypeScript типы (api.types.ts, db.types.ts)
│   └── app.ts                  # Точка входа
├── tests/                      # unit/ + integration/ + setup.ts
├── prisma/                     # Prisma (если используется)
├── Dockerfile
├── package.json
└── tsconfig.json
```

---

## Архитектура слоёв

```
Request → Routes → Controllers → Services → Repositories → Database
                        ↓
                   Middleware (auth, validation, logging)
```

### Почему слои

Слоистая архитектура решает три проблемы:

1. **Тестируемость** — сервисы тестируются без HTTP, репозитории мокаются. Без слоёв приходится поднимать весь сервер для каждого теста.
2. **Заменяемость** — переход с Prisma на Drizzle затрагивает только repositories. Смена Fastify на Hono — только routes/controllers.
3. **Читаемость** — новый разработчик сразу понимает где искать бизнес-логику (services), а где работу с БД (repositories).

### Ответственность каждого слоя

| Слой | Что делает | Чего не делает |
|------|-----------|----------------|
| **Routes** | Маппинг URL → controller, подключение middleware | Бизнес-логика, прямой доступ к БД |
| **Controllers** | Парсинг request, вызов service, формирование response | SQL запросы, сложная логика |
| **Services** | Бизнес-правила, оркестрация, транзакции | Знание о HTTP (req/reply), прямой SQL |
| **Repositories** | CRUD, сложные запросы, работа с ORM | Бизнес-логика, HTTP |

> Примеры кода для каждого слоя → `references/layers.md`

---

## Валидация

Валидация на границах системы (API endpoints, env при старте) — это единственное место, где стоит валидировать. Внутренний код доверяет типам TypeScript.

Используй **zod** для:
- Тел запросов (body), параметров (params), query
- Environment variables при старте приложения
- Ответов от внешних API (если не доверяешь)

Паттерн: схемы живут в `types/api.types.ts`, типы выводятся через `z.infer`.

> Примеры схем и middleware валидации → `references/layers.md` (секция "Валидация")

---

## Обработка ошибок

Иерархия кастомных ошибок позволяет:
- Возвращать правильные HTTP коды без if/else цепочек
- Логировать ошибки единообразно в одном месте
- Скрывать внутренние детали от клиента (500 → generic message)

Базовая иерархия: `AppError` → `NotFoundError`, `ValidationError`, `UnauthorizedError`, `ForbiddenError`.
Error handler middleware ловит все ошибки, логирует и возвращает стандартизированный JSON.

> Полные примеры ошибок и error handler → `references/errors.md`

---

## Аутентификация (JWT)

Паттерн dual-token:
- **Access token** (15 мин) — короткоживущий, для авторизации запросов
- **Refresh token** (7 дней) — для обновления access token без повторного логина

Почему именно так: компромисс между безопасностью (украденный access token быстро истекает) и UX (пользователь не перелогинивается каждые 15 минут).

Хранение: httpOnly cookies (защита от XSS) или Authorization header (для мобильных/SPA).

> JWT утилиты, auth middleware, auth controller → `references/auth.md`

---

## Инициализация и конфигурация

- **Environment**: валидация через zod при старте — приложение падает сразу если переменные не валидны, а не через час при первом обращении
- **Fastify bootstrap**: plugins → middleware → routes → listen
- **CORS**: настраивается через env (CORS_ORIGIN)

> Примеры env.ts и app.ts → `references/setup.md`

---

## Best Practices

### Код
- TypeScript strict mode — ловит ошибки на этапе компиляции
- Zod для валидации на границах (API, env) — единый источник правды для типов и валидации
- Dependency Injection для тестируемости — сервисы принимают зависимости, а не создают их
- Async/await везде — callbacks создают "pyramid of doom"

### БД
- Prisma или Drizzle ORM — типобезопасность и миграции из коробки
- Миграции для всех изменений схемы — воспроизводимость на любом окружении
- Индексы на часто запрашиваемые поля — без них full table scan на каждый запрос
- Транзакции для связанных операций — частичные записи хуже полного отката
- Подробнее → skill `postgres-best-practices`, MCP `pg-aiguide`

### Безопасность
- Параметризованные запросы через ORM — защита от SQL injection
- Rate limiting — защита от brute force и DDoS
- Helmet для HTTP headers — базовая защита от XSS, clickjacking
- Валидация всех входных данных — никогда не доверяй клиенту

### Тесты
- Unit-тесты для services — бизнес-логика покрыта
- Integration-тесты для API — endpoints работают end-to-end
- Моки для внешних сервисов — тесты не зависят от third-party
- Отдельная БД для тестов — изоляция от dev данных
- Подробнее → skill `testing-patterns`
