#!/bin/bash
cd ~/sell || exit 1

kill $(lsof -t -i :8790) 2>/dev/null
pkill -f 'scripts/run/sellbot.sh'
pkill -f 'scripts/run/sell.sh'
pkill -f 'orchestrator.mjs'
pkill -f 'poll.mjs'
sleep 2

mkdir -p logs
TS=$(date +%Y%m%d)
nohup bash scripts/run/sellbot.sh >> "logs/sellbot-${TS}.log" 2>&1 &
sleep 2
nohup bash scripts/run/sell.sh >> "logs/sell-${TS}.log" 2>&1 &
ln -sf "logs/sellbot-${TS}.log" sellbot.log
ln -sf "logs/sell-${TS}.log" sell.log

tail -f sellbot.log