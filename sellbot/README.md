# Sellbot

Выдача на FunTime. Настройки — **`bot.json`** (см. `bot.json.example`, дефолты в `settings.mjs`). Файл `.env` не нужен.

```bash
npm install
cp bot.json.example bot.json
npm start
```

Из корня `sell/`: `npm start --prefix sellbot` или `./scripts/run/sellbot.sh`.

## bot.json

Минимум:

```json
[{ "username": "ник", "password": "пароль", "anarchy": 502 }]
```

Опционально: `wsPort`, `payTemplate`, `paySuffix`, `mockDelivery`, `healthCheckEnabled`, таймауты — см. `settings.mjs`.

## Telegram (опционально)

Без `TELEGRAM_TOKEN` в окружении — не подключается. При запуске:

```bash
TELEGRAM_TOKEN=... TELEGRAM_CHAT_ID=... npm start
```

## Выдача `/pay`

Заказ → подключение → цикл `/pay` до `[✔] Успешно` → отключение после `idleQuitMs` без очереди.
