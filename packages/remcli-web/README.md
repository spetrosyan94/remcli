# remcli-web visual gates

Все visual-тесты работают только с детерминированными `?fixtures=1` маршрутами приложения.
Baseline сравнивается с ранее принятым screenshot самого приложения. CI сверяет tracked
`src/styles/tokens.css` с contract и вычисленными runtime CSS значениями. В локальном
checkout с ignored `design/` тот же contract дополнительно сверяет `design/tokens.css`.

## Команды

```bash
npm -w remcli-web run test:e2e
npm -w remcli-web run test:design-contract
npm -w remcli-web run test:visual
npm -w remcli-web run test:visual:update
```

`test:visual` запускает Chromium-проекты для `390x844` и `1280x800` в dark/light,
фиксирует locale `en-US`, timezone `UTC` и время fixture. Матрица покрывает home, new
session, chat, terminal, zen, settings, concierge, все состояния connect (idle/scanning/error/manual)
и открытую Command Palette.
Одновременно проверяются screenshot и отсутствие axe-нарушений уровней
`serious`/`critical`. `test:design-contract` проверяет tracked contract и runtime CSS; в
локальном checkout дополнительно проверяет синхронизацию ignored `design/tokens.css`.
На macOS screenshot gate не является acceptance-командой: запускайте его в указанном ниже
pinned Linux container, иначе растеризация Chromium может законно отличаться от CI baseline.

Docker и Linux Playwright image относятся только к developer/CI visual gate. Они не
являются зависимостью Remcli: обычные `npm install`, `npm run dev:web`, сборка,
daemon и PWA-клиент не скачивают image и не требуют Docker.

## Baseline process

`design/` — ignored/manual source для ручного или AI-аудита семантики дизайна. Его
`tokens.css` проверяется локально, когда каталог присутствует, но не попадает в GitHub
checkout и не запускает CI сам по себе. HTML/TSX-референсы не являются screenshot baseline
и не участвуют в pixel diff.
Baseline хранится только в `e2e/__screenshots__/` и снимается с fixture-режима самого
приложения.

Для одинакового Chromium/Linux-рендеринга обновляйте baseline только в pinned Docker
образе CI `mcr.microsoft.com/playwright@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48`
и принудительно на `linux/amd64`: GitHub Actions runner имеет эту архитектуру, а Apple
Silicon Docker иначе выберет локальный `linux/arm64` variant. Visual job и baseline
используют встроенные в этот образ Node/npm, без дополнительной установки Node.

```bash
docker run --rm --init --ipc=host --platform linux/amd64 \
  --user "$(id -u):$(id -g)" \
  -e CI=1 \
  -e npm_config_cache=/tmp/npm-cache \
  --tmpfs /workspace/node_modules:rw,exec,mode=1777 \
  --tmpfs /workspace/packages/remcli-cli/node_modules:rw,exec,mode=1777 \
  --tmpfs /workspace/packages/remcli-web/node_modules:rw,exec,mode=1777 \
  --tmpfs /workspace/packages/remcli-web/test-results:rw,exec,mode=1777 \
  --tmpfs /workspace/packages/remcli-web/playwright-report:rw,exec,mode=1777 \
  -v "$PWD:/workspace" \
  -w /workspace \
  mcr.microsoft.com/playwright@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48 \
  bash -lc 'npm ci --ignore-scripts && npm -w remcli-web run test:visual:update'
```

Создание или обновление baseline — отдельное owner-reviewed изменение: перед отправкой
просмотрите diff PNG и подтвердите, что это намеренная правка принятого вида приложения.
`test:visual:update` намеренно переснимает всю матрицу в pinned environment, чтобы даже
малые, но видимые изменения текста не остались в старом baseline.
Playwright report, traces, screenshots и video при ошибке находятся в
`playwright-report/visual` и `test-results/visual`; эти артефакты не коммитятся.
