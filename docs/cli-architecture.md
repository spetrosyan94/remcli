# Архитектура CLI

Этот документ описывает Remcli (`packages/remcli-cli`) и его демон. CLI — это одновременно интерактивный инструмент и фоновый менеджер сессий, который синхронизирует состояние машины с сервером.

## Обзор системы

```mermaid
graph TB
    subgraph "Remcli"
        Entry[src/index.ts]
        API[API Client]
        Daemon[Daemon Process]
        Agents[Agent Runners]
        Persist[Persistence]
    end

    subgraph "~/.remcli"
        Settings[settings.json]
        AccessKey[access.key]
        DaemonState[daemon.state.json]
        Logs[logs/]
    end

    subgraph "P2P Server"
        HTTP[HTTP API]
        Socket[Socket.IO]
    end

    Entry --> API
    Entry --> Daemon
    Entry --> Agents
    Entry --> Persist

    Persist --> Settings & AccessKey & DaemonState & Logs

    API --> HTTP & Socket
    Daemon --> API
    Agents --> API
```

## Общая структура
- **Точка входа:** `src/index.ts` разбирает подкоманды и маршрутизирует выполнение.
- **API-клиент:** `src/api` отвечает за HTTP + Socket.IO, шифрование и RPC.
- **Демон:** `src/daemon` работает в фоне, запускает сессии и поддерживает состояние машины.
- **Персистентность/конфигурация:** `src/persistence.ts` + `src/configuration.ts` управляют локальным состоянием в `~/.remcli`.
- **Агенты:** `src/claude`, `src/cursor`, `src/codex`, `src/gemini` — раннеры для конкретных провайдеров.

## Поток запуска CLI

```mermaid
flowchart TD
    Start([remcli ...]) --> Parse[Parse subcommand]

    Parse --> Doctor{doctor?}
    Parse --> Auth{auth?}
    Parse --> Connect{connect?}
    Parse --> Agent{cursor/codex/gemini?}
    Parse --> Default{default}

    Doctor --> RunDoctor[Run diagnostics]
    Auth --> RunAuth[Auth flow]
    Connect --> RunConnect[Connect machine]

    Agent --> Setup[authAndSetupMachineIfNeeded]
    Default --> Setup

    Setup --> Context{Background?}
    Context --> |Yes| StartDaemon[Start daemon]
    Context --> |No| RunAgent[Run agent directly]

    StartDaemon --> SpawnSession[Spawn session]
```

`src/index.ts` — роутер CLI. Он:
- Разбирает подкоманды (`doctor`, `setup`, `auth`, `connect`, `cursor`, `codex`, `gemini` и сценарии запуска по умолчанию).
- При необходимости обеспечивает аутентификацию и настройку машины (`authAndSetupMachineIfNeeded`).
- Запускает демон или агент напрямую в зависимости от подкоманды/контекста.

## Локальное состояние и конфигурация

```mermaid
graph LR
    subgraph "~/.remcli"
        direction TB
        settings["settings.json<br/><i>profile, onboarding</i>"]
        access["access.key<br/><i>encryption keys</i>"]
        daemon["daemon.state.json<br/><i>PID, port, version</i>"]
        logs["logs/<br/><i>CLI/daemon logs</i>"]
    end

    subgraph "Environment Overrides"
        direction TB
        E1[REMCLI_HOME_DIR]
        E2[REMCLI_VARIANT]
        E3[REMCLI_EXPERIMENTAL]
        E4[REMCLI_DISABLE_CAFFEINATE]
    end

    E1 -.-> settings & access & daemon & logs
```

