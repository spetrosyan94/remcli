---
name: testing-patterns
description: |
  Паттерны тестирования, настройка инструментов, mock factories, проверка актуальности тестов.
  Применяй при ЛЮБОЙ работе с тестами — написание, настройка, дебаг, ревью.
  USE THIS SKILL WHEN:
  - Написании unit/integration/e2e тестов для любого модуля
  - Настройке vitest, jest, playwright с нуля -> see references/
  - Тестировании React компонентов с Testing Library
  - Создании mock data factories (fishery pattern)
  - Проверке/улучшении test coverage
  - Ревью/обновлении существующих тестов после изменений кода
  - Дебаге падающих или flaky тестов
  - Настройке CI для тестов (parallel, sharding, coverage thresholds)
  Ключевые слова: тесты, testing, test, coverage, мок, mock, vitest, jest, playwright,
  spec, describe, it, expect, assert, fixture, factory, e2e, integration, unit test,
  testing library, react testing, тестирование.
---

# Паттерны тестирования

## Зачем тесты

Тесты -- не бюрократия. Это инструмент инженера:

- **Уверенность при рефакторинге** -- меняешь внутреннюю реализацию, тесты подтверждают, что контракт не сломан.
- **Документация ожидаемого поведения** -- describe/it блоки читаются как спецификация. Новый разработчик понимает модуль через тесты быстрее, чем через код.
- **Ловля регрессий до пользователей** -- баг, пойманный в CI, стоит в 100 раз дешевле бага в продакшене.
- **Ускорение разработки** -- кажется парадоксом, но тесты позволяют менять код агрессивнее и быстрее, без ручной проверки каждого сценария.

## Структура тестов

### Бэкенд (Node.js)
```
backend/
├── src/
│   └── modules/
│       └── users/
│           ├── users.service.ts
│           └── users.service.spec.ts   # Unit-тесты рядом с кодом
├── test/
│   ├── factories/                       # Mock data factories
│   │   └── user.factory.ts
│   ├── helpers/                          # Утилиты для тестов
│   │   └── test-db.ts
│   ├── integration/                      # Integration-тесты
│   │   └── users.integration.spec.ts
│   └── e2e/                              # End-to-end тесты
│       └── users.e2e.spec.ts
```

### Фронтенд (React)
```
frontend/
├── src/
│   └── components/
│       └── Button/
│           ├── Button.tsx
│           └── Button.test.tsx          # Component-тесты рядом с компонентом
├── tests/
│   └── integration/                      # Integration-тесты
```

## Типы тестов

| Тип | Что тестирует | Примеры | Скорость |
|-----|---------------|---------|----------|
| Unit | Изолированная логика | Сервисы, утилиты, хуки | Мс |
| Integration | Взаимодействие модулей | API endpoints + DB | Секунды |
| Component | UI компоненты | Рендеринг, user events | Мс |
| E2E | Полные сценарии | Регистрация, покупка | Десятки секунд |

## Vitest: настройка и запуск

Vitest -- стандартный тест-раннер для проектов на Vite (и не только). Подробная конфигурация: `references/vitest-setup.md`.

```typescript
// vitest.config.ts -- минимальный пример
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node', // или 'jsdom' для фронтенда
    setupFiles: ['./test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 80,
        lines: 80,
      },
    },
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
```

```json
// package.json scripts
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "test:ui": "vitest --ui"
  }
}
```

## React Testing Library

Стандарт для тестирования React компонентов. Подробные паттерны: `references/react-testing.md`.

```typescript
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UserCard } from './UserCard';

describe('UserCard', () => {
  it('should display user name and email', () => {
    render(<UserCard name="Alice" email="alice@example.com" />);

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('alice@example.com')).toBeInTheDocument();
  });

  it('should call onEdit when edit button clicked', async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();

    render(<UserCard name="Alice" email="alice@example.com" onEdit={onEdit} />);
    await user.click(screen.getByRole('button', { name: /edit/i }));

    expect(onEdit).toHaveBeenCalledOnce();
  });
});
```

