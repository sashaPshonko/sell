#!/bin/bash
cd "$(dirname "$0")/../.." || exit 1

killpids() {
    local sig=$1
    shift
    for pat in "$@"; do
        pkill "$sig" -f "$pat" 2>/dev/null || true
    done
}

echo "[stop] останавливаю sell + sellbot…"

kill $(lsof -t -i :8790) 2>/dev/null || true

# сначала мягко — обёртки, потом node
killpids '' 'scripts/run/sellbot.sh' 'run/sellbot.sh' 'scripts/run/sell.sh' 'run/sell.sh'
sleep 1
killpids '' orchestrator.mjs poll.mjs

if [ -f .poll.pid ]; then
    kill "$(cat .poll.pid)" 2>/dev/null || true
fi
if [ -f sellbot/.orchestrator.pid ]; then
    kill "$(cat sellbot/.orchestrator.pid)" 2>/dev/null || true
fi

sleep 1

# кто остался — kill -9
killpids -9 'scripts/run/sellbot.sh' 'run/sellbot.sh' 'scripts/run/sell.sh' 'run/sell.sh'
killpids -9 orchestrator.mjs poll.mjs

rm -f sellbot/.orchestrator.pid .poll.pid
sleep 1

left=$(ps aux | grep -E 'run/sell\.sh|run/sellbot\.sh|poll\.mjs|orchestrator\.mjs' | grep -v grep || true)
if [ -n "$left" ]; then
    echo "[stop] ещё живы (убей вручную kill -9 PID):"
    echo "$left"
else
    echo "[stop] всё остановлено"
fi
