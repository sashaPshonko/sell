#!/bin/bash
cd "$(dirname "$0")/../../sellbot"

LOCK_FILE="/tmp/sellbot-orchestrator.lock"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "[sellbot] уже запущен (flock $LOCK_FILE) — выход"
    exit 1
fi

while true; do
    node orchestrator.mjs
    code=$?
    if [ "$code" -eq 2 ]; then
        echo "[sellbot] второй экземпляр — не перезапускаем"
        exit 1
    fi
    sleep 5
done
