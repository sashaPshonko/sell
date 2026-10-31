#!/bin/bash
# Рестарт: убить всё → поднять заново (как nohup scripts/50x.sh в 4narek).
cd ~/sell || exit 1

pkill -f 'scripts/run/sellbot.sh' 2>/dev/null || true
pkill -f 'scripts/run/sell.sh' 2>/dev/null || true
pkill -f 'orchestrator.mjs' 2>/dev/null || true
pkill -f 'sell-orch' 2>/dev/null || true
pkill -f 'sell-bot' 2>/dev/null || true
pkill -f 'poll.mjs' 2>/dev/null || true
kill $(lsof -t -i :8790) 2>/dev/null || true
rm -f .poll.pid sellbot/.orchestrator.pid
rm -f /tmp/sell-poll.pid /tmp/sellbot-orchestrator.pid
rm -f /tmp/sell-poll.lock /tmp/sellbot-orchestrator.lock
sleep 2

mkdir -p logs
TS=$(date +%Y%m%d)
# старые дневные логи
find logs -name 'sell-*.log' -mtime +14 -delete 2>/dev/null || true
find logs -name 'sellbot-*.log' -mtime +14 -delete 2>/dev/null || true
nohup bash scripts/run/sellbot.sh >> "logs/sellbot-${TS}.log" 2>&1 &
sleep 1
nohup bash scripts/run/sell.sh >> "logs/sell-${TS}.log" 2>&1 &
ln -sf "logs/sellbot-${TS}.log" sellbot.log
ln -sf "logs/sell-${TS}.log" sell.log

echo "[sell] запущено. Проверка:"
pgrep -af 'sell\.sh|sellbot\.sh|poll\.mjs|sell-orch|sell-bot' || true
tail -f sellbot.log