Локальное состояние хранится в `~/.remcli` (или `REMCLI_HOME_DIR`):
- `settings.json`: настройки онбординга и профиля (валидируются/мигрируются).
- `access.key`: локальный ключевой материал для шифрования/аутентификации.
- `daemon.state.json`: строгий локальный lifecycle-снимок daemon (`instanceId`, state/reason, PID, порты, версия и диагностические child PID), без ключей pairing или runner credentials. Unversioned state старого релиза служит только migration-диагностикой: handoff блокируется лишь для наблюдаемого Remcli `daemon start-sync`, а wrapper/reused/unrelated PID игнорируется. Подтверждённый legacy daemon требует явной остановки прежним CLI/Terminal и никогда не завершается по PID из файла.
- `logs/`: логи CLI/демона.

Конфигурация находится в `src/configuration.ts`:
- Поведение управляется переменными `REMCLI_VARIANT`, `REMCLI_EXPERIMENTAL`, `REMCLI_DISABLE_CAFFEINATE`.

## Архитектура API-клиента

```mermaid
graph TB
    subgraph "API Clients"
        Base[ApiClient]
        Session[ApiSessionClient]
        Machine[ApiMachineClient]
        Encrypt[encryption.ts]
    end

    subgraph "P2P Server"
        HTTP[HTTP API]
        Socket[Socket.IO]
    end

    Base --> |POST /v1/sessions| HTTP
    Base --> |POST /v1/machines| HTTP

    Session --> |session-scoped| Socket
    Machine --> |machine-scoped| Socket

    Encrypt --> Base & Session & Machine
```

### HTTP
`ApiClient` (`src/api/api.ts`) отвечает за:
- Создание сессий (`POST /v1/sessions`) с зашифрованными метаданными/состоянием.
- Регистрацию машины (`POST /v1/machines`) с зашифрованными метаданными/состоянием демона.
- Остальные CRUD-операции через `ApiSessionClient` и `ApiMachineClient`.

### WebSocket

```mermaid
graph LR
    subgraph "ApiSessionClient"
        S_In[Receive: update]
        S_Out[Emit: message, update-metadata,<br/>update-state, session-alive, usage-report]
    end

    subgraph "ApiMachineClient"
        M_In[Receive: machine updates]
        M_Out[Emit: machine-alive,<br/>update metadata/state]
    end

    P2PServer((Socket.IO)) --> S_In & M_In
    S_Out & M_Out --> P2PServer
```

`ApiSessionClient` (`src/api/apiSession.ts`) подключается к Socket.IO как **session-scoped** клиент:
- Принимает события `update` и расшифровывает содержимое сообщений.
- Отправляет `message`, `update-metadata`, `update-state`, `session-alive` и `usage-report`.
- Выбирает схему live user prompt один раз из initial `metadata.flavor` daemon-owned
  runner-а. Позднее изменение metadata не способно сменить schema: Codex и
  Cursor принимают только текст с безопасной меткой источника, Claude/Gemini —
  только свои legacy native поля. Для старой transport-сессии без известного
  provider допустим лишь такой же безопасный text prompt; model, permissions,
  system prompt и tool controls отклоняются до runner callback.
- Typed `metadata.executionOutcome` синхронизируется через `update-metadata` как
  watermark `{ kind, occurredAt }`; error text, stack и provider payload туда не
  входят. Правила записи и UI-приоритеты: [протокол](protocol.md).

`ApiMachineClient` (`src/api/apiMachine.ts`) подключается как **machine-scoped** клиент:
- Шлёт heartbeat-события `machine-alive`.
- Обновляет метаданные машины/состояние демона с оптимистичным контролем конкурентности.
- Принимает обновления машины и сливает их локально.

### Шифрование

```mermaid
flowchart LR
    subgraph "Client-side"
        Plain[Plaintext Data]
        Encrypt[encryption.ts]
        B64[Base64 Encoded]
    end

    Plain --> |encrypt| Encrypt --> B64 --> |send| P2PServer[(P2P Server)]
    P2PServer --> |receive| B64 --> |decrypt| Encrypt --> Plain

    style Plain fill:#e8f5e9
    style B64 fill:#fff3e0
```

