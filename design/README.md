# design/ — хендофф remcli для Claude Code

Дизайн-референс живёт в Claude Design проекте (файлы `01 Identity` … `04 Motion`); здесь — переносимая версия.

## Формат экранов
`screens/*.tsx` — React + Tailwind в духе shadcn/ui, самодостаточные (общие примитивы в `screens/components.tsx`, иконки — `lucide-react`). Это **референс-код**: точная разметка, классы и состояния; подключение роутинга/данных — на стороне приложения.

## Setup

1. Подключить `tokens.css` глобально (тема через класс `dark` на `<html>`).
2. Шрифты: Geist + Geist Mono (Google Fonts или `geist` npm-пакет).
3. Tailwind config — добавить:

```ts
theme: {
  extend: {
    fontFamily: {
      sans: ['Geist', 'system-ui', 'sans-serif'],
      mono: ['"Geist Mono"', '"JetBrains Mono"', 'ui-monospace', 'monospace'],
    },
    colors: {
      // стандартные shadcn-цвета (background, card, accent…) — как в их пресете
      status: {
        running: 'hsl(var(--status-running))',
        thinking: 'hsl(var(--status-thinking))',
        permission: 'hsl(var(--status-permission))',
        idle: 'hsl(var(--status-idle))',
        offline: 'hsl(var(--status-offline))',
        error: 'hsl(var(--status-error))',
      },
    },
    keyframes: {
      blink: { '0%,49%': { opacity: '1' }, '50%,100%': { opacity: '0' } },
      pulseDot: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
      bar: { '0%,100%': { transform: 'scaleY(.25)' }, '50%': { transform: 'scaleY(1)' } },
    },
    animation: {
      blink: 'blink 1.1s steps(2) infinite',
      'blink-think': 'blink 0.9s steps(2) infinite',
      'pulse-run': 'pulseDot 2s ease-in-out infinite',
      'pulse-think': 'pulseDot 1.2s ease-in-out infinite',
      bar: 'bar 0.9s ease-in-out infinite',
    },
  },
}
```

Остальные тайминги/кривые — `MOTION.md`.

## PWA-заметки (детали в DESIGN.md)
- standalone, `min-h-dvh`, `viewport-fit=cover`, отступы `env(safe-area-inset-*)` уже проставлены в экранах;
- theme-color: dark `#09090B`, light `#FAFAFA`; терминал всегда тёмный `#050507`;
- `app-icon-1024.png` = maskable (знак в центральных 62%), отдельный файл продублирован под оба имени;
- splash: `assets/splash.png` + анимация знака из MOTION.md §9.

## Карта экранов
| файл | экран | примечания |
|---|---|---|
| connect.tsx | онбординг/подключение | состояния: idle · scanning · connecting · error · manual |
| home.tsx | список машин и сессий | FAB, таб-бар, пустое состояние |
| new-session.tsx | новая сессия | машина→агент→модель→разрешения→директория; resume-sheet |
| chat.tsx | чат сессии (главный) | permission-card, tool-calls, diff, TTS, диктовка, баннеры |
| terminal.tsx | терминал | всегда dark |
| zen.tsx | задачи | «работать над задачей» |
| settings.tsx | настройки | тема/язык/голос/машины |
| palette.tsx | ⌘K палитра | сессии + действия |

## pages/ — HTML-референс
Те же экраны как самостоятельные HTML-страницы (инлайн-стили, пиксельно совпадают с макетами): открыть `pages/index.html`. Использовать как визуальный эталон при переносе TSX; source of truth по классам/токенам — `screens/*.tsx` + `tokens.css`. Дополнительно: `connect-states`, `chat-states`, `home-light`, `chat-light`, `desktop`.
