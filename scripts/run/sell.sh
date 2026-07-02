#!/bin/bash
cd "$(dirname "$0")/../.."

LOCK_FILE="/tmp/sell-poll.lock"
exec 8>"$LOCK_FILE"
if ! flock -n 8; then
    echo "[sell] poll уже запущен (flock $LOCK_FILE) — выход"
    exit 1
fi

while true; do
    node poll.mjs
    code=$?
    if [ "$code" -eq 2 ]; then
        echo "[sell] poll уже запущен (pid lock) — выход"
        exit 1
    fi
    sleep 5
done
