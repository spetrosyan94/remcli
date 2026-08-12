# Протокол

Этот документ описывает сетевой протокол Remcli в том виде, в каком он реализован в P2P-сервере (`packages/remcli-cli/src/daemon/p2p/`). Протокол намеренно мал: JSON поверх HTTP для чтения/действий и Socket.IO для синхронизации в реальном времени. Большинство payload сквозно шифруется на стороне клиента; границы шифрования и детали кодирования — см. `encryption.md`.

> Границы шифрования и request integrity описаны в
> [encryption.md](encryption.md) и [p2p-security.md](p2p-security.md). Direct
> LAN через HTTP остаётся режимом доверенной сети; request proof не заменяет
> HTTPS.

## Транспорт и версионирование
- HTTP API: JSON-запросы/ответы на роутах `/v1` и `/v2`.
- WebSocket: Socket.IO-сервер на пути `/v1/updates` (транспорты: websocket, polling).
- CORS: `*` (на стороне сервера).

## Мотивация дизайна протокола
Протокол спроектирован минимальным, явным и устойчивым к нестабильной связи. Несколько руководящих принципов определяют нейминг, payload и версионирование:

- **Малая поверхность вместо полноты.** Роуты и события существуют, только если дают чёткий примитив синхронизации (например, сессии, машины, KV). Если возможность можно выразить как данные внутри существующего примитива — так и следует делать.
- **Явные типы событий и короткие ключи.** Payload обновлений использует `t` для типа события и лаконичные имена полей (`sid`, `id`, `seq`), чтобы уменьшить размер сообщений без потери смысла. Эти имена стабильны, потому что используются всеми клиентами.
- **Разделение персистентного и эфемерного.** Всё, что должно восстанавливаться после переподключения, — событие `update` с номером последовательности. Присутствие и usage — `ephemeral`, чтобы избежать путаницы состояния и минимизировать хранение.
- **Монотонное упорядочивание на уровне пользователя.** `UpdatePayload.seq` — единый счётчик на пользователя. Это упрощает согласование на клиенте: применяй обновления по порядку — и ты консистентен для этого пользователя.
- **Оптимистичный контроль конкурентности по умолчанию.** Версионируемые поля (metadata, agent state, daemon state, KV) требуют `expectedVersion`. Это предотвращает молчаливые перезаписи и оставляет разрешение конфликтов за клиентом.
- **Границы шифрования на стороне клиента.** Серверу никогда не нужно понимать plaintext. Поэтому протокол трактует большинство payload как непрозрачные строки или base64-блобы, что упрощает серверную логику и усиливает гарантии приватности.
- **Обратная совместимость вместо ломающих изменений.** Новые роуты/события добавляются, а не мутируют существующие формы несовместимым образом.
- **Отказ от полного набора REST-глаголов.** Чтение — преимущественно `GET`, запись/действия — преимущественно `POST`, `DELETE` — когда намерение однозначно. Полная палитра REST не используется, потому что многие мутации не привязаны чисто к одной сущности или выходят за рамки CRUD-логики. Ограничение `GET` + `POST` (плюс изредка `DELETE`) упрощает клиент и делает протокол яснее.

Если предлагается новое поле или событие протокола, оно должно ответить на вопрос: создаёт ли это долговечный примитив синхронизации, или это можно закодировать внутри существующих зашифрованных payload без расширения поверхности API?

## Аутентификация
API-endpoint'ы (`/v1/*`, `/v2/*`) требуют `Authorization: Bearer <token>`. Тот же токен используется и в handshake Socket.IO. Роуты статических файлов (ассеты веб-приложения) и `/health` аутентификации не требуют. Единственное исключение — одноразовый opaque ticket `GET /v1/pairing-rekey/:ticket`: ответ не содержит открытого ключа и зашифрован на ephemeral public key браузера.

### Request integrity

Bearer аутентифицирует соединение. Все изменяющие HTTP и Socket.IO запросы,
работающие по bearer, дополнительно несут одноразовый request proof, построенный
от `authSecret` и привязанный к transport, операции, request id и payload.
Исключение — daemon-issued session runner с проверенным `runnerCredential` и
ограниченной session scope. Proof содержит подписанный `expiresAt`; daemon
отклоняет отсутствующий, неверный или повторно использованный proof до
handler/store side effect, хранит replay id только до expiry и временно
fail-closed при заполненном живыми id bounded cache. Контракт
заголовков/полей и canonical payload должен оставаться общим для CLI и web;
security model и ограничения — в `p2p-security.md`.

