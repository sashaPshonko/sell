# sell (PlayerOK + Rust выдача)

| Часть | Конфиг |
|--------|--------|
| PlayerOK | `.env` — `PLAYEROK_TOKEN` + `PLAYEROK_AUID` |
| Анархия | `config.mjs` — `DELIVERY_ANARCHY` |
| Боты выдачи | `sellbot-rust/bots/sell.json` |
| Орк | `sellbot-rust/orch.json` (`go_ws`, соль смен) |

Выдача: `/pay` дважды. После двух выдач или конца смены — остаток следующему боту. Смена не длиннее 2 часов (две штуки в сутки, старт плавает). Покупки пишутся в `purchases.json` (время по Москве + счётчик по часам) — по нему потом подкручиваем окна. Непривязанные к Go не спим.

```bash
cd sellbot-rust && cargo build --release -p bot --bin sell-bot -p orch --bin sell-orch
# из корня sell:
./scripts/run/sellbot.sh
./scripts/run/sell.sh
# или
./kill.sh
```
