# Antigravity CLI в Remcli

## Статус и runtime

Antigravity поддерживается наряду с Codex и Cursor. Claude terminal wrapper
остаётся доступен, но его phone/Web provider flow отложен до отдельной
provider capability/lifecycle приёмки.

Daemon запускает локальный `agy` без shell и связывает его с Remcli через
stdin/stdout в формате `stream-json`:

```text
Phone/Web -> Remcli P2P -> daemon -> agy --input-format stream-json --output-format stream-json
```

`init`, `step_update` и `result` schema-валидируются. Каждый event обязан
содержать ожидаемый `conversation_id`; чужой ID отклоняется. Пользовательский
prompt передаётся JSON event `user`, tool steps и output стримятся обратно в
Remcli. Ограниченные stderr diagnostics очищаются от чувствительных данных.

## Dynamic catalog

Перед spawn daemon получает account-visible catalog через `agy models` и текущую
модель через `agy -p /model`. Catalog не является статичным allowlist: Remcli
сохраняет точные model IDs/display names, fingerprint/version и проверяет
selection перед запуском. Для опубликованных вариантов сохраняется связь
`runtimeModels[effort]`.

Antigravity reasoning efforts: `low`, `medium`, `high`. Gemini-модели могут
легитимно присутствовать в catalog как модели внутри Antigravity; отдельного
provider для Gemini здесь нет.

## Launch controls

Доступны modes `default`, `accept-edits`, `plan`. Отдельно проверяются
`--sandbox` и явный опасный профиль `--dangerously-skip-permissions`. Sandbox
не подменяет execution mode, а dangerous control должен оставаться видимым в
UI и не включаться неявно.

## Exact conversation resume

Native identity Antigravity это `conversation_id`. Новый и возобновлённый
процесс получает `--conversation <id>` и обязан подтвердить тот же ID в `init`;
при ошибке resume Remcli не создаёт новую conversation как fallback.

Интерактивная история читается из upstream storage:
`~/.gemini/antigravity-cli/history.jsonl`. Headless `stream-json` не добавляет
туда новые conversation, поэтому Remcli ведёт отдельный ограниченный индекс
`antigravity-sessions.json` в своём каталоге данных. Индекс содержит только
`conversationId`, рабочую директорию и время обновления; prompts, ответы,
токены и provider-файлы в него не копируются. Picker объединяет оба источника,
дедуплицирует exact conversation ID и применяет фильтр рабочей директории до
ответа.

Для созданной Remcli conversation resume повторяет сохранённые model и effort,
заново проверяя их по свежему capability snapshot. Launch controls при resume
сбрасываются в безопасные значения: `default`, без принудительного sandbox и
без `--dangerously-skip-permissions`. Для provider-only истории выбранные в UI
model и effort также повторно валидируются перед spawn.

## Transcript replay

Native resume и видимая история чата — разные контракты. `--conversation <id>`
восстанавливает контекст модели, но headless `stream-json` возвращает только
events текущего запуска. Upstream `history.jsonl` содержит picker metadata, а
документированный `transcript_path` относится к активному TUI status-line и не
является headless API.

Remcli поэтому хранит завершённые Antigravity turns отдельно от session index:

- один encrypted file на native conversation, filename — SHA-256 от
  `conversation_id`, без prompt или native ID в имени;
- ciphertext защищён существующим content encryption key Remcli; каталог имеет
  mode `0700`, файлы — `0600`, запись выполняется atomic replace;
- versioned strict schema ограничивает размер файла, число turns, сообщения и
  tool payloads; при заполнении удаляются самые старые turns;
- сохраняется только завершённый provider turn: user text, безопасная проекция
  tool events и assistant/error result, если provider вернул видимый текст;
- повреждённый, oversized, чужой workspace или нерасшифровываемый файл
  игнорируется и не блокирует native resume.

После daemon restart новый wrapper воспроизводит encrypted transcript только
после exact native bind и до публикации `ready`. В рамках того же daemon
существующий parent-wrapper остаётся источником lineage, поэтому повторный
replay не создаёт дубликаты. Historical assistant messages не меняют
`executionOutcome` новой сессии.

## Матрица поддержки

| Provider | Статус |
| --- | --- |
| Codex | supported |
| Cursor | supported |
| Antigravity | supported |
| Claude | terminal wrapper supported; phone/Web disabled / deferred |

Deterministic tests покрывают argv, stream schemas, exact ID, bounded session
index и catalog validation. Product-boundary и browser gates отдельно проверяют
create/resume/error на `390x844` и `1280x800`; доступность установленного `agy`
и реального account catalog зависит от локальной машины.
