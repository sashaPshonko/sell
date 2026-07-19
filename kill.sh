#!/bin/bash
# Рестарт: убить всё → поднять заново (как nohup scripts/50x.sh в 4narek).
cd ~/sell || exit 1

pkill -f 'scripts/run/sellbot.sh' 2>/dev/null || true
pkill -f 'scripts/run/sell.sh' 2>/dev/null || true
pkill -f 'orchestrator.mjs' 2>/dev/null || true
pkill -f 'poll.mjs' 2>/dev/null || true
kill $(lsof -t -i :8790) 2>/dev/null || true
rm -f .poll.pid sellbot/.orchestrator.pid
rm -f /tmp/sell-poll.pid /tmp/sellbot-orchestrator.pid
rm -f /tmp/sell-poll.lock /tmp/sellbot-orchestrator.lock
sleep 2

mkdir -p logs
TS=$(date +%Y%m%d)
nohup bash scripts/run/sellbot.sh >> "logs/sellbot-${TS}.log" 2>&1 &
sleep 1
nohup bash scripts/run/sell.sh >> "logs/sell-${TS}.log" 2>&1 &
ln -sf "logs/sellbot-${TS}.log" sellbot.log
ln -sf "logs/sell-${TS}.log" sell.log

echo "[sell] запущено. Проверка:"
pgrep -af 'sell\.sh|sellbot\.sh|poll\.mjs|orchestrator\.mjs' || true
tail -f sellbot.log
