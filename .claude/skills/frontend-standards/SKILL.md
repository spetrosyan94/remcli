---
name: frontend-standards
description: |
  Архитектура фронтенда, UI компоненты, дизайн-эстетика и TypeScript конвенции
  для проектов на React+Vite+Tailwind+shadcn. Используй при ЛЮБОЙ работе с фронтендом —
  даже простое создание компонента или вопрос про стили выиграет от конвенций проекта.
  USE THIS SKILL WHEN:
  - Создании фронтенд-проекта (React+Vite+Tailwind+shadcn init) -> see references/setup.md
  - Создании UI компонентов, страниц, layouts, структуры проекта
  - Выборе дизайна: шрифты, цвета, темы, визуальные эффекты -> see references/design.md
  - Настройке API интеграции с React Query, форм (react-hook-form+zod) -> see references/components.md
  - Анимациях (Framer Motion), оптимизации изображений, accessibility -> see references/performance.md
  - TypeScript конвенциях: TUser vs UserType, IProps vs Props, EStatus vs StatusEnum
  - Оценке дизайна на "AI Slop" (generic, soulless, безликий)
  - Mobile-first паттернах, touch interactions, haptic feedback
  Ключевые слова: frontend, фронтенд, react, vite, tailwind, shadcn, ui, компонент,
  component, design, дизайн, layout, страница, page, form, форма, animation, анимация.
---

# Frontend Standards

## Project Structure

```
frontend/
├── public/                     # Static (favicon, robots.txt)
├── src/
│   ├── api/                    # API client and requests
│   │   ├── client.ts           # Axios/fetch instance
│   │   ├── endpoints.ts        # API endpoints
│   │   └── hooks/              # React Query hooks
│   ├── assets/                 # Images, icons, fonts
│   ├── components/
│   │   ├── ui/                 # shadcn/ui (customized!)
│   │   ├── layout/             # Header, Footer, Sidebar, PageWrapper
│   │   └── common/             # Reusable components
│   ├── features/               # Feature-based modules (when needed)
│   │   ├── auth/               # { components/, hooks/, types.ts }
│   │   └── dashboard/
│   ├── pages/                  # Page components
│   ├── lib/                    # shadcn utils (cn, utils)
│   ├── store/                  # Zustand stores / Jotai atoms
│   ├── hooks/                  # Custom hooks
│   ├── utils/                  # Formatting, validation helpers
│   ├── constants/              # Routes, API constants
│   ├── config/                 # env.ts
│   ├── styles/                 # globals.css, fonts.css, animations.css
│   ├── types/                  # TypeScript types
│   │   ├── interfaces/         # IUser.ts, IApiResponse.ts
│   │   ├── types/              # TUser.ts, TMovie.ts
│   │   ├── enums/              # EColors.ts, EStatus.ts
│   │   └── schemas/            # Zod validation schemas
│   ├── test/
│   ├── App.tsx
│   ├── main.tsx
│   └── router.tsx
├── index.html
├── vite.config.ts
├── tsconfig.json
├── components.json             # shadcn/ui config
└── package.json
```

## When to Use `features/`

The `features/` directory provides domain isolation -- each feature owns its components, hooks, and types. This prevents cross-domain coupling as the codebase grows and makes it easy to delete or refactor entire features without collateral damage.

| Use `features/`                                    | Skip `features/`                        |
|----------------------------------------------------|-----------------------------------------|
| 10+ pages, clear domain boundaries                 | < 5 pages, most components are shared   |
| Feature has its own components + hooks + types      | MVP / prototype                         |
| Team members work on separate domains               | Solo developer, small scope             |

---

## Type Naming Conventions

Prefixes make it instantly clear what kind of construct you're looking at in imports and usage, without hovering or navigating to the definition.

| Prefix | Kind      | File example          | Usage example                     |
|--------|-----------|-----------------------|-----------------------------------|
| `T`    | type      | `types/TUser.ts`      | `TUser`, `TMovie`, `TLoginForm`   |
| `I`    | interface | `interfaces/IApi.ts`  | `IApiResponse<T>`, `IUserService` |
| `E`    | enum      | `enums/EStatus.ts`    | `EStatus.ACTIVE`, `EColors.PRIMARY` |

> For general naming rules (files, variables, functions) -> see **core-standards** skill.

---

## Design Aesthetic: No "AI Slop"

This section is the **single source of truth** for design philosophy across the entire project. Core-standards defers here.

### Why This Matters

"AI Slop" is the visual equivalent of generic stock photography -- Inter font, purple gradients on white, default shadcn palette unchanged. Users subconsciously recognize it as mass-produced and untrustworthy. Products that look like every other AI-generated landing page fail to build brand identity and erode user confidence.

### Banned Patterns

- **Generic fonts**: Inter, Roboto, Arial, system-ui as primary font
- **Default shadcn palette**: Using the out-of-box colors without customization
- **Purple gradients on white**: The single most overused AI-generated visual
- **Flat white/grey backgrounds**: No texture, no character, no depth

### What to Do Instead

1. **Pick distinctive font pairings** -- a display font for headings + a body font (see `references/design.md` for recommended combos)
2. **Customize the shadcn color palette** in `globals.css` with CSS variables to match the project's identity
3. **Add texture** -- gradient meshes, subtle noise overlays, thoughtful shadows
4. **Dark theme too** -- design it intentionally, not as an afterthought

> Full CSS snippets for fonts, palettes, visual effects, and theme provider -> see `references/design.md`.

---

## Key References

| Need                                            | Where                            |
|-------------------------------------------------|----------------------------------|
| Project init (Vite, Tailwind 4, shadcn, aliases)| `references/setup.md`            |
| Typography, colors, visual effects, theme       | `references/design.md`           |
| Mobile patterns, API client, React Query, forms | `references/components.md`       |
| Animations, images, accessibility               | `references/performance.md`      |
| Lazy loading, virtualization, memoization       | **vercel-react-best-practices** skill   |
| General naming, SOLID, env conventions          | **core-standards** skill         |

---

## Quick Setup Checklist

1. `npm create vite@latest frontend -- --template react-ts`
2. Install Tailwind CSS 4 + shadcn/ui (see `references/setup.md`)
3. Configure `@/` alias in vite.config.ts + tsconfig.json
4. Choose font pairing, customize color palette (see `references/design.md`)
5. Set up API client + React Query (see `references/components.md`)
6. Add `ThemeProvider` for light/dark support (see `references/design.md`)

---

## MCP Usage

Always use **context7** MCP before working with any library (React, Tailwind, shadcn, Framer Motion, React Query, etc.) to get up-to-date API references.

Use **shadcn** MCP when adding or customizing UI components:
```bash
npx shadcn@latest add button drawer dialog input form
```