CLI шифрует клиентский контент до того, как он покидает машину, через `src/api/encryption.ts`.
- Метаданные сессии, состояние агента, сообщения, состояние машины и значения KV шифруются на стороне клиента.
- Кодирование на проводе — base64; см. `encryption.md`.

## Архитектура демона

```mermaid
graph TB
    subgraph "Daemon Process"
        Control[Control Server<br/>127.0.0.1:port]
        Sessions[Session Map]
        MachineClient[ApiMachineClient]
    end

    subgraph "Child Processes"
        S1[Session 1]
        S2[Session 2]
        S3[Session N]
    end

    CLI[CLI] --> |IPC| Control
    Control --> Sessions
    Sessions --> S1 & S2 & S3

    MachineClient --> |heartbeat| P2PServer[(P2P Server)]
    MachineClient --> |state sync| P2PServer
```

Демон — долгоживущий процесс, отвечающий за выполнение сессий в фоне и поддержание присутствия машины.

### Структура модулей

`src/daemon/run.ts` — тонкий координатор, связывающий сфокусированные модули:

| Модуль | Ответственность |
|--------|-----------------|
| `run.ts` | Оркестрация запуска/остановки: lock-файл, P2P-сервер, QR-код, туннель, связывание модулей ниже |
| `sessionSpawner.ts` | Фабрика менеджера сессий: запуск/остановка/трекинг дочерних сессий, окна tmux, очистка |
| `providerSpawnRequest.ts` | Строгая provider-discriminated граница encrypted machine-RPC перед capability validation и process spawn |
| `src/daemon/sessions/listAgentSessions.ts` | Сканирует on-disk хранилища сессий агентов (Claude/Codex/Cursor/Gemini) для пикера resume (RPC `list-agent-sessions`) |
| `machineSocket.ts` | Machine-scoped Socket.IO-клиент, подключающийся к собственному P2P-серверу демона; регистрирует RPC-обработчики (`spawn-session` и др.) |
| `heartbeat.ts` | Интервальный цикл: удаляет мёртвые сессии, при смене версии запрашивает свой graceful shutdown и передаёт replacement только после release lock, обнаруживает чужие демоны, пишет heartbeat в файл состояния |
| `controlServer.ts` | Локальный HTTP IPC только на `127.0.0.1` |

### Жизненный цикл

```mermaid
flowchart TD
    Start([startDaemon]) --> Validate[Validate version]
    Validate --> Lock[Acquire lock file]
    Lock --> Auth[Authenticate]
    Auth --> Register[Register machine with server]
    Register --> Control[Start control server]
    Control --> Track[Track child sessions]
    Track --> Sync[Sync daemon state to server]
    Sync --> Running([Running])

    Running --> |SIGTERM| Shutdown[Cleanup & exit]
```

1. `startDaemon()` проверяет запущенную версию и захватывает lock-файл.
2. Аутентифицируется и регистрирует машину на сервере.
3. Запускает локальный **контрольный сервер** для IPC.
4. Ведёт map отслеживаемых дочерних сессий и обновляет состояние демона на сервере.

### Раздача веб-приложения

Демон раздаёт предсобранное веб-приложение (`packages/remcli-web/dist/` или bundled `web-dist/`) как статические файлы через `@fastify/static` на том же порту P2P-сервера. Это позволяет закодировать в QR-код URL, открывающий веб-приложение прямо с демона — отдельный dev-сервер не нужен. Демон ищет веб-сборку в:

1. Переменной окружения `REMCLI_WEB_DIR`
2. `../remcli-web/dist` относительно пакета `packages/remcli-cli`
3. `web-dist/` внутри опубликованного CLI-пакета
4. `packages/remcli-web/dist` относительно cwd

SPA-fallback роут отдаёт `index.html` на любой несматченный GET-запрос (кроме API-роутов `/v1/*` и `/v2/*`). Статические файлы раздаются без аутентификации; `bearer token` требуется только для API-роутов.

