---
name: backend-standards
description: |
  Стандарты разработки бэкенда: структура проекта, слои, валидация, аутентификация.
  Применяется автоматически при: backend, бэкенд, api, сервер, server, fastify, nestjs,
  controller, service, repository, jwt, auth, validation, zod, prisma, drizzle.
---

# Стандарты Backend разработки

## Структура проекта (Node.js)

```
backend/
├── src/
│   ├── api/                    # API слой
│   │   ├── routes/             # Роуты (endpoints)
│   │   │   ├── index.ts        # Регистрация всех роутов
│   │   │   ├── users.routes.ts
│   │   │   └── auth.routes.ts
│   │   ├── controllers/        # Контроллеры (обработка запросов)
│   │   │   ├── users.controller.ts
│   │   │   └── auth.controller.ts
│   │   └── middleware/         # Middleware
│   │       ├── auth.middleware.ts
│   │       ├── error.middleware.ts
│   │       └── logger.middleware.ts
│   │
│   ├── services/               # Бизнес-логика
│   │   ├── users.service.ts
│   │   └── auth.service.ts
│   │
│   ├── repositories/           # Работа с БД
│   │   ├── users.repository.ts
│   │   └── base.repository.ts
│   │
│   ├── db/                     # Конфигурация БД
│   │   ├── client.ts           # Prisma/Drizzle client
│   │   ├── migrations/         # Миграции
│   │   └── seed.ts             # Seed данные
│   │
│   ├── lib/                    # Утилиты
│   │   ├── logger.ts           # Логгер (pino)
│   │   ├── errors.ts           # Кастомные ошибки
│   │   └── jwt.ts              # JWT утилиты
│   │
│   ├── config/                 # Конфигурация
│   │   ├── env.ts              # Environment variables
│   │   └── constants.ts        # Константы
│   │
│   ├── types/                  # TypeScript типы
│   │   ├── api.types.ts        # API типы (request/response)
│   │   └── db.types.ts         # DB типы
│   │
│   └── app.ts                  # Точка входа
│
├── tests/                      # Тесты
│   ├── unit/
│   ├── integration/
│   └── setup.ts
│
├── prisma/                     # Prisma (если используется)
│   └── schema.prisma
│
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

### Routes (API endpoints)
```typescript
// src/api/routes/users.routes.ts
import { FastifyInstance } from 'fastify';
import { UsersController } from '../controllers/users.controller';
import { authMiddleware } from '../middleware/auth.middleware';

export async function usersRoutes(app: FastifyInstance) {
  const controller = new UsersController();

  app.get('/users', { preHandler: [authMiddleware] }, controller.getAll);
  app.get('/users/:id', { preHandler: [authMiddleware] }, controller.getById);
  app.post('/users', controller.create);
}
```

### Controllers (обработка запросов)
```typescript
// src/api/controllers/users.controller.ts
import { FastifyRequest, FastifyReply } from 'fastify';
import { UsersService } from '../../services/users.service';
import { CreateUserSchema, TCreateUser } from '../../types/api.types';

export class UsersController {
  private usersService = new UsersService();

  getAll = async (req: FastifyRequest, reply: FastifyReply) => {
    const users = await this.usersService.findAll();
    return reply.send({ data: users });
  };

  create = async (
    req: FastifyRequest<{ Body: TCreateUser }>,
    reply: FastifyReply
  ) => {
    const validated = CreateUserSchema.parse(req.body);
    const user = await this.usersService.create(validated);
    return reply.status(201).send({ data: user });
  };
}
```

### Services (бизнес-логика)
```typescript
// src/services/users.service.ts
import { UsersRepository } from '../repositories/users.repository';
import { TCreateUser, TUser } from '../types/api.types';
import { hashPassword } from '../lib/auth';

export class UsersService {
  private repository = new UsersRepository();

  async findAll(): Promise<TUser[]> {
    return this.repository.findAll();
  }

  async create(data: TCreateUser): Promise<TUser> {
    const hashedPassword = await hashPassword(data.password);
    return this.repository.create({
      ...data,
      password: hashedPassword,
    });
  }
}
```

### Repositories (работа с БД)
```typescript
// src/repositories/users.repository.ts
import { db } from '../db/client';
import { TCreateUser, TUser } from '../types/api.types';

export class UsersRepository {
  async findAll(): Promise<TUser[]> {
    return db.user.findMany();
  }

  async findById(id: string): Promise<TUser | null> {
    return db.user.findUnique({ where: { id } });
  }

  async create(data: TCreateUser): Promise<TUser> {
    return db.user.create({ data });
  }
}
```

---

## Валидация (zod)

### Схемы валидации
```typescript
// src/types/api.types.ts
import { z } from 'zod';

// User schemas
export const CreateUserSchema = z.object({
  email: z.string().email('Неверный формат email'),
  password: z.string().min(8, 'Минимум 8 символов'),
  name: z.string().min(2, 'Минимум 2 символа'),
});

export const UpdateUserSchema = CreateUserSchema.partial();

export const UserIdSchema = z.object({
  id: z.string().uuid('Неверный формат ID'),
});

