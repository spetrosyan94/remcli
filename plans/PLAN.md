# Plan: Whisper Native Bindings + ElevenLabs Cleanup + Tests

## Контекст

Whisper STT pipeline уже работает (backend + frontend). Нужно:
1. Заменить shell exec `whisper-cli` на npm-пакет `smart-whisper` (native N-API bindings)
2. Полностью удалить ElevenLabs из обоих пакетов
3. Показать транскрипцию в чате как сообщение пользователя (визуальный маркер)
4. Покрыть тестами
5. Code review

## Порядок: 1 → 2 → 5 (отображение) → 3 (тесты) → 4 (review)

---

## Задача 1: Замена whisper-cli binary на smart-whisper

**Агент:** backend-dev

**Почему smart-whisper:**
- Настоящие N-API native bindings (не shell exec)
- Prebuilt binaries для macOS/Linux/Windows
- Model manager с автоскачиванием
- GPU acceleration на macOS (Metal) из коробки
- Загрузка модели один раз, множество инференсов
- Активно поддерживается (0.8.x)

**Что менять:**

### 1.1 Установка зависимости
- [ ] `npm -w remcli install smart-whisper node-wav`
- [ ] `node-wav` нужен для декодирования WAV в Float32Array PCM

### 1.2 Переписать `whisperService.ts`
- [ ] Убрать: `findWhisperBinary()`, `cachedBinaryPath`, `WHISPER_BINARY_NAMES`, `WHISPER_SEARCH_PATHS`
- [ ] Убрать: `execFile`, `execFileSync`, `execFilePromise`, `tryExecSync`
- [ ] Убрать: `parseWhisperOutput()` (smart-whisper возвращает структурированный результат)
- [ ] Добавить: singleton `Whisper` instance (ленивая инициализация, одна загрузка модели)
- [ ] `transcribe(audioPath)`: конвертировать в WAV → декодировать через `node-wav` → `whisper.transcribe(pcm, { language: 'auto' })`
- [ ] `ensureModel()`: использовать smart-whisper model manager ИЛИ оставить текущую логику скачивания (HuggingFace URL тот же)
- [ ] `isAvailable()`: всегда `true` (npm зависимость, не системный binary)
- [ ] `getStatus()`: убрать `binaryPath`, добавить `nativeBindings: true`
- [ ] `ensureWav()`: оставить как есть (ffmpeg конвертация для m4a/webm)
- [ ] Экспортируемый интерфейс `TranscriptionResult` — без изменений
- [ ] Добавить `freeWhisper()` для graceful shutdown daemon

### 1.3 Обновить `doctor.ts`
- [ ] Убрать проверку whisper binary (`which whisper-cli`)
- [ ] Оставить проверку ffmpeg
- [ ] Оставить проверку модели
- [ ] Обновить сообщения: "Whisper: native bindings (smart-whisper)" вместо binary path

### 1.4 Обновить `p2pRestRoutes.ts`
- [ ] `isWhisperAvailable()` → всегда true (или проверка что smart-whisper загружается)
- [ ] Остальное без изменений (endpoint, multipart, temp file)

### 1.5 Обновить `p2pServer.ts`
- [ ] При shutdown вызывать `freeWhisper()` для освобождения нативных ресурсов

**Файлы:**
- `packages/remcli-cli/src/daemon/whisper/whisperService.ts` (основные изменения)
- `packages/remcli-cli/src/ui/doctor.ts` (строки 264-283)
- `packages/remcli-cli/src/daemon/p2p/p2pRestRoutes.ts` (строка ~203)
- `packages/remcli-cli/src/daemon/p2p/p2pServer.ts` (shutdown)
- `packages/remcli-cli/package.json` (новые зависимости)

---

## Задача 2: Удаление ElevenLabs

**Агент:** frontend-dev

**Удалить файлы целиком:**
- [ ] `packages/remcli-app/sources/realtime/RealtimeVoiceSession.tsx`
- [ ] `packages/remcli-app/sources/realtime/RealtimeVoiceSession.web.tsx`
- [ ] `packages/remcli-app/sources/sync/apiVoice.ts`

