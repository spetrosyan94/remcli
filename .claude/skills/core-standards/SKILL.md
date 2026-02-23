---
name: core-standards
description: |
  Универсальные стандарты разработки: языковые правила, clean code, SOLID, нейминг,
  env переменные, MCP серверы, правила агентов, дизайн-подход.
  Применяется автоматически при: стандарты, standards, правила, rules, код, code,
  нейминг, naming, переменные, variables, дизайн, design, качество, quality.
user-invocable: false
---

# Универсальные стандарты разработки

Портативный набор правил для любого проекта. Копируй `.claude/skills/core-standards/` в новый проект.

---

## 1. Языковые правила

- **Документация, описания, общение**: на русском языке
- **Код, нейминг, технические обозначения**: на английском языке
- Промпты агентов и их описания — на русском
- Имена файлов, переменных, функций, классов — на английском

---

## 2. Clean Code и SOLID

### SOLID

- **S** — Single Responsibility: один класс/функция — одна ответственность
- **O** — Open/Closed: открыт для расширения, закрыт для изменения
- **L** — Liskov Substitution: подтипы заменяют базовые типы
- **I** — Interface Segregation: много специфичных интерфейсов лучше одного общего
- **D** — Dependency Inversion: зависимость от абстракций, не от реализаций

### Паттерны проектирования (применять по необходимости)

- Repository — для работы с БД
- Service — для бизнес-логики
- Factory — для создания объектов
- Strategy — для взаимозаменяемых алгоритмов
- Observer — для событий

### Чистый код

- Функции делают одну вещь
- Минимум вложенности (early return)
- Комментарии только для "почему", не "что"
- DRY — избегать дублирования
- ЗАПРЕЩЕНО: `// ...`, `// TODO` (без тикета), `// остальной код`, placeholder-комментарии

---

## 3. Нейминг (КРИТИЧЕСКИ ВАЖНО)

Имена должны быть **самодокументирующими**.

| Правило | Хорошо | Плохо |
|---------|--------|-------|
| Функции — глаголы | `getUserBalance`, `calculateBonus` | `userBalance`, `bonus` |
| Переменные — существительные | `userBalance`, `bonusAmount` | `get`, `calc` |
| Без аббревиатур | `transactionId`, `configuration` | `txId`, `cfg` |
| Общепринятые — можно | `id`, `url`, `api`, `db` | `identifier`, `uniformResourceLocator` |
| Boolean — вопрос | `isActive`, `hasAccess`, `canEdit` | `active`, `access`, `edit` |
| Массивы — множественное число | `users`, `orderItems` | `userList`, `orderItemArray` |
| Callbacks — on/handle | `onSubmit`, `handleClick` | `submit`, `click` |

```typescript
// ПЛОХО
const d = getData();
const r = calc(d.a, d.b);
if (r > t) { process(r); }

// ХОРОШО
const userTransaction = getLatestTransaction();
const bonusAmount = calculateBonusFromTransaction(userTransaction.sum, userTransaction.type);
if (bonusAmount > minimumBonusThreshold) {
  applyBonusToUserAccount(bonusAmount);
}
```

---

## 4. Запрет магических чисел и строк

```typescript
// ПЛОХО
if (status === 1) { ... }
if (role === 'admin') { ... }
setTimeout(() => {}, 86400000);

// ХОРОШО
const EStatus = { ACTIVE: 1, INACTIVE: 0 };
const ERoles = { ADMIN: 'admin', USER: 'user' };
const MS_IN_DAY = 24 * 60 * 60 * 1000;

if (status === EStatus.ACTIVE) { ... }
if (role === ERoles.ADMIN) { ... }
setTimeout(() => {}, MS_IN_DAY);
```

Все значения выносить в: `constants/`, `config/`, `types/enums/`

---

## 5. Environment Variables

### Структура .env файлов

- `.env.example` — шаблон с комментариями (БЕЗ секретов, в git)
- `.env` — локальные переменные (в .gitignore)

### Формат

```bash
# ============================================================================
# Database Configuration
# ============================================================================
DATABASE_URL=postgresql://user:password@localhost:5432/app

# ============================================================================
# Application Configuration
# ============================================================================
NODE_ENV=development
PORT=3000
LOG_LEVEL=debug

# ============================================================================
# Frontend Configuration (VITE_ prefix обязателен)
# ============================================================================
VITE_API_URL=http://localhost:3000/api/v1
```

- Секции разделять комментариями
- Фронтенд переменные с префиксом `VITE_`
- Валидировать env через zod при старте приложения

---

## 6. MCP серверы (ОБЯЗАТЕЛЬНО)

### context7 — актуальная документация библиотек

```
mcp__context7__resolve-library-id — найти ID библиотеки
mcp__context7__query-docs — получить документацию
```

Использовать ПЕРЕД работой с любым npm пакетом, фреймворком, API.

### pg-aiguide — PostgreSQL и TimescaleDB

```
mcp__pg-aiguide__search_docs — поиск документации PostgreSQL
mcp__pg-aiguide__view_skill — best practices
```

Использовать ПЕРЕД написанием SQL, миграций, EXPLAIN ANALYZE.

### shadcn — компоненты UI (для фронтенда)

Использовать для добавления и кастомизации shadcn/ui компонентов.

---

## 7. Правила для агентов

### Уточняющие вопросы

Все агенты ОБЯЗАНЫ задавать уточняющие вопросы перед реализацией:
- Анализируй идею проекта
- Используй `AskUserQuestion` для сбора информации
- Не делай предположений — спрашивай

### Актуальные библиотеки

- Проверяй через `mcp__context7__query-docs` перед использованием
- Используй LTS версии для production
- Следуй best practices из официальной документации

### Обязательное тестирование

После реализации функционала ОБЯЗАТЕЛЬНО покрывай тестами:
- **Бэкенд**: unit для логики, integration для API, тесты для БД
- **Фронтенд**: unit для утилит/хуков, component для UI

### Передача информации планировщику

После сбора требований: сформировать резюме → передать в plan mode → дождаться утверждения → реализовать.

---

## 8. Дизайн-подход: Избегаем "AI Slop"

### ЗАПРЕЩЕНО (AI Slop)

- Generic шрифты: Inter, Roboto, Arial, system fonts
- Стандартные палитры shadcn без кастомизации
- Фиолетовые градиенты на белом фоне
- Предсказуемые layouts и шаблонные компоненты
- Однотонные белые/серые фоны без характера

### Что делать вместо этого

- Выбирать смелое эстетическое направление для каждого проекта
- Использовать уникальные шрифты из Google Fonts
- Создавать кастомные цветовые палитры
- Добавлять текстуры, градиенты, визуальные эффекты
- Каждый проект = уникальный визуальный язык

### Варианты эстетики (выбрать один)

Brutally minimal / Maximalist chaos / Retro-futuristic / Organic-natural / Luxury-refined / Playful-toy / Editorial-magazine / Brutalist-raw / Art deco-geometric / Soft-pastel / Industrial-utilitarian / Cyberpunk-neon

---

## 9. Аутентификация

### JWT паттерн

- Access token: короткий срок (15 мин)
- Refresh token: длинный срок (7 дней)
- Хранение: httpOnly cookies или Authorization header
