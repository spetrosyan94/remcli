---
name: frontend-standards
description: |
  Стандарты разработки фронтенда: структура проекта, нейминг, инициализация, эстетика.
  Применяется автоматически при: react, vite, tailwind, shadcn, компонент, component,
  typescript, тип, type, interface, enum, структура, structure, инициализация, init, дизайн, design.
---

# Стандарты Frontend разработки

## Структура проекта

```
frontend/
├── public/                     # Статика (favicon, robots.txt)
├── src/
│   ├── api/                    # API клиент и запросы
│   │   ├── client.ts           # Axios/fetch instance
│   │   ├── endpoints.ts        # API endpoints
│   │   └── hooks/              # React Query хуки
│   │
│   ├── assets/                 # Статические ресурсы
│   │   ├── images/             # Изображения
│   │   ├── icons/              # SVG иконки
│   │   └── fonts/              # Локальные шрифты
│   │
│   ├── components/
│   │   ├── ui/                 # shadcn/ui компоненты (кастомизированные!)
│   │   ├── layout/             # Header, Footer, Sidebar, PageWrapper
│   │   └── common/             # Переиспользуемые компоненты
│   │
│   ├── features/               # Feature-based модули (опционально)
│   │   ├── auth/               # Авторизация
│   │   │   ├── components/
│   │   │   ├── hooks/
│   │   │   └── types.ts
│   │   └── dashboard/          # Dashboard
│   │
│   ├── pages/                  # Страницы приложения
│   │   ├── HomePage.tsx
│   │   ├── ProfilePage.tsx
│   │   └── index.ts            # Re-exports
│   │
│   ├── lib/                    # Утилиты shadcn (cn, utils)
│   │
│   ├── store/                  # Глобальное состояние
│   │   ├── useUserStore.ts     # Zustand stores
│   │   └── atoms/              # Jotai atoms
│   │
│   ├── hooks/                  # Кастомные хуки
│   │   ├── useMediaQuery.ts
│   │   ├── useLocalStorage.ts
│   │   └── useHaptic.ts
│   │
│   ├── utils/                  # Утилиты
│   │   ├── format.ts           # Форматирование
│   │   └── validation.ts       # Валидация
│   │
│   ├── constants/              # Константы
│   │   ├── routes.ts           # Пути роутинга
│   │   └── api.ts              # API константы
│   │
│   ├── config/                 # Конфигурация
│   │   └── env.ts              # Environment variables
│   │
│   ├── styles/                 # Глобальные стили
│   │   ├── globals.css         # Tailwind + CSS variables
│   │   ├── fonts.css           # Подключение шрифтов
│   │   └── animations.css      # CSS анимации
│   │
│   ├── types/                  # TypeScript типы
│   │   ├── interfaces/         # IUser.ts, IApiResponse.ts
│   │   ├── types/              # TUser.ts, TMovie.ts
│   │   ├── enums/              # EColors.ts, EStatus.ts
│   │   └── schemas/            # Zod схемы валидации
│   │
│   ├── test/                   # Тесты
│   │   └── setup.ts
│   │
│   ├── App.tsx                 # Корневой компонент
│   ├── main.tsx                # Entry point
│   └── router.tsx              # React Router конфигурация
│
├── index.html
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── components.json             # shadcn/ui конфигурация
└── package.json
```

### Когда использовать `features/`

**Используй `features/`** для:
- Крупных приложений с 10+ страницами
- Когда есть чёткое разделение по доменам (auth, billing, dashboard)
- Когда фича имеет свои компоненты, хуки, типы

**Не используй `features/`** для:
- Маленьких приложений (< 5 страниц)
- Когда большинство компонентов переиспользуются
- MVP и прототипов

---

## Нейминг типов

### Types (T-префикс)
```typescript
// types/types/TUser.ts
export type TUser = {
  id: string;
  name: string;
  email: string;
};

// types/types/TMovie.ts
export type TMovie = {
  id: number;
  title: string;
  year: number;
};
```

### Interfaces (I-префикс)
```typescript
// types/interfaces/IApiResponse.ts
export interface IApiResponse<T> {
  data: T;
  status: number;
  message: string;
}

// types/interfaces/IUserService.ts
export interface IUserService {
  getUser(id: string): Promise<TUser>;
  updateUser(id: string, data: Partial<TUser>): Promise<TUser>;
}
```

### Enums (E-префикс)
```typescript
// types/enums/EStatus.ts
export enum EStatus {
  PENDING = 'pending',
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

// types/enums/EColors.ts
export enum EColors {
  PRIMARY = '#007AFF',
  SECONDARY = '#5856D6',
  SUCCESS = '#34C759',
  ERROR = '#FF3B30',
}
```

---

## Инициализация проекта

### 1. Создание Vite + React + TypeScript

```bash
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install
```

### 2. Установка Tailwind CSS 4

```bash
npm install tailwindcss @tailwindcss/vite
```