**Очистить файлы:**
- [ ] `packages/remcli-app/sources/realtime/RealtimeProvider.tsx` — убрать `ElevenLabsProvider`, оставить `{children}`
- [ ] `packages/remcli-app/sources/realtime/RealtimeSession.ts` — убрать ветку `agentId` / ElevenLabs
- [ ] `packages/remcli-app/sources/sync/appConfig.ts` — убрать поля `elevenLabsAgentIdDev`, `elevenLabsAgentIdProd` и загрузку env
- [ ] `packages/remcli-app/sources/constants/Languages.ts` — убрать тип `ElevenLabsLanguage`, поле `elevenLabsCode` из всех языков, функции `getElevenLabsCode()`, `getElevenLabsCodeFromPreference()`, `getElevenLabsSupportedLanguages()`
- [ ] `packages/remcli-app/sources/-session/SessionView.tsx` — убрать условные проверки `config.elevenLabsAgentId*`, упростить логику (только Whisper)

**Зависимости:**
- [ ] `packages/remcli-app/package.json` — удалить `@elevenlabs/react`, `@elevenlabs/react-native`
- [ ] Запустить `npm install` для пересборки lock-файла

**Проверки:**
- [ ] `grep -r "elevenlabs\|ElevenLabs\|eleven_labs\|eleven-labs" packages/` — должен быть пустой результат
- [ ] `npm -w remcli-app run typecheck` — без новых ошибок

---

## Задача 5: Отображение транскрипции в чате

**Агент:** frontend-dev (та же задача, после удаления ElevenLabs)

**Текущее поведение:** `useWhisperVoice.ts:58` вызывает `sync.sendMessage(sessionId, result.text)` — текст уже появляется в чате как `UserTextMessage`. Механизм `displayText` уже существует в `typesMessage.ts`.

**Что сделать:**
- [ ] В `useWhisperVoice.ts:58` добавить иконку микрофона в displayText:
  ```
  sync.sendMessage(sessionId, result.text, `🎤 ${result.text}`)
  ```
- [ ] Проверить что `UserTextBlock` в `MessageView.tsx` корректно рендерит `displayText`

**Вопрос к шефу:** достаточно ли иконки 🎤 в displayText, или нужен отдельный визуальный стиль (другой цвет пузыря, badge "Voice" и т.д.)?

---

## Задача 3: Тесты

**Агент:** tester

### Backend тесты (`packages/remcli-cli/`)
- [ ] `whisperService.test.ts` — unit тесты:
  - `ensureModel()` — скачивание, атомарность, sanity check размера
  - `ensureWav()` — конвертация через ffmpeg
  - `transcribe()` — вызов smart-whisper, парсинг результата
  - `getStatus()` — корректные поля
  - `isAvailable()` — всегда true
  - `freeWhisper()` — освобождение ресурсов
- [ ] `p2pRestRoutes.test.ts` — endpoint `/v1/voice/transcribe`:
  - Успешная транскрипция
  - Ошибка при пустом аудио
  - Корректный cleanup temp файлов

### Frontend тесты (`packages/remcli-app/`)
- [ ] `whisperRecorder.test.ts` — запись: start/stop/permissions
- [ ] `apiWhisper.test.ts` — FormData, fetch, обработка ответов
- [ ] `useWhisperVoice.test.ts` — state machine: idle→recording→transcribing→idle, ошибки, отмена
- [ ] Проверить что displayText с 🎤 прокидывается в sendMessage

---

## Задача 4: Code Review

**Агент:** code-reviewer

- [ ] Ревью всех изменений из задач 1-3 и 5
- [ ] Confidence >= 80%
- [ ] Проверка: нет остатков ElevenLabs, нет shell exec whisper, тесты проходят

---

## Назначение агентов

| Задача | Агент | Зависимости |
|--------|-------|-------------|
| 1. smart-whisper | backend-dev | — |
| 2. Удаление ElevenLabs | frontend-dev | — |
| 5. displayText для voice | frontend-dev | после задачи 2 |
| 3. Тесты | tester | после задач 1, 2, 5 |
| 4. Code review | code-reviewer | после задачи 3 |

**Задачи 1 и 2 можно запустить ПАРАЛЛЕЛЬНО** — они в разных пакетах, нет конфликтов файлов.

---

## Риски

1. **smart-whisper prebuilt binaries** — могут не собраться на конкретной платформе. Fallback: `nodejs-whisper` (но он тоже делает shell exec внутри).
2. **node-wav** — нужен для декодирования WAV в PCM Float32Array. Если формат не WAV (m4a, webm), сначала ffmpeg конвертация, потом decode.
3. **ElevenLabs зависимости** — транзитивные пакеты (`livekit-client` и др.) должны уйти после `npm install`.
4. **typecheck** — в проекте есть pre-existing ошибки из node_modules. Сверять только новые.
