# Sellbot

Всё в **`bot.json`** (см. `bot.json.example`). `.env` не нужен.

```bash
npm install
cp bot.json.example bot.json
npm start
```

## MC proxy через Xray (`proxyVia`)

Если с VPS до SOCKS-прокси (в `proxy`) нет прямого доступа — цепочка:

`VPS → 127.0.0.1:1080 (xray) → proxy → mc.funtime.su`

В `bot.json`:

```json
"proxy": "socks5://user:pass@host:50101",
"proxyVia": "socks5://127.0.0.1:1080"
```

VLESS-ссылка — в **`vless.url`** (git). При старте orchestrator сам поднимает `node xray.mjs`, если `:1080` закрыт.

```bash
node xray.mjs          # поднять SOCKS
node xray-check.mjs    # проверить
```

## Telegram

В `bot.json`:

```json
"telegramToken": "...",
"telegramChatId": "твой id",
"telegramProxy": "off"
```

Без `telegramChatId`: напиши боту **`/start`**, перезапусти sellbot — id возьмётся из getUpdates. Команда **`/chatid`** в чате с ботом.

Если Telegram с VPS не открывается: `"telegramProxy": "socks5h://127.0.0.1:1080"` — тот же xray на `:1080` (`telegramAutoXray` по умолчанию).
