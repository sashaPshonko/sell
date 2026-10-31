#!/bin/bash
# Rust sell-orch (выдача /pay). Не mineflayer.
cd "$(dirname "$0")/../../sellbot-rust" || exit 1

BIN=./target/release/sell-orch
while true; do
    if [ ! -x "$BIN" ]; then
        echo "[sellbot] нет $BIN — cargo build -p orch --bin sell-orch --release -p bot"
        exit 1
    fi
    "$BIN"
    code=$?
    echo "[sellbot] sell-orch exit $code — через 5s"
    sleep 5
done
