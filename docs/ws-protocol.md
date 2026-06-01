# WebSocket протокол (бот выдачи)

Сервер: **sellbot** (`npm start` в `sellbot/`), порт `WS_PORT` (8790).

**sell** подключается как клиент (`WS_URL=ws://127.0.0.1:8790`).

## Sell → бот: новый заказ

```json
{
  "type": "order",
  "orderId": "1f158322-9d4f-6f70-de4a-1df74e539f78",
  "dealId": "1f158322-9d4f-6f70-de4a-1df74e539f78",
  "chatId": "...",
  "buyer": "Plato5",
  "nick": "Steve",
  "amount": 100,
  "anarchy": "221",
  "itemName": "100KK FUNTIME 1.21"
}
```

`orderId` = `dealId` PlayerOK (один заказ = один id).

## Бот → sell: события

```json
{ "type": "delivery_ok", "orderId": "..." }
{ "type": "delivery_failed", "orderId": "...", "reason": "текст" }
{ "type": "delivery_stalled", "orderId": "...", "reason": "queue_timeout", "queued": 2 }
{ "type": "invalid_nick", "orderId": "..." }
{ "type": "player_offline", "orderId": "..." }
```

`delivery_stalled` — таймаут (1 мин) при непустой очереди: заказ сбрасывается, покупателю в чат — снова `/nick`.

После `invalid_nick` / `player_offline` sell пишет покупателю в чат PlayerOK про `/nick`.

## Смена ника

Покупатель пишет `/nick NewNick` → sell шлёт ботам:

```json
{ "type": "nick_update", "orderId": "...", "nick": "NewNick" }
```

Бот может повторить выдачу с новым ником.
