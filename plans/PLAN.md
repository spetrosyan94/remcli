# План: Чистка, фиксы и рефакторинг remcli

> По итогам аудита 02.07.2026: 8 тиммейтов-исследователей + 8 адверсиальных критиков + 4 doc-ресёрчера + главный критик полноты (21 агент, ~2.8M токенов).
> Правило: удаляем только то, что критик подтвердил (confirmed). Uncertain — ручная проверка перед удалением.
> После каждого этапа: `npm -w remcli-app run typecheck` + `npm -w remcli run build` + тесты.
>
> **ПРОГРЕСС**: Этапы 0-2 ВЫПОЛНЕНЫ и запушены (0f4f348 fix CLI, f192b7b chore CLI, afb8fb0 chore app; −19k строк, −20 зависимостей). Этапы 3-4 ВЫПОЛНЕНЫ (ad89a06): run.ts→модули, typed daemonPost, AgentDisplay, whisper download+backpressure, TTS голос по языку ('auto' дефолт, app передаёт язык), Cursor detect/trust/PowerShell, Gemini OAuth-детект, все CLAUDE.md синхронизированы. Рефакторинги 3A (общий harness) и 3C (разбор runGemini) ОТЛОЖЕНЫ до после веб-пивота и миграции Codex на app-server. 3D отменён (пивот). Этап 7 (LM Studio консьерж) ВЫПОЛНЕН (8428d74 + 27cf932): daemon-сервис + REST /v1/concierge/*, function calling с guardrails, 14 тестов; UI консьержа — в волне 6 (добавить в паритет-список 6.2). Этап 6 — ЖДЁТ дизайн в design/.

---

## Этап 0 — Подготовка
- [ ] Решение пользователя: закоммитить/застэшить текущие незакоммиченные изменения (в рабочем дереве уже есть правки TTS/sessions)
- [ ] Baseline: прогнать typecheck (app) + build + test (cli), зафиксировать зелёное состояние

## Этап 1 — Критические баги (чинить до любой чистки)
- [ ] **qwenTtsWorker.py**: инициализировать `req_id` ДО `json.loads(line)` — сейчас одна битая строка stdin роняет весь резидентный воркер (~1.7GB) через NameError
- [ ] **qwenTtsProvider.ts**: обработчики exit/error должны отклонять промис `waitForReady()` — иначе краш Python при загрузке модели висит 120 секунд вместо мгновенной ошибки
- [ ] **daemon/mac/install.ts:51**: plist генерируется с аргументом `remcli-daemon`, а роутинг ждёт `daemon start-sync` → установленный LaunchDaemon вообще не стартует демона
- [ ] **Cursor resume сломан**: демон передаёт `--resume <id>` в `remcli cursor`, но ветка cursor в index.ts его не парсит → распарсить и прокинуть в runCursor → cursorQuery
- [ ] **Codex resume мёртв**: конфиг-ключ `experimental_resume` удалён из Codex осенью 2025 — контекст молча теряется, а UI пишет «Resuming previous context…» → убрать мёртвый механизм + честное поведение (полная миграция на app-server — Этап 4)
- [ ] **Gemini**: `--experimental-acp` → `--acp`; реализовать resume через ACP `loadSession` (демон и мобильный пикер уже готовы); обновить список моделей (gemini-3-pro/flash-preview, auto)
- [ ] **apiArtifacts.ts**: backoff() бесконечно ретраит фатальные 501 от демона → не ретраить 4xx/501 (в связке с решением по artifacts, Этап 2H)
- [ ] **SidebarView.tsx:253**: кнопка inbox безусловно ведёт в несуществующий роут `/(app)/inbox` — убрать кнопку + useInboxHasContent

## Этап 2 — Удаление облачных остатков (батчами по фичам, каждый батч = атомарный срез)

### 2A. LiveKit / realtime-голос (крупнейший остаток)
- [ ] `sources/realtime/` целиком (RealtimeSession, RealtimeProvider(.web), voiceConfig, realtimeClientTools, hooks/)
- [ ] `components/VoiceAssistantStatusBar.tsx` + ссылки на него в MainView/SidebarView/SessionView/ZenHome (координированное удаление, иначе сломается typecheck)
- [ ] realtime-ветка в `sync/storage.ts` (realtimeStatus/realtimeMode + сеттеры + debounce), вызовы voiceHooks.* из sync.ts
- [ ] `types/react-native-webrtc-web-shim.d.ts`, стаб `/v1/voice/token` в p2pRestRoutes.ts
- [ ] Deps: @livekit/react-native, @livekit/react-native-expo-plugin, @livekit/react-native-webrtc, livekit-client, @config-plugins/react-native-webrtc + plugins в app.config.js
- [ ] ВАЖНО: `VoiceBars.tsx` НЕ удалять — живой через VoiceRecordingBar (STT)

### 2B. RevenueCat / подписки
- [ ] Deps: @revenuecat/purchases-js, react-native-purchases, react-native-purchases-ui
- [ ] `sync/appConfig.ts`: поля revenueCatAppleKey/GoogleKey/StripeKey + env-оверрайды
- [ ] `dev/index.tsx`: кнопка Purchases → /dev/purchases (роута нет); перевод settings.supportUsSubtitlePro

### 2C. Friends / social / роуты-призраки
- [ ] `_layout.tsx`: Stack.Screen inbox/index, friends/index, friends/search, user/[id], dev/masked-progress (файлов роутов нет)
- [ ] Закомментированный social-блок в SettingsView + navigation.navigate('friends/search')
- [ ] Translations (все 10 языков): секции friends.*, feed.*, inbox.*, profile.*, usage.* + связанные errors-ключи; висячий router.push('/settings/usage')

### 2D. Облачная авторизация/аккаунт
- [ ] `auth/authGetToken.ts` + `authChallenge.ts` (бьют в отсутствующий /v1/auth)
- [ ] createAccount-флоу в `app/(app)/index.tsx`, `restore/manual.tsx` — в P2P нерабочие; экран приветствия должен предлагать только QR-подключение
- [ ] `sync/apiServices.ts` (connectService мёртв; disconnectService — проверить UI-вызов) + GitHub OAuth часть apiGithub.ts (getGitHubOAuthParams, getAccountProfile) + UI привязки сервисов в настройках
- [ ] `settings/connect/claude.tsx` — логика закомментирована

### 2E. Мёртвый CLI-кластер (все confirmed)
- [ ] utils: deriveKey.ts (+appspec), hmac_sha512.ts (+test), hex.ts, text.ts, backupKey.ts (проверить), MessageQueue.ts, fileAtomic.ts (atomicFileWrite)
- [ ] ui: messageFormatter.ts, messageFormatterInk.ts, qrcode.ts (+test, дублирует p2pQRCode), ink/RemoteModeDisplay.tsx, ink/DaemonPrompt.tsx
- [ ] modules/proxy/ целиком
- [ ] Deps: http-proxy, http-proxy-middleware, @types/http-proxy, expo-server-sdk, @stablelib/hex (после удаления кластера)
- [ ] index.ts: строку про `remcli notify` из help (команда — заглушка «cloud removed»)

### 2F. Осиротевшие компоненты/хуки app (только confirmed критиком)
- [ ] NewSessionWizard.tsx, entityColor.ts, TransitionStack.tsx, toSnakeCase.ts — confirmed
- [ ] PlusPlus(.web).tsx, PlaceholderContainerView.tsx, ExternalLink.tsx, loadSkia(.web).ts, formatPermissionParams.ts, useGetPath, useSearch, useAsyncCommand, useAutocomplete, useAutocompleteSession — перепроверить греп перед удалением (критик не дал явного вердикта каждому)

### 2G. Мёртвый scaffolding src/agent/ (CLI)
- [ ] initializeAgents(), registerGeminiAgent(), createAcpBackend(), legacy-алиасы AcpSdkBackend, type-guards в AgentMessage, типы AgentBackendConfig/AcpAgentConfig/AgentTransport, неиспользуемый импорт DEFAULT_GEMINI_MODEL
- [ ] agent/adapters/ и AgentRegistry — uncertain: решить вместе с рефакторингом 3A (либо удалить, либо реально задействовать)
- [ ] cloudToken в Gemini НЕ трогать (живой OAuth) — только переименовать (vendorOauthToken)

### 2H. Продуктовые решения (нужен выбор пользователя)
- [ ] **artifacts**: удалить целиком (4 экрана + apiArtifacts + REST-стабы + socket-хендлеры + переводы) ИЛИ довести (унифицировать транспорт REST↔Socket) — сейчас рассинхрон: REST list всегда пуст, POST → 501
- [ ] **track/PostHog**: удалить целиком ИЛИ оставить как opt-in; в любом случае вычистить события удалённых фич (trackPaywall*, trackFriends*, whatsNew, voiceRecording)
- [ ] **Push-уведомления**: expo-server-sdk мёртв в CLI, а app.config.js включает remote push — remote-push без облака невозможен: убрать remote-часть, оставить локальные?
- [ ] **Сенсоры «improve AI quality»**: react-native-vision-camera (0 импортов — почти наверняка мёртв), expo-location/expo-calendar (используются в _layout.tsx — проверить реальную ценность)
- [ ] **-zen режим**: довести (i18n, полноценная точка входа) ИЛИ перенести под dev/ как эксперимент

## Этап 3 — Рефакторинг (после чистки)
- [ ] **3A. Общий harness агент-сессий**: runClaude/runCodex/runGemini/runCursor дублируют sessionTag, setBackend, ApiClient.create, machineId, metadata, offline-reconnect, notifyDaemon → извлечь общий каркас; PermissionMode → табличный маппер флагов агента
- [ ] **3B. daemon/run.ts**: god-функция 1000+ строк → вынести spawnSession, machine-RPC-bootstrap, heartbeat-loop
- [ ] **3C. runGemini.ts (1253 строки)**: onMessage-switch в отдельный модуль; поправить `default:` посреди switch; дедуп emitReadyIfIdle с runCodex
- [ ] **3D. Дедупы app**: useConnectAccount+useConnectTerminal → один хук; git-status компоненты → общий хук
- [ ] **3E. CLI-мелочи**: typed daemonPost (дискриминированный union), helper для вывода ошибок субкоманд index.ts (~7 дублей), Ink-дисплеи Codex/Gemini → один компонент, дедуп ensureModel/downloadModelWithProgress в whisperService, убрать монки-патч handleWorkerLine в qwenTtsProvider
- [ ] **3F. p2p**: сузить P2PServerConfig до используемого; чистить replayedSessions при удалении сессии; удалить ApiMachineClient+getOrCreateMachine (или переиспользовать вместо инлайна)

## Этап 4 — Актуализация интеграций и доков
- [ ] **Cursor**: детект бинаря `agent` вместо `cursor` в setup.ts/doctor.ts; PowerShell-команда установки для Windows; `--trust` в cursorQuery; (опц.) --stream-partial-output с дедупликацией по model_call_id; (опц.) agent ls/create-chat вместо скана store.db
- [ ] **Codex**: спланировать миграцию mcp-server → app-server (thread/resume, turn/interrupt, model/list); упростить getCodexMcpCommand (убрать легаси-ветку `codex mcp`); различать elicitation-типы (exec vs patch-approval)
- [ ] **Gemini**: детектировать отказ OAuth (Google отключил Gemini CLI для free/Pro/Ultra с 18.06.2026) и показывать понятную ошибку; (страт.) оценить Antigravity CLI как нового агента
- [ ] **Claude Code**: сверить используемые флаги/hooks с установленной версией; рассмотреть --model/--effort passthrough в мобильный пикер
- [ ] Обновить CLAUDE.md (корневой + пакетные): убрать упоминания LiveKit/realtime как живых, задокументировать convention `-session`/`-zen`, поправить Binary: agent для Cursor, обновить README
- [ ] Закрыть пробелы аудита: .github/workflows (гоняются ли тесты; .appspec.ts вне vitest include), packages/remcli-cli/scripts/*.cjs, bin/*.mjs, src-root (configuration.ts, agents.ts, lib.ts, persistence.ts), конфиги app (babel/metro/plugins), .release-it/.npmignore, осиротевшие ассеты

## Этап 5 — Верификация
- [ ] typecheck app + build/test cli — зелёные
- [ ] Smoke: `remcli daemon start` → QR → подключение приложения; запуск каждой интеграции (claude/codex/gemini/cursor); TTS synthesize/stop; whisper transcribe
- [ ] Diff-ревью code-reviewer агентами (адверсиально) перед фиксацией
- [ ] Добавить knip/ts-prune в CI рядом с typecheck + dead-key detection для translations
- [ ] documentation-sync: README/CLAUDE.md соответствуют коду

## Этап 6 — ВЕБ-ПИВОТ (решение владельца 02.07.2026): только веб-версия + shadcn/ui
> Решения: полная миграция на Vite + React + Tailwind + shadcn/ui (новый пакет `packages/remcli-web`); remcli-app (React Native/Expo) удаляется ПОСЛЕ паритета новой веб-версии; Tauri и вся нативная iOS/Android-сборка удаляются. Мобильный доступ — браузер/PWA (демон уже отдаёт webAppDir). Документация библиотек — ВСЕГДА через MCP context7 (+ MCP shadcn для компонентов).

### 6.1 Каркас и дизайн-система
- [ ] Пакет remcli-web: Vite + React + TS strict + Tailwind + shadcn/ui (init через context7/shadcn MCP)
- [ ] Дизайн-концепция: эргономичный, современный, лаконичный (mobile-first, тёмная/светлая тема, минимум хрома, фокус на чате сессии); соблюдать frontend-standards skill
- [ ] Перенос переносимой логики из remcli-app: sync-движок, encryption (libsodium-wrappers для web), apiSocket (socket.io-client), storage (localStorage/IndexedDB вместо AsyncStorage), i18n (10 языков)

### 6.2 Экраны (паритет с remcli-app)
- [ ] Подключение по QR (камера через getUserMedia + ручной ввод URL/ключа)
- [ ] Список сессий/машин, новая сессия (агент, модель, permission mode, директория), resume-пикер
- [ ] Чат сессии: сообщения, markdown, диффы, tool views, permissions, командная палитра
- [ ] Voice: STT (MediaRecorder → /v1/voice/transcribe), TTS Listen-кнопка (/v1/voice/synthesize)
- [ ] Настройки (язык, тема, TTS-провайдер/голос), терминал, git-статус
- [ ] Zen-режим — довести до релиза уже в новом дизайне (i18n c самого начала)

### 6.3 Интеграция с демоном и вывод из эксплуатации RN
- [ ] Демон: webAppDir → сборка remcli-web; `remcli daemon start` печатает URL веб-клиента
- [ ] Smoke-паритет: QR-подключение, спавн каждого агента, чат, permissions, voice — с телефона через браузер
- [ ] После паритета: удалить packages/remcli-app целиком (+ Tauri, expo-конфиги, patches, jest-expo, CI typecheck переключить на remcli-web)

## Этап 6.4 — Доделки демона под веб-клиент (решения владельца 02.07.2026; сразу после волны 6.3)
- [x] **Zen → KV демона**: доделать KV-хранилище демона (сейчас /v1/kv — заглушки без персиста): версионируемый persist в ~/.remcli/kv-store.json (atomic write), OCC по version; переключить ZenPage с localStorage на /v1/kv (миграция локальных задач при первом подключении); задачи становятся общими для всех устройств ✅ 9179c5f
- [x] **Удаление машины на сервере**: команда «забудь машину» в демоне (DELETE /v1/machines/:id или RPC) + событие delete-machine клиентам; SettingsPage вызывает её вместо локального forgetMachine; машина не возвращается при reconnect (кроме собственной машины демона — её удалять нельзя, вернуть понятную ошибку) ✅ 9179c5f
- [x] **Консьерж: reasoning-модели**: вырезать блоки `<think>…</think>` из ответа LLM в conciergeService (Qwen3 — thinking-модель, на машине владельца проверено: тег утекает в content) + тест ✅ conciergeService.test.ts
- [x] **Консьерж: явная локаль**: POST /v1/concierge/chat принимает `lang` (опционально); демон добавляет в системный промт строку «язык интерфейса пользователя — X, отвечай на нём, если собеседник не пишет на другом»; веб-клиент передаёт текущий язык UI (getCurrentLanguage). Причина: маленькие модели (3-4B) ненадёжно определяют язык по коротким репликам ✅ текущая волна
- [x] **Консьерж: кастомная добавка к промту** (опционально): поле `conciergeExtraPrompt` в setup.json — ДОБАВЛЯЕТСЯ к базовому системному промту (не заменяет его — правила безопасности и tool-рамки неприкосновенны) ✅ concierge service

## Текущая контрольная точка — wave 6.9 + Concierge + проверки (04.07.2026)
- [x] Wave 6.9 motion fixes по `design/MOTION.md`: токены, shimmer, drawer timings, status/permission glow, Listen/Voice motion, reduced-motion, кнопка `↓ к концу`.
- [x] Concierge/Jarvis fixes: русское имя «Джарвис» для ru/lang=ru без конфликтующего prompt, persist истории в web, refresh/status reconnect bug, stateless LM Studio context через полный feed/messages.
- [x] CLI tests изолированы от окружения: API tests мокают актуальный P2P URL source, listAgentSessions не читает реальные `~/.claude`.
- [x] `daemon.state.json` пишется атомарно через temp file + rename; реальный `daemon.integration.test.ts` с test server проходит 12/12.
- [x] Offline reconnection tests детерминированы через injectable retry delay; full CLI suite больше не ждёт случайный backoff.
- [x] Проверки в основном repo: web typecheck/test/build, CLI typecheck/build/test, daemon integration с server.
- [ ] Smoke с телефона: `npm start` → QR/PWA/chat/permissions/voice/zen/Concierge/splash/native-feel.
- [ ] После принятия владельцем: visual regression baseline → удаление `packages/remcli-app` → settings rekey → web terminal.

## Этап 6.6 — Проверка соответствия дизайну (решение владельца 02.07.2026; после волны 6.4)
- [ ] **ИИ-визуальный аудит** (разовый + по запросу): воркфлоу-агенты с браузером открывают эталон design/pages/*.html и живую страницу приложения (fixture-режим), скриншотят оба (390×844 + desktop, dark + light), сравнивают семантически (отступы, цвета, статусы, анимации по MOTION.md) → отчёт несоответствий по всем 8 экранам; ориентир — HTML-эталоны (не скриншоты)
- [ ] **Fixture-режим приложения**: детерминированные состояния экранов (фикс-данные чата/сессий) для скриншот-тестов — без него visual regression невозможен
- [ ] **Playwright visual regression в CI**: baseline снимается с ПРИНЯТОГО владельцем вида приложения (не с дизайн-HTML — шрифтовый рендеринг даст ложные диффы), toHaveScreenshot с порогом; ловит регрессии дизайна
- [ ] **Детерминированные дизайн-тесты**: kit-компоненты используют правильные токены (status-цвета, радиусы, mono), тач-цели ≥44px, axe a11y

## Этап 6.5 — Терминал в вебе (ПОСЛЕ полного перехода на новый дизайн и удаления remcli-app)
- [ ] PTY-стриминг в демоне: node-pty уже в зависимостях CLI — спавн/attach shell на машине, socket-события terminal-output/terminal-input/resize (session-scoped, E2E-шифрование как у сообщений), лимиты и авторизация как у остальных RPC
- [ ] TerminalPage: заменить заглушку на живой терминал (xterm.js — сверить через context7), always-dark (#050507) по дизайну
- [ ] Безопасность: терминал = полный доступ к машине — только после явного подтверждения на хосте или отдельного флага демона

## Этап 6.7 — Постоянное сопряжение и автозапуск (решения владельца 03.07.2026)
- [ ] **Persistent pairing (ПРИОРИТЕТ)**: shared secret генерируется один раз и сохраняется в ~/.remcli/ (chmod 600), демон переиспользует его при рестартах; порт закрепляется (fallback на новый, если занят); команда `remcli daemon rekey` для принудительной смены ключа. Итог: QR сканируется один раз, подключение переживает рестарты/перезагрузки. Сейчас run.ts:198 генерит новый секрет на каждый старт — автозапуск и PWA cold start бессмысленны без этого
- [ ] **UI rekey в настройках веб-клиента** (идея владельца 03.07.2026, обдумывается): кнопка «Обновить ключ подключения» → Dialog-предупреждение (другие устройства потеряют доступ, нужен рескан) → RPC rekey, демон возвращает новый секрет ИНИЦИАТОРУ по текущему зашифрованному каналу → клиент сохраняет в localStorage и бесшовно переподключается (короткий сплэш → Home). Отдельная кнопка «Показать QR» — рисует QR подключения на экране (демон уже отдаёт данные) для добавления нового устройства сканом с экрана. Требует серверной части: rekey как RPC (не только CLI-команда), безопасная доставка нового секрета инициатору
- [ ] Оговорка туннеля: quick-туннель cloudflared меняет URL при каждом старте (ограничение бесплатных туннелей) — задокументировать; опция named tunnel (аккаунт Cloudflare) — отдельным пунктом при желании владельца
- [ ] **Автозапуск Windows**: `remcli daemon install` через Task Scheduler (schtasks) — структура по образцу daemon/mac/ → daemon/windows/
- [ ] **Автозапуск Linux**: systemd user unit → daemon/linux/

## Этап 7 — Фичи демона (после чистки, параллельно с 6)
- [ ] **Local concierge (LM Studio)**: опциональный «швейцар» в демоне через OpenAI-совместимый API (localhost:1234) — приветствие, статус сессий, запуск агента через существующие RPC демона (list/spawn-session) с function calling; строгий системный промпт; переключение чата на агента после запуска
- [ ] TTS: выбор edge-голоса по options.lang вместо хардкода ru-RU
- [ ] daemon.state.json: сохранять state/stateReason при остановке; персистить PID детей
- [ ] Подпись P2P-запросов (порт на 0.0.0.0) — по daemon/CLAUDE.md

---

## Решения владельца (02.07.2026)
1. Artifacts: УДАЛИТЬ ✅ (волны 2-3)
2. PostHog: УДАЛИТЬ ✅ (волна 2)
3. Remote push убрать, локальные нотификации оставить; vision-camera убрать ✅
4. -zen: доводить до релиза → в составе новой веб-версии (6.2)
5. LM Studio concierge: ДА (этап 7)
6. Клиент: ТОЛЬКО ВЕБ, shadcn/ui, полная миграция; remcli-app удалить после паритета; Tauri убрать
7. Незакоммиченное закоммичено и запушено ✅
