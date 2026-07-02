# remcli — MOTION.md

Сдержанный язык: dev-инструмент. Всё реализуемо CSS/Tailwind (tailwindcss-animate) + SVG. Без JS-анимационных библиотек; Lottie — опционально только для splash.

## Токены
- `--dur-micro: 120ms` — hover, нажатия, иконки
- `--dur-std: 200ms` — fade, crossfade, push-переходы
- `--dur-enter: 240ms` — появление карточек
- `--dur-sheet: 320ms` — sheet/drawer
- Кривые: `--ease-out: cubic-bezier(0.22,1,0.36,1)` (всё), `--ease-sheet: cubic-bezier(0.32,0.72,0,1)` (iOS-like), курсоры — `steps(2)`.
- `prefers-reduced-motion`: пульсы и шиммер → статичные, переходы → fade 120ms.

## Спецификации
1. **«Агент думает»** — блок-курсор 8×15px цвета thinking (#22D3EE), `blink 0.9s steps(2) infinite` рядом с меткой агента. Без ease — жёсткий терминальный блинк.
2. **Стриминг** — текст чанками (без пер-буквенных эффектов), в конце строки курсор-блок акцентного цвета. Автоскролл `scroll-behavior:smooth`; свайп вверх отключает прилипание, кнопка «↓ к концу» возвращает.
3. **VoiceRecordBar** — бары 3px, высота = уровень (Web Audio), transform scaleY, стагер задержек 0.1–0.7s. Стоп → бары гаснут 150ms → спиннер распознавания 120ms fade.
4. **ListenButton (TTS)** — idle→синтез: спиннер, ширина кнопки фиксируется (нет прыжка); синтез→играет: crossfade 150ms, эквалайзер 3 бара scaleY (0.6–0.9s, стагер); стоп → idle 120ms.
5. **Смена статуса** — цвет дота/рамки transition 250ms ease-out + одиночная вспышка box-shadow 400ms (без бесконечного глоу). Пульс только у running (2s) и thinking (1.2s), opacity 1→0.35.
6. **PermissionCard** — вход: `translateY(10px) scale(0.98) → 0`, opacity 0→1, 240ms ease-out; одна вспышка амбер-кольца (box-shadow 0→5px→0, 400ms) + haptic light. Никакого зацикленного пульса.
7. **Sheet/Drawer** — снизу 320ms `--ease-sheet`, скрим 0→55% за 200ms; закрытие 260ms. Push-экраны: slide-X 24px + fade 200ms (native-feel). Palette: scale 0.98→1 + fade 160ms.
8. **Skeleton → контент** — shimmer 1.4s linear (gradient 90°); замена crossfade 200ms, геометрия скелета = геометрии строк (без сдвигов). Splash→Home: fade 250ms.
9. **Логотип (≤1.4s, splash и пустые состояния)**
   - 0–380ms: оба шеврона съезжаются к центру (эхо слева −8px, основной справа +7px), ease-out; эхо останавливается на opacity 0.26
   - 400–1400ms: курсор-блок мигает 2 раза, steps(1)
   - далее: на splash — fade в Home; в пустых состояниях — курсор продолжает медленный blink 1.2s
   - CSS: keyframes `rcEcho` / `rcMain` / `rcCur` — см. `04 Motion.dc.html`.
