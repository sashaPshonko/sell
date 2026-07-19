#!/bin/bash
# Как 4narek: цикл + node в foreground. Без trap/CHILD — pkill убивает и обёртку, и node.
cd "$(dirname "$0")/../../sellbot" || exit 1

while true; do
    node orchestrator.mjs
    code=$?
    if [ "$code" -eq 2 ]; then
        echo "[sellbot] уже запущен (pid lock) — выход"
        exit 1
    fi
    echo "[sellbot] orchestrator exit $code — через 5s"
    sleep 5
done