### Автозапуск при входе пользователя

`remcli daemon autostart install [--tunnel]` устанавливает user-level автозапуск
без `sudo` или прав администратора:

| Платформа | Механизм | Ресурс |
|-----------|----------|--------|
| macOS | LaunchAgent | `~/Library/LaunchAgents/com.remcli-cli.daemon.plist` |
| Linux | `systemd --user` | `~/.config/systemd/user/remcli.service` |
| Windows | Task Scheduler | `RemcliDaemonAutostart` |

Все три адаптера запускают absolute `process.execPath` и текущий
`dist/index.mjs daemon start-sync`; `--tunnel` сохраняется только как launch
argument. Pairing files, ключи и произвольное окружение в unit/task не
записываются. Ресурс имеет owner marker `remcli-managed-autostart-v1`: чужой
plist/unit/task не перезаписывается и не удаляется.

macOS adapter работает только в `gui/<uid>` текущего пользователя, не требует
`sudo`, не создаёт системный сервис и не использует `KeepAlive`, `WatchPaths`
или `StartInterval`. Linux adapter проверяет доступность user manager, но не
включает lingering; unit использует `Restart=no`. Windows task запускается при
logon текущего пользователя с `InteractiveToken` и `LeastPrivilege`, без
restart policy.
Поэтому явный `remcli daemon stop` оставляет daemon остановленным до ручного
старта или следующего входа пользователя. Удаление autostart не завершает уже
работающий daemon; для этого отдельно используется `remcli daemon stop`.
Если autostart удалён во время работы daemon, текущий проверенный LaunchAgent
помечается как stale до явного stop: повторная установка не останавливает его
сама. После `remcli daemon stop` следующий install безопасно выгружает только
остановленный Remcli job и создаёт свежий user-level autostart.

`remcli daemon autostart status` показывает missing/foreign/installed/stale,
режим tunnel и устаревший absolute Node/package path. Повторная установка
обновляет только owned resource. Пользовательская установка не использует и не
скачивает Docker image.

Сам P2P daemon может запуститься без `tmux`; это позволяет диагностике и web
подключению работать на любом host. Создание AI-сессии остаётся отдельной
provider boundary: на macOS/Linux нужен `tmux`, а на native Windows текущая
версия честно предлагает WSL с `tmux`, не выдавая Task Scheduler за готовый
terminal transport.

### Контрольный сервер (локальный IPC)

```mermaid
sequenceDiagram
    participant CLI
    participant State as daemon.state.json
    participant Control as Control Server
    participant Daemon

    CLI->>State: Read port
    State-->>CLI: port: 12345

    CLI->>Control: GET /list
    Control-->>CLI: [sessions...]

    CLI->>Control: POST /spawn-session
    Control->>Daemon: Spawn child process
    Daemon-->>Control: Session started
    Control-->>CLI: OK

    CLI->>Control: POST /stop
    Control->>Daemon: Shutdown
```

`startDaemonControlServer()` (`src/daemon/controlServer.ts`) запускает HTTP-сервер на `127.0.0.1` и предоставляет:
- `/list` (список активных сессий)
- `/stop-session`
- `/spawn-session`
- `/stop` (остановка демона)
- `/session-started` (самоотчёт сессии)
- `/pairing-rekey/approve` (только локальное подтверждение pending pairing rekey)

CLI общается с этим сервером через `controlClient.ts`, используя порт и `instanceId` из `daemon.state.json`: сначала проверяется `GET /identity`, затем выполняется управляющий запрос. `stopped`/`failed` snapshot не является разрешением на HTTP-команду или PID-only kill.

### Pairing QR и rekey

