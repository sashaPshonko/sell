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

CHILD=""

stop_child() {
    if [ -n "$CHILD" ] && kill -0 "$CHILD" 2>/dev/null; then
        kill -TERM "$CHILD" 2>/dev/null
        for _ in 1 2 3 4 5; do
            kill -0 "$CHILD" 2>/dev/null || break
            sleep 1
        done
        kill -KILL "$CHILD" 2>/dev/null || true
        wait "$CHILD" 2>/dev/null || true
    fi
    CHILD=""
}

on_signal() {
    stop_child
    exit 0
}

trap on_signal TERM INT HUP

while true; do
    node orchestrator.mjs &
    CHILD=$!
    wait "$CHILD"
    code=$?
    CHILD=""
    if [ "$code" -eq 2 ]; then
        echo "[sellbot] exit 2 (дубль) — чищу orchestrator и retry через 3s"
        pkill -9 -f 'orchestrator.mjs' 2>/dev/null || true
        rm -f .orchestrator.pid
        sleep 3
        continue
    fi
    echo "[sellbot] orchestrator exit $code — перезапуск через 5s"
    rm -f .orchestrator.pid
    sleep 5
done
