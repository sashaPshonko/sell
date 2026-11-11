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