Для JSON HTTP endpoint canonical payload — parsed JSON body. Для multipart
`POST /v1/voice/transcribe` proof имеет action-level payload `null`: он
одноразово привязывает operation/request id, но не хеширует audio stream.

## QR-код и раздача веб-приложения
Демон показывает в терминале QR-код, кодирующий URL:
```
http://<LAN_IP>:<PORT>/terminal/connect#<base64(JSON)>                  (LAN)
https://<subdomain>.trycloudflare.com/terminal/connect#<base64(JSON)>   (tunnel)
```
Хэш-фрагмент — компактный JSON в base64 `{k: <pairing material>, v: <version>}`; host/port выводятся из URL. v1 содержит один 32-byte secret. v2 содержит 64 bytes: `authSecret || contentSecret`. `authSecret` формирует bearer HMAC-SHA512, а `contentSecret` остаётся ключом legacy content encryption. Веб-клиент принимает только соответствующие пары длина/версия.

Если QR недоступен, веб-клиент принимает эту же полную ссылку одной вставкой из terminal output. Отдельные поля адреса и ключа не используются. Принимаются только `http`/`https`; hash-ключ остаётся в браузере и не показывается в статусе или ошибке подключения.

Pairing хранится в `~/.remcli/p2p-pairing.json` с правами `0600`: `{ v: 2, authSecret, contentSecret, port, createdAt }`. Старый файл `{ secret, ... }` мигрируется как одинаковые auth/content secrets. Материал pairing не пишется в `daemon.state.json`, heartbeat, machine metadata или диагностические логи.

### Show QR и rekey

`Show QR` запрашивает QR через зашифрованный machine RPC и отображает его только в React state текущего браузера. Он не попадает в URL, `history.state`, toast или P2P event.

`Rekey` создаёт короткоживущий pending request с browser ephemeral public key. Демон не меняет ключ до локального подтверждения:

```text
remcli daemon rekey approve <request-id> <code>
```

Команда обращается только к loopback control server. При подтверждении daemon записывает новый `authSecret`, отключает user/machine sockets со старым bearer и оставляет `contentSecret` прежним. Актуальный QR запечатывается `tweetnacl.box` для инициировавшего браузера; endpoint ticket отдаёт только sealed payload с `Cache-Control: no-store`. Закрытие pending dialog посылает cancel с request ID и approval code; coordinator повторно сверяет TTL/state перед самой ротацией. После расшифровки replacement browser сохраняет его как recovery credential до Socket.IO handshake: старый bearer уже отозван, а Socket.IO продолжает reconnect. ACK-capable session runner может продолжить или переподключиться только с валидным daemon-issued `runnerCredential`. Если сохранённый порт занят при запуске, daemon выбирает новый случайный порт и новый QR всё равно требуется. Quick-tunnel cloudflared меняет URL после каждого старта, поэтому tunnel QR пересканируется после рестарта. Public QR публикуется только после подтверждения соединения cloudflared с edge. Если регистрация не состоялась или соединение позднее потеряно, daemon очищает public endpoint и остаётся доступен только по LAN; после исправления сети нужен новый запуск `start:tunnel` и новый QR.

`Rekey` ротирует только `authSecret`: старые bearer и request proof сразу
отзываются, а `contentSecret` остаётся у активных runners ради непрерывности.
Это revoke remote control, а не полная ротация конфиденциальности; детали и
границы этой операции описаны в `p2p-security.md`.

## WebSocket-соединение
### Handshake
Подключение через Socket.IO:

```
path: "/v1/updates"
auth: {
  token: "<bearer token>",
  clientType: "user-scoped" | "session-scoped" | "machine-scoped",
  sessionId?: "<session id>",
  machineId?: "<machine id>"
}
```

Правила, проверяемые на сервере:
- `token` обязателен.
- `session-scoped` требует `sessionId`.
- `machine-scoped` требует `machineId`.
- `session-scoped` может читать и менять только свой `sessionId`: `message`,
  metadata/state, lifecycle, usage и ACK проверяются до обращения к store/router.
  Его RPC method обязан начинаться с `<sessionId>:`. Для чужого или
  несуществующего scope возвращается нейтральная ошибка без раскрытия
  существования сессии.