`p2pPairing.ts` хранит v2 pairing отдельно от daemon state: revocable `authSecret`, стабильный `contentSecret`, порт и дату. `PairingRekeyCoordinator` живёт только в памяти daemon и связывает browser request, TTL, host approval и sealed delivery. `machineSocket.ts` обслуживает `show-pairing-qr`, `request-pairing-rekey` и cancel pending request; подтверждение невозможно вызвать через P2P RPC и выполняется CLI-командой `remcli daemon rekey approve <request-id> <code>` через loopback control server. Перед commit coordinator повторно проверяет TTL/state, чтобы async QR generation не отозвала bearer после истечения ticket.

После успешной записи pairing файла `run.ts` переключает P2P auth secret, закрывает old user/machine sockets и заново подключает собственный machine socket. Content key и ACK runner credential не ротируются, поэтому активная Codex session не перезапускается. Полный wire contract — в [protocol.md](protocol.md) и [encryption.md](encryption.md).

### Запуск сессий

```mermaid
flowchart LR
    subgraph "Session Sources"
        CLI[CLI<br/><i>foreground</i>]
        Daemon[Daemon<br/><i>background</i>]
        Remote[Mobile/Web<br/><i>via RPC</i>]
    end

    subgraph "Session Process"
        Session[Agent Session]
        Handlers[RPC Handlers]
    end

    CLI --> Session
    Daemon --> Session
    Remote --> |spawn-session| Daemon --> Session

    Session --> Handlers

    subgraph "RPC Surface"
        Handlers --> Bash[bash]
        Handlers --> Files[file read/write]
        Handlers --> Search[ripgrep]
        Handlers --> Diff[difftastic]
    end
```

Сессии могут быть запущены:
- CLI напрямую (foreground).
- Демоном (в фоне).
- Удалёнными запросами по RPC (из mobile/web через подключение машины).

Каждая daemon-owned сессия получает собственный immutable tmux ownership tuple
(`sessionName`, window, pane, PID и owner marker). Display name tmux не
используется как идентификатор для destructive cleanup. На macOS daemon может
попросить Terminal.app открыть attach к owned pane: результат явно возвращается
как `opened`, `unavailable` или `not-requested`; невозможность открыть окно не
выдаётся за ошибку запуска agent runner.

При stop демон освобождает только подтверждённо owned child process/pane. При
`unknown` или `mismatch` tracking сохраняется для безопасной повторной попытки,
а не расширяется до пользовательского Terminal window или чужой tmux-сессии.

Внешний machine-RPC проходит `providerSpawnRequest.ts` до capability discovery:
общие lifecycle fields отделены от provider-native schemas. Поэтому Codex
получает только app-server selection, Cursor - только headless stream controls,
а daemon-issued runner identity никогда не приходит от web-клиента.

Для уже активных daemon-owned Codex/Cursor wrappers отдельные strict RPC
`get-session-execution` и `set-session-execution` работают только с exact Remcli
session ID. Snapshot имеет CAS revision и `current/pending`; запись проходит
fresh provider validation, а runner применяет pending через защищённый local
control endpoint перед следующим phone prompt. Это общий продуктовый contract,
но исполнение остаётся provider-native: Codex начинает новый app-server turn,
Cursor запускает следующий headless `--resume` с тем же native ID.

Запуск сессий демоном использует `registerCommonHandlers` для предоставления контролируемой RPC-поверхности (shell-команды, файловые операции, помощники поиска/diff).

### Возобновление сессий (resume)

Поддержка возобновления предыдущей сессии агента (например, по нажатию «Resume» в клиенте) различается по агентам:

