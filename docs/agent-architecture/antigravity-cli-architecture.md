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
