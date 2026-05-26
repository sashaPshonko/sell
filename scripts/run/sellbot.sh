#!/bin/bash
cd "$(dirname "$0")/../../sellbot"
while true; do
    node orchestrator.mjs
    sleep 5
done