| Агент | Resume | Механизм |
|-------|--------|----------|
| Claude Code | Реализован путь, acceptance pending | `--resume <id>`; история исходной сессии реплеится в P2P-хранилище (`src/claude/utils/replaySessionHistory.ts`). Отдельные provider-specific daemon-boundary, real CLI и Browser fixture gates ещё не приняты. |
| Cursor | Lifecycle D/I/L/UI-F принят | `agent --resume <id>` сохраняет подтверждённый native Cursor ID и workspace между headless turns. Account-visible model валидируется daemon-ом; смена модели в чате применяется только к следующему prompt через тот же native ID, без reset сессии. `Agent` / `Plan` / `Ask` и launch controls остаются session-level. Delivery подтверждается после matching `system/init`, bind и согласованного metadata; transient metadata failure в том же runner повторяет только reconciliation, без второго native prompt. Active resume и cleanup защищены daemon runner credential и immutable tmux ownership. Детали: [Cursor CLI](agent-architecture/cursor-cli-architecture.md). |
| Gemini | Реализован путь, acceptance pending | ACP `session/load`, если агент декларирует capability `loadSession`; иначе откат к новой сессии (`src/agent/acp/AcpBackend.ts`). Отдельные ACP daemon-boundary, real provider и Browser fixture gates ещё не приняты. |
| Codex | Поддерживается | Официальный app-server хранит один native thread для phone и remote TUI. Attach-only resume не создаёт фиктивный prompt. Account-visible model/reasoning валидируются daemon-ом; смена в открытом чате применяется к следующему `turn/start`, а активный старый turn не получает новый prompt через `turn/steer`. Shared transport имеет typed private fallback; MCP не используется как chat/resume transport. Детали: [Codex / ChatGPT](agent-architecture/codex-chatgpt-architecture.md). |

### Контракт resume picker

`list-agent-sessions` сортирует только по provider-native `lastModified`. Web
никогда не использует UUID как заголовок: порядок primary label — provider
`sessionName`, затем `firstMessage`, затем нейтральное
`provider · project · activity`; native ID остаётся коротким вторичным
идентификатором.

- Codex читает bounded first user message только transiently из уже существующей
  native JSONL history. Remcli не создаёт отдельную persistent копию prompt.
- Cursor использует `~/.cursor/chats/.../store.db` только как existence/mtime
  marker и не читает SQLite schema или transcript. При отсутствии публичного
  title API picker показывает нейтральный fallback с выбранной директорией.
- RPC не принимает и не сохраняет title/preview. Directory filter применяется
  до ответа, поэтому picker не предлагает незаметный resume другой папки.

Примечания по агентам:
- **Cursor**: бинарник CLI определяется как `agent` (fallback: `cursor-agent` для старых сборок); headless turn использует `--print --output-format stream-json --trust`. Daemon нормализует account-visible `agent models` в short-lived catalog, а New Session отправляет exact `cursorExecution { model, catalogVersion }`; raw CLI output, static web catalog и stale selection не проходят. Обычный Agent не получает несуществующий `--mode agent`; `plan`/`ask` маппятся в нативный `--mode`, а `force`/`auto-review` - в отдельные флаги. До создания daemon-owned P2P session runner подтверждает одноразовую daemon capability через `/cursor-runner-preflight`; ручной `--started-by daemon` не считается provenance и terminal не читает injected daemon model env. После `system/init` wrapper проходит credential-protected атомарную привязку native ID через `/cursor-session-bound`. При корректном `Ctrl+C` credential-protected `runner-stopping` блокирует новый resume до archive/flush/close, а `runner-stopped` освобождает только immutable owned pane; неполный proof остаётся tracked для retry. Bind создаёт in-memory lineage `{native ID -> previous Remcli P2P session, workspace}` только для daemon-owned wrapper; same-daemon resume получает provisional parent relation в initial metadata, которую matching `system/init` + bind подтверждает, а pre-init failure/abort/stop/mode change удаляет до fresh turn/archive. Неудачный bounded metadata rollback завершает wrapper fail-closed. Web использует связь только для уже существующей P2P-ленты Remcli: native Cursor history/DB не читается, external Cursor sessions и restart daemon relation не создают. Это исключает повторный tmux wrapper для active resume. Детали: [agent-architecture/cursor-cli-architecture.md](agent-architecture/cursor-cli-architecture.md).
- **Gemini**: режим ACP использует `--acp` на новых сборках с откатом к `--experimental-acp` (проверяется однократно через `gemini --help`). С 2026-06-18 Google отключил доступ Gemini CLI для OAuth-пользователей (аккаунт Google) — CLI выводит понятную ошибку с предложением аутентификации по API-ключу вместо общего сбоя.