### Типы соединений
- `user-scoped`: получает обновления всего аккаунта.
- `session-scoped`: получает обновления только конкретной сессии.
- `machine-scoped`: используется демонами; получает обновления машины и отправляет её состояние.

### События сервер -> клиент
Сервер отправляет два типа событий:

#### `update`
Персистентные события синхронизации. Форма payload:
```
{
  id: string,
  seq: number,
  body: { t: string, ... },
  createdAt: number
}
```

#### `ephemeral`
Транзиентные события присутствия/usage. Форма payload:
```
{
  type: string,
  ...
}
```

### Типы событий `update`
Имена полей ниже соответствуют payload на проводе.

- `new-session`
  - `body`: `{ t: "new-session", id, seq, metadata, metadataVersion, agentState, agentStateVersion, dataEncryptionKey, active, activeAt, createdAt, updatedAt }`

- `update-session`
  - `body`: `{ t: "update-session", id, metadata?, agentState? }`
  - `metadata`: `{ value, version }` или null
  - `agentState`: `{ value, version }` или null

- `delete-session`
  - `body`: `{ t: "delete-session", sid }`

- `new-message`
  - `body`: `{ t: "new-message", sid, message: { id, seq, content, localId, createdAt, updatedAt } }`

- `new-machine`
  - `body`: `{ t: "new-machine", machineId, seq, metadata, metadataVersion, daemonState, daemonStateVersion, dataEncryptionKey, active, activeAt, createdAt, updatedAt }`

- `update-machine`
  - `body`: `{ t: "update-machine", machineId, metadata?, daemonState?, activeAt? }`

### `executionOutcome` в metadata сессии

`metadata.executionOutcome` — опциональный типизированный watermark результата
исполнения. Его форма строго ограничена двумя полями:

```text
{
  "kind": "error" | "success",
  "occurredAt": 0
}
```

`occurredAt` — timestamp в миллисекундах Unix-времени. Outcome-обновление не
помещает в metadata текст ошибки, stack trace или исходный provider payload.
Текст ошибки живёт отдельно в зашифрованном chat event. В Codex app-server
потоке `runCodex` публикует event вида `{ type: "message", message:
"<redacted>", isError: true }` только после redaction текста; generic
`ApiSessionClient` записывает в metadata лишь `kind` и `occurredAt` и сам не
является универсальным redactor-ом для произвольных сообщений адаптеров.

Правила записи:

- `error` появляется только по явному error-сигналу (`isError: true` в session
  event или ACP message).
- `success` появляется только после live agent output с непустым текстом. Для
  ACP message требуется явный `isError: false`; история при resume, reasoning,
  tool/status events и пустые сообщения outcome не меняют.
- При конфликте или запаздывающем событии побеждает только более новый
  watermark: кандидат с `occurredAt <=` текущего значения игнорируется.
- После `session-end` (завершённая terminal-сессия) новые outcome-обновления не
  запускаются; при `metadata.lifecycleState === "archived"` кандидат блокируется
  на этапе merge. Уже поставленная в очередь metadata-операция отдельно не
  отменяется.
- `success` заменяет предыдущий `error` watermark, но не является отдельным
  UI-статусом. Для online-сессии UI применяет приоритет
  `offline > permission > thinking > error > idle`; `success` приводит к
  `idle`, если более приоритетное состояние отсутствует.
- `summary.text` и другие свободные metadata-поля не устанавливают и не
  очищают outcome. Summary может отображаться как текст, но сам по себе не
  делает сессию ошибочной.

### Типы событий `ephemeral`
- `activity`: `{ type: "activity", id: sessionId, active, activeAt, thinking }`
- `machine-activity`: `{ type: "machine-activity", id: machineId, active, activeAt }`
- `usage`: `{ type: "usage", id: sessionId, key, tokens, cost, timestamp }`

### WebSocket-события клиент -> сервер
- `ping` -> callback `{}`

- `update-metadata`
  - `{ sid, metadata, expectedVersion }`
  - Ответ: `{ result: "success", version, metadata }` или `{ result: "version-mismatch", version, metadata }`

- `update-state`
  - `{ sid, agentState, expectedVersion }`
  - Ответ: `{ result: "success", version, agentState }` или `{ result: "version-mismatch", version, agentState }`