**Правила:**
- Запрашивай элементы через `getByRole`, `getByLabelText`, `getByText` -- в порядке приоритета.
- Не используй `getByTestId` кроме крайних случаев -- это не то, что видит пользователь.
- `userEvent` вместо `fireEvent` -- он точнее имитирует реальное поведение.
- `waitFor` и `findBy*` для асинхронных операций.

## Integration-тесты API (supertest + test DB)

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { buildApp } from '@/app';
import { resetDatabase } from '../helpers/test-db';

describe('POST /api/users', () => {
  let app: ReturnType<typeof buildApp>;
  let request: supertest.SuperTest<supertest.Test>;

  beforeAll(async () => {
    app = buildApp({ database: process.env.TEST_DATABASE_URL });
    await app.ready();
    request = supertest(app.server);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  it('should create user and return 201', async () => {
    const res = await request
      .post('/api/users')
      .send({ email: 'new@test.com', name: 'New User', password: 'Str0ng!Pass' })
      .expect(201);

    expect(res.body).toMatchObject({
      id: expect.any(String),
      email: 'new@test.com',
      name: 'New User',
    });
    expect(res.body).not.toHaveProperty('password');
  });

  it('should return 409 when email already exists', async () => {
    await request.post('/api/users').send({
      email: 'dup@test.com', name: 'First', password: 'Str0ng!Pass',
    });
    await request.post('/api/users').send({
      email: 'dup@test.com', name: 'Second', password: 'Str0ng!Pass',
    }).expect(409);
  });
});
```

Паттерны API-тестирования также описаны в skill `backend-standards`.

## Изоляция тестов

Тесты ОБЯЗАНЫ быть независимы. Порядок выполнения не должен влиять на результат.

### DB-изоляция через транзакции

```typescript
// test/helpers/test-db.ts
import { prisma } from '@/lib/prisma';

export async function resetDatabase() {
  // TRUNCATE CASCADE для полной очистки
  const tablenames = await prisma.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `;

  for (const { tablename } of tablenames) {
    if (tablename !== '_prisma_migrations') {
      await prisma.$executeRawUnsafe(`TRUNCATE TABLE "public"."${tablename}" CASCADE;`);
    }
  }
}

// Альтернатива: транзакция с откатом (быстрее)
export function withTestTransaction(fn: (tx: PrismaClient) => Promise<void>) {
  return async () => {
    await prisma.$transaction(async (tx) => {
      await fn(tx as any);
      throw new RollbackError(); // откат после каждого теста
    }).catch((e) => {
      if (!(e instanceof RollbackError)) throw e;
    });
  };
}
```

### beforeEach / afterEach

```typescript
describe('UserService', () => {
  let service: UserService;

  beforeEach(() => {
    service = new UserService(mockRepository);
    vi.clearAllMocks(); // Сброс всех моков между тестами
  });

  afterEach(() => {
    vi.restoreAllMocks(); // Восстановление оригинальных реализаций
  });
});
```

## Нейминг тестов

```typescript
// Формат: describe → it → should + что делать
describe('UserService', () => {
  describe('createUser', () => {
    it('should create user with valid data', () => {});
    it('should throw error when email already exists', () => {});
    it('should hash password before saving', () => {});
  });
});
```

## Актуальность тест-кейсов

### ОБЯЗАТЕЛЬНО после ЛЮБОГО изменения кода

1. **Проверить тест-кейсы** на соответствие текущей логике
2. **Проверить мок-данные** -- актуальны ли они?
3. **Обновить тесты** если логика изменилась

### Что проверять в тестах

| Аспект | Вопрос |
|--------|--------|
| Позитивные кейсы | Покрыты ли все success сценарии? |
| Негативные кейсы | Покрыты ли все error сценарии? |
| Мок-данные | Соответствуют ли реальной структуре данных? |
| Ожидаемые ответы | Соответствуют ли текущему формату ответа? |
| Edge cases | Покрыты ли граничные случаи? |

### Красные флаги в тестах

- Устаревшие названия полей в мок-данных
- Устаревшие коды ошибок в ожидаемых ответах
- Тесты которые не запускаются (skip)
- Тесты которые всегда проходят (бесполезные)
- Хардкод значений которые изменились в коде

### Чеклист при изменении кода

- [ ] Тесты запускаются?
- [ ] Тесты проходят?
- [ ] Мок-данные соответствуют реальной структуре?
- [ ] Новая логика покрыта тестами?
- [ ] Удалённая логика -- тесты удалены?
- [ ] Edge cases учтены?

## Mock Data Factories

### Зачем фабрики вместо хардкода

- **Типобезопасность** -- TypeScript проверяет соответствие типу, невозможно забыть обязательное поле.
- **Реалистичные данные** -- faker генерирует правдоподобные значения, что ловит баги форматирования.
- **Легкие переопределения** -- в каждом тесте меняешь только то, что важно для сценария. Остальное -- defaults.
- **Единая точка правды** -- поменялась схема User? Обновил фабрику -- все тесты подтянулись.

```typescript
// test/factories/user.factory.ts
import { faker } from '@faker-js/faker';
import type { User } from '@/types';

export const createMockUser = (overrides?: Partial<User>): User => ({
  id: faker.string.uuid(),
  email: faker.internet.email(),
  name: faker.person.fullName(),
  role: 'user',
  createdAt: faker.date.recent(),
  updatedAt: new Date(),
  ...overrides,
});

// Использование в тесте
const admin = createMockUser({ role: 'admin' });
const recentUser = createMockUser({ createdAt: new Date() });
```

### Синхронизация с типами

```typescript
// Мок ДОЛЖЕН соответствовать типу -- TypeScript проверит
import type { User } from '@/types';

const mockUser: User = createMockUser();
// Если тип User изменится -- компиляция упадёт
```

## Coverage: пороги и стратегия

| Метрика | Минимум | Цель |
|---------|---------|------|
| Statements | 80% | 90% |
| Branches | 75% | 85% |
| Functions | 80% | 90% |
| Lines | 80% | 90% |

**Что покрывать в первую очередь:**
1. Бизнес-логика (сервисы, use cases) -- 90%+
2. API endpoints (integration) -- 85%+
3. Утилиты и хелперы -- 90%+
4. React компоненты с логикой -- 80%+
5. Простые presentational компоненты -- достаточно smoke test

**Что НЕ нужно покрывать:**
- Сгенерированный код (Prisma client, GraphQL types)
- Конфигурационные файлы
- Type definitions

## Когда пропускать тесты

```typescript
// Performance-тесты -- не запускать в CI по умолчанию
describe.skipIf(process.env.CI)('Performance benchmarks', () => {
  it('should handle 10k records under 500ms', () => {});
});

// Тесты с внешними API -- пропускать если нет credentials
describe.skipIf(!process.env.STRIPE_TEST_KEY)('Stripe integration', () => {
  it('should create payment intent', () => {});
});

// Flaky тест -- НЕ skip, а ПОЧИНИТЬ или УДАЛИТЬ
// it.skip('flaky test') -- ЗАПРЕЩЕНО оставлять навсегда
// Если skip неизбежен -- добавь TODO с датой и причиной
it.skip('TODO(2026-03-14): fix after Stripe SDK update', () => {});
```

## Дебаг падающих тестов

1. **Читай сообщение об ошибке целиком** -- 80% информации там
2. **Изолируй тест**: `it.only(...)` -- убедись что падает не из-за порядка
3. **Проверь моки**: `vi.clearAllMocks()` в `beforeEach` -- часто причина в утечке состояния
4. **Сравни с кодом**: тест ожидает старый формат? Обнови тест
5. **Проверь async**: забытый `await` -- причина 50% flaky тестов

## Перекрёстные ссылки

- **backend-standards** -- паттерны API тестирования, структура слоёв, валидация
- **vercel-react-best-practices** -- тестирование оптимизаций (memo, useMemo), см. `references/react-testing.md`
- **frontend-standards** -- структура компонентов, что именно тестировать в UI

## Автоматические триггеры

Этот skill применяется при обнаружении ключевых слов:
- `тесты`, `testing`, `test`, `spec`
- `coverage`, `покрытие`
- `мок`, `mock`, `stub`, `factory`
- `vitest`, `jest`, `playwright`
- `актуальность тестов`, `обновить тесты`
- `debug test`, `падает тест`, `failing test`
