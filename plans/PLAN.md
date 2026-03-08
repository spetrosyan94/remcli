# Plan: Setup Wizard для remcli

## Контекст

Реализовать интерактивный `remcli setup` wizard для установки/настройки компонентов:
Whisper STT (модели), AI-агенты (Claude Code, Gemini CLI, Codex CLI), расширить doctor.

## Архитектура

### Текущее состояние
- Whisper уже интегрирован через `smart-whisper` native bindings, модель `ggml-base.bin` (~140MB) авто-скачивается
- Doctor уже показывает статус Whisper (bindings, model, ffmpeg)
- Команды парсятся вручную в `index.ts` (if/else chain)
- Конфиг хранится в `~/.remcli/settings.json` (Zod-валидация)
- Кнопка микрофона в app показывается всегда в P2P режиме (нет проверки доступности)

### Целевое состояние
- `remcli setup` — интерактивный wizard
- `remcli doctor` — расширен статусом AI-агентов
- `~/.remcli/setup.json` — конфиг установленного
- App: микрофон disabled если whisper недоступен
- Daemon: endpoint `/v1/whisper/status` для проверки доступности

---

## Задача 1: Setup Wizard CLI команда

**Агент:** backend-dev

### 1.1 Зависимость @inquirer/prompts
- [x] `npm -w remcli install @inquirer/prompts` (already installed)

### 1.2 Файл `src/commands/setup.ts`
- [x] Создать `handleSetupCommand()` — основной entry point
- [x] **Шаг 1: Whisper модель**
- [x] **Шаг 2: AI-агенты (multi-select)**
- [x] **Шаг 3: Summary**

### 1.3 Расширить `whisperService.ts`
- [x] Поддержка нескольких моделей (WHISPER_MODELS map)
- [x] `getSelectedModel()` — читает из setup.json
- [x] `ensureModel()` — использовать выбранную модель
- [x] `downloadModelWithProgress()` — Progress callback

### 1.4 Конфиг `~/.remcli/setup.json`
- [x] Zod-схема SetupConfigSchema в `persistence.ts`
- [x] Функции `readSetupConfig()` / `writeSetupConfig()`

### 1.5 Регистрация команды в `index.ts`
- [x] Добавить `if (subcommand === 'setup')` → dynamic import

### 1.6 Обновить `package.json` скрипты
- [x] Корневой `package.json`: обновить `"setup"` скрипт

**Файлы:**
- `packages/remcli-cli/src/commands/setup.ts` (новый)
- `packages/remcli-cli/src/daemon/whisper/whisperService.ts` (расширение)
- `packages/remcli-cli/src/persistence.ts` (setup config)
- `packages/remcli-cli/src/index.ts` (регистрация команды)
- `packages/remcli-cli/package.json` (зависимость @inquirer/prompts)
- `package.json` (корневой, скрипт setup)

---

## Задача 2: Расширить Doctor статусом AI-агентов

**Агент:** backend-dev (та же задача, после wizard)

### 2.1 Обновить `doctor.ts`
- [x] Добавить секцию "🤖 AI Agents" после Whisper
- [x] Для каждого агента: which + --version, green/red
- [x] Показать какая модель Whisper выбрана (selectedModel)

**Файлы:**
- `packages/remcli-cli/src/ui/doctor.ts`

---

## Задача 3: Disable микрофона без Whisper

**Агент:** frontend-dev

### 3.1 Daemon endpoint `/v1/whisper/status`
- [x] Добавить GET endpoint в `p2pRestRoutes.ts`
- [x] Возвращает `{ available: boolean, model: string | null, modelDownloaded: boolean }`

### 3.2 App: проверка доступности whisper
- [x] Хук `useWhisperAvailability()` — запрос `/v1/whisper/status` при подключении
- [x] В `SessionView.tsx`: `useWhisperMode` учитывает `whisperAvailable`
- [x] Если недоступен — кнопка микрофона disabled с opacity 0.4
- [x] Modal.alert "Запустите remcli setup для установки голосового ввода"
- [x] Добавить строки в переводы (все 10 языков включая zh-Hant)

**Файлы:**
- `packages/remcli-cli/src/daemon/p2p/p2pRestRoutes.ts` (endpoint)
- `packages/remcli-app/sources/hooks/useWhisperAvailability.ts` (новый)
- `packages/remcli-app/sources/-session/SessionView.tsx` (проверка)
- `packages/remcli-app/sources/components/AgentInput.tsx` (disabled state)
- `packages/remcli-app/sources/text/translations/*.ts` (все языки)

---

## Назначение агентов

| Задача | Агент | Зависимости |
|--------|-------|-------------|
| 1+2. Setup Wizard + Doctor | backend-dev | — |
| 3. Disable микрофона | frontend-dev | endpoint из задачи 1 |

**Задачи 1+2 — один backend-dev агент (последовательно).**
**Задача 3 — frontend-dev, параллельно с 1+2** (endpoint добавит сам в p2pRestRoutes).

---

## Риски

1. **@inquirer/prompts** — ESM-only пакет, проверить совместимость с pkgroll build
2. **Модели whisper** — large ~3GB, нужен прогресс-бар при скачивании
3. **`which` на Windows** — использовать `where` (уже есть паттерн в whisperService.ts)
4. **Gemini CLI пакет** — уточнить актуальное имя npm пакета (может быть `@anthropic-ai/gemini-cli` или `@google/gemini-cli`)