### Состояние машины

```mermaid
graph TB
    subgraph "Machine Metadata (static)"
        M1[host]
        M2[platform]
        M3[CLI version]
        M4[paths]
    end

    subgraph "Daemon State (dynamic)"
        D1[pid]
        D2[httpPort]
        D3[startedAt]
        D4[shutdown info]
    end

    subgraph "Sync Targets"
        P2PServer[(P2P Server)]
        Local[daemon.state.json]
    end

    ApiMachine[ApiMachineClient]

    M1 & M2 & M3 & M4 --> ApiMachine
    D1 & D2 & D3 & D4 --> ApiMachine
    D1 & D2 & D3 & D4 --> Local

    ApiMachine --> P2PServer
```

- **Метаданные машины** — статическая информация (host, платформа, версия CLI, пути).
- **Состояние демона** — динамическое (pid, httpPort, startedAt, информация об остановке).

Демон обновляет их через `ApiMachineClient` и зеркалирует локальное состояние в `daemon.state.json` для контроля/диагностики.

## RPC и мост инструментов

```mermaid
sequenceDiagram
    participant Mobile
    participant P2PServer as P2P Server
    participant Daemon
    participant Session

    Mobile->>P2PServer: RPC: spawn-session
    P2PServer->>Daemon: Forward via Socket.IO
    Daemon->>Session: Spawn process
    Session-->>Daemon: Running

    Mobile->>P2PServer: RPC: bash "ls -la"
    P2PServer->>Session: Forward via Socket.IO
    Session->>Session: Execute command
    Session-->>P2PServer: Result
    P2PServer-->>Mobile: Result

    Note over Mobile,Session: All RPC flows through Socket.IO<br/>No direct REST exposure
```

RPC используется для отправки команд по Socket.IO-соединению:
- Сессии регистрируют RPC-обработчики (например, `bash`, чтение/запись файлов, `ripgrep`, `difftastic`).
- Демон регистрирует обработчик `spawn-session`, чтобы сервер/мобильный клиент мог попросить его запустить локальную сессию.

Этот механизм позволяет P2P-серверу и мобильным клиентам управлять локальными действиями без широкой REST-поверхности.

## Сервисы демона

Опциональные сервисы, размещённые в демоне и доступные через P2P REST API:

| Сервис | Endpoints | Примечания |
|--------|-----------|------------|
| Whisper STT | `GET /v1/whisper/status`, `POST /v1/voice/transcribe` | Локальная транскрипция через whisper.cpp (`src/daemon/whisper/`) |
| TTS | `GET /v1/tts/status`, `POST /v1/voice/synthesize` | edge-tts (по умолчанию) или qwen3-tts; при `ttsEdgeVoice: 'auto'` (дефолт конфигурации) голос Edge подбирается по языку ответа (`src/daemon/tts/edgeTtsProvider.ts`) |
| Concierge | `GET /v1/concierge/status`, `POST /v1/concierge/chat` | Опциональный локальный LLM-ассистент («Jarvis») через LM Studio (`src/daemon/concierge/conciergeService.ts`). Персона + мягкие правила: `CONCIERGE_SYSTEM_PROMPT`; жёсткие ограничения в коде (whitelist из 3 инструментов, валидация агента/директории перед запуском, 4 раунда × 5 вызовов инструментов, один spawn на диалог). Пользовательский суффикс промпта: `conciergeExtraPrompt` в setup.json (не может переопределить базовые правила) |

### Локальный concierge (LM Studio)

