#!/bin/bash
cd "$(dirname "$0")/../.."

LOCK_FILE="/tmp/sell-poll.lock"
exec 8>"$LOCK_FILE"
if ! flock -n 8; then
    echo "[sell] уже запущен (flock $LOCK_FILE) — второй nohup не нужен"
    echo "[sell] остановить: bash scripts/run/stop.sh  или  pkill -f 'scripts/run/sell.sh'"
    exit 1
fi

echo "[sell] wrapper pid $$ — poll loop"

while true; do
    node poll.mjs
    code=$?
    if [ "$code" -eq 2 ]; then
        echo "[sell] poll уже запущен (pid lock) — выход"
        exit 1
    fi
    if [ "$code" -eq 3 ]; then
        echo "[sell] фatal: auth/query — wrapper останавливается (не перезапускаю)"
        exit 1
    fi
    sleep 5
done
