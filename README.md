# sell (PlayerOK + Rust выдача)

| Часть | Конфиг |
|--------|--------|
| PlayerOK | `.env` — `PLAYEROK_TOKEN` + `PLAYEROK_AUID` |
| Анархия | `config.mjs` — `DELIVERY_ANARCHY` |
| Боты выдачи | `sellbot-rust/bots/sell.json` |
| Орк | `sellbot-rust/orch.json` (`go_ws`, соль смен) |

Выдача: `/pay` дважды (подтверждение FunTime = один перевод). Боты офлайн, пока нет заказов: приходит заказ — заходит держатель денег (первый в очереди `queue.json`), выдаёт и выходит через 25 с простоя. После 2 выдач покупателям он третьим переводом отдаёт весь остаток следующему (тот заходит только принять) и уходит в конец очереди. Времени смены нет, лимит только по числу переводов. Состояние: `./target/release/sell-orch --schedule` или `schedule.json`. Непривязанные боты остаются онлайн, пока не пройдут привязку.

```bash
cd sellbot-rust && cargo build --release -p bot --bin sell-bot -p orch --bin sell-orch
# из корня sell:
./scripts/run/sellbot.sh
./scripts/run/sell.sh
# или
./kill.sh
```

## FunPay (автовыдача)

Отдельный процесс `funpay/poll.mjs`, тот же оркестратор (WS :8790) и те же боты, что у PlayerOK. Заказы идут с префиксом `fp-`, состояние — `funpay-state.json`, журнал — `funpay-orders.jsonl`.

| Что | Где |
|--------|--------|
| Сессия | `.env`: `FUNPAY_GOLDEN_KEY` (cookie golden_key из браузера) |
| Режим | `FUNPAY_LIVE=1` — писать в чат и слать заказы боту; без неё — наблюдение (всё логируется, ничего не отправляется) |
| Размер выдачи | `funpay/amount.mjs`: цена за 1кк, значит выдаём столько кк, сколько куплено (количество × `FUNPAY_DEFAULT_UNIT_KK`=1; единица из описания лота только при `FUNPAY_UNIT_FROM_DESC=1`); минимум берётся из описания лота («ОТ 200КК», раз в 10 мин читается со страницы продавца), иначе `FUNPAY_MIN_KK` (200) — меньше: возврат + сообщение; потолка нет (`FUNPAY_MAX_KK` по желанию) |
| Тексты | `funpay/texts.mjs` |

```bash
npm install                                   # нужен cheerio
node funpay/probe.mjs [--order ID] [--dump ./dump]   # сверка селекторов на живом аккаунте, только чтение
node --test --test-concurrency=1 funpay/*.test.mjs                # тесты (в т.ч. сквозной с поддельным FunPay и оркестратором)
./scripts/run/funpay.sh
```

Первый запуск пропускает все уже существующие оплаты (они могли быть выданы вручную). Подтверждать заказ после выдачи не нужно: его подтверждает покупатель.