Лёгкий LLM-ассистент, встроенный в демон. По умолчанию отключён; включается через `conciergeEnabled` в `~/.remcli/setup.json` (`conciergeUrl` по умолчанию `http://127.0.0.1:1234/v1`, пустой `conciergeModel` = первая модель, которую сообщает сервер). Работает с любым OpenAI-совместимым API и маршрутизирует намерение в детерминированные вызовы функций:

- `list_sessions` — список активных сессий
- `get_daemon_status` — версия/uptime/порт/туннель демона
- `spawn_agent_session` — запускает сессию агента, только по явному запросу пользователя

`POST /v1/concierge/chat` возвращает `{ reply, actions }`; доступность дёшево проверяется запросом к `{url}/models` (выключенный LM Studio возвращает 503 и никогда не роняет демон).

## Мастер настройки и диагностика

### `remcli setup`

Интерактивный мастер настройки (`src/commands/setup.ts`), который конфигурирует:
1. **Модель Whisper STT** — выбирает и скачивает локальную модель распознавания речи.
2. **TTS-провайдер** — edge-tts (бесплатно, без настройки) или qwen3-tts (локальное клонирование голоса, только Apple Silicon).
3. **Установку AI-агентов** — устанавливает поддерживаемых агентов кроссплатформенными командами.
4. **HTTPS-туннель cloudflared** — устанавливает бинарник cloudflared для удалённого доступа и голосового ввода в вебе.

Поддерживаемые агенты:

| Агент | Бинарник | macOS / Linux | Windows |
|-------|----------|---------------|---------|
| Claude Code | `claude` | `curl -fsSL https://claude.ai/install.sh \| bash` | `irm https://claude.ai/install.ps1 \| iex` |
| Gemini CLI | `gemini` | `npm install -g @google/gemini-cli` | `npm install -g @google/gemini-cli` |
| Codex CLI | `codex` | `npm install -g @openai/codex` | `npm install -g @openai/codex` |
| Cursor CLI | `agent` (старые сборки: `cursor-agent`) | `curl https://cursor.com/install -fsS \| bash` | `curl https://cursor.com/install -fsS \| bash` |

Установка cloudflared по платформам:

| Платформа | Команда |
|-----------|---------|
| macOS | `brew install cloudflared` |
| Linux | скачивание `.deb` из GitHub releases |
| Windows | `winget install Cloudflare.cloudflared` |

Authtoken не нужен — quick tunnels cloudflared работают из коробки.

Определение платформы — через `process.platform === 'win32'`. Установка выполняется со `stdio: 'inherit'`, чтобы пользователь видел прогресс в реальном времени.

Конфигурация сохраняется в `~/.remcli/setup.json`.

### `remcli doctor`

Команда диагностики (`src/ui/doctor.ts`), которая проверяет:
- Базовую информацию (версия, платформа, Node.js)
- Статус демона и процессы
- Статус модели Whisper STT
- Статус TTS-провайдера
- **Доступность AI-агентов** — обнаруживает все четыре агента (Claude Code, Gemini CLI, Codex CLI, Cursor CLI) через `which`/`where` и сообщает установленные версии (Cursor: `agent`, fallback `cursor-agent`)
- Файлы логов и ссылки на поддержку

## Ссылки на реализацию
- Точка входа CLI: `packages/remcli-cli/src/index.ts`
- Координатор демона: `packages/remcli-cli/src/daemon/run.ts`
- Модули демона: `packages/remcli-cli/src/daemon/sessionSpawner.ts`, `machineSocket.ts`, `heartbeat.ts`
- Контрольный сервер/клиент: `packages/remcli-cli/src/daemon/controlServer.ts`, `packages/remcli-cli/src/daemon/controlClient.ts`
- Concierge: `packages/remcli-cli/src/daemon/concierge/conciergeService.ts`
- TTS: `packages/remcli-cli/src/daemon/tts/`
- API-клиенты: `packages/remcli-cli/src/api`
- Персистентность: `packages/remcli-cli/src/persistence.ts`
- Конфигурация: `packages/remcli-cli/src/configuration.ts`
