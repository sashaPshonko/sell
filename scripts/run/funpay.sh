#!/bin/bash
# Автовыдача FunPay: цикл + node, как scripts/run/sell.sh. Один экземпляр — pid-lock в funpay/poll.mjs.
# Режим: FUNPAY_LIVE=1 в .env — боевой; без него — только наблюдение (ничего не шлёт).
cd "$(dirname "$0")/../.." || exit 1

while true; do
    node funpay/poll.mjs
    code=$?
    if [ "$code" -eq 2 ]; then
        echo "[funpay] уже запущен (pid lock) — выход"
        exit 1
    fi
    if [ "$code" -eq 3 ]; then
        echo "[funpay] ошибка авторизации (golden_key) — не перезапускаю"
        exit 1
    fi
    echo "[funpay] exit $code — через 5s"
    sleep 5
done
