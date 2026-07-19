#!/bin/bash
# Как 4narek scripts/50x.sh: цикл + node. Один экземпляр — pid-lock в poll.mjs.
cd "$(dirname "$0")/../.." || exit 1

while true; do
    node poll.mjs
    code=$?
    if [ "$code" -eq 2 ]; then
        echo "[sell] уже запущен (pid lock) — выход"
        exit 1
    fi
    if [ "$code" -eq 3 ]; then
        echo "[sell] fatal auth — не перезапускаю"
        exit 1
    fi
    echo "[sell] poll exit $code — через 5s"
    sleep 5
done
