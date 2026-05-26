# Sellbot — оркестратор выдачи валюты

Связка с `sell/` (PlayerOK): при оплате sell шлёт заказ по WebSocket, sellbot поднимает mineflayer-бота на анархии и выдаёт валюту.

## Запуск

```bash
cd sellbot && npm install && cp .env.example .env
# SKIP_TELEGRAM=1 пока нет токена
npm start
```

В другом терминале (из корня `sell/`):

```bash
npm start
```

В `sell/.env` должно быть `WS_URL=ws://127.0.0.1:8790` (по умолчанию sell подключается к sellbot).

## Telegram

Когда будет токен — в `.env`:

```
SKIP_TELEGRAM=0
TELEGRAM_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_PROXY=off
```

Команды: `/ping`, `/start` (воркер), `/stop`.

Строки из `parentPort.postMessage('текст')` в воркере уходят в Telegram.

Живёт внутри `sell/sellbot/`. На VPS клонируй/копируй всю папку **`sell/`**.

## Выдача `/pay`

1. Заказ → бот **подключается** (не висит на сервере постоянно).
2. **Цикл** (как `safeAH` в 4NAREK): `antiAfk` → `/pay` → пауза `PAY_LOOP_WAIT_MS` (2 с) → снова, пока не придёт успех.
3. Просьба «подтвердите выдачу» **игнорируется** — успех только по `[✔] Успешно!` (константа в `worker.mjs`).
4. Очередь пуста → через `IDLE_QUIT_MS` бот **отключается**.

**AFK**: флаг `afk` → в цикле только осмотр и `continue`, без `/pay`, пока не снимется AFK.

**Капча / бан**: алерт в Telegram, воркер стоп (как в 4NAREK).

Подстрой маркеры по логам `💬` в консоли — см. `.env.example`.

## Бот

`bot.json` — один аккаунт (username, password, anarchy).