**vite.config.ts:**
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
```

**src/styles/globals.css:**
```css
@import 'tailwindcss';
@import './fonts.css';
```

### 3. Установка shadcn/ui

```bash
npx shadcn@latest init
```

Выбрать:
- Style: Default
- Base color: Slate (КАСТОМИЗИРОВАТЬ потом!)
- CSS variables: Yes

**Добавление компонентов:**
```bash
npx shadcn@latest add button drawer dialog input form
```

### 4. Настройка алиасов

**tsconfig.json:**
```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  }
}
```

---

## Эстетика и дизайн

### Философия: Избегай "AI Slop"

**ЗАПРЕЩЕНО**:
- Generic шрифты: Inter, Roboto, Arial, system-ui
- Стандартные палитры shadcn без кастомизации
- Фиолетовые градиенты на белом фоне
- Однотонные белые/серые фоны без характера

### Типографика

**Подключение уникальных шрифтов (styles/fonts.css):**
```css
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=Syne:wght@400;500;600;700;800&display=swap');

:root {
  --font-display: 'Syne', sans-serif;
  --font-body: 'Plus Jakarta Sans', sans-serif;
}

body {
  font-family: var(--font-body);
}

h1, h2, h3 {
  font-family: var(--font-display);
}
```

**Рекомендуемые комбинации шрифтов:**
| Display | Body | Стиль |
|---------|------|-------|
| Syne | Plus Jakarta Sans | Modern tech |
| Playfair Display | Source Serif Pro | Editorial |
| Bebas Neue | DM Sans | Bold industrial |
| Space Grotesk | Outfit | Geometric |
| Archivo Black | Literata | High contrast |

### Цветовые палитры

**Кастомизация globals.css:**
```css
@layer base {
  :root {
    /* Пример: Cyberpunk */
    --background: 240 10% 4%;
    --foreground: 0 0% 95%;
    --primary: 280 100% 70%;
    --primary-foreground: 0 0% 100%;
    --secondary: 180 100% 50%;
    --accent: 60 100% 50%;
    --muted: 240 5% 15%;
    --muted-foreground: 240 5% 65%;
    --border: 240 5% 20%;
    --ring: 280 100% 70%;
    --radius: 0.5rem;
  }

  .dark {
    /* Тёмная тема тоже должна быть красивой! */
  }
}
```

### Визуальные эффекты

**Gradient mesh (styles/animations.css):**
```css
.gradient-mesh {
  background:
    radial-gradient(at 40% 20%, hsl(280 100% 70% / 0.3) 0px, transparent 50%),
    radial-gradient(at 80% 0%, hsl(180 100% 50% / 0.2) 0px, transparent 50%),
    radial-gradient(at 0% 50%, hsl(60 100% 50% / 0.1) 0px, transparent 50%);
}

.noise-overlay::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
  opacity: 0.03;
  pointer-events: none;
}
```

---

## Темы: светлая и тёмная

### CSS переменные (globals.css)

```css
@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 222.2 84% 4.9%;
    --primary: 222.2 47.4% 11.2%;
    --primary-foreground: 210 40% 98%;
    /* ... остальные переменные */
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --foreground: 210 40% 98%;
    --primary: 210 40% 98%;
    --primary-foreground: 222.2 47.4% 11.2%;
    /* ... остальные переменные */
  }
}
```

### Theme Provider

```typescript
// components/theme-provider.tsx
import { createContext, useContext, useEffect, useState } from 'react';

type Theme = 'dark' | 'light' | 'system';

const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
}>({
  theme: 'system',
  setTheme: () => null,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('theme') as Theme) || 'system'
  );

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
      root.classList.add(systemTheme);
    } else {
      root.classList.add(theme);
    }

    localStorage.setItem('theme', theme);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export const useTheme = () => useContext(ThemeContext);
```

---

## Mobile-first паттерны

### Touch-friendly кнопки

```typescript
// Минимальный размер для touch — 44px
<Button className="min-h-[44px] min-w-[44px] touch-manipulation">
  Нажми меня
</Button>
```

### Drawer для мобильных модальных окон

```typescript
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer';

