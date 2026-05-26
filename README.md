# sell (PlayerOK + sellbot)

Одна папка для git и VPS.

| Часть | Где |
|--------|-----|
| PlayerOK | корень `sell/` — `poll.mjs`, `.env` с `PLAYEROK_TOKEN` |
| Выдача на сервере | `sellbot/` — `bot.json`, свой `.env` |

```bash
npm install
npm install --prefix sellbot
cp .env.example .env
cp sellbot/.env.example sellbot/.env
```

Перезапуск (nohup сам):

```bash
./scripts/run/sellbot.sh   # сначала
./scripts/run/sell.sh
```

`WS_URL=ws://127.0.0.1:8790` в `.env` — sellbot слушает тот же порт.