- `message`
  - `{ sid, message, localId? }`
  - Создаёт новое сообщение сессии (зашифрованный payload) и отправляет обновление `new-message` остальным соединениям.

- `session-alive`
  - `{ sid, time, thinking?, mode? }`
  - Отправляет `ephemeral` activity user-scoped соединениям.

- `session-end`
  - `{ sid, time }`
  - Помечает сессию неактивной и отправляет `ephemeral` activity.

- `usage-report`
  - `{ key, sessionId?, tokens, cost }`
  - Сохраняет отчёт об использовании и опционально отправляет `ephemeral` usage для сессии.

- `machine-alive`
  - `{ machineId, time }`
  - Отправляет `ephemeral` machine-activity.

- `machine-update-metadata`
  - `{ machineId, metadata, expectedVersion }`
  - Ответ: `{ result: "success", version, metadata }` или `{ result: "version-mismatch", version, metadata }`

- `machine-update-state`
  - `{ machineId, daemonState, expectedVersion }`
  - Ответ: `{ result: "success", version, daemonState }` или `{ result: "version-mismatch", version, daemonState }`

- `rpc-register`
  - `{ method }` -> сервер отправляет `rpc-registered`

- `rpc-unregister`
  - `{ method }` -> сервер отправляет `rpc-unregistered`

- `rpc-call`
  - `{ method, params }` -> callback `{ ok, result? | error? }`
  - Сервер пересылает вызов зарегистрированному сокету через `rpc-request` (на основе ack).
  - `get-session-execution { sessionId }` возвращает daemon-owned
    `{ sessionId, provider, revision, current, pending? }` только для активной
    Codex/Cursor wrapper-сессии.
  - `set-session-execution { sessionId, expectedRevision, execution }` принимает
    provider-discriminated selection, повторно проверяет свежий catalog и
    возвращает новый snapshot. Raw selection из chat message не используется.

## HTTP-endpoint'ы по областям

| Область | Endpoint | Описание |
|---------|----------|----------|
| Health | `GET /health` | Liveness-проба (без аутентификации) |
| Account | `GET /v1/account/settings`, `GET /v1/account/profile`, `POST /v1/account/settings` | Заглушки аккаунта для совместимости с клиентом |
| KV | `GET /v1/kv`, `GET /v1/kv/:key`, `POST /v1/kv/bulk`, `POST /v1/kv` | Зашифрованное key-value хранилище (мутация с `version` для оптимистичного контроля конкурентности) |
| Voice (STT) | `GET /v1/whisper/status`, `POST /v1/voice/transcribe` | Локальная multipart-транскрипция Whisper; action-level proof с payload `null`, без хеширования audio stream |
| Voice (TTS) | `GET /v1/tts/status`, `POST /v1/voice/synthesize` | Статус TTS + синтез: `{ text, voice?, lang? }` → `audio/ogg` (OGG Opus) |
| Concierge | `GET /v1/concierge/status`, `POST /v1/concierge/chat` | Опциональный локальный LLM-ассистент (LM Studio); тело chat: `{ messages: [{ role, content }] }` → `{ reply, actions }` |
| Sessions | `GET /v1/sessions`, `GET /v2/sessions`, `GET /v2/sessions/active`, `POST /v1/sessions`, `GET /v1/sessions/:sessionId/messages`, `DELETE /v1/sessions/:sessionId` | CRUD сессий + история сообщений |
| Machines | `POST /v1/machines`, `GET /v1/machines`, `GET /v1/machines/:id` | Регистрация и листинг машин |

## Секвенирование и конкурентность
- `UpdatePayload.seq` — последовательность обновлений на пользователя (монотонная), используется для порядка синхронизации.
- У сессий и машин есть собственные поля `seq`, используемые клиентами для упорядочивания.
- Версионируемые поля (metadata, agentState, daemonState, KV) используют оптимистичный контроль конкурентности с `expectedVersion` и возвращают ответ version-mismatch с текущей версией/данными.

## Ссылки на реализацию
- API-роуты: `packages/remcli-cli/src/daemon/p2p/p2pRestRoutes.ts`
- Socket-обработчики: `packages/remcli-cli/src/daemon/p2p/p2pSocketHandlers.ts`
- Маршрутизация событий: `packages/remcli-cli/src/daemon/p2p/p2pEventRouter.ts`
