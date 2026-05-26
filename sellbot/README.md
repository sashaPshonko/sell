# Sellbot

Всё в **`bot.json`** (см. `bot.json.example`). `.env` не нужен.

```bash
npm install
cp bot.json.example bot.json
npm start
```

## Telegram

В `bot.json`:

```json
"telegramToken": "...",
"telegramChatId": "твой id",
"telegramProxy": "off"
```

Без `telegramChatId`: напиши боту **`/start`**, перезапусти sellbot — id возьмётся из getUpdates. Команда **`/chatid`** в чате с ботом.

Если Telegram с VPS не открывается: `"telegramProxy": "socks5h://127.0.0.1:1080"`.
