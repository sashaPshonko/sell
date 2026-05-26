# sell (PlayerOK + sellbot)

| Часть | Конфиг |
|--------|--------|
| PlayerOK | `.env` — `PLAYEROK_TOKEN`, `WS_URL=ws://127.0.0.1:8790` |
| Выдача FunTime | `sellbot/bot.json` — бот и все настройки sellbot (**без .env**) |

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

Обязательно: `username`, `password`, `anarchy`.

Остальное опционально (дефолты в `sellbot/settings.mjs`): `wsPort`, `payTemplate`, `paySuffix`, `mockDelivery`, `healthCheckEnabled`, таймауты и т.д.

Тест без Minecraft: `"mockDelivery": true` в `bot.json`.

Telegram (если нужен) — переменные окружения при запуске: `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`. Без токена Telegram не поднимается.