// Types
export type TCreateUser = z.infer<typeof CreateUserSchema>;
export type TUpdateUser = z.infer<typeof UpdateUserSchema>;
```

### Middleware валидации
```typescript
// src/api/middleware/validate.middleware.ts
import { FastifyRequest, FastifyReply } from 'fastify';
import { ZodSchema, ZodError } from 'zod';
import { ValidationError } from '../../lib/errors';

export function validate(schema: ZodSchema) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      req.body = schema.parse(req.body);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError(error.errors);
      }
      throw error;
    }
  };
}
```

---

## Обработка ошибок

### Кастомные ошибки
```typescript
// src/lib/errors.ts
export class AppError extends Error {
  constructor(
    public message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} не найден`, 404, 'NOT_FOUND');
  }
}

export class ValidationError extends AppError {
  constructor(public errors: any[]) {
    super('Ошибка валидации', 400, 'VALIDATION_ERROR');
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Не авторизован') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Доступ запрещён') {
    super(message, 403, 'FORBIDDEN');
  }
}
```

### Error handler middleware
```typescript
// src/api/middleware/error.middleware.ts
import { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { AppError, ValidationError } from '../../lib/errors';
import { logger } from '../../lib/logger';

export function errorHandler(
  error: FastifyError,
  req: FastifyRequest,
  reply: FastifyReply
) {
  // Логируем ошибку
  logger.error({
    type: 'error',
    traceId: req.headers['x-trace-id'],
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack,
    },
    method: req.method,
    path: req.url,
  });

  // Кастомные ошибки
  if (error instanceof ValidationError) {
    return reply.status(400).send({
      error: {
        code: error.code,
        message: error.message,
        details: error.errors,
      },
    });
  }

  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }

  // Неизвестные ошибки
  return reply.status(500).send({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Внутренняя ошибка сервера',
    },
  });
}
```

---

## Аутентификация (JWT)

### JWT утилиты
```typescript
// src/lib/jwt.ts
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface IJwtPayload {
  userId: string;
  email: string;
}

export function generateAccessToken(payload: IJwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: '15m' });
}

export function generateRefreshToken(payload: IJwtPayload): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: '7d' });
}

export function verifyAccessToken(token: string): IJwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as IJwtPayload;
}

export function verifyRefreshToken(token: string): IJwtPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as IJwtPayload;
}
```

### Auth middleware
```typescript
// src/api/middleware/auth.middleware.ts
import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken } from '../../lib/jwt';
import { UnauthorizedError } from '../../lib/errors';

export async function authMiddleware(
  req: FastifyRequest,
  reply: FastifyReply
) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Токен не предоставлен');
  }

  const token = authHeader.split(' ')[1];

  try {
    const payload = verifyAccessToken(token);
    req.user = payload;
  } catch (error) {
    throw new UnauthorizedError('Невалидный токен');
  }
}
```

### Auth controller
```typescript
// src/api/controllers/auth.controller.ts
import { FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../../services/auth.service';
import { LoginSchema, RegisterSchema } from '../../types/api.types';

export class AuthController {
  private authService = new AuthService();

  login = async (req: FastifyRequest, reply: FastifyReply) => {
    const { email, password } = LoginSchema.parse(req.body);
    const tokens = await this.authService.login(email, password);
    return reply.send({ data: tokens });
  };

  register = async (req: FastifyRequest, reply: FastifyReply) => {
    const data = RegisterSchema.parse(req.body);
    const user = await this.authService.register(data);
    return reply.status(201).send({ data: user });
  };

  refresh = async (req: FastifyRequest, reply: FastifyReply) => {
    const { refreshToken } = req.body as { refreshToken: string };
    const tokens = await this.authService.refresh(refreshToken);
    return reply.send({ data: tokens });
  };
}
```

---

## Конфигурация Environment

```typescript
// src/config/env.ts
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
});

export const env = envSchema.parse(process.env);
export type TEnv = z.infer<typeof envSchema>;
```

---

## Инициализация Fastify

```typescript
// src/app.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './config/env';
import { logger } from './lib/logger';
import { errorHandler } from './api/middleware/error.middleware';
import { requestLogger } from './api/middleware/logger.middleware';
import { registerRoutes } from './api/routes';

async function bootstrap() {
  const app = Fastify({ logger: false });

  // Plugins
  await app.register(cors, { origin: env.CORS_ORIGIN });

  // Middleware
  app.addHook('onRequest', requestLogger);
  app.setErrorHandler(errorHandler);

  // Routes
  await registerRoutes(app);

  // Start
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  logger.info(`Server running on port ${env.PORT}`);
}

bootstrap().catch((err) => {
  logger.error(err);
  process.exit(1);
});
```

---

## Best Practices

### Код
- TypeScript strict mode
- Zod для валидации на границах (API, env)
- Dependency Injection для тестируемости
- Async/await везде (без callbacks)

### БД
- Prisma или Drizzle ORM
- Миграции для всех изменений схемы
- Индексы на часто запрашиваемые поля
- Транзакции для связанных операций

### Безопасность
- Параметризованные запросы (ORM)
- Rate limiting
- Helmet для HTTP headers
- Валидация всех входных данных

### Тесты
- Unit-тесты для services
- Integration-тесты для API
- Моки для внешних сервисов
- Отдельная БД для тестов
