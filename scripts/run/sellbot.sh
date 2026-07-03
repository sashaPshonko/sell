#!/bin/bash
cd "$(dirname "$0")/../../sellbot"

LOCK_FILE="/tmp/sellbot-orchestrator.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "[sellbot] уже запущен (flock $LOCK_FILE) — второй nohup не нужен"
    echo "[sellbot] остановить: bash scripts/run/stop.sh  или  pkill -f 'scripts/run/sellbot.sh'"
    exit 1
fi

echo "[sellbot] wrapper pid $$ — orchestrator loop"

while true; do
    node orchestrator.mjs
    code=$?
    if [ "$code" -eq 2 ]; then
        echo "[sellbot] второй экземпляр — не перезапускаем"
        exit 1
    fi
    sleep 5
done
