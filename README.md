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

Minecraft-прокси: `proxy` — внешний SOCKS. Если VPS не достучится до прокси напрямую — `proxyVia`: `"socks5://127.0.0.1:1080"`. Цепочка: VPS → xray → proxy → MC.

Xray поднимается сам при старте sellbot (`node sellbot/xray.mjs`, ссылка в `sellbot/vless.url`). Вручную: `cd sellbot && node xray.mjs` / `node xray-check.mjs`.
