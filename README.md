# sell (PlayerOK + sellbot)

| Часть | Конфиг |
|--------|--------|
| PlayerOK | `.env` — `PLAYEROK_TOKEN` + `PLAYEROK_AUID` (+ `PLAYEROK_DDG1` опционально) |
| Анархия выдачи | **`config.mjs`** — `DELIVERY_ANARCHY` (git pull на VPS) |
| Выдача FunTime | `sellbot/bot.json` — ник/пароль бота и настройки sellbot (**без .env**) |

```bash
npm install
npm install --prefix sellbot
cp .env.example .env
cp sellbot/bot.json.example sellbot/bot.json   # ник, пароль, анархия
```

Перезапуск:

```bash
./scripts/run/sellbot.sh
./scripts/run/sell.sh
```

### sellbot/bot.json

Обязательно: `username`, `password`. Анархия — в `config.mjs`, не в `bot.json`.

Остальное опционально (дефолты в `sellbot/settings.mjs`): `wsPort`, `payTemplate`, `paySuffix`, `mockDelivery`, `healthCheckEnabled`, таймауты и т.д.

Тест без Minecraft: `"mockDelivery": true` в `bot.json`.

Telegram — в `sellbot/bot.json`: `telegramToken`, `telegramChatId` (или напиши боту `/start` и перезапусти — подтянет из getUpdates). `telegramProxy`: `"off"` или SOCKS.
