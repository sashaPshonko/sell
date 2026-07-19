#!/bin/bash
cd "$(dirname "$0")/../.." || exit 1

echo "[stop] sell + sellbot…"
pkill -f 'scripts/run/sellbot.sh' 2>/dev/null || true
pkill -f 'scripts/run/sell.sh' 2>/dev/null || true
pkill -f 'orchestrator.mjs' 2>/dev/null || true
pkill -f 'poll.mjs' 2>/dev/null || true
kill $(lsof -t -i :8790) 2>/dev/null || true
rm -f .poll.pid sellbot/.orchestrator.pid
rm -f /tmp/sell-poll.pid /tmp/sellbot-orchestrator.pid
rm -f /tmp/sell-poll.lock /tmp/sellbot-orchestrator.lock
sleep 1

left=$(pgrep -af 'sell\.sh|sellbot\.sh|poll\.mjs|orchestrator\.mjs' || true)
if [ -n "$left" ]; then
    echo "[stop] ещё живы:"
    echo "$left"
else
    echo "[stop] ок"
fi
