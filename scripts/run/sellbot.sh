#!/bin/bash
cd "$(dirname "$0")/../../sellbot"
while true; do
    node orchestrator.mjs
    code=$?
    if [ "$code" -eq 2 ]; then
        echo "[sellbot] порт занят — второй экземпляр не запускаем (exit 2)"
        exit 1
    fi
    sleep 5
done