function MobileModal() {
  return (
    <Drawer>
      <DrawerTrigger asChild>
        <Button>Открыть</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Заголовок</DrawerTitle>
        </DrawerHeader>
        <div className="p-4">
          {/* Контент */}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
```

### Haptic feedback

```typescript
// hooks/useHaptic.ts
export function useHaptic() {
  const trigger = (type: 'light' | 'medium' | 'heavy' = 'light') => {
    if ('vibrate' in navigator) {
      const patterns = {
        light: [10],
        medium: [20],
        heavy: [30, 10, 30],
      };
      navigator.vibrate(patterns[type]);
    }
  };

  return { trigger };
}

// Использование
const { trigger } = useHaptic();
<Button onClick={() => { trigger('medium'); handleClick(); }}>
  Кнопка с вибрацией
</Button>
```

### Свайпы

```typescript
// hooks/useSwipe.ts
import { useState, TouchEvent } from 'react';

export function useSwipe(onSwipeLeft?: () => void, onSwipeRight?: () => void) {
  const [touchStart, setTouchStart] = useState<number | null>(null);

  const onTouchStart = (e: TouchEvent) => {
    setTouchStart(e.touches[0].clientX);
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (!touchStart) return;

    const touchEnd = e.changedTouches[0].clientX;
    const diff = touchStart - touchEnd;
    const threshold = 50;

    if (diff > threshold) onSwipeLeft?.();
    if (diff < -threshold) onSwipeRight?.();

    setTouchStart(null);
  };

  return { onTouchStart, onTouchEnd };
}
```

---

## API интеграция

### API клиент

```typescript
// api/client.ts
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

export async function apiClient<T>(
  endpoint: string,
  options?: RequestInit
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!response.ok) {
    throw new Error(`API Error: ${response.status}`);
  }

  return response.json();
}
```

### React Query хуки

```typescript
// api/hooks/useUser.ts
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import { TUser } from '@/types/types/TUser';

export function useUser(id: string) {
  return useQuery({
    queryKey: ['user', id],
    queryFn: () => apiClient<TUser>(`/users/${id}`),
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<TUser> }) =>
      apiClient<TUser>(`/users/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['user', id] });
    },
  });
}
```

---

## Производительность

### Lazy loading роутов

```typescript
import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';

const Home = lazy(() => import('./pages/HomePage'));
const Profile = lazy(() => import('./pages/ProfilePage'));

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div>Loading...</div>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/profile" element={<Profile />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
```

### Оптимизация изображений

```typescript
// Lazy loading + WebP с fallback
<picture>
  <source srcSet="/image.webp" type="image/webp" />
  <img
    src="/image.jpg"
    alt="Description"
    loading="lazy"
    decoding="async"
  />
</picture>
```

### Виртуализация списков

```typescript
import { useVirtualizer } from '@tanstack/react-virtual';

function VirtualList({ items }: { items: string[] }) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 50,
  });

  return (
    <div ref={parentRef} className="h-[400px] overflow-auto">
      <div style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualItem) => (
          <div
            key={virtualItem.key}
            style={{
              position: 'absolute',
              top: virtualItem.start,
              height: virtualItem.size,
            }}
          >
            {items[virtualItem.index]}
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## Анимации

### CSS transitions (простые)

```css
.btn {
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}

.btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.btn:active {
  transform: translateY(0);
}
```

### Framer Motion (сложные)

```typescript
import { motion } from 'framer-motion';

// Staggered reveal
const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.1 }
  }
};

const item = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0 }
};

<motion.ul variants={container} initial="hidden" animate="show">
  {items.map(i => (
    <motion.li key={i} variants={item}>
      {i}
    </motion.li>
  ))}
</motion.ul>
```

### Accessibility (prefers-reduced-motion)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

```typescript
// React hook
function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = () => setPrefersReducedMotion(mediaQuery.matches);
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  }, []);

  return prefersReducedMotion;
}
```

---

## Формы с валидацией

### react-hook-form + zod + shadcn/ui

```bash
npm install react-hook-form @hookform/resolvers zod
npx shadcn@latest add form input
```

### Схема валидации
```typescript
// types/schemas/auth.schema.ts
import { z } from 'zod';

export const LoginSchema = z.object({
  email: z.string().email('Неверный формат email'),
  password: z.string().min(8, 'Минимум 8 символов'),
});

export const RegisterSchema = z.object({
  name: z.string().min(2, 'Минимум 2 символа'),
  email: z.string().email('Неверный формат email'),
  password: z.string()
    .min(8, 'Минимум 8 символов')
    .regex(/[A-Z]/, 'Нужна заглавная буква')
    .regex(/[0-9]/, 'Нужна цифра'),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: 'Пароли не совпадают',
  path: ['confirmPassword'],
});

export type TLoginForm = z.infer<typeof LoginSchema>;
export type TRegisterForm = z.infer<typeof RegisterSchema>;
```

### Компонент формы
```typescript
// components/forms/LoginForm.tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { LoginSchema, TLoginForm } from '@/types/schemas/auth.schema';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface ILoginFormProps {
  onSubmit: (data: TLoginForm) => Promise<void>;
  isLoading?: boolean;
}

export function LoginForm({ onSubmit, isLoading }: ILoginFormProps) {
  const form = useForm<TLoginForm>({
    resolver: zodResolver(LoginSchema),
    defaultValues: {
      email: '',
      password: '',
    },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  placeholder="your@email.com"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Пароль</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  placeholder="********"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <Button type="submit" className="w-full" disabled={isLoading}>
          {isLoading ? 'Загрузка...' : 'Войти'}
        </Button>
      </form>
    </Form>
  );
}
```

### Использование с React Query
```typescript
// pages/LoginPage.tsx
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { LoginForm } from '@/components/forms/LoginForm';
import { authApi } from '@/api/auth';
import { TLoginForm } from '@/types/schemas/auth.schema';

export function LoginPage() {
  const navigate = useNavigate();

  const loginMutation = useMutation({
    mutationFn: (data: TLoginForm) => authApi.login(data),
    onSuccess: () => {
      navigate('/dashboard');
    },
    onError: (error) => {
      // Обработка ошибки
    },
  });

  return (
    <div className="max-w-md mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Вход</h1>
      <LoginForm
        onSubmit={loginMutation.mutateAsync}
        isLoading={loginMutation.isPending}
      />
    </div>
  );
}
```
