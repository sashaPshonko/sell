# sell (PlayerOK + sellbot)

| Часть | Конфиг |
|--------|--------|
| PlayerOK | `.env` — `PLAYEROK_TOKEN`; cookies → `captures/session.cookie` (`npm run capture-curl`) |
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

Telegram — в `sellbot/bot.json`: `telegramToken`, `telegramChatId` (или напиши боту `/start` и перезапусти — подтянет из getUpdates). `telegramProxy`: `"off"` или SOCKS.
